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

function isMaintenanceModeEnabled() {
  const overrides = loadOverrides()
  return String(overrides.MAINTENANCE_MODE || 'false') === 'true'
}

// ─── Version ──────────────────────────────────────────────────────────────────
const versionFile = path.join(__dirname, '../.version')
const APP_ENV_NORM = (process.env.APP_ENV || env).toLowerCase()
function getAppVersion() {
  const rawVersion = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, 'utf8').trim()
    : require('../package.json').version
  const baseVersion = rawVersion.replace(/-dev\.\d+/, '').replace(/-rc.*/, '')
  if (APP_ENV_NORM === 'production') return baseVersion
  if (APP_ENV_NORM === 'staging') return rawVersion.includes('-rc') ? rawVersion : `${baseVersion}-rc`
  return rawVersion.includes('-dev.') ? rawVersion : `${baseVersion}-dev.0`
}

// ─── Run migration on startup ─────────────────────────────────────────────────
require('./db/migrate')

// ─── App ──────────────────────────────────────────────────────────────────────
const express      = require('express')
const cookieParser = require('cookie-parser')
const rateLimit    = require('express-rate-limit')
const { requireAuth, optionalAuth } = require('./middleware/auth')
const { rolePermissions, hasPermission } = require('./utils/roles')
const { getPasswordPolicy } = require('./auth-utils')
const { API_CATALOG_VERSION, MOBILE_API_CONTRACT, buildApiCatalog } = require('./api-catalog')
const emailSvc = require('./email')
const logger   = require('./utils/logger')

const app = express()
const GITHUB_REPO = process.env.GITHUB_REPO || 'loucas781/ForgeShift'
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`
const GITHUB_RELEASES_CACHE_MS = 5 * 60 * 1000
let githubReleasesCache = { fetchedAt: 0, data: null }

app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: false, limit: '1mb' }))
// Raw text body parser for backup restore (accepts large .fsbackup files)
app.use('/api/backup/restore', express.text({ limit: '256mb', type: 'text/plain' }))
app.use(cookieParser())

app.use((req, res, next) => {
  logger.debug(`[req] ${req.method} ${req.path}`)
  next()
})

async function fetchPublishedReleases(forceRefresh = false) {
  const now = Date.now()
  if (!forceRefresh && githubReleasesCache.data && (now - githubReleasesCache.fetchedAt) < GITHUB_RELEASES_CACHE_MS) {
    return githubReleasesCache.data
  }

  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ForgeShift/1.0',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  const res = await fetch(GITHUB_RELEASES_URL, {
    headers,
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`)

  const payload = await res.json()
  const releases = Array.isArray(payload) ? payload.map(rel => ({
    id: rel.id,
    version: String(rel.tag_name || '').replace(/^v/i, ''),
    tagName: rel.tag_name || '',
    name: rel.name || rel.tag_name || 'Untitled release',
    publishedAt: rel.published_at || rel.created_at || null,
    prerelease: !!rel.prerelease,
    draft: !!rel.draft,
    url: rel.html_url || null,
    notes: String(rel.body || ''),
  })).filter(rel => rel.version && !rel.draft) : []

  githubReleasesCache = { fetchedAt: now, data: releases }
  return releases
}

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
app.use('/api/shifts',         writeLimiter)
app.use('/api/teams',          writeLimiter)
app.use('/api/templates',      writeLimiter)
app.use('/api/users',          writeLimiter)
app.use('/api/locations',      writeLimiter)
app.use('/api/tasks',          writeLimiter)
app.use('/api/organisations',  writeLimiter)

// Apple App Site Association — must be served as application/json (no file extension)
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').sendFile(path.join(__dirname, '../public/.well-known/apple-app-site-association'))
})

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    const db = require('./db/connection')
    db.prepare('SELECT 1').get()
    res.json({ ok: true, version: getAppVersion(), uptime: Math.floor(process.uptime()) })
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unavailable' })
  }
})

