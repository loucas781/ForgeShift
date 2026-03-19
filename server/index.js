'use strict'

// ─── Load environment ─────────────────────────────────────────────────────────
const fs   = require('fs')
const path = require('path')

const env     = process.env.NODE_ENV || 'development'
const envFile = path.join(__dirname, '../', `.env.${env}`)
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) return
    const k = trimmed.slice(0, eqIdx).trim()
    const v = trimmed.slice(eqIdx + 1).trim()
    if (k && !process.env[k]) process.env[k] = v
  })
}

// ─── Runtime overrides ────────────────────────────────────────────────────────
const overridesFile = path.join(__dirname, '../.runtime-overrides.json')
function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(overridesFile, 'utf8')) } catch { return {} }
}
function saveOverrides(data) {
  fs.writeFileSync(overridesFile, JSON.stringify(data, null, 2))
}
const _overrides = loadOverrides()
Object.entries(_overrides).forEach(([k, v]) => { process.env[k] = String(v) })

// ─── Version ──────────────────────────────────────────────────────────────────
const versionFile = path.join(__dirname, '../.version')
const rawVersion  = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, 'utf8').trim()
  : require('../package.json').version

const baseVersion = rawVersion.replace(/-dev\.\d+/, '').replace(/-rc.*/, '')
const APP_ENV_NORM = (process.env.APP_ENV || env).toLowerCase()
let APP_VERSION
if (APP_ENV_NORM === 'production') {
  APP_VERSION = baseVersion
} else if (APP_ENV_NORM === 'staging') {
  APP_VERSION = rawVersion.includes('-rc') ? rawVersion : `${baseVersion}-rc`
} else {
  APP_VERSION = rawVersion.includes('-dev.') ? rawVersion : `${baseVersion}-dev.0`
}

// ─── Run migration on startup ─────────────────────────────────────────────────
require('./db/migrate')

// ─── App ──────────────────────────────────────────────────────────────────────
const express      = require('express')
const cookieParser = require('cookie-parser')
const rateLimit    = require('express-rate-limit')
const { requireAuth, optionalAuth } = require('./middleware/auth')
const { getPasswordPolicy } = require('./auth-utils')
const emailSvc = require('./email')

const app = express()

app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: false }))
// Raw text body parser for backup restore (accepts large .fsbackup files)
app.use('/api/backup/restore', express.text({ limit: '256mb', type: 'text/plain' }))
app.use(cookieParser())

app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.path}`)
  next()
})

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1)

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.APP_ENV === 'development',
  message: { error: 'Too many attempts — please wait 15 minutes.' },
}))

// Serve static files
app.use(express.static(path.join(__dirname, '../public'), { index: false }))

// ── Config endpoint ────────────────────────────────────────────────────────────
app.get('/api/config', optionalAuth, (req, res) => {
  const overrides = loadOverrides()
  let user = null
  if (req.user) {
    const db = require('./db/connection')
    user = db.prepare('SELECT id, name, email, initials, color, avatar, role FROM users WHERE id = ?').get(req.user.id) || null
  }
  // Load feature flags from app_preferences
  const db = require('./db/connection')
  const featureTasksRow = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_tasks'").get()
  const featureTasks = featureTasksRow ? featureTasksRow.value === 'true' : false
  res.json({
    appName:        process.env.APP_NAME      || 'ForgeShift',
    appEnv:         process.env.APP_ENV       || env,
    version:        APP_VERSION,
    nodeVersion:    process.version,
    platform:       process.platform,
    user,
    allowSignup:    (overrides.ALLOW_SIGNUP  ?? 'true') !== 'false',
    cookieSecure:   process.env.COOKIE_SECURE === 'true',
    trustProxy:     process.env.TRUST_PROXY   === 'true',
    passwordPolicy: getPasswordPolicy(overrides),
    smtpEnabled:    emailSvc.getSmtpConfig().enabled,
    featureTasks,
  })
})

// ── GET/PATCH /api/features — admin feature flag management ───────────────────
app.get('/api/features', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const row = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_tasks'").get()
  res.json({ feature_tasks: row ? row.value === 'true' : false })
})
app.patch('/api/features', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const { feature_tasks } = req.body
  if (typeof feature_tasks === 'boolean') {
    db.prepare(`INSERT INTO app_preferences (key, value, updated_at) VALUES ('feature_tasks', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(feature_tasks ? 'true' : 'false')
  }
  const row = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_tasks'").get()
  res.json({ feature_tasks: row ? row.value === 'true' : false })
})

