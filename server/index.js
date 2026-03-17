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

const app = express()

app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: false }))
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
  res.json({
    appName:        process.env.APP_NAME      || 'ForgeShift',
    appEnv:         process.env.APP_ENV       || env,
    version:        APP_VERSION,
    user,
    allowSignup:    (overrides.ALLOW_SIGNUP  ?? 'true') !== 'false',
    cookieSecure:   process.env.COOKIE_SECURE === 'true',
    passwordPolicy: getPasswordPolicy(overrides),
  })
})

// ── Admin: toggle runtime settings ────────────────────────────────────────────
app.patch('/api/config', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const overrides = loadOverrides()
  if (typeof req.body.allowSignup === 'boolean') overrides.ALLOW_SIGNUP = req.body.allowSignup ? 'true' : 'false'
  if (typeof req.body.cookieSecure === 'boolean') {
    overrides.COOKIE_SECURE = req.body.cookieSecure ? 'true' : 'false'
    process.env.COOKIE_SECURE = overrides.COOKIE_SECURE
  }
  saveOverrides(overrides)
  res.json({ ok: true, allowSignup: overrides.ALLOW_SIGNUP !== 'false' })
})

// ── Audit log ─────────────────────────────────────────────────────────────────
app.get('/api/audit', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const limit  = Math.min(parseInt(req.query.limit || '50'), 200)
  const offset = parseInt(req.query.offset || '0')
  const entries = db.prepare(`
    SELECT a.*, u.name as actor_name, u.initials as actor_initials, u.color as actor_color
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset)
  const total = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c
  res.json({ entries, total, limit, offset })
})

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'))
app.use('/api/users',     require('./routes/users'))
app.use('/api/shifts',    require('./routes/shifts'))
app.use('/api/templates', require('./routes/templates'))
app.use('/api/locations', require('./routes/locations'))
app.use('/api/ical',      require('./routes/ical'))

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