// ── Config endpoint ────────────────────────────────────────────────────────────
app.get('/api/config', optionalAuth, (req, res) => {
  // Version metadata can be bumped without restarting a long-running dev
  // process, so do not let an intermediary retain the previous counter.
  res.set('Cache-Control', 'no-store')
  const overrides = loadOverrides()
  let user = null
  if (req.user) {
    const db = require('./db/connection')
    user = db.prepare(`SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
                              r.name AS role_name, r.color AS role_color, r.permissions AS role_permissions
                         FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`).get(req.user.id) || null
    if (user) {
      user.permissions = rolePermissions({ role: user.role, id: user.role_id, permissions: user.role_permissions })
      delete user.role_permissions
    }
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
    version:        getAppVersion(),
    nodeVersion:    process.version,
    platform:       process.platform,
    user,
    sectionAccess: user ? {
      calendar: hasPermission(req, 'view_calendar') || hasPermission(req, 'view_shifts') || hasPermission(req, 'view_own_rota') || hasPermission(req, 'view_other_rotas') || hasPermission(req, 'view_team_rotas') || hasPermission(req, 'view_all_rotas') || hasPermission(req, 'manage_team_shifts') || hasPermission(req, 'manage_org_shifts') || hasPermission(req, 'manage_all_shifts'),
      shifts: hasPermission(req, 'view_shifts') || hasPermission(req, 'view_own_rota') || hasPermission(req, 'view_other_rotas') || hasPermission(req, 'view_team_rotas') || hasPermission(req, 'view_all_rotas') || hasPermission(req, 'manage_team_shifts') || hasPermission(req, 'manage_org_shifts') || hasPermission(req, 'manage_all_shifts'),
      tasks: hasPermission(req, 'view_tasks') || hasPermission(req, 'manage_tasks') || hasPermission(req, 'manage_team_tasks') || hasPermission(req, 'manage_all_tasks'),
      templates: hasPermission(req, 'view_templates') || hasPermission(req, 'manage_templates'),
      teams: hasPermission(req, 'view_teams') || hasPermission(req, 'manage_teams') || hasPermission(req, 'manage_own_teams') || hasPermission(req, 'manage_all_teams'),
      locations: hasPermission(req, 'view_locations') || hasPermission(req, 'manage_locations'),
      organisations: hasPermission(req, 'view_organisations') || hasPermission(req, 'manage_organisations'),
      settings: hasPermission(req, 'view_settings') || hasPermission(req, 'manage_settings'),
    } : null,
    allowSignup:        (overrides.ALLOW_SIGNUP  ?? 'true') !== 'false',
    maintenanceMode:    (overrides.MAINTENANCE_MODE ?? 'false') === 'true',
    cookieSecure:       process.env.COOKIE_SECURE === 'true',
    trustProxy:         process.env.TRUST_PROXY   === 'true',
    passwordPolicy:     getPasswordPolicy(overrides),
    smtpEnabled:        emailSvc.getSmtpConfig().enabled,
    inactivityTimeout:  overrides.INACTIVITY_TIMEOUT_MINUTES != null ? parseInt(overrides.INACTIVITY_TIMEOUT_MINUTES) : 15,
    featureTasks,
    featureDragDrop,
    features: {
      tasks: featureTasks,
      dragDrop: featureDragDrop,
    },
  })
})

// ── Published GitHub releases for update checks ───────────────────────────────
app.get('/api/releases', requireAuth, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1'
    const releases = await fetchPublishedReleases(forceRefresh)
    res.set('Cache-Control', 'no-store')
    res.json({
      repo: GITHUB_REPO,
      fetchedAt: new Date().toISOString(),
      releases,
    })
  } catch (err) {
    logger.error('releases:', err.message)
    res.status(502).json({ error: 'Failed to load published releases' })
  }
})

