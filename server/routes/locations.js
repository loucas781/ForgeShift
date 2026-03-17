'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit  = require('../audit')

router.get('/', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM locations ORDER BY name').all())
})

router.post('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, address, color } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' })
    const id = uuidv4()
    db.prepare('INSERT INTO locations (id, name, address, color, created_by) VALUES (?,?,?,?,?)')
      .run(id, name.trim(), address || null, color || '#0052cc', req.user.id)
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(id)
    audit(req.user.id, 'location.create', 'location', id, name.trim())
    res.status(201).json(loc)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, address, color } = req.body
    db.prepare('UPDATE locations SET name=?, address=?, color=? WHERE id=?')
      .run(name || '', address || null, color || '#0052cc', req.params.id)
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id)
    audit(req.user.id, 'location.update', 'location', req.params.id, name)
    res.json(loc)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id)
    if (!loc) return res.status(404).json({ error: 'Not found' })
    db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'location.delete', 'location', req.params.id, loc.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
