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
 * Restore strategy:
 *   Each table uses the safest upsert pattern for its constraint set.
 *   Users are handled with a two-step approach to cover both id and email
 *   uniqueness constraints — the most common source of restore failures.
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
    const teams        = db.prepare('SELECT * FROM teams ORDER BY created_at').all()
    const teamMembers  = db.prepare('SELECT * FROM team_members ORDER BY added_at').all()

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
        teams,
        team_members:     teamMembers,
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
  const stats = { users: 0, locations: 0, templates: 0, templateDays: 0, shifts: 0, preferences: 0, teams: 0, teamMembers: 0 }

  // Detect which optional columns exist so we don't INSERT columns that
  // haven't been added yet on older instances (additive migration safety).
  const userCols  = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name))
  const shiftCols = new Set(db.prepare('PRAGMA table_info(shifts)').all().map(c => c.name))

  // Run entire restore inside a single SQLite transaction for atomicity
  const restore = db.transaction(() => {

    // ── 1. Users ─────────────────────────────────────────────────────────────
    // Two-step upsert to handle BOTH unique constraints on users:
    //   - PRIMARY KEY (id)
    //   - UNIQUE (email)
    //
    // Scenario A: same id exists → UPDATE in place (preserves passwords etc.)
    // Scenario B: same email exists under a different id (e.g. fresh install
    //   recreated the admin) → re-key the existing row to the backup id first,
    //   then the main upsert on id will cleanly UPDATE it.
    // Scenario C: neither exists → INSERT fresh.
    const updateUserIdByEmail = db.prepare(`
      UPDATE users SET id = @id WHERE email = @email AND id != @id
    `)
    const upsertUser = db.prepare(`
      INSERT INTO users (
        id, name, email, password, initials, color, avatar, role, is_active, created_at
        ${userCols.has('totp_secret')  ? ', totp_secret'  : ''}
        ${userCols.has('totp_enabled') ? ', totp_enabled' : ''}
        ${userCols.has('prefs')        ? ', prefs'        : ''}
      ) VALUES (
        @id, @name, @email, @password, @initials, @color, @avatar, @role, @is_active, @created_at
        ${userCols.has('totp_secret')  ? ', @totp_secret'  : ''}
        ${userCols.has('totp_enabled') ? ', @totp_enabled' : ''}
        ${userCols.has('prefs')        ? ', @prefs'        : ''}
      )
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, email=excluded.email, initials=excluded.initials,
        color=excluded.color, avatar=excluded.avatar, role=excluded.role,
        is_active=excluded.is_active
        ${userCols.has('totp_secret')  ? ', totp_secret=excluded.totp_secret'   : ''}
        ${userCols.has('totp_enabled') ? ', totp_enabled=excluded.totp_enabled' : ''}
        ${userCols.has('prefs')        ? ', prefs=excluded.prefs'               : ''}
    `)
    for (const u of (tables.users || [])) {
      // Step 1: if this email already exists under a different id, re-key it
      updateUserIdByEmail.run({ id: u.id, email: u.email })
      // Step 2: upsert on id (now guaranteed to be the only row with this email)
      upsertUser.run({
        id:           u.id,
        name:         u.name,
        email:        u.email,
        password:     u.password,
        initials:     u.initials,
        color:        u.color || '#0052cc',
        avatar:       u.avatar || null,
        role:         u.role || 'member',
        is_active:    u.is_active ?? 1,
        created_at:   u.created_at,
        totp_secret:  u.totp_secret  || null,
        totp_enabled: u.totp_enabled ?? 0,
        prefs:        u.prefs        || '{}',
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
    // Has UNIQUE(template_id, day_of_week) in addition to the PK — handle both.
    const upsertTmplDay = db.prepare(`
      INSERT INTO template_days (id, template_id, day_of_week, location_id, start_time, end_time, notes, note_color, is_off)
      VALUES (@id, @template_id, @day_of_week, @location_id, @start_time, @end_time, @notes, @note_color, @is_off)
      ON CONFLICT(id) DO UPDATE SET
        day_of_week=excluded.day_of_week, location_id=excluded.location_id,
        start_time=excluded.start_time, end_time=excluded.end_time,
        notes=excluded.notes, note_color=excluded.note_color, is_off=excluded.is_off
      ON CONFLICT(template_id, day_of_week) DO UPDATE SET
        location_id=excluded.location_id,
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
    // Has UNIQUE(user_id, date) in addition to the PK — handle both.
    const upsertShift = db.prepare(`
      INSERT INTO shifts (
        id, user_id, date, location_id, start_time, end_time,
        notes, note_color, is_off, template_id, created_by, created_at, updated_at
        ${shiftCols.has('is_oncall') ? ', is_oncall' : ''}
      ) VALUES (
        @id, @user_id, @date, @location_id, @start_time, @end_time,
        @notes, @note_color, @is_off, @template_id, @created_by, @created_at, @updated_at
        ${shiftCols.has('is_oncall') ? ', @is_oncall' : ''}
      )
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, location_id=excluded.location_id,
        start_time=excluded.start_time, end_time=excluded.end_time,
        notes=excluded.notes, note_color=excluded.note_color,
        is_off=excluded.is_off, updated_at=excluded.updated_at
        ${shiftCols.has('is_oncall') ? ', is_oncall=excluded.is_oncall' : ''}
      ON CONFLICT(user_id, date) DO UPDATE SET
        location_id=excluded.location_id,
        start_time=excluded.start_time, end_time=excluded.end_time,
        notes=excluded.notes, note_color=excluded.note_color,
        is_off=excluded.is_off, updated_at=excluded.updated_at
        ${shiftCols.has('is_oncall') ? ', is_oncall=excluded.is_oncall' : ''}
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
        is_oncall:   s.is_oncall ?? 0,
        template_id: s.template_id || null,
        created_by:  s.created_by || null,
        created_at:  s.created_at,
        updated_at:  s.updated_at || s.created_at,
      })
      stats.shifts++
    }

    // ── 6. iCal Tokens ────────────────────────────────────────────────────────
    // Has two UNIQUE constraints: user_id and token.
    // Delete the existing token for this user first so neither constraint fires.
    const deleteIcal = db.prepare('DELETE FROM ical_tokens WHERE user_id = @user_id')
    const insertIcal = db.prepare(`
      INSERT OR IGNORE INTO ical_tokens (id, user_id, token, created_at)
      VALUES (@id, @user_id, @token, @created_at)
    `)
    for (const t of (tables.ical_tokens || [])) {
      deleteIcal.run({ user_id: t.user_id })
      insertIcal.run({ id: t.id, user_id: t.user_id, token: t.token, created_at: t.created_at })
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

    // ── 8. Teams ──────────────────────────────────────────────────────────────
    const upsertTeam = db.prepare(`
      INSERT INTO teams (id, name, color, created_by, created_at)
      VALUES (@id, @name, @color, @created_by, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, color=excluded.color
    `)
    for (const t of (tables.teams || [])) {
      upsertTeam.run({
        id:         t.id,
        name:       t.name,
        color:      t.color || '#0052cc',
        created_by: t.created_by || null,
        created_at: t.created_at,
      })
      stats.teams++
    }

    // ── 9. Team Members ───────────────────────────────────────────────────────
    const upsertTeamMember = db.prepare(`
      INSERT OR IGNORE INTO team_members (team_id, user_id, added_at)
      VALUES (@team_id, @user_id, @added_at)
    `)
    for (const m of (tables.team_members || [])) {
      upsertTeamMember.run({
        team_id:  m.team_id,
        user_id:  m.user_id,
        added_at: m.added_at || new Date().toISOString(),
      })
      stats.teamMembers++
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