// ── GET/PATCH /api/features — admin feature flag management ───────────────────
app.get('/api/features', requireAuth, (req, res) => {
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const tasksRow    = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_tasks'").get()
  const dragDropRow = db.prepare("SELECT value FROM app_preferences WHERE key = 'feature_drag_drop'").get()
  res.json({
    feature_tasks:     tasksRow    ? tasksRow.value    === 'true'  : false,
    feature_drag_drop: dragDropRow ? dragDropRow.value !== 'false' : true,
  })
})
app.patch('/api/features', requireAuth, (req, res) => {
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
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
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
  const overrides = loadOverrides()
  if (typeof req.body.allowSignup === 'boolean')  overrides.ALLOW_SIGNUP   = req.body.allowSignup  ? 'true' : 'false'
  if (typeof req.body.maintenanceMode === 'boolean') overrides.MAINTENANCE_MODE = req.body.maintenanceMode ? 'true' : 'false'
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
  if (req.body.inactivityTimeout !== undefined) {
    const v = req.body.inactivityTimeout
    if (v === null || v === 0) {
      overrides.INACTIVITY_TIMEOUT_MINUTES = 0
    } else {
      const n = parseInt(v)
      if (isNaN(n) || n < 1 || n > 10080) return res.status(400).json({ error: 'Timeout must be 1–10080 minutes, or 0 to disable' })
      overrides.INACTIVITY_TIMEOUT_MINUTES = n
    }
  }
  saveOverrides(overrides)
  res.json({
    ok: true,
    allowSignup:       overrides.ALLOW_SIGNUP   !== 'false',
    maintenanceMode:   overrides.MAINTENANCE_MODE === 'true',
    cookieSecure:      process.env.COOKIE_SECURE === 'true',
    trustProxy:        process.env.TRUST_PROXY   === 'true',
    inactivityTimeout: overrides.INACTIVITY_TIMEOUT_MINUTES != null ? parseInt(overrides.INACTIVITY_TIMEOUT_MINUTES) : 15,
  })
})