// ── Admin: toggle runtime settings ────────────────────────────────────────────
app.patch('/api/config', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const overrides = loadOverrides()
  if (typeof req.body.allowSignup === 'boolean')  overrides.ALLOW_SIGNUP   = req.body.allowSignup  ? 'true' : 'false'
  if (typeof req.body.cookieSecure === 'boolean') {
    overrides.COOKIE_SECURE = req.body.cookieSecure ? 'true' : 'false'
    process.env.COOKIE_SECURE = overrides.COOKIE_SECURE
  }
  if (typeof req.body.trustProxy === 'boolean') {
    overrides.TRUST_PROXY = req.body.trustProxy ? 'true' : 'false'
    process.env.TRUST_PROXY = overrides.TRUST_PROXY
    // Apply immediately to Express — no restart needed
    req.app.set('trust proxy', req.body.trustProxy ? 1 : 0)
  }
  saveOverrides(overrides)
  res.json({
    ok: true,
    allowSignup:  overrides.ALLOW_SIGNUP   !== 'false',
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    trustProxy:   process.env.TRUST_PROXY   === 'true',
  })
})

// ── PATCH /api/config/password-policy — admin: update password policy ─────────
app.patch('/api/config/password-policy', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const { getPasswordPolicy } = require('./auth-utils')
  const overrides = loadOverrides()
  const current   = getPasswordPolicy(overrides)
  const allowed   = ['minLength','requireUpper','requireLower','requireNumber','requireSpecial','noSequential']
  const updated   = { ...current }
  for (const key of allowed) {
    if (key === 'minLength') {
      if (req.body[key] !== undefined) {
        const v = parseInt(req.body[key])
        if (isNaN(v) || v < 6 || v > 128) return res.status(400).json({ error: 'minLength must be 6–128' })
        updated[key] = v
      }
    } else if (typeof req.body[key] === 'boolean') {
      updated[key] = req.body[key]
    }
  }
  overrides.PASSWORD_POLICY = updated
  saveOverrides(overrides)
  res.json({ ok: true, passwordPolicy: updated })
})

