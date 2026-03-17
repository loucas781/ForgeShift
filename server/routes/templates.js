'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit  = require('../audit')

// ── GET /api/templates ────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const templates = db.prepare(`
    SELECT t.*, u.name as created_by_name
    FROM shift_templates t
    LEFT JOIN users u ON u.id = t.created_by
    ORDER BY t.name
  `).all()

  const days = db.prepare('SELECT * FROM template_days ORDER BY day_of_week').all()
  const daysByTemplate = {}
  days.forEach(d => {
    if (!daysByTemplate[d.template_id]) daysByTemplate[d.template_id] = []
    daysByTemplate[d.template_id].push(d)
  })

  res.json(templates.map(t => ({ ...t, days: daysByTemplate[t.id] || [] })))
})

// ── GET /api/templates/:id ────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const tmpl = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id)
  if (!tmpl) return res.status(404).json({ error: 'Template not found' })
  const days = db.prepare('SELECT * FROM template_days WHERE template_id = ? ORDER BY day_of_week').all(req.params.id)
  res.json({ ...tmpl, days })
})

// ── POST /api/templates ───────────────────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, description, days } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Template name is required.' })

    const id = uuidv4()
    db.prepare('INSERT INTO shift_templates (id, name, description, created_by) VALUES (?,?,?,?)')
      .run(id, name.trim(), description || null, req.user.id)

    if (Array.isArray(days)) {
      const ins = db.prepare(`
        INSERT INTO template_days (id, template_id, day_of_week, location_id, start_time, end_time, notes, note_color, is_off)
        VALUES (?,?,?,?,?,?,?,?,?)
      `)
      const tx = db.transaction(() => {
        days.forEach(d => {
          ins.run(uuidv4(), id, d.day_of_week, d.location_id || null,
                  d.start_time || null, d.end_time || null,
                  d.notes || null, d.note_color || '#0052cc', d.is_off ? 1 : 0)
        })
      })
      tx()
    }

    const tmpl = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(id)
    const tmplDays = db.prepare('SELECT * FROM template_days WHERE template_id = ? ORDER BY day_of_week').all(id)
    audit(req.user.id, 'template.create', 'template', id, name.trim())
    res.status(201).json({ ...tmpl, days: tmplDays })
  } catch (err) {
    console.error('template create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/templates/:id ────────────────────────────────────────────────────
router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const tmpl = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id)
    if (!tmpl) return res.status(404).json({ error: 'Template not found' })

    const { name, description, days } = req.body
    if (name?.trim()) {
      db.prepare('UPDATE shift_templates SET name=?, description=? WHERE id=?')
        .run(name.trim(), description ?? tmpl.description, req.params.id)
    }

    if (Array.isArray(days)) {
      db.prepare('DELETE FROM template_days WHERE template_id = ?').run(req.params.id)
      const ins = db.prepare(`
        INSERT INTO template_days (id, template_id, day_of_week, location_id, start_time, end_time, notes, note_color, is_off)
        VALUES (?,?,?,?,?,?,?,?,?)
      `)
      const tx = db.transaction(() => {
        days.forEach(d => {
          ins.run(uuidv4(), req.params.id, d.day_of_week, d.location_id || null,
                  d.start_time || null, d.end_time || null,
                  d.notes || null, d.note_color || '#0052cc', d.is_off ? 1 : 0)
        })
      })
      tx()
    }

    const updated = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id)
    const updDays = db.prepare('SELECT * FROM template_days WHERE template_id = ? ORDER BY day_of_week').all(req.params.id)
    audit(req.user.id, 'template.update', 'template', req.params.id, updated.name)
    res.json({ ...updated, days: updDays })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/templates/:id ─────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const tmpl = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id)
    if (!tmpl) return res.status(404).json({ error: 'Template not found' })
    db.prepare('DELETE FROM shift_templates WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'template.delete', 'template', req.params.id, tmpl.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