// ── PATCH /api/config/password-policy — admin: update password policy ─────────
app.patch('/api/config/password-policy', requireAuth, (req, res) => {
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
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
  if (!hasPermission(req, 'view_audit')) return res.status(403).json({ error: 'Admin only' })
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
  if (!hasPermission(req, 'view_audit')) return res.status(403).json({ error: 'Admin only' })
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
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
  try {
    const db = require('./db/connection')
    const audit = require('./audit')
    db.prepare('DELETE FROM audit_log').run()
    audit(req.user.id, 'settings_change', 'audit_log', 'all', 'Audit Log', { detail: 'Cleared all audit log entries' })
    res.json({ ok: true })
  } catch (err) {
    logger.error('[audit clear]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Short-lived cache helper (10 s public, stale-while-revalidate)
function cacheShort(req, res, next) {
  res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=30')
  next()
}

// ── GET /api/stats — instance stats for Build Info panel ──────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
  const db = require('./db/connection')
  const users     = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active = 1').get().c
  const shifts    = db.prepare('SELECT COUNT(*) as c FROM shifts').get().c
  const locations = db.prepare('SELECT COUNT(*) as c FROM locations').get().c
  const templates = db.prepare('SELECT COUNT(*) as c FROM shift_templates').get().c
  res.json({ users, shifts, locations, templates })
})

// ── GET /api/endpoints — admin-only API catalogue ─────────────────────────────
app.get('/api/endpoints', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  try {
    const groups = buildApiCatalog()
    const endpointCount = groups.reduce((total, group) => total + group.endpoints.length, 0)
    res.set('Cache-Control', 'no-store')
    res.json({
      catalogVersion: API_CATALOG_VERSION,
      appVersion: getAppVersion(),
      authentication: 'Secure HTTP-only session cookie',
      endpointCount,
      mobileEndpointCount: MOBILE_API_CONTRACT.length,
      groups,
    })
  } catch (err) {
    logger.error('api catalogue:', err.message)
    res.status(500).json({ error: 'Failed to build API catalogue' })
  }
})

// ── SSE — Real-time broadcast ──────────────────────────────────────────────────
const sseClients = new Map()  // userId → Set<res>

function broadcastShiftEvent(type, shift, actorId) {
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      // Clients only need the event type and actor for cache invalidation. Do
      // not send shift/user/location/notes data to every connected account.
      try { res.write(`data: ${JSON.stringify({ type, actorId })}\n\n`) } catch {}
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
function blockApiDuringMaintenance(req, res, next) {
  if (!isMaintenanceModeEnabled()) return next()
  if (req.user && hasPermission(req, 'manage_settings')) return next()
  return res.status(503).json({
    error: 'Maintenance mode is enabled. Access is currently limited to administrators.',
    maintenanceMode: true,
  })
}

app.use('/api/auth',             require('./routes/auth'))
app.use('/api/users',            requireAuth, blockApiDuringMaintenance, require('./routes/users'))
app.use('/api/shifts',           requireAuth, blockApiDuringMaintenance, require('./routes/shifts'))
app.use('/api/templates',        requireAuth, blockApiDuringMaintenance, require('./routes/templates'))
app.use('/api/template-groups',  requireAuth, blockApiDuringMaintenance, require('./routes/template-groups'))
app.use('/api/locations',        requireAuth, blockApiDuringMaintenance, require('./routes/locations'))
app.use('/api/teams',            requireAuth, blockApiDuringMaintenance, require('./routes/teams'))
app.use('/api/organisations',    requireAuth, blockApiDuringMaintenance, require('./routes/organisations'))
app.use('/api/ical',             require('./routes/ical'))
app.use('/api/backup',           requireAuth, blockApiDuringMaintenance, require('./routes/backup'))
app.use('/api/tasks',            requireAuth, blockApiDuringMaintenance, require('./routes/tasks'))
app.use('/api/task-list-groups', requireAuth, blockApiDuringMaintenance, require('./routes/task-list-groups'))
app.use('/api/holidays',         requireAuth, blockApiDuringMaintenance, require('./routes/holidays'))
app.use('/api/passkeys',         require('./routes/passkeys'))
app.use('/api/roles',            requireAuth, blockApiDuringMaintenance, require('./routes/roles'))

// ── GET /api/config/email — read SMTP config (admin, password masked) ─────────
app.get('/api/config/email', requireAuth, (req, res) => {
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
  const o = loadOverrides()
  res.json({
    publicAppUrl: o.APP_URL || process.env.APP_URL || '',
    smtpHost:     o.SMTP_HOST      || '',
    smtpPort:     o.SMTP_PORT      || '587',
    smtpSecure:   o.SMTP_SECURE    === 'true',
    smtpUser:     o.SMTP_USER      || '',
    smtpPass:     o.SMTP_PASS      ? '••••••••' : '',
    smtpFromName: o.SMTP_FROM_NAME || '',
    smtpFromAddr: o.SMTP_FROM_ADDR || '',
    smtpReplyTo:  o.SMTP_REPLY_TO  || '',
    smtpTestSubject: o.SMTP_TEST_SUBJECT || '',
    smtpTestMessage: o.SMTP_TEST_MESSAGE || '',
    hasPassword:  !!(o.SMTP_PASS),
    enabled:      !!(o.SMTP_HOST && o.SMTP_USER),
  })
})

// ── PATCH /api/config/email — save SMTP config ────────────────────────────────
app.patch('/api/config/email', requireAuth, (req, res) => {
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
  const o = loadOverrides()
  const { publicAppUrl, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, smtpFromName, smtpFromAddr, smtpReplyTo, smtpTestSubject, smtpTestMessage } = req.body
  if (publicAppUrl !== undefined) {
    const cleaned = String(publicAppUrl).trim().replace(/\/+$/, '')
    if (cleaned) {
      let parsed
      try { parsed = new URL(cleaned) } catch { return res.status(400).json({ error: 'Public App URL must be a valid URL.' }) }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Public App URL must start with http:// or https://.' })
      }
    }
    o.APP_URL = cleaned
  }
  if (smtpHost     !== undefined) o.SMTP_HOST      = smtpHost.trim()
  if (smtpPort     !== undefined) o.SMTP_PORT      = String(smtpPort)
  if (smtpSecure   !== undefined) o.SMTP_SECURE    = smtpSecure ? 'true' : 'false'
  if (smtpUser     !== undefined) o.SMTP_USER      = smtpUser.trim()
  if (smtpFromName !== undefined) o.SMTP_FROM_NAME = smtpFromName.trim()
  if (smtpFromAddr !== undefined) o.SMTP_FROM_ADDR = smtpFromAddr.trim()
  if (smtpReplyTo  !== undefined) o.SMTP_REPLY_TO  = smtpReplyTo.trim()
  if (smtpTestSubject !== undefined) o.SMTP_TEST_SUBJECT = String(smtpTestSubject).trim()
  if (smtpTestMessage !== undefined) o.SMTP_TEST_MESSAGE = String(smtpTestMessage).trim()
  // Only overwrite password if a real value (not the masked placeholder) is provided
  if (smtpPass !== undefined && smtpPass !== '••••••••' && smtpPass !== '') o.SMTP_PASS = smtpPass
  if (smtpPass === '') delete o.SMTP_PASS
  saveOverrides(o)
  res.json({ ok: true, enabled: !!(o.SMTP_HOST && o.SMTP_USER) })
})

// ── POST /api/config/email/test — send a test email ───────────────────────────
app.post('/api/config/email/test', requireAuth, async (req, res) => {
  if (!hasPermission(req, 'manage_settings')) return res.status(403).json({ error: 'Admin only' })
  const result = await emailSvc.testConnection()
  if (!result.ok) return res.status(400).json({ error: result.error })
  const db   = require('./db/connection')
  const me   = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id)
  const o    = loadOverrides()
  const to   = String(me.email || '').trim()
  const replyTo = String(req.body?.replyTo || o.SMTP_REPLY_TO || '').trim()
  const subject = String(req.body?.subject || o.SMTP_TEST_SUBJECT || `${process.env.APP_NAME || 'ForgeShift'} SMTP test — it works!`).trim()
  const message = String(req.body?.message || o.SMTP_TEST_MESSAGE || `Hi ${me.name}, your ${(process.env.APP_NAME || 'ForgeShift')} SMTP configuration is working correctly.`).trim()
  if (!to) return res.status(400).json({ error: 'Your admin account must have an email address.' })
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) return res.status(400).json({ error: 'Please enter a valid reply-to email.' })
  if (!subject) return res.status(400).json({ error: 'Test email subject is required.' })
  if (!message) return res.status(400).json({ error: 'Test email message is required.' })
  const sent = await emailSvc.sendMail({
    to,
    replyTo,
    subject,
    html: `<p>${message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`,
    text: message,
  })
  if (!sent.ok) return res.status(400).json({ error: sent.error || 'Failed to send test email.' })
  res.json({ ok: true, sentTo: to, replyTo: replyTo || null })
})

