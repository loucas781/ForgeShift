'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit  = require('../audit')
const { DEFAULT_COLOR, normalizeColorInput, resolveStoredColor } = require('../utils/color-utils')

// ── GET /api/locations ────────────────────────────────────────────────────────
// Admin: all locations with member_count + members array.
// Others: locations with no members (open to all) + locations they're a member of.
router.get('/', requireAuth, (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const locs = db.prepare(`
        SELECT l.*, COUNT(DISTINCT lm.user_id) AS member_count
        FROM locations l
        LEFT JOIN location_members lm ON lm.location_id = l.id
        GROUP BY l.id ORDER BY l.name
      `).all()
      const members = db.prepare(`
        SELECT lm.location_id, u.id, u.name, u.role, u.color, u.initials
        FROM location_members lm JOIN users u ON u.id = lm.user_id ORDER BY u.name
      `).all()
      const byLoc = {}
      members.forEach(m => {
        if (!byLoc[m.location_id]) byLoc[m.location_id] = []
        byLoc[m.location_id].push({ id: m.id, name: m.name, role: m.role, color: m.color, initials: m.initials })
      })
      locs.forEach(l => { l.members = byLoc[l.id] || [] })
      return res.json(locs)
    }
    // Non-admin: unassigned (no members) OR user is a member
    const locs = db.prepare(`
      SELECT l.*
      FROM locations l
      WHERE l.id NOT IN (SELECT DISTINCT location_id FROM location_members)
         OR l.id IN (SELECT location_id FROM location_members WHERE user_id = ?)
      ORDER BY l.name
    `).all(req.user.id)
    res.json(locs)
  } catch (err) {
    console.error('locations get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, address, color } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' })
    const id = uuidv4()
    db.prepare('INSERT INTO locations (id, name, address, color, created_by) VALUES (?,?,?,?,?)')
      .run(id, name.trim(), address || null, resolveStoredColor(color, DEFAULT_COLOR), req.user.id)
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
    const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    db.prepare('UPDATE locations SET name=?, address=?, color=? WHERE id=?')
      .run(
        name?.trim() || existing.name,
        address !== undefined ? (address || null) : existing.address,
        color !== undefined ? normalizeColorInput(color) : existing.color,
        req.params.id
      )
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id)
    audit(req.user.id, 'location.update', 'location', req.params.id, loc.name)
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

// ── PUT /api/locations/:id/members — replace full member list ─────────────────
router.put('/:id/members', requireAuth, requireAdmin, (req, res) => {
  try {
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id)
    if (!loc) return res.status(404).json({ error: 'Not found' })
    const { user_ids } = req.body
    if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array.' })
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM location_members WHERE location_id = ?').run(req.params.id)
      const ins = db.prepare('INSERT OR IGNORE INTO location_members (location_id, user_id) VALUES (?,?)')
      user_ids.forEach(uid => ins.run(req.params.id, uid))
    })
    tx()
    audit(req.user.id, 'location.members_updated', 'location', req.params.id, loc.name)
    res.json({ ok: true })
  } catch (err) {
    console.error('location members put:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
