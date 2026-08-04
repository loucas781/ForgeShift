'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { hasPermission } = require('../utils/roles')
const audit  = require('../audit')
const { DEFAULT_COLOR, normalizeColorInput, resolveStoredColor } = require('../utils/color-utils')
const logger = require('../utils/logger')

function organisationIdsFor(locationId) {
  return db.prepare('SELECT org_id FROM location_organisations WHERE location_id = ? ORDER BY org_id').all(locationId).map(r => r.org_id)
}
function addOrganisationFields(location) {
  if (!location) return location
  const organisation_ids = organisationIdsFor(location.id)
  location.organisation_ids = organisation_ids
  location.organisations = db.prepare(`SELECT o.id, o.name, o.color FROM organisations o
    WHERE o.id IN (${organisation_ids.length ? organisation_ids.map(() => '?').join(',') : "''"}) ORDER BY o.name`).all(...organisation_ids)
  // Keep legacy scalar output deterministic for old clients.
  location.org_id = location.org_id || organisation_ids[0] || null
  return location
}
function requestedOrganisationIds(body, existing) {
  if (Array.isArray(body.organisation_ids)) return [...new Set(body.organisation_ids.filter(Boolean).map(String))]
  if (Array.isArray(body.org_ids)) return [...new Set(body.org_ids.filter(Boolean).map(String))]
  if (body.org_id !== undefined) return body.org_id ? [String(body.org_id)] : []
  return existing ? organisationIdsFor(existing.id) : []
}
function setOrganisationIds(locationId, ids) {
  const validIds = ids.filter(orgId => db.prepare('SELECT id FROM organisations WHERE id = ?').get(orgId))
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM location_organisations WHERE location_id = ?').run(locationId)
    const ins = db.prepare('INSERT OR IGNORE INTO location_organisations (location_id, org_id) VALUES (?,?)')
    validIds.forEach(orgId => ins.run(locationId, orgId))
    db.prepare('UPDATE locations SET org_id = ? WHERE id = ?').run(validIds[0] || null, locationId)
  })
  tx()
}

// ── GET /api/locations ────────────────────────────────────────────────────────
// Admin: all locations with member_count + members array.
// Others: locations with no members (open to all) + locations they're a member of.
router.get('/', requireAuth, (req, res) => {
  try {
    if (req.user.role === 'admin' || hasPermission(req, 'manage_locations')) {
      const locs = db.prepare(`
        SELECT l.*, o.name AS org_name
        FROM locations l
        LEFT JOIN organisations o ON o.id = l.org_id
        ORDER BY l.name
      `).all()
      return res.json(locs.map(addOrganisationFields))
    }
    // Non-admin: unassigned (no org) OR user belongs to the location's org
    const locs = db.prepare(`
      SELECT l.*
      FROM locations l
      WHERE NOT EXISTS (SELECT 1 FROM location_organisations lo WHERE lo.location_id = l.id)
         OR EXISTS (SELECT 1 FROM location_organisations lo JOIN organisation_members om ON om.org_id=lo.org_id
                    WHERE lo.location_id=l.id AND om.user_id = ?)
         OR (l.org_id IS NOT NULL AND l.org_id IN (SELECT org_id FROM organisation_members WHERE user_id = ?))
      ORDER BY l.name
    `).all(req.user.id, req.user.id)
    res.json(locs.map(addOrganisationFields))
  } catch (err) {
    logger.error('locations get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/', requireAuth, requirePermission('manage_locations'), (req, res) => {
  try {
    const { name, address, color, org_id } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' })
    const id = uuidv4()
    const ids = requestedOrganisationIds(req.body)
    db.prepare('INSERT INTO locations (id, name, address, color, org_id, created_by) VALUES (?,?,?,?,?,?)')
      .run(id, name.trim(), address || null, resolveStoredColor(color, DEFAULT_COLOR), null, req.user.id)
    setOrganisationIds(id, ids.length ? ids : (org_id ? [org_id] : []))
    const loc = addOrganisationFields(db.prepare('SELECT * FROM locations WHERE id = ?').get(id))
    audit(req.user.id, 'location.create', 'location', id, name.trim())
    res.status(201).json(loc)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id', requireAuth, requirePermission('manage_locations'), (req, res) => {
  try {
    const { name, address, color, org_id } = req.body
    const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const ids = requestedOrganisationIds(req.body, existing)
    db.prepare('UPDATE locations SET name=?, address=?, color=?, org_id=? WHERE id=?')
      .run(
        name?.trim() || existing.name,
        address !== undefined ? (address || null) : existing.address,
        color !== undefined ? normalizeColorInput(color) : existing.color,
        ids[0] || null,
        req.params.id
      )
    setOrganisationIds(req.params.id, ids)
    const loc = addOrganisationFields(db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id))
    audit(req.user.id, 'location.update', 'location', req.params.id, loc.name)
    res.json(loc)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id', requireAuth, requirePermission('manage_locations'), (req, res) => {
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
router.put('/:id/members', requireAuth, requirePermission('manage_locations'), (req, res) => {
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
