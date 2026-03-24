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
const logger   = require('./utils/logger')

const app = express()

app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: false, limit: '1mb' }))
// Raw text body parser for backup restore (accepts large .fsbackup files)
app.use('/api/backup/restore', express.text({ limit: '256mb', type: 'text/plain' }))
app.use(cookieParser())

app.use((req, res, next) => {
  logger.debug(`[req] ${req.method} ${req.path}`)
  next()
})

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1)

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.APP_ENV === 'development',
  message: { error: 'Too many attempts — please wait 15 minutes.' },
}))

// Rate limit on data write operations (POST/PUT/PATCH/DELETE to most API routes)
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  skip: (req) => process.env.APP_ENV === 'development' || !['POST','PUT','PATCH','DELETE'].includes(req.method),
  message: { error: 'Too many requests — please slow down.' },
})
app.use('/api/shifts',        writeLimiter)
app.use('/api/teams',         writeLimiter)
app.use('/api/templates',     writeLimiter)
app.use('/api/users',         writeLimiter)
app.use('/api/locations',     writeLimiter)
app.use('/api/tasks',         writeLimiter)
app.use('/api/organisations', writeLimiter)

// Serve static files
app.use(express.static(path.join(__dirname, '../public'), { index: false }))

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    const db = require('./db/connection')
    db.prepare('SELECT 1').get()
    res.json({ ok: true, version: APP_VERSION, uptime: Math.floor(process.uptime()) })
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unavailable' })
  }
})

// ── Config endpoint ────────────────────────────────────────────────────────────
app.get('/api/config', optionalAuth, cacheShort, (req, res) => {
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
  const featureDragDropRow = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_drag_drop'").get()
  const featureDragDrop = featureDragDropRow ? featureDragDropRow.value !== 'false' : true
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
    featureDragDrop,
  })
})

