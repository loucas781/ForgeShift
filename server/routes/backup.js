'use strict'
/**
 * backup.js — Export and restore ForgeShift data.
 *
 * Export  GET  /api/backup/export
 *   - Builds a .fsbackup.zip containing:
 *       manifest.json  — all DB tables (no binary data)
 *       avatars/       — raw avatar image files
 *   - Uses system `zip` (guaranteed present on Ubuntu/Proxmox LXC)
 *   - Admin only
 *
 * Restore  POST  /api/backup/restore   (multipart/form-data, field: "backup")
 *   - Accepts the .fsbackup.zip file produced by export
 *   - Extracts manifest.json and avatars/ from the zip
 *   - Upserts all rows in FK dependency order — never wipes existing data
 *   - Copies avatar files into public/uploads/avatars/
 *   - Admin only
 *
 * Restore strategy:
 *   Tables are restored in FK dependency order (parents before children).
 *   Each table uses the safest upsert pattern for its constraint set.
 *   Users are handled with a two-step approach to cover both id and email
 *   uniqueness constraints. Locations, template_groups, and shift_templates
 *   use name-based re-keying to prevent cross-instance duplicates.
 *   Foreign keys are disabled for the duration so that re-keying user rows
 *   and re-ordering inserts never triggers cascade deletes mid-transaction.
 */

const router  = require('express').Router()
const db      = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const audit   = require('../audit')
const fs      = require('fs')
const path    = require('path')
const os      = require('os')
const { spawnSync } = require('child_process')
const multer  = require('multer')

const BACKUP_FORMAT_VERSION = 1
const AVATARS_DIR = path.join(__dirname, '../../public/uploads/avatars')

// Multer: store uploaded backup zip in a temp file
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename:    (_req, _file, cb) => cb(null, `fs-restore-${Date.now()}.zip`),
})
const upload = multer({ storage: uploadStorage, limits: { fileSize: 512 * 1024 * 1024 } })

router.use(requireAuth)

// ── Admin guard ───────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
})

// ── GET /api/backup/export ────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  // Use a temp directory so we can build the zip structure before streaming
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'fsbackup-'))
  const zipPath = path.join(os.tmpdir(), `fsbackup-${Date.now()}.zip`)

  try {
    const tables = {
      // Parents first
      users:                db.prepare('SELECT * FROM users ORDER BY created_at').all(),
      locations:            db.prepare('SELECT * FROM locations ORDER BY created_at').all(),
      template_groups:      db.prepare('SELECT * FROM template_groups ORDER BY sort_order, created_at').all(),
      // Children of the above
      shift_templates:      db.prepare('SELECT * FROM shift_templates ORDER BY created_at').all(),
      template_days:        db.prepare('SELECT * FROM template_days').all(),
      user_template_groups: db.prepare('SELECT * FROM user_template_groups').all(),
      teams:                db.prepare('SELECT * FROM teams ORDER BY created_at').all(),
      team_members:         db.prepare('SELECT * FROM team_members ORDER BY added_at').all(),
      shifts:               db.prepare('SELECT * FROM shifts ORDER BY date').all(),
      task_lists:           db.prepare('SELECT * FROM task_lists ORDER BY sort_order, created_at').all(),
      task_assignments:     db.prepare('SELECT * FROM task_assignments ORDER BY date').all(),
      ical_tokens:          db.prepare('SELECT * FROM ical_tokens').all(),
      app_preferences:      db.prepare('SELECT * FROM app_preferences').all(),
      audit_log:            db.prepare('SELECT * FROM audit_log ORDER BY created_at LIMIT 10000').all(),
    }

    const manifest = {
      format:      'forgeshift-backup',
      version:     BACKUP_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      exported_by: req.user.id,
      instance:    process.env.APP_URL || 'unknown',
      tables,
    }

    // Write manifest.json into temp dir
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest))

    // Copy avatar files into temp dir avatars/ subfolder
    const tmpAvatarsDir = path.join(tmpDir, 'avatars')
    fs.mkdirSync(tmpAvatarsDir)
    if (fs.existsSync(AVATARS_DIR)) {
      for (const file of fs.readdirSync(AVATARS_DIR)) {
        if (file.match(/\\.jpe?g$/i)) {
          fs.copyFileSync(path.join(AVATARS_DIR, file), path.join(tmpAvatarsDir, file))
        }
      }
    }

    // Build zip using system zip (present on all Ubuntu/Proxmox LXC instances)
    const result = spawnSync('zip', ['-r', zipPath, '.'], { cwd: tmpDir })
    if (result.status !== 0) {
      throw new Error('zip failed: ' + (result.stderr?.toString() || 'unknown error'))
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename  = `forgeshift-backup-${timestamp}.fsbackup.zip`

    audit(req.user.id, 'backup.export', 'system', null, filename)

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    const stream = fs.createReadStream(zipPath)
    stream.pipe(res)
    stream.on('end', () => {
      // Clean up temp files after streaming
      try { fs.unlinkSync(zipPath) } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    })
    stream.on('error', err => {
      console.error('backup export stream:', err.message)
      if (!res.headersSent) res.status(500).json({ error: 'Export failed: ' + err.message })
    })
  } catch (err) {
    // Clean up on error
    try { fs.unlinkSync(zipPath) } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    console.error('backup export:', err.message)
    res.status(500).json({ error: 'Export failed: ' + err.message })
  }
})

