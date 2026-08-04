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
 *   Tables are restored in FK dependency order (parents before children).
 *   Each table uses the safest upsert pattern for its constraint set.
 *   Users are handled with a two-step approach to cover both id and email
 *   uniqueness constraints — the most common source of restore failures.
 *   Foreign keys are disabled for the duration so that re-keying user rows
 *   and re-ordering inserts never triggers cascade deletes mid-transaction.
 */

const router  = require('express').Router()
const db      = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const { hasPermission, ensureBuiltinRoles, BUILTIN } = require('../utils/roles')
const audit   = require('../audit')
const logger  = require('../utils/logger')
const { DEFAULT_COLOR, resolveStoredColor } = require('../utils/color-utils')
const fs      = require('fs')
const path    = require('path')

const AVATARS_DIR = path.join(__dirname, '../../public/uploads/avatars')

const BACKUP_FORMAT_VERSION = 1

router.use(requireAuth)

// ── Admin guard ───────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (!hasPermission(req, 'manage_backups')) return res.status(403).json({ error: 'Admin only' })
  next()
})

// ── GET /api/backup/export ────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  try {
    const allTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    )
    const tables = {
      // Parents first
      users:                 db.prepare('SELECT * FROM users ORDER BY created_at').all(),
      roles:                 allTables.has('roles') ? db.prepare('SELECT * FROM roles ORDER BY name').all() : [],
      organisations:         allTables.has('organisations')
                               ? db.prepare('SELECT * FROM organisations ORDER BY created_at').all() : [],
      locations:             db.prepare('SELECT * FROM locations ORDER BY created_at').all(),
      location_organisations: allTables.has('location_organisations') ? db.prepare('SELECT * FROM location_organisations').all() : [],
      template_groups:       allTables.has('template_groups')
                               ? db.prepare('SELECT * FROM template_groups ORDER BY sort_order, created_at').all() : [],
      // Children of the above
      shift_templates:       db.prepare('SELECT * FROM shift_templates ORDER BY created_at').all(),
      template_days:         db.prepare('SELECT * FROM template_days').all(),
      template_pattern_days: db.prepare('SELECT * FROM template_pattern_days').all(),
      user_template_groups:  allTables.has('user_template_groups')
                               ? db.prepare('SELECT * FROM user_template_groups').all() : [],
      teams:                 db.prepare('SELECT * FROM teams ORDER BY created_at').all(),
      team_members:          db.prepare('SELECT * FROM team_members ORDER BY added_at').all(),
      organisation_members:  allTables.has('organisation_members')
                               ? db.prepare('SELECT * FROM organisation_members ORDER BY added_at').all() : [],
      shifts:                db.prepare('SELECT * FROM shifts ORDER BY date').all(),
      task_lists:            db.prepare('SELECT * FROM task_lists ORDER BY sort_order, created_at').all(),
      task_assignments:      db.prepare('SELECT * FROM task_assignments ORDER BY date').all(),
      ical_tokens:           db.prepare('SELECT * FROM ical_tokens').all(),
      app_preferences:       db.prepare('SELECT * FROM app_preferences').all(),
      audit_log:             db.prepare('SELECT * FROM audit_log ORDER BY created_at LIMIT 10000').all(),
    }

    // ── Avatar files — stored separately from DB rows ─────────────────────────
    // Each entry is { filename, data } where data is a base64-encoded JPEG.
    // Kept out of the users table rows intentionally — the DB only holds a URL
    // path; the actual image bytes live on disk and are round-tripped here.
    const avatars = []
    if (fs.existsSync(AVATARS_DIR)) {
      const files = fs.readdirSync(AVATARS_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      for (const filename of files) {
        try {
          const data = fs.readFileSync(path.join(AVATARS_DIR, filename)).toString('base64')
          avatars.push({ filename, data })
        } catch { /* skip unreadable files */ }
      }
    }

    const manifest = {
      format:      'forgeshift-backup',
      version:     BACKUP_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      exported_by: req.user.id,
      instance:    process.env.APP_URL || 'unknown',
      tables,
      avatars,      // [{ filename, data }] — image bytes as base64, separate from DB rows
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
    logger.error('backup export:', err.message)
    res.status(500).json({ error: 'Export failed' })
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
  const stats = {}

  // Detect which optional columns exist so we never INSERT columns that
  // haven't been added yet via additive migrations on older instances.
  const userCols     = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name))
  const shiftCols    = new Set(db.prepare('PRAGMA table_info(shifts)').all().map(c => c.name))
  const teamCols     = new Set(db.prepare('PRAGMA table_info(teams)').all().map(c => c.name))
  const taskListCols = new Set(db.prepare('PRAGMA table_info(task_lists)').all().map(c => c.name))
  const templateCols = new Set(db.prepare('PRAGMA table_info(shift_templates)').all().map(c => c.name))
  const locCols      = new Set(db.prepare('PRAGMA table_info(locations)').all().map(c => c.name))

  // Check which tables actually exist on this instance (feature flags may
  // mean some tables haven't been created yet).
  const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  )

  // IMPORTANT: In better-sqlite3 the FK pragma must be set at connection level
  // *before* starting a transaction — PRAGMAs inside a transaction are silently
  // ignored by SQLite (FK enforcement is a compile-time session setting, not
  // transactional). Disable now, restore in the finally block below.
  db.pragma('foreign_keys = OFF')

  const restore = db.transaction(() => {
    try {

      // ── 1. Users ───────────────────────────────────────────────────────────
      if (existingTables.has('roles')) {
        const protectedRoleIds = new Set(Object.values(BUILTIN).map(role => role.id))
        const upsertRole = db.prepare(`INSERT INTO roles (id,name,color,permissions,is_builtin,is_system,created_by,created_at,updated_at)
          VALUES (@id,@name,@color,@permissions,@is_builtin,@is_system,@created_by,@created_at,@updated_at)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,permissions=excluded.permissions,
            is_builtin=excluded.is_builtin,is_system=excluded.is_system`)
        for (const r of (tables.roles || [])) upsertRole.run({
          id: r.id,
          name: r.name,
          color: r.color || '#0052cc',
          permissions: typeof r.permissions === 'string' ? r.permissions : JSON.stringify(r.permissions || []),
          is_builtin: protectedRoleIds.has(r.id) ? 1 : 0,
          is_system: r.id === BUILTIN.inactive.id ? 1 : 0,
          created_by: r.created_by || null,
          created_at: r.created_at || new Date().toISOString(),
          updated_at: r.updated_at || r.created_at || new Date().toISOString(),
        })
      }
      // Two-step upsert handles BOTH unique constraints (id PK + email UNIQUE):
      //   • Scenario A — same id exists → UPDATE in place
      //   • Scenario B — same email exists under a different id (e.g. fresh
      //     install recreated the admin) → re-key existing row to backup id,
      //     then the ON CONFLICT(id) upsert updates it cleanly
      //   • Scenario C — neither exists → fresh INSERT
      const updateUserIdByEmail = db.prepare(`
        UPDATE users SET id = @id WHERE email = @email AND id != @id
      `)
      const upsertUser = db.prepare(`
        INSERT INTO users (
          id, name, email, password, initials, color, avatar, role, is_active, created_at
          ${userCols.has('totp_secret')  ? ', totp_secret'  : ''}
          ${userCols.has('totp_enabled') ? ', totp_enabled' : ''}
          ${userCols.has('prefs')        ? ', prefs'        : ''}
          ${userCols.has('role_id')      ? ', role_id'      : ''}
          ${userCols.has('previous_role_id') ? ', previous_role_id' : ''}
        ) VALUES (
          @id, @name, @email, @password, @initials, @color, @avatar, @role, @is_active, @created_at
          ${userCols.has('totp_secret')  ? ', @totp_secret'  : ''}
          ${userCols.has('totp_enabled') ? ', @totp_enabled' : ''}
          ${userCols.has('prefs')        ? ', @prefs'        : ''}
          ${userCols.has('role_id')      ? ', @role_id'      : ''}
          ${userCols.has('previous_role_id') ? ', @previous_role_id' : ''}
        )
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, email=excluded.email, initials=excluded.initials,
          color=excluded.color, avatar=excluded.avatar, role=excluded.role,
          is_active=excluded.is_active
          ${userCols.has('totp_secret')  ? ', totp_secret=excluded.totp_secret'   : ''}
          ${userCols.has('totp_enabled') ? ', totp_enabled=excluded.totp_enabled' : ''}
          ${userCols.has('prefs')        ? ', prefs=excluded.prefs'               : ''}
          ${userCols.has('role_id')      ? ', role_id=COALESCE(excluded.role_id, users.role_id)' : ''}
          ${userCols.has('previous_role_id') ? ', previous_role_id=COALESCE(excluded.previous_role_id, users.previous_role_id)' : ''}
      `)
      let userCount = 0
      for (const u of (tables.users || [])) {
        updateUserIdByEmail.run({ id: u.id, email: u.email })
        upsertUser.run({
          id:           u.id,
          name:         u.name,
          email:        u.email,
          password:     u.password,
          initials:     u.initials,
          color:        resolveStoredColor(u.color, DEFAULT_COLOR),
          avatar:       u.avatar || null,
          role:         u.role || 'member',
          is_active:    u.is_active ?? 1,
          created_at:   u.created_at,
          totp_secret:  u.totp_secret  || null,
          totp_enabled: u.totp_enabled ?? 0,
          prefs:        u.prefs        || '{}',
          role_id:      u.role_id || null,
          previous_role_id: u.previous_role_id || null,
        })
        userCount++
      }
      stats.users = userCount

      // ── 2. Organisations ───────────────────────────────────────────────────
      if (existingTables.has('organisations')) {
        const upsertOrg = db.prepare(`
          INSERT INTO organisations (id, name, color, created_by, created_at)
          VALUES (@id, @name, @color, @created_by, @created_at)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, color=excluded.color
        `)
        let orgCount = 0
        for (const o of (tables.organisations || [])) {
          upsertOrg.run({
            id:         o.id,
            name:       o.name,
            color:      o.color || '#0052cc',
            created_by: o.created_by || null,
            created_at: o.created_at,
          })
          orgCount++
        }
        stats.organisations = orgCount
      }

      // ── 3. Locations ───────────────────────────────────────────────────────
      // Two-step: re-key any existing row that shares the same name but has a
      // different id (e.g. a default location auto-created on fresh install),
      // then upsert on id so subsequent restores stay idempotent.
      const updateLocIdByName = db.prepare(`
        UPDATE locations SET id = @id WHERE LOWER(TRIM(name)) = LOWER(TRIM(@name)) AND id != @id
      `)
      const upsertLoc = db.prepare(`
        INSERT INTO locations (id, name, address, color, created_by, created_at
          ${locCols.has('org_id') ? ', org_id' : ''}
        )
        VALUES (@id, @name, @address, @color, @created_by, @created_at
          ${locCols.has('org_id') ? ', @org_id' : ''}
        )
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, address=excluded.address, color=excluded.color
          ${locCols.has('org_id') ? ', org_id=excluded.org_id' : ''}
      `)
      let locCount = 0
      for (const l of (tables.locations || [])) {
        updateLocIdByName.run({ id: l.id, name: l.name })
        upsertLoc.run({
          id:         l.id,
          name:       l.name,
          address:    l.address || null,
          color:      resolveStoredColor(l.color, DEFAULT_COLOR),
          created_by: l.created_by || null,
          created_at: l.created_at,
          org_id:     l.org_id || null,
        })
        locCount++
      }
      stats.locations = locCount

      if (existingTables.has('location_organisations')) {
        const upsertLocationOrg = db.prepare(`INSERT OR IGNORE INTO location_organisations (location_id, org_id, added_at)
          VALUES (@location_id, @org_id, @added_at)`)
        let loCount = 0
        for (const lo of (tables.location_organisations || [])) {
          upsertLocationOrg.run({ location_id: lo.location_id, org_id: lo.org_id, added_at: lo.added_at || new Date().toISOString() })
          loCount++
        }
        // Backups from before multi-organisation locations only contain org_id.
        if (!(tables.location_organisations || []).length) {
          for (const location of (tables.locations || [])) {
            if (!location.org_id) continue
            upsertLocationOrg.run({ location_id: location.id, org_id: location.org_id, added_at: location.created_at || new Date().toISOString() })
            loCount++
          }
        }
        stats.locationOrganisations = loCount
      }

      // ── 4. Template Groups ─────────────────────────────────────────────────
      // Must come before shift_templates which references group_id.
      if (existingTables.has('template_groups')) {
        const upsertTmplGroup = db.prepare(`
          INSERT INTO template_groups (id, name, sort_order, created_by, created_at)
          VALUES (@id, @name, @sort_order, @created_by, @created_at)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, sort_order=excluded.sort_order
        `)
        let tgCount = 0
        for (const g of (tables.template_groups || [])) {
          upsertTmplGroup.run({
            id:         g.id,
            name:       g.name,
            sort_order: g.sort_order ?? 0,
            created_by: g.created_by || null,
            created_at: g.created_at,
          })
          tgCount++
        }
        stats.templateGroups = tgCount
      }

      // ── 5. Shift Templates ─────────────────────────────────────────────────
      // Two-step: re-key existing rows sharing the same name under a different
      // id before upserting, matching the same pattern used for locations.
      const updateTmplIdByName = db.prepare(`
        UPDATE shift_templates SET id = @id WHERE LOWER(TRIM(name)) = LOWER(TRIM(@name)) AND id != @id
      `)
      const tmplHasOrgId = templateCols.has('org_id')
      const tmplHasType = templateCols.has('template_type')
      const tmplHasCycleLength = templateCols.has('cycle_length')
      const upsertTmpl = db.prepare(`
        INSERT INTO shift_templates (id, name, description, created_by, created_at
          ${tmplHasOrgId ? ', org_id' : ''}
          ${tmplHasType ? ', template_type' : ''}
          ${tmplHasCycleLength ? ', cycle_length' : ''}
        )
        VALUES (@id, @name, @description, @created_by, @created_at
          ${tmplHasOrgId ? ', @org_id' : ''}
          ${tmplHasType ? ', @template_type' : ''}
          ${tmplHasCycleLength ? ', @cycle_length' : ''}
        )
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, description=excluded.description
          ${tmplHasOrgId ? ', org_id=excluded.org_id' : ''}
          ${tmplHasType ? ', template_type=excluded.template_type' : ''}
          ${tmplHasCycleLength ? ', cycle_length=excluded.cycle_length' : ''}
      `)
      let tmplCount = 0
      for (const t of (tables.shift_templates || [])) {
        updateTmplIdByName.run({ id: t.id, name: t.name })
        upsertTmpl.run({
          id:            t.id,
          name:          t.name,
          description:   t.description || null,
          created_by:    t.created_by || null,
          created_at:    t.created_at,
          // org_id is the new field; fall back to null (old backups won't have it)
          org_id:        t.org_id || null,
          template_type: t.template_type || 'weekly',
          cycle_length:  t.cycle_length ?? 7,
        })
        tmplCount++
      }
      stats.templates = tmplCount

      // ── 6. Template Days ───────────────────────────────────────────────────
      // UNIQUE(template_id, day_of_week) in addition to PK — handle both.
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
      let tdCount = 0
      for (const td of (tables.template_days || [])) {
        upsertTmplDay.run({
          id:          td.id,
          template_id: td.template_id,
          day_of_week: td.day_of_week,
          location_id: td.location_id || null,
          start_time:  td.start_time || null,
          end_time:    td.end_time || null,
          notes:       td.notes || null,
          note_color:  resolveStoredColor(td.note_color, DEFAULT_COLOR),
          is_off:      td.is_off ?? 0,
        })
        tdCount++
      }
      stats.templateDays = tdCount

      // ── 7. Pattern Template Days ──────────────────────────────────────────
      if (existingTables.has('template_pattern_days')) {
        const upsertPatternDay = db.prepare(`
          INSERT INTO template_pattern_days (
            id, template_id, day_index, location_id, start_time, end_time, notes, note_color, is_off
          )
          VALUES (
            @id, @template_id, @day_index, @location_id, @start_time, @end_time, @notes, @note_color, @is_off
          )
          ON CONFLICT(id) DO UPDATE SET
            day_index=excluded.day_index, location_id=excluded.location_id,
            start_time=excluded.start_time, end_time=excluded.end_time,
            notes=excluded.notes, note_color=excluded.note_color, is_off=excluded.is_off
          ON CONFLICT(template_id, day_index) DO UPDATE SET
            location_id=excluded.location_id,
            start_time=excluded.start_time, end_time=excluded.end_time,
            notes=excluded.notes, note_color=excluded.note_color, is_off=excluded.is_off
        `)
        let patternDayCount = 0
        for (const td of (tables.template_pattern_days || [])) {
          upsertPatternDay.run({
            id: td.id,
            template_id: td.template_id,
            day_index: td.day_index,
            location_id: td.location_id || null,
            start_time: td.start_time || null,
            end_time: td.end_time || null,
            notes: td.notes || null,
            note_color: resolveStoredColor(td.note_color, DEFAULT_COLOR),
            is_off: td.is_off ?? 0,
          })
          patternDayCount++
        }
        stats.templatePatternDays = patternDayCount
      }

      // ── 8. User → Template Group assignments ───────────────────────────────
      if (existingTables.has('user_template_groups')) {
        const upsertUTG = db.prepare(`
          INSERT OR IGNORE INTO user_template_groups (user_id, group_id, added_at)
          VALUES (@user_id, @group_id, @added_at)
        `)
        let utgCount = 0
        for (const m of (tables.user_template_groups || [])) {
          upsertUTG.run({
            user_id:  m.user_id,
            group_id: m.group_id,
            added_at: m.added_at || new Date().toISOString(),
          })
          utgCount++
        }
        stats.userTemplateGroups = utgCount
      }

      // ── 9. Teams ───────────────────────────────────────────────────────────
      if (existingTables.has('teams')) {
        const upsertTeam = db.prepare(`
          INSERT INTO teams (id, name, color, created_by, created_at
            ${teamCols.has('owned_by') ? ', owned_by' : ''}
            ${teamCols.has('org_id')   ? ', org_id'   : ''}
          )
          VALUES (@id, @name, @color, @created_by, @created_at
            ${teamCols.has('owned_by') ? ', @owned_by' : ''}
            ${teamCols.has('org_id')   ? ', @org_id'   : ''}
          )
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, color=excluded.color
            ${teamCols.has('owned_by') ? ', owned_by=excluded.owned_by' : ''}
            ${teamCols.has('org_id')   ? ', org_id=excluded.org_id'     : ''}
        `)
        let teamCount = 0
        for (const t of (tables.teams || [])) {
          upsertTeam.run({
            id:         t.id,
            name:       t.name,
            color:      resolveStoredColor(t.color, DEFAULT_COLOR),
            created_by: t.created_by || null,
            created_at: t.created_at,
            owned_by:   t.owned_by || null,
            org_id:     t.org_id || null,
          })
          teamCount++
        }
        stats.teams = teamCount
      }

      // ── 10. Team Members ───────────────────────────────────────────────────
      if (existingTables.has('team_members')) {
        const upsertTeamMember = db.prepare(`
          INSERT OR IGNORE INTO team_members (team_id, user_id, added_at)
          VALUES (@team_id, @user_id, @added_at)
        `)
        let tmCount = 0
        for (const m of (tables.team_members || [])) {
          upsertTeamMember.run({
            team_id:  m.team_id,
            user_id:  m.user_id,
            added_at: m.added_at || new Date().toISOString(),
          })
          tmCount++
        }
        stats.teamMembers = tmCount
      }

      // ── 9. Organisation Members ────────────────────────────────────────────
      if (existingTables.has('organisation_members')) {
        const upsertOrgMember = db.prepare(`
          INSERT OR IGNORE INTO organisation_members (org_id, user_id, added_at)
          VALUES (@org_id, @user_id, @added_at)
        `)
        let omCount = 0
        for (const m of (tables.organisation_members || [])) {
          upsertOrgMember.run({
            org_id:   m.org_id,
            user_id:  m.user_id,
            added_at: m.added_at || new Date().toISOString(),
          })
          omCount++
        }
        stats.organisationMembers = omCount
      }

      // ── 12. Shifts ─────────────────────────────────────────────────────────
      // UNIQUE(user_id, date) in addition to PK — handle both.
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
      let shiftCount = 0
      for (const s of (tables.shifts || [])) {
        upsertShift.run({
          id:          s.id,
          user_id:     s.user_id,
          date:        s.date,
          location_id: s.location_id || null,
          start_time:  s.start_time || null,
          end_time:    s.end_time || null,
          notes:       s.notes || null,
          note_color:  resolveStoredColor(s.note_color, DEFAULT_COLOR),
          is_off:      s.is_off ?? 0,
          is_oncall:   s.is_oncall ?? 0,
          template_id: s.template_id || null,
          created_by:  s.created_by || null,
          created_at:  s.created_at,
          updated_at:  s.updated_at || s.created_at,
        })
        shiftCount++
      }
      stats.shifts = shiftCount

      // ── 13. Task Lists ─────────────────────────────────────────────────────
      // Must come before task_assignments which references task_list_id.
      if (existingTables.has('task_lists')) {
        const upsertTaskList = db.prepare(`
          INSERT INTO task_lists (id, name, color, sort_order, created_by, created_at
            ${taskListCols.has('description') ? ', description' : ''}
            ${taskListCols.has('location_id') ? ', location_id' : ''}
            ${taskListCols.has('org_id')      ? ', org_id'      : ''}
          )
          VALUES (@id, @name, @color, @sort_order, @created_by, @created_at
            ${taskListCols.has('description') ? ', @description' : ''}
            ${taskListCols.has('location_id') ? ', @location_id' : ''}
            ${taskListCols.has('org_id')      ? ', @org_id'      : ''}
          )
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, color=excluded.color, sort_order=excluded.sort_order
            ${taskListCols.has('description') ? ', description=excluded.description' : ''}
            ${taskListCols.has('location_id') ? ', location_id=excluded.location_id' : ''}
            ${taskListCols.has('org_id')      ? ', org_id=excluded.org_id'           : ''}
        `)
        let tlCount = 0
        for (const tl of (tables.task_lists || [])) {
          upsertTaskList.run({
            id:          tl.id,
            name:        tl.name,
            color:       resolveStoredColor(tl.color, DEFAULT_COLOR),
            sort_order:  tl.sort_order ?? 0,
            created_by:  tl.created_by || null,
            created_at:  tl.created_at,
            description: tl.description || null,
            location_id: tl.location_id || null,
            org_id:      tl.org_id || null,
          })
          tlCount++
        }
        stats.taskLists = tlCount
      }

      // ── 14. Task Assignments ───────────────────────────────────────────────
      // UNIQUE(user_id, task_list_id, date) in addition to PK — handle both.
      if (existingTables.has('task_assignments')) {
        const upsertTaskAssign = db.prepare(`
          INSERT INTO task_assignments (id, user_id, task_list_id, date, created_by, created_at)
          VALUES (@id, @user_id, @task_list_id, @date, @created_by, @created_at)
          ON CONFLICT(id) DO UPDATE SET
            date=excluded.date, task_list_id=excluded.task_list_id
          ON CONFLICT(user_id, task_list_id, date) DO UPDATE SET
            created_by=excluded.created_by
        `)
        let taCount = 0
        for (const ta of (tables.task_assignments || [])) {
          upsertTaskAssign.run({
            id:           ta.id,
            user_id:      ta.user_id,
            task_list_id: ta.task_list_id,
            date:         ta.date,
            created_by:   ta.created_by || null,
            created_at:   ta.created_at,
          })
          taCount++
        }
        stats.taskAssignments = taCount
      }

      // ── 15. iCal Tokens ────────────────────────────────────────────────────
      // Two UNIQUE constraints (user_id + token) — delete first, then insert.
      const deleteIcal = db.prepare('DELETE FROM ical_tokens WHERE user_id = @user_id')
      const insertIcal = db.prepare(`
        INSERT OR IGNORE INTO ical_tokens (id, user_id, token, created_at)
        VALUES (@id, @user_id, @token, @created_at)
      `)
      for (const t of (tables.ical_tokens || [])) {
        deleteIcal.run({ user_id: t.user_id })
        insertIcal.run({ id: t.id, user_id: t.user_id, token: t.token, created_at: t.created_at })
      }

      // ── 16. App Preferences ────────────────────────────────────────────────
      const upsertPref = db.prepare(`
        INSERT INTO app_preferences (key, value, updated_at)
        VALUES (@key, @value, @updated_at)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `)
      let prefCount = 0
      for (const p of (tables.app_preferences || [])) {
        upsertPref.run({ key: p.key, value: p.value, updated_at: p.updated_at || new Date().toISOString() })
        prefCount++
      }
      stats.preferences = prefCount

    } catch (err) {
      throw err
    }
  })

  try {
    restore()
    // Reassert immutable built-ins and park/restore legacy inactive accounts
    // after importing both role and user rows.
    ensureBuiltinRoles()

    // ── Restore avatar files ─────────────────────────────────────────────────
    // Written to disk after the DB transaction so a DB failure doesn't leave
    // orphaned files. Filenames are validated to prevent path traversal.
    const avatarStats = { restored: 0, skipped: 0 }
    if (Array.isArray(manifest.avatars) && manifest.avatars.length > 0) {
      if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true })
      for (const entry of manifest.avatars) {
        // Strict filename validation — only allow <id>.jpg / <id>.jpeg / <id>.png etc.
        if (!entry.filename || !/^[\w-]+\.(jpg|jpeg|png|gif|webp)$/i.test(entry.filename)) {
          avatarStats.skipped++
          continue
        }
        try {
          const dest = path.join(AVATARS_DIR, entry.filename)
          fs.writeFileSync(dest, Buffer.from(entry.data, 'base64'))
          avatarStats.restored++
        } catch {
          avatarStats.skipped++
        }
      }
    }
    stats.avatars = avatarStats

    audit(req.user.id, 'backup.restore', 'system', null, manifest.exported_at, { stats })
    res.json({ ok: true, exported_at: manifest.exported_at, instance: manifest.instance, stats })
  } catch (err) {
    logger.error('backup restore error:', err.message)
    res.status(500).json({ error: 'Restore failed' })
  } finally {
    // Always re-enable FK enforcement after the restore attempt — must be done
    // outside the transaction so it actually takes effect at connection level.
    db.pragma('foreign_keys = ON')
  }
})

module.exports = router