// ── Audit log ─────────────────────────────────────────────────────────────────
app.get('/api/audit', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const limit  = Math.min(parseInt(req.query.limit || '50'), 200)
  const offset = parseInt(req.query.offset || '0')
  const entries = db.prepare(`
    SELECT a.*, u.name as actor_name, u.initials as actor_initials, u.color as actor_color, u.avatar as actor_avatar
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset)
  const total = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c
  res.json({ entries, total, limit, offset })
})

// ── GET /api/stats — instance stats for Build Info panel ──────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const users     = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active = 1').get().c
  const shifts    = db.prepare('SELECT COUNT(*) as c FROM shifts').get().c
  const locations = db.prepare('SELECT COUNT(*) as c FROM locations').get().c
  const templates = db.prepare('SELECT COUNT(*) as c FROM shift_templates').get().c
  res.json({ users, shifts, locations, templates })
})

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',             require('./routes/auth'))
app.use('/api/users',            require('./routes/users'))
app.use('/api/shifts',           require('./routes/shifts'))
app.use('/api/templates',        require('./routes/templates'))
app.use('/api/template-groups',  require('./routes/template-groups'))
app.use('/api/locations',        require('./routes/locations'))
app.use('/api/teams',            require('./routes/teams'))
app.use('/api/ical',             require('./routes/ical'))
app.use('/api/backup',           require('./routes/backup'))
app.use('/api/tasks',            require('./routes/tasks'))
app.use('/api/holidays',         require('./routes/holidays'))

// ── GET /api/config/email — read SMTP config (admin, password masked) ─────────
app.get('/api/config/email', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const o = loadOverrides()
  res.json({
    smtpHost:     o.SMTP_HOST      || '',
    smtpPort:     o.SMTP_PORT      || '587',
    smtpSecure:   o.SMTP_SECURE    === 'true',
    smtpUser:     o.SMTP_USER      || '',
    smtpPass:     o.SMTP_PASS      ? '••••••••' : '',
    smtpFromName: o.SMTP_FROM_NAME || '',
    smtpFromAddr: o.SMTP_FROM_ADDR || '',
    hasPassword:  !!(o.SMTP_PASS),
    enabled:      !!(o.SMTP_HOST && o.SMTP_USER),
  })
})

// ── PATCH /api/config/email — save SMTP config ────────────────────────────────
app.patch('/api/config/email', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const o = loadOverrides()
  const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, smtpFromName, smtpFromAddr } = req.body
  if (smtpHost     !== undefined) o.SMTP_HOST      = smtpHost.trim()
  if (smtpPort     !== undefined) o.SMTP_PORT      = String(smtpPort)
  if (smtpSecure   !== undefined) o.SMTP_SECURE    = smtpSecure ? 'true' : 'false'
  if (smtpUser     !== undefined) o.SMTP_USER      = smtpUser.trim()
  if (smtpFromName !== undefined) o.SMTP_FROM_NAME = smtpFromName.trim()
  if (smtpFromAddr !== undefined) o.SMTP_FROM_ADDR = smtpFromAddr.trim()
  // Only overwrite password if a real value (not the masked placeholder) is provided
  if (smtpPass !== undefined && smtpPass !== '••••••••' && smtpPass !== '') o.SMTP_PASS = smtpPass
  if (smtpPass === '') delete o.SMTP_PASS
  saveOverrides(o)
  res.json({ ok: true, enabled: !!(o.SMTP_HOST && o.SMTP_USER) })
})

// ── POST /api/config/email/test — send a test email ───────────────────────────
app.post('/api/config/email/test', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const result = await emailSvc.testConnection()
  if (!result.ok) return res.status(400).json({ error: result.error })
  const db   = require('./db/connection')
  const me   = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id)
  const appName = process.env.APP_NAME || 'ForgeShift'
  await emailSvc.sendMail({
    to: me.email,
    subject: `${appName} SMTP test — it works!`,
    html: `<p>Hi ${me.name},</p><p>Your ${appName} SMTP configuration is working correctly.</p>`,
    text: `Hi ${me.name}, your ${appName} SMTP configuration is working correctly.`,
  })
  res.json({ ok: true, sentTo: me.email })
})

// ── Page routing ──────────────────────────────────────────────────────────────
app.get('/login.html',           (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')))
app.get('/signup.html',          (req, res) => res.sendFile(path.join(__dirname, '../public/signup.html')))
app.get('/forgot-password.html', (req, res) => res.sendFile(path.join(__dirname, '../public/forgot-password.html')))
app.get('/reset-password.html',  (req, res) => res.sendFile(path.join(__dirname, '../public/reset-password.html')))

app.get(['/', '/index.html'],    requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')))
app.get('/calendar.html',        requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/calendar.html')))
app.get('/templates.html',       requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/templates.html')))
app.get('/profile.html',         requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/profile.html')))
app.get('/settings.html',        requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/settings.html')))

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' })
  res.status(404).send('Not found')
})

// ── Error handler ──────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err)
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' })
  res.status(500).send('Server error')
})

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000')
app.listen(PORT, () => {
  console.log(`\n  ForgeShift [${env}] running at http://localhost:${PORT}\n`)
})