// ── GET/PATCH /api/features — admin feature flag management ───────────────────
app.get('/api/features', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const tasksRow    = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_tasks'").get()
  const dragDropRow = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_drag_drop'").get()
  res.json({
    feature_tasks:     tasksRow    ? tasksRow.value    === 'true'  : false,
    feature_drag_drop: dragDropRow ? dragDropRow.value !== 'false' : true,
  })
})
app.patch('/api/features', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const { feature_tasks, feature_drag_drop } = req.body
  if (typeof feature_tasks === 'boolean') {
    db.prepare(`INSERT INTO app_preferences (key, value, updated_at) VALUES ('feature_tasks', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(feature_tasks ? 'true' : 'false')
  }
  if (typeof feature_drag_drop === 'boolean') {
    db.prepare(`INSERT INTO app_preferences (key, value, updated_at) VALUES ('feature_drag_drop', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(feature_drag_drop ? 'true' : 'false')
  }
  const tasksRow    = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_tasks'").get()
  const dragDropRow = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_drag_drop'").get()
  res.json({
    feature_tasks:     tasksRow    ? tasksRow.value    === 'true'  : false,
    feature_drag_drop: dragDropRow ? dragDropRow.value !== 'false' : true,
  })
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
  const limit    = Math.min(parseInt(req.query.limit  || '30'), 200)
  const offset   = parseInt(req.query.offset  || '0')
  const action   = req.query.action   || ''
  const actorId  = req.query.actor_id || ''

  const where = []
  const params = []
  if (action)  { where.push('a.action = ?');   params.push(action) }
  if (actorId) { where.push('a.actor_id = ?'); params.push(actorId) }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''

  const entries = db.prepare(`
    SELECT a.*, u.name as actor_name, u.initials as actor_initials, u.color as actor_color, u.avatar as actor_avatar
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ${whereClause}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log a ${whereClause}`).get(...params).c

  // Return distinct actors for populating the user filter
  const actors = db.prepare(`
    SELECT DISTINCT u.id, u.name, u.initials, u.color, u.avatar
    FROM audit_log a JOIN users u ON u.id = a.actor_id
    ORDER BY u.name
  `).all()

  res.json({ entries, total, limit, offset, actors })
})

app.get('/api/audit/export', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const action  = req.query.action   || ''
  const actorId = req.query.actor_id || ''
  const where = []; const params = []
  if (action)  { where.push('a.action = ?');   params.push(action) }
  if (actorId) { where.push('a.actor_id = ?'); params.push(actorId) }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const entries = db.prepare(`
    SELECT a.created_at, u.name as actor_name, a.action, a.entity_type, a.entity_name, a.entity_id, a.detail
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ${whereClause} ORDER BY a.created_at DESC
  `).all(...params)
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const header = ['Time', 'User', 'Action', 'Entity Type', 'Entity Name', 'Entity ID', 'Detail'].map(escape).join(',')
  const rows = entries.map(e => [e.created_at, e.actor_name, e.action, e.entity_type, e.entity_name, e.entity_id, e.detail].map(escape).join(','))
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`)
  res.send([header, ...rows].join('\r\n'))
})

app.delete('/api/audit', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const auditModule = require('./audit')
  db.prepare('DELETE FROM audit_log').run()
  auditModule.log(db, { actor_id: req.user.id, action: 'settings_change', entity_type: 'audit_log', entity_id: 'all', entity_name: 'Audit Log', detail: 'Cleared all audit log entries' })
  res.json({ ok: true })
})

// Short-lived cache helper (10 s public, stale-while-revalidate)
function cacheShort(req, res, next) {
  res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=30')
  next()
}

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

// ── SSE — Real-time broadcast ──────────────────────────────────────────────────
const sseClients = new Map()  // userId → Set<res>

function broadcastShiftEvent(type, shift, actorId) {
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      try { res.write(`data: ${JSON.stringify({ type, shift, actorId })}\n\n`) } catch {}
    }
  }
}
app.locals.broadcastShiftEvent = broadcastShiftEvent

app.get('/api/sse', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write('data: {"type":"connected"}\n\n')

  const uid = req.user.id
  if (!sseClients.has(uid)) sseClients.set(uid, new Set())
  sseClients.get(uid).add(res)

  // Keepalive ping every 25 s to prevent proxy timeouts
  const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25000)

  req.on('close', () => {
    clearInterval(ping)
    sseClients.get(uid)?.delete(res)
    if (sseClients.get(uid)?.size === 0) sseClients.delete(uid)
  })
})

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',             require('./routes/auth'))
app.use('/api/users',            require('./routes/users'))
app.use('/api/shifts',           require('./routes/shifts'))
app.use('/api/templates',        require('./routes/templates'))
app.use('/api/template-groups',  require('./routes/template-groups'))
app.use('/api/locations',        require('./routes/locations'))
app.use('/api/teams',            require('./routes/teams'))
app.use('/api/organisations',    require('./routes/organisations'))
app.use('/api/ical',             require('./routes/ical'))
app.use('/api/backup',           require('./routes/backup'))
app.use('/api/tasks',            require('./routes/tasks'))
app.use('/api/task-list-groups', require('./routes/task-list-groups'))
app.use('/api/holidays',         require('./routes/holidays'))
app.use('/api/passkeys',         require('./routes/passkeys'))

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
  logger.error(`Unhandled error on ${req.method} ${req.path}:`, err.message || err)
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' })
  res.status(500).send('Server error')
})

// ── Periodic cleanup of expired password reset tokens ─────────────────────────
function cleanExpiredTokens() {
  try {
    const db = require('./db/connection')
    const now = new Date().toISOString()
    const tokens   = db.prepare("DELETE FROM password_reset_tokens   WHERE expires_at < ? OR used = 1").run(now)
    const sessions = db.prepare("DELETE FROM password_reset_sessions WHERE expires_at < ? OR used = 1").run(now)
    if (tokens.changes || sessions.changes) {
      logger.debug(`Token cleanup: removed ${tokens.changes} tokens, ${sessions.changes} sessions`)
    }
  } catch (err) {
    logger.error('Token cleanup failed:', err.message)
  }
}
// Run on startup and every 30 minutes
cleanExpiredTokens()
setInterval(cleanExpiredTokens, 30 * 60 * 1000)

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000')
app.listen(PORT, () => {
  logger.info(`ForgeShift [${env}] running at http://localhost:${PORT}`)
})
