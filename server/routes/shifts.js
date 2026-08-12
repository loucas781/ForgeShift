'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const audit  = require('../audit')
const { buildHolidayMapServer } = require('../holidays')
const { getShiftLeadScope } = require('../utils/scope')
const logger = require('../utils/logger')
const { hasPermission } = require('../utils/roles')
const { DEFAULT_COLOR, normalizeColorInput, resolveStoredColor } = require('../utils/color-utils')
const {
  PATTERN_TEMPLATE_TYPE,
  loadTemplateDays,
  normalizeTemplateType,
} = require('../utils/template-utils')

// ── GET /api/shifts ───────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=30')
  try {
    const { start, end, user_id } = req.query
    let sql = `
      SELECT s.*, u.name as user_name, u.initials as user_initials, u.color as user_color,
             l.name as location_name, l.color as location_color, l.address as location_address
      FROM shifts s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN locations l ON l.id = s.location_id
      WHERE 1=1
    `
    const params = []
    if (start)   { sql += ' AND s.date >= ?'; params.push(start) }
    if (end)     { sql += ' AND s.date <= ?'; params.push(end) }
    if (user_id) { sql += ' AND s.user_id = ?'; params.push(user_id) }

    if (hasPermission(req, 'view_other_rotas') && req.user.role !== 'shift_lead') {
      // no extra filter — admins and managers see all shifts
    } else if (req.user.role === 'shift_lead') {
      // Always constrain to team scope whether or not a specific user_id was requested.
      // This prevents a shift lead querying an out-of-scope user directly via the API.
      const scope = getShiftLeadScope(req.user.id)
      if (user_id) {
        // Specific user requested — must be in scope
        if (!scope.has(user_id)) return res.status(403).json({ error: 'That user is not in your team.' })
        // user_id filter already applied to SQL above; no extra IN clause needed
      } else {
        const placeholders = [...scope].map(() => '?').join(',')
        sql += ` AND s.user_id IN (${placeholders})`
        params.push(...scope)
      }
    } else {
      if (!hasPermission(req, 'view_shifts') && !hasPermission(req, 'view_own_rota')) return res.status(403).json({ error: 'You do not have permission to view shifts.' })
      if (user_id && user_id !== req.user.id) return res.status(403).json({ error: 'You can only view your own shifts.' })
      sql += ' AND s.user_id = ?'; params.push(req.user.id)
    }

    sql += ' ORDER BY s.date, u.name'
    const shifts = db.prepare(sql).all(...params)
    res.json(shifts)
  } catch (err) {
    logger.error('shifts get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/shifts/export/csv ────────────────────────────────────────────────
router.get('/export/csv', requireAuth, (req, res) => {
  try {
    const canViewOwn = hasPermission(req, 'view_own_rota')
    const canViewOthers = hasPermission(req, 'view_other_rotas')
    const { start, end } = req.query
    let user_id = req.user.id
    if ((req.user.role === 'admin' || req.user.role === 'manager' || hasPermission(req, 'view_other_rotas')) && req.query.user_id) {
      user_id = req.query.user_id === 'all' ? null : req.query.user_id
    } else if (req.user.role === 'shift_lead' && req.query.user_id) {
      const scope = getShiftLeadScope(req.user.id)
      if (scope.has(req.query.user_id)) user_id = req.query.user_id
    }
    if (user_id === req.user.id && !canViewOwn) return res.status(403).json({ error: 'You do not have permission to view your rota.' })
    if (user_id !== req.user.id && !canViewOthers) return res.status(403).json({ error: 'You do not have permission to view other rotas.' })

    let sql = `
      SELECT s.*, u.name as user_name, l.name as location_name
      FROM shifts s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN locations l ON l.id = s.location_id
      WHERE 1=1
    `
    const params = []
    if (start)   { sql += ' AND s.date >= ?'; params.push(start) }
    if (end)     { sql += ' AND s.date <= ?'; params.push(end) }
    if (user_id) { sql += ' AND s.user_id = ?'; params.push(user_id) }
    else if (!(req.user.role === 'admin' || req.user.role === 'manager' || hasPermission(req, 'view_other_rotas'))) { sql += ' AND s.user_id = ?'; params.push(req.user.id) }
    sql += ' ORDER BY s.date, u.name'

    const rows = db.prepare(sql).all(...params)
    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
    const esc = v => `"${(v || '').replace(/"/g, '""')}"`
    const lines = ['Date,Day,User,Location,Start,End,Hours,Notes,Type']
    for (const s of rows) {
      const d = new Date(s.date + 'T00:00:00')
      const hours = (s.start_time && s.end_time)
        ? (() => { const [sh,sm] = s.start_time.split(':').map(Number); const [eh,em] = s.end_time.split(':').map(Number); return (((eh*60+em)-(sh*60+sm))/60).toFixed(2) })()
        : ''
      const type = s.is_off ? 'Annual Leave' : s.is_oncall ? 'On-call' : 'Shift'
      lines.push([s.date, DAY_NAMES[d.getDay()], esc(s.user_name||''), esc(s.location_name||''),
        s.start_time||'', s.end_time||'', hours, esc(s.notes||''), type].join(','))
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="shifts-${new Date().toISOString().slice(0,10)}.csv"`)
    res.send(lines.join('\r\n'))
  } catch (err) {
    logger.error('csv export:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/shifts/:id ───────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const shift = db.prepare(`
    SELECT s.*, l.name as location_name, l.color as location_color
    FROM shifts s LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.id = ?
  `).get(req.params.id)
  if (!shift) return res.status(404).json({ error: 'Shift not found' })
  if (hasPermission(req, 'view_other_rotas') && req.user.role !== 'shift_lead') { return res.json(shift) }
  if (req.user.role === 'shift_lead') {
    const scope = getShiftLeadScope(req.user.id)
    if (!scope.has(shift.user_id)) return res.status(403).json({ error: 'Forbidden' })
    return res.json(shift)
  }
  if (shift.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
  if (!hasPermission(req, 'view_shifts') && !hasPermission(req, 'view_own_rota')) return res.status(403).json({ error: 'Forbidden' })
  res.json(shift)
})

// ── POST /api/shifts ──────────────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  try {
    const canAddOthers = hasPermission(req, 'add_other_shifts')
    const canAddOwn = hasPermission(req, 'add_own_shifts')
    const isShiftLead = req.user.role === 'shift_lead'
    const { user_id, date, location_id, start_time, end_time, notes, note_color, is_off, is_oncall } = req.body

    if (!date) return res.status(400).json({ error: 'Date is required.' })

    const targetUserId = user_id || req.user.id
    if (targetUserId === req.user.id) {
      if (!canAddOwn) return res.status(403).json({ error: 'You do not have permission to create your own shifts.' })
    } else if (isShiftLead) {
      // Verify target is in shift_lead's scope
      const scope = getShiftLeadScope(req.user.id)
      if (!canAddOthers || !scope.has(targetUserId)) return res.status(403).json({ error: 'You can only assign shifts to members of your teams.' })
    } else if (!canAddOthers) {
      return res.status(403).json({ error: 'You do not have permission to create this shift.' })
    }

    let id, shift
    const checkAndInsert = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM shifts WHERE user_id = ? AND date = ?').get(targetUserId, date)
      if (existing) return { conflict: 'date' }

      // Time overlap check (skipped when force=true query param is set)
      if (!req.query.force && start_time && end_time) {
        const overlap = db.prepare(`
          SELECT id FROM shifts
          WHERE user_id = ? AND date = ? AND start_time IS NOT NULL AND end_time IS NOT NULL
            AND start_time < ? AND end_time > ?
        `).get(targetUserId, date, end_time, start_time)
        if (overlap) return { conflict: 'time' }
      }

      id = uuidv4()
      db.prepare(`
        INSERT INTO shifts (id, user_id, date, location_id, start_time, end_time, notes, note_color, is_off, is_oncall, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, targetUserId, date, location_id || null, start_time || null, end_time || null,
             notes || null, resolveStoredColor(note_color, DEFAULT_COLOR), is_off ? 1 : 0, is_oncall ? 1 : 0, req.user.id)
      shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id)
      return { ok: true }
    })

    const result = checkAndInsert()
    if (result.conflict === 'date') return res.status(409).json({ error: 'A shift already exists for this user on this date.' })
    if (result.conflict === 'time') return res.status(409).json({ error: 'This shift overlaps with an existing shift.', conflict: true })
    audit(req.user.id, 'shift.create', 'shift', id, date)
    req.app.locals.broadcastShiftEvent?.('shift.create', shift, req.user.id)
    res.status(201).json(shift)
  } catch (err) {
    logger.error('shift create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/shifts/:id ───────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id)
    if (!shift) return res.status(404).json({ error: 'Shift not found' })

    const canEditOthers = hasPermission(req, 'edit_other_shifts')
    const canEditOwn = hasPermission(req, 'edit_own_shifts')
    if (shift.user_id === req.user.id) {
      if (!canEditOwn) return res.status(403).json({ error: 'You do not have permission to edit your own shifts.' })
    } else if (canEditOthers && req.user.role !== 'shift_lead') {
      // full access
    } else if (req.user.role === 'shift_lead') {
      const scope = getShiftLeadScope(req.user.id)
      if (!canEditOthers || !scope.has(shift.user_id)) return res.status(403).json({ error: 'Forbidden' })
    } else {
      return res.status(403).json({ error: 'You do not have permission to edit this shift.' })
    }

    const { date: newDate, location_id, start_time, end_time, notes, note_color, is_off, is_oncall } = req.body
    const targetDate = newDate || shift.date
    db.prepare(`
      UPDATE shifts SET date=?, location_id=?, start_time=?, end_time=?, notes=?, note_color=?, is_off=?, is_oncall=?, updated_at=datetime('now'), updated_by=?
      WHERE id=?
    `).run(targetDate, location_id || null, start_time || null, end_time || null,
           notes || null, note_color !== undefined ? normalizeColorInput(note_color) : shift.note_color, is_off ? 1 : 0, is_oncall ? 1 : 0, req.user.id, req.params.id)

    const updated = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id)
    audit(req.user.id, 'shift.update', 'shift', req.params.id, targetDate)
    req.app.locals.broadcastShiftEvent?.('shift.update', updated, req.user.id)
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/shifts/:id ────────────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id)
    if (!shift) return res.status(404).json({ error: 'Shift not found' })

    const canDeleteOthers = hasPermission(req, 'delete_other_shifts')
    const canDeleteOwn = hasPermission(req, 'delete_own_shifts')
    if (shift.user_id === req.user.id) {
      if (!canDeleteOwn) return res.status(403).json({ error: 'You do not have permission to delete your own shifts.' })
    } else if (canDeleteOthers && req.user.role !== 'shift_lead') {
      // full access
    } else if (req.user.role === 'shift_lead') {
      const scope = getShiftLeadScope(req.user.id)
      if (!canDeleteOthers || !scope.has(shift.user_id)) return res.status(403).json({ error: 'Forbidden' })
    } else {
      return res.status(403).json({ error: 'You do not have permission to delete this shift.' })
    }

    db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'shift.delete', 'shift', req.params.id, shift.date)
    req.app.locals.broadcastShiftEvent?.('shift.delete', { id: req.params.id, date: shift.date }, req.user.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/shifts/apply-template ──────────────────────────────────────────
router.post('/apply-template', requireAuth, (req, res) => {
  try {
    const { template_id, user_id, week_start, start_date, range_start, end_date, skip_holidays } = req.body
    if (!template_id || !user_id)
      return res.status(400).json({ error: 'template_id and user_id are required.' })
    const canApply = user_id === req.user.id
      ? hasPermission(req, 'add_own_shifts')
      : hasPermission(req, 'add_other_shifts')
    if (!canApply) return res.status(403).json({ error: 'You do not have permission to add shifts for this user.' })

    // shift_lead: verify target user is in their scope
    if (req.user.role === 'shift_lead') {
      const scope = getShiftLeadScope(req.user.id)
      if (!scope.has(user_id)) return res.status(403).json({ error: 'You can only assign shifts to members of your teams.' })
    }

    const tmpl = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(template_id)
    if (!tmpl) return res.status(404).json({ error: 'Template not found' })
    const templateType = normalizeTemplateType(tmpl.template_type)
    const baseDate = templateType === PATTERN_TEMPLATE_TYPE ? start_date : week_start
    if (!baseDate) {
      return res.status(400).json({
        error: templateType === PATTERN_TEMPLATE_TYPE
          ? 'start_date is required for pattern templates.'
          : 'week_start is required for weekly templates.'
      })
    }

    const days = loadTemplateDays(db, template_id, templateType)

    // Parse the selected date as local date components to avoid UTC-offset day drift.
    const [sy, sm, sd] = baseDate.split('-').map(Number)
    const rangeStartDate = range_start || baseDate
    const rangeEndDate = end_date || null

    // Build a Set of bank holiday date strings if the toggle is enabled
    const bankHolidayDates = new Set()
    if (skip_holidays) {
      // 'holidays' is a per-user preference — read from the requesting user's prefs
      const userRow = db.prepare('SELECT prefs FROM users WHERE id = ?').get(req.user.id)
      let userPrefs = {}
      try { userPrefs = JSON.parse(userRow?.prefs || '{}') } catch {}
      const enabledSets = Array.isArray(userPrefs.holidays) ? userPrefs.holidays : []
      if (enabledSets.length) {
        // Collect all years spanned by the template span
        const years = new Set()
        for (const day of days) {
          years.add(new Date(sy, sm - 1, sd + day.day_index).getFullYear())
        }
        for (const yr of years) {
          const map = buildHolidayMapServer(yr, enabledSets, db)
          for (const dateStr of Object.keys(map)) bankHolidayDates.add(dateStr)
        }
      }
    }

    const candidateDates = days.map(day => {
      const target = new Date(sy, sm - 1, sd + day.day_index)
      const yyyy = target.getFullYear()
      const mm = String(target.getMonth() + 1).padStart(2, '0')
      const dd = String(target.getDate()).padStart(2, '0')
      return `${yyyy}-${mm}-${dd}`
    }).filter(dateStr => {
      if (rangeStartDate && dateStr < rangeStartDate) return false
      if (rangeEndDate && dateStr > rangeEndDate) return false
      return !(skip_holidays && bankHolidayDates.has(dateStr))
    })
    if (candidateDates.length) {
      const existing = db.prepare(`SELECT 1 FROM shifts WHERE user_id = ? AND date IN (${candidateDates.map(() => '?').join(',')}) LIMIT 1`)
        .get(user_id, ...candidateDates)
      const canReplace = user_id === req.user.id
        ? hasPermission(req, 'edit_own_shifts')
        : hasPermission(req, 'edit_other_shifts')
      if (existing && !canReplace) {
        return res.status(403).json({ error: 'Applying this template would replace an existing shift, which you do not have permission to edit.' })
      }
    }

    const created = []
    const skipped = []

    const insert = db.prepare(`
      INSERT OR REPLACE INTO shifts (id, user_id, date, location_id, start_time, end_time, notes, note_color, is_off, is_oncall, template_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `)

    const tx = db.transaction(() => {
      for (const day of days) {
        // Local-date arithmetic avoids UTC midnight roll-back on servers behind UTC.
        const target = new Date(sy, sm - 1, sd + day.day_index)
        const yyyy   = target.getFullYear()
        const mm     = String(target.getMonth() + 1).padStart(2, '0')
        const dd     = String(target.getDate()).padStart(2, '0')
        const dateStr = `${yyyy}-${mm}-${dd}`

        if (rangeStartDate && dateStr < rangeStartDate) continue
        if (rangeEndDate && dateStr > rangeEndDate) continue

        if (skip_holidays && bankHolidayDates.has(dateStr)) {
          skipped.push(dateStr)
          continue
        }

        const id = uuidv4()
        insert.run(id, user_id, dateStr, day.location_id, day.start_time, day.end_time,
                   day.notes, day.note_color, day.is_off, 0, template_id, req.user.id)
        created.push(dateStr)
      }
    })
    tx()

    // Stamp last applied time on the template
    if (created.length > 0) {
      db.prepare("UPDATE shift_templates SET last_applied_at = datetime('now') WHERE id = ?").run(template_id)
    }

    audit(req.user.id, 'shift.template_apply', 'shift', template_id, tmpl.name, {
      user_id,
      template_type: templateType,
      start_date: baseDate,
      range_start: rangeStartDate,
      end_date: rangeEndDate,
      days: created.length,
      skipped: skipped.length,
    })
    if (created.length) req.app.locals.broadcastShiftEvent?.('shift.create', { user_id, start_date: baseDate }, req.user.id)
    res.json({ ok: true, applied: created.length, skipped: skipped.length })
  } catch (err) {
    logger.error('apply template:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})
module.exports = router
