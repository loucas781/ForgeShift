'use strict'
/**
 * backup.js — Export and restore ForgeShift data.
 *
 * Export  GET  /api/backup/export
 *   - Dumps all DB tables to a JSON manifest
 *   - Returns a .fsbackup file (JSON wrapped in a versioned envelope)
 *   - Admin only
 *
 * Restore  POST  /api/backup/restore   (Content-Type: text/plain, raw JSON body)
 *   - Accepts a .fsbackup file
 *   - Upserts all rows in dependency order — never wipes existing data
 *   - Admin only
 *
 * Restore strategy: INSERT OR REPLACE / INSERT OR IGNORE
 *   Existing rows are overwritten with backup values; rows not in the backup
 *   are left untouched. Safe to run against a live instance.
 */

const router  = require('express').Router()
const db      = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const audit   = require('../audit')

const BACKUP_FORMAT_VERSION = 1

router.use(requireAuth)

// ── Admin guard ───────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
})

// ── GET /api/backup/export ────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  try {
    const users        = db.prepare('SELECT * FROM users ORDER BY created_at').all()
    const locations    = db.prepare('SELECT * FROM locations ORDER BY created_at').all()
    const templates    = db.prepare('SELECT * FROM shift_templates ORDER BY created_at').all()
    const templateDays = db.prepare('SELECT * FROM template_days').all()
    const shifts       = db.prepare('SELECT * FROM shifts ORDER BY date').all()
    const icalTokens   = db.prepare('SELECT * FROM ical_tokens').all()
    const preferences  = db.prepare('SELECT * FROM app_preferences').all()
    const auditLog     = db.prepare('SELECT * FROM audit_log ORDER BY created_at LIMIT 10000').all()

    const manifest = {
      format:      'forgeshift-backup',
      version:     BACKUP_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      exported_by: req.user.id,
      instance:    process.env.APP_URL || 'unknown',
      tables: {
        users,
        locations,
        shift_templates:  templates,
        template_days:    templateDays,
        shifts,
        ical_tokens:      icalTokens,
        app_preferences:  preferences,
        audit_log:        auditLog,
      },
    }

    const json      = JSON.stringify(manifest)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename  = `forgeshift-backup-${timestamp}.fsbackup`

    audit(req.user.id, 'backup.export', 'system', null, filename)

    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', Buffer.byteLength(json))
    res.send(json)
  } catch (err) {
    console.error('backup export:', err.message)
    res.status(500).json({ error: 'Export failed: ' + err.message })
  }
})

