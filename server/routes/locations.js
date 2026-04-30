'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit  = require('../audit')
const { DEFAULT_COLOR, normalizeColorInput, resolveStoredColor } = require('../utils/color-utils')
const logger = require('../utils/logger')

// ── GET /api/locations ────────────────────────────────────────────────────────
// Admin: all locations with member_count + members array.
// Others: locations with no members (open to all) + locations they're a member of.
router.get('/', requireAuth, (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const locs = db.prepare(`
        SELECT l.*, o.name AS org_name
        FROM locations l
        LEFT JOIN organisations o ON o.id = l.org_id
        ORDER BY l.name
      `).all()
      return res.json(locs)
    }
    // Non-admin: unassigned (no org) OR user belongs to the location's org
    const locs = db.prepare(`
      SELECT l.*
      FROM locations l
      WHERE l.org_id IS NULL
         OR l.org_id IN (SELECT org_id FROM organisation_members WHERE user_id = ?)
      ORDER BY l.name
    `).all(req.user.id)
    res.json(locs)
  } catch (err) {
    logger.error('locations get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, address, color, org_id } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' })
    const id = uuidv4()
    db.prepare('INSERT INTO locations (id, name, address, color, org_id, created_by) VALUES (?,?,?,?,?,?)')
      .run(id, name.trim(), address || null, resolveStoredColor(color, DEFAULT_COLOR), org_id || null, req.user.id)
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(id)
    audit(req.user.id, 'location.create', 'location', id, name.trim())
    res.status(201).json(loc)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, address, color, org_id } = req.body
    const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    db.prepare('UPDATE locations SET name=?, address=?, color=?, org_id=? WHERE id=?')
      .run(
        name?.trim() || existing.name,
        address !== undefined ? (address || null) : existing.address,
        color !== undefined ? normalizeColorInput(color) : existing.color,
        org_id !== undefined ? (org_id || null) : existing.org_id,
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
    logger.error('location members put:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