// ── Page routing ──────────────────────────────────────────────────────────────
function sendPage(res, file) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  res.sendFile(path.join(__dirname, '../public', file))
}

function sendMaintenancePage(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  res.status(503).sendFile(path.join(__dirname, '../public', 'maintenance.html'))
}

function requirePageAccess(req, res, next) {
  if (isMaintenanceModeEnabled() && !hasPermission(req, 'manage_settings')) {
    return sendMaintenancePage(res)
  }
  next()
}

app.get('/login.html',           (req, res) => sendPage(res, 'login.html'))
app.get('/signup.html',          (req, res) => sendPage(res, 'signup.html'))
app.get('/forgot-password.html', (req, res) => sendPage(res, 'forgot-password.html'))
app.get('/reset-password.html',  (req, res) => sendPage(res, 'reset-password.html'))

app.get(['/', '/index.html'],    requireAuth, requirePageAccess, (req, res) => sendPage(res, 'index.html'))
app.get('/calendar.html',        requireAuth, requirePageAccess, (req, res) => sendPage(res, 'index.html'))
app.get('/templates.html',       requireAuth, requirePageAccess, (req, res) => sendPage(res, 'templates.html'))
app.get('/profile.html',         requireAuth, requirePageAccess, (req, res) => sendPage(res, 'profile.html'))
app.get('/settings.html',        requireAuth, requirePageAccess, (req, res) => sendPage(res, 'settings.html'))

// Serve static assets after explicit page routes so HTML requests always use
// the handlers above, which apply auth and no-store cache headers.
app.use(express.static(path.join(__dirname, '../public'), { index: false }))

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