// ── POST /api/backup/restore ──────────────────────────────────────────────────
// Accepts multipart/form-data with a "backup" file field (the .fsbackup.zip)
router.post('/restore', upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file received.' })

  const zipPath  = req.file.path
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsrestore-'))

  try {
    // Extract the zip
    const unzip = spawnSync('unzip', ['-o', zipPath, '-d', extractDir])
    if (unzip.status !== 0) {
      throw new Error('unzip failed: ' + (unzip.stderr?.toString() || 'unknown error'))
    }

    // Read manifest
    const manifestPath = path.join(extractDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Not a valid ForgeShift backup — manifest.json not found.')
    }
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      throw new Error('Invalid backup file — could not parse manifest.json.')
    }

    if (manifest.format !== 'forgeshift-backup') {
      throw new Error('Not a valid ForgeShift backup file.')
    }
    if (manifest.version > BACKUP_FORMAT_VERSION) {
      throw new Error(`Backup was created with a newer version of ForgeShift (format v${manifest.version}). Please upgrade first.`)
    }

    const { tables = {} } = manifest
    const stats = {}

    // Detect which optional columns exist
    const userCols     = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name))
    const shiftCols    = new Set(db.prepare('PRAGMA table_info(shifts)').all().map(c => c.name))
    const teamCols     = new Set(db.prepare('PRAGMA table_info(teams)').all().map(c => c.name))
    const taskListCols = new Set(db.prepare('PRAGMA table_info(task_lists)').all().map(c => c.name))

    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    )

    // IMPORTANT: FK pragma must be set at connection level BEFORE the transaction
    db.pragma('foreign_keys = OFF')

    const restore = db.transaction(() => {
      try {

        // ── 1. Users ─────────────────────────────────────────────────────────
        const updateUserIdByEmail = db.prepare(
          `UPDATE users SET id = @id WHERE email = @email AND id != @id`
        )
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
        let userCount = 0
        for (const u of (tables.users || [])) {
          updateUserIdByEmail.run({ id: u.id, email: u.email })
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
          userCount++
        }
        stats.users = userCount

        // ── 2. Locations ─────────────────────────────────────────────────────
        // Re-key by name to prevent cross-instance duplicates
        const reKeyLocByName = db.prepare(
          `UPDATE locations SET id = @id WHERE name = @name AND id != @id`
        )
        const upsertLoc = db.prepare(`
          INSERT INTO locations (id, name, address, color, created_by, created_at)
          VALUES (@id, @name, @address, @color, @created_by, @created_at)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, address=excluded.address, color=excluded.color
        `)
        let locCount = 0
        for (const l of (tables.locations || [])) {
          reKeyLocByName.run({ id: l.id, name: l.name })
          upsertLoc.run({
            id:         l.id,
            name:       l.name,
            address:    l.address || null,
            color:      l.color || '#0052cc',
            created_by: l.created_by || null,
            created_at: l.created_at,
          })
          locCount++
        }
        stats.locations = locCount

        // ── 3. Template Groups ────────────────────────────────────────────────
        if (existingTables.has('template_groups')) {
          const reKeyTGByName = db.prepare(
            `UPDATE template_groups SET id = @id WHERE name = @name AND id != @id`
          )
          const upsertTmplGroup = db.prepare(`
            INSERT INTO template_groups (id, name, sort_order, created_by, created_at)
            VALUES (@id, @name, @sort_order, @created_by, @created_at)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, sort_order=excluded.sort_order
          `)
          let tgCount = 0
          for (const g of (tables.template_groups || [])) {
            reKeyTGByName.run({ id: g.id, name: g.name })
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

        // ── 4. Shift Templates ────────────────────────────────────────────────
        const tmplHasGroupId = new Set(
          db.prepare('PRAGMA table_info(shift_templates)').all().map(c => c.name)
        ).has('group_id')
        const upsertTmpl = db.prepare(`
          INSERT INTO shift_templates (id, name, description, created_by, created_at
            ${tmplHasGroupId ? ', group_id' : ''}
          )
          VALUES (@id, @name, @description, @created_by, @created_at
            ${tmplHasGroupId ? ', @group_id' : ''}
          )
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, description=excluded.description
            ${tmplHasGroupId ? ', group_id=excluded.group_id' : ''}
        `)
        const reKeyTmplByName = db.prepare(
          `UPDATE shift_templates SET id = @id WHERE name = @name AND id != @id`
        )
        let tmplCount = 0
        for (const t of (tables.shift_templates || [])) {
          reKeyTmplByName.run({ id: t.id, name: t.name })
          upsertTmpl.run({
            id:          t.id,
            name:        t.name,
            description: t.description || null,
            created_by:  t.created_by || null,
            created_at:  t.created_at,
            group_id:    t.group_id || null,
          })
          tmplCount++
        }
        stats.templates = tmplCount

        // ── 5. Template Days ──────────────────────────────────────────────────
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
            note_color:  td.note_color || '#0052cc',
            is_off:      td.is_off ?? 0,
          })
          tdCount++
        }
        stats.templateDays = tdCount

        // ── 6. User → Template Group assignments ──────────────────────────────
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

        // ── 7. Teams ──────────────────────────────────────────────────────────
        if (existingTables.has('teams')) {
          const upsertTeam = db.prepare(`
            INSERT INTO teams (id, name, color, created_by, created_at
              ${teamCols.has('owned_by') ? ', owned_by' : ''}
            )
            VALUES (@id, @name, @color, @created_by, @created_at
              ${teamCols.has('owned_by') ? ', @owned_by' : ''}
            )
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, color=excluded.color
              ${teamCols.has('owned_by') ? ', owned_by=excluded.owned_by' : ''}
          `)
          let teamCount = 0
          for (const t of (tables.teams || [])) {
            upsertTeam.run({
              id:         t.id,
              name:       t.name,
              color:      t.color || '#0052cc',
              created_by: t.created_by || null,
              created_at: t.created_at,
              owned_by:   t.owned_by || null,
            })
            teamCount++
          }
          stats.teams = teamCount
        }

        // ── 8. Team Members ───────────────────────────────────────────────────
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

        // ── 9. Shifts ─────────────────────────────────────────────────────────
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
            note_color:  s.note_color || '#0052cc',
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

        // ── 10. Task Lists ────────────────────────────────────────────────────
        if (existingTables.has('task_lists')) {
          const upsertTaskList = db.prepare(`
            INSERT INTO task_lists (id, name, color, sort_order, created_by, created_at
              ${taskListCols.has('description') ? ', description' : ''}
              ${taskListCols.has('location_id') ? ', location_id' : ''}
            )
            VALUES (@id, @name, @color, @sort_order, @created_by, @created_at
              ${taskListCols.has('description') ? ', @description' : ''}
              ${taskListCols.has('location_id') ? ', @location_id' : ''}
            )
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, color=excluded.color, sort_order=excluded.sort_order
              ${taskListCols.has('description') ? ', description=excluded.description' : ''}
              ${taskListCols.has('location_id') ? ', location_id=excluded.location_id' : ''}
          `)
          let tlCount = 0
          for (const tl of (tables.task_lists || [])) {
            upsertTaskList.run({
              id:          tl.id,
              name:        tl.name,
              color:       tl.color || '#0052cc',
              sort_order:  tl.sort_order ?? 0,
              created_by:  tl.created_by || null,
              created_at:  tl.created_at,
              description: tl.description || null,
              location_id: tl.location_id || null,
            })
            tlCount++
          }
          stats.taskLists = tlCount
        }

        // ── 11. Task Assignments ──────────────────────────────────────────────
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

        // ── 12. iCal Tokens ───────────────────────────────────────────────────
        const deleteIcal = db.prepare('DELETE FROM ical_tokens WHERE user_id = @user_id')
        const insertIcal = db.prepare(`
          INSERT OR IGNORE INTO ical_tokens (id, user_id, token, created_at)
          VALUES (@id, @user_id, @token, @created_at)
        `)
        for (const t of (tables.ical_tokens || [])) {
          deleteIcal.run({ user_id: t.user_id })
          insertIcal.run({ id: t.id, user_id: t.user_id, token: t.token, created_at: t.created_at })
        }

        // ── 13. App Preferences ───────────────────────────────────────────────
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

    restore()

    // ── 14. Avatar files (outside DB transaction — filesystem operation) ──────
    // Copy avatar images from the extracted zip into public/uploads/avatars/.
    // Done after the DB transaction so user IDs are finalised (re-keying complete).
    const extractedAvatarsDir = path.join(extractDir, 'avatars')
    let avatarCount = 0
    if (fs.existsSync(extractedAvatarsDir)) {
      if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true })
      for (const file of fs.readdirSync(extractedAvatarsDir)) {
        if (file.match(/\.jpe?g$/i)) {
          fs.copyFileSync(
            path.join(extractedAvatarsDir, file),
            path.join(AVATARS_DIR, file)
          )
          // Ensure the avatar column points at the clean URL (no stale cache-buster)
          const userId = file.replace(/\.jpe?g$/i, '')
          db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(
            `/uploads/avatars/${file}`, userId
          )
          avatarCount++
        }
      }
    }
    stats.avatars = avatarCount

    audit(req.user.id, 'backup.restore', 'system', null, manifest.exported_at, { stats })
    res.json({ ok: true, exported_at: manifest.exported_at, instance: manifest.instance, stats })

  } catch (err) {
    console.error('backup restore error:', err.message)
    res.status(500).json({ error: 'Restore failed: ' + err.message })
  } finally {
    // Always re-enable FK enforcement after restore attempt
    db.pragma('foreign_keys = ON')
    // Clean up temp files
    try { fs.unlinkSync(zipPath) } catch {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch {}
  }
})

module.exports = router
