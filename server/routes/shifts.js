'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit  = require('../audit')

// ── GET /api/shifts — list shifts (date range filter) ─────────────────────────
router.get('/', requireAuth, (req, res) => {
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
    // Non-admins can only see their own unless they pass all
    if (req.user.role !== 'admin' && !user_id) {
      sql += ' AND s.user_id = ?'; params.push(req.user.id)
    }
    sql += ' ORDER BY s.date, u.name'
    const shifts = db.prepare(sql).all(...params)
    res.json(shifts)
  } catch (err) {
    console.error('shifts get:', err.message)
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
  if (req.user.role !== 'admin' && shift.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' })
  res.json(shift)
})

// ── POST /api/shifts ──────────────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    const { user_id, date, location_id, start_time, end_time, notes, note_color, is_off } = req.body

    if (!date) return res.status(400).json({ error: 'Date is required.' })
    const targetUserId = (isAdmin && user_id) ? user_id : req.user.id

    // Check for duplicate
    const existing = db.prepare('SELECT id FROM shifts WHERE user_id = ? AND date = ?').get(targetUserId, date)
    if (existing) return res.status(409).json({ error: 'A shift already exists for this user on this date.' })

    const id = uuidv4()
    db.prepare(`
      INSERT INTO shifts (id, user_id, date, location_id, start_time, end_time, notes, note_color, is_off, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, targetUserId, date, location_id || null, start_time || null, end_time || null,
           notes || null, note_color || '#0052cc', is_off ? 1 : 0, req.user.id)

    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id)
    audit(req.user.id, 'shift.create', 'shift', id, date)
    res.status(201).json(shift)
  } catch (err) {
    console.error('shift create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/shifts/:id ───────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id)
    if (!shift) return res.status(404).json({ error: 'Shift not found' })
    if (req.user.role !== 'admin' && shift.user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' })

    const { location_id, start_time, end_time, notes, note_color, is_off } = req.body
    db.prepare(`
      UPDATE shifts SET location_id=?, start_time=?, end_time=?, notes=?, note_color=?, is_off=?, updated_at=datetime('now')
      WHERE id=?
    `).run(location_id || null, start_time || null, end_time || null,
           notes || null, note_color || '#0052cc', is_off ? 1 : 0, req.params.id)

    const updated = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id)
    audit(req.user.id, 'shift.update', 'shift', req.params.id, shift.date)
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
    if (req.user.role !== 'admin' && shift.user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' })
    db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'shift.delete', 'shift', req.params.id, shift.date)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/shifts/apply-template ──────────────────────────────────────────
router.post('/apply-template', requireAuth, requireAdmin, (req, res) => {
  try {
    const { template_id, user_id, week_start } = req.body
    if (!template_id || !user_id || !week_start)
      return res.status(400).json({ error: 'template_id, user_id and week_start are required.' })

    const tmpl = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(template_id)
    if (!tmpl) return res.status(404).json({ error: 'Template not found' })

    const days = db.prepare('SELECT * FROM template_days WHERE template_id = ?').all(template_id)
    const start = new Date(week_start)
    const created = []

    const insert = db.prepare(`
      INSERT OR REPLACE INTO shifts (id, user_id, date, location_id, start_time, end_time, notes, note_color, is_off, template_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `)

    const tx = db.transaction(() => {
      for (const day of days) {
        const d = new Date(start)
        d.setDate(d.getDate() + day.day_of_week)
        const dateStr = d.toISOString().slice(0, 10)
        const id = uuidv4()
        insert.run(id, user_id, dateStr, day.location_id, day.start_time, day.end_time,
                   day.notes, day.note_color, day.is_off, template_id, req.user.id)
        created.push(dateStr)
      }
    })
    tx()

    audit(req.user.id, 'shift.template_apply', 'shift', template_id, tmpl.name, { user_id, week_start, days: created.length })
    res.json({ ok: true, applied: created.length })
  } catch (err) {
    console.error('apply template:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