// ── POST /api/backup/restore ──────────────────────────────────────────────────
// Body is raw text — wired up with express.text() in index.js
router.post('/restore', (req, res) => {
  let manifest
  try {
    const raw = req.body
    if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'No backup data received.' })
    manifest = JSON.parse(raw)
  } catch {
    return res.status(400).json({ error: 'Invalid backup file — could not parse JSON.' })
  }

  if (manifest.format !== 'forgeshift-backup') {
    return res.status(400).json({ error: 'Not a valid ForgeShift backup file.' })
  }
  if (manifest.version > BACKUP_FORMAT_VERSION) {
    return res.status(400).json({ error: `Backup was created with a newer version of ForgeShift (format v${manifest.version}). Please upgrade first.` })
  }

  const { tables = {} } = manifest
  const stats = { users: 0, locations: 0, templates: 0, templateDays: 0, shifts: 0, preferences: 0 }

  // Run entire restore inside a single SQLite transaction for atomicity
  const restore = db.transaction(() => {

    // ── 1. Users ─────────────────────────────────────────────────────────────
    const upsertUser = db.prepare(`
      INSERT INTO users (id, name, email, password, initials, color, avatar, role, is_active, created_at)
      VALUES (@id, @name, @email, @password, @initials, @color, @avatar, @role, @is_active, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, email=excluded.email, initials=excluded.initials,
        color=excluded.color, avatar=excluded.avatar, role=excluded.role,
        is_active=excluded.is_active
    `)
    for (const u of (tables.users || [])) {
      upsertUser.run({
        id:         u.id,
        name:       u.name,
        email:      u.email,
        password:   u.password,
        initials:   u.initials,
        color:      u.color || '#0052cc',
        avatar:     u.avatar || null,
        role:       u.role || 'member',
        is_active:  u.is_active ?? 1,
        created_at: u.created_at,
      })
      stats.users++
    }

    // ── 2. Locations ──────────────────────────────────────────────────────────
    const upsertLoc = db.prepare(`
      INSERT INTO locations (id, name, address, color, created_by, created_at)
      VALUES (@id, @name, @address, @color, @created_by, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, address=excluded.address, color=excluded.color
    `)
    for (const l of (tables.locations || [])) {
      upsertLoc.run({
        id:         l.id,
        name:       l.name,
        address:    l.address || null,
        color:      l.color || '#0052cc',
        created_by: l.created_by || null,
        created_at: l.created_at,
      })
      stats.locations++
    }

    // ── 3. Shift Templates ────────────────────────────────────────────────────
    const upsertTmpl = db.prepare(`
      INSERT INTO shift_templates (id, name, description, created_by, created_at)
      VALUES (@id, @name, @description, @created_by, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description
    `)
    for (const t of (tables.shift_templates || [])) {
      upsertTmpl.run({
        id:          t.id,
        name:        t.name,
        description: t.description || null,
        created_by:  t.created_by || null,
        created_at:  t.created_at,
      })
      stats.templates++
    }

    // ── 4. Template Days ──────────────────────────────────────────────────────
    const upsertTmplDay = db.prepare(`
      INSERT INTO template_days (id, template_id, day_of_week, location_id, start_time, end_time, notes, note_color, is_off)
      VALUES (@id, @template_id, @day_of_week, @location_id, @start_time, @end_time, @notes, @note_color, @is_off)
      ON CONFLICT(id) DO UPDATE SET
        day_of_week=excluded.day_of_week, location_id=excluded.location_id,
        start_time=excluded.start_time, end_time=excluded.end_time,
        notes=excluded.notes, note_color=excluded.note_color, is_off=excluded.is_off
    `)
    for (const td of (tables.template_days || [])) {
      upsertTmplDay.run({
        id:          td.id,
        template_id: td.template_id,
        day_of_week: td.day_of_week,
        location_id: td.location_id || null,
        start_time:  td.start_time || null,
        end_time:    td.end_time || null,
        notes:       td.notes || null,
        note_color:  td.note_color || '#0052cc',
        is_off:      td.is_off ?? 0,
      })
      stats.templateDays++
    }

    // ── 5. Shifts ─────────────────────────────────────────────────────────────
    const upsertShift = db.prepare(`
      INSERT INTO shifts (id, user_id, date, location_id, start_time, end_time, notes, note_color, is_off, template_id, created_by, created_at, updated_at)
      VALUES (@id, @user_id, @date, @location_id, @start_time, @end_time, @notes, @note_color, @is_off, @template_id, @created_by, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, location_id=excluded.location_id,
        start_time=excluded.start_time, end_time=excluded.end_time,
        notes=excluded.notes, note_color=excluded.note_color,
        is_off=excluded.is_off, updated_at=excluded.updated_at
    `)
    for (const s of (tables.shifts || [])) {
      upsertShift.run({
        id:          s.id,
        user_id:     s.user_id,
        date:        s.date,
        location_id: s.location_id || null,
        start_time:  s.start_time || null,
        end_time:    s.end_time || null,
        notes:       s.notes || null,
        note_color:  s.note_color || '#0052cc',
        is_off:      s.is_off ?? 0,
        template_id: s.template_id || null,
        created_by:  s.created_by || null,
        created_at:  s.created_at,
        updated_at:  s.updated_at || s.created_at,
      })
      stats.shifts++
    }

    // ── 6. iCal Tokens ────────────────────────────────────────────────────────
    const upsertIcal = db.prepare(`
      INSERT INTO ical_tokens (id, user_id, token, created_at)
      VALUES (@id, @user_id, @token, @created_at)
      ON CONFLICT(user_id) DO NOTHING
    `)
    for (const t of (tables.ical_tokens || [])) {
      upsertIcal.run({ id: t.id, user_id: t.user_id, token: t.token, created_at: t.created_at })
    }

    // ── 7. App Preferences ────────────────────────────────────────────────────
    const upsertPref = db.prepare(`
      INSERT INTO app_preferences (key, value, updated_at)
      VALUES (@key, @value, @updated_at)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `)
    for (const p of (tables.app_preferences || [])) {
      upsertPref.run({ key: p.key, value: p.value, updated_at: p.updated_at || new Date().toISOString() })
      stats.preferences++
    }
  })

  try {
    restore()
    audit(req.user.id, 'backup.restore', 'system', null, manifest.exported_at, { stats })
    res.json({ ok: true, exported_at: manifest.exported_at, instance: manifest.instance, stats })
  } catch (err) {
    console.error('backup restore error:', err.message)
    res.status(500).json({ error: 'Restore failed: ' + err.message })
  }
})

module.exports = router
