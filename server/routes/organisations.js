'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { hasPermission } = require('../utils/roles')
const audit  = require('../audit')
const logger = require('../utils/logger')

const COLORS = ['#0052cc','#00875a','#6554c0','#ff5630','#ff991f','#36b37e','#00b8d9','#e01e5a','#904ee2','#0065ff']

// ── GET /api/organisations ────────────────────────────────────────────────────
// Admin: all orgs with member list + item counts.
// Manager: all orgs (basic info only — needed for template filtering across all orgs).
// Others: orgs they belong to (name + id only).
router.get('/', requireAuth, (req, res) => {
  try {
    const canManageOrganisations = req.user.role === 'admin' || hasPermission(req, 'manage_organisations')
    const needsOrganisationOptions = req.user.role === 'manager' || [
      'manage_locations',
      'manage_templates',
      'manage_tasks',
      'manage_teams',
    ].some(permission => hasPermission(req, permission))

    if (!canManageOrganisations && needsOrganisationOptions) {
      const orgs = db.prepare(`
        SELECT o.id, o.name, o.color
        FROM organisations o
        ORDER BY o.name
      `).all()
      return res.json(orgs)
    }

    if (!canManageOrganisations) {
      const orgs = db.prepare(`
        SELECT o.id, o.name, o.color
        FROM organisations o
        JOIN organisation_members om ON om.org_id = o.id AND om.user_id = ?
        ORDER BY o.name
      `).all(req.user.id)
      return res.json(orgs)
    }

    const orgs = db.prepare(`
      SELECT o.*,
             COUNT(DISTINCT om.user_id)  AS member_count,
      COUNT(DISTINCT CASE WHEN lo.org_id = o.id THEN lo.location_id WHEN l.org_id = o.id THEN l.id END) AS location_count,
             COUNT(DISTINCT tl.id)       AS task_list_count,
             COUNT(DISTINCT st.id)       AS template_count,
             COUNT(DISTINCT t.id)        AS team_count
      FROM organisations o
      LEFT JOIN organisation_members om ON om.org_id = o.id
      LEFT JOIN locations l             ON l.org_id  = o.id
      LEFT JOIN location_organisations lo ON lo.org_id = o.id
      LEFT JOIN task_lists tl           ON tl.org_id = o.id
      LEFT JOIN shift_templates st      ON st.org_id = o.id
      LEFT JOIN teams t                 ON t.org_id  = o.id
      GROUP BY o.id
      ORDER BY o.name
    `).all()

    if (orgs.length) {
      const orgIds = orgs.map(o => o.id)
      const members = db.prepare(`
        SELECT om.org_id, u.id, u.name, u.initials, u.color, u.avatar, u.role, u.role_id,
               r.name AS role_name, r.color AS role_color, u.is_active
        FROM organisation_members om JOIN users u ON u.id = om.user_id LEFT JOIN roles r ON r.id=u.role_id
        WHERE om.org_id IN (${orgIds.map(() => '?').join(',')})
        ORDER BY u.name
      `).all(...orgIds)
      const byOrg = {}
      members.forEach(m => {
        if (!byOrg[m.org_id]) byOrg[m.org_id] = []
        byOrg[m.org_id].push({ id: m.id, name: m.name, initials: m.initials, color: m.color, avatar: m.avatar, role: m.role, role_id: m.role_id, role_name: m.role_name, role_color: m.role_color, is_active: m.is_active })
      })
      orgs.forEach(o => { o.members = byOrg[o.id] || [] })
    } else {
      orgs.forEach(o => { o.members = [] })
    }

    res.json(orgs)
  } catch (err) {
    logger.error('organisations get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/organisations — create (admin-only) ─────────────────────────────
router.post('/', requireAuth, requirePermission('manage_organisations'), (req, res) => {
  try {
    const { name, color } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Organisation name is required.' })
    const count = db.prepare('SELECT COUNT(*) AS c FROM organisations').get().c
    const orgColor = color || COLORS[count % COLORS.length]
    const id = uuidv4()
    db.prepare('INSERT INTO organisations (id, name, color, created_by) VALUES (?,?,?,?)')
      .run(id, name.trim(), orgColor, req.user.id)
    audit(req.user.id, 'org.create', 'organisation', id, name.trim(), { by: req.user.name })
    const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(id)
    org.members = []
    org.member_count = 0
    org.location_count = 0
    org.task_list_count = 0
    org.template_count = 0
    org.team_count = 0
    res.status(201).json(org)
  } catch (err) {
    logger.error('organisation create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/organisations/:id — rename / recolour (admin-only) ─────────────
router.patch('/:id', requireAuth, requirePermission('manage_organisations'), (req, res) => {
  try {
    const { name, color } = req.body
    const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(req.params.id)
    if (!org) return res.status(404).json({ error: 'Organisation not found' })
    const updates = []; const vals = []
    if (name?.trim()) { updates.push('name = ?'); vals.push(name.trim()) }
    if (color)        { updates.push('color = ?'); vals.push(color) }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })
    vals.push(req.params.id)
    db.prepare(`UPDATE organisations SET ${updates.join(', ')} WHERE id = ?`).run(...vals)
    audit(req.user.id, 'org.update', 'organisation', req.params.id, name || org.name, { by: req.user.name })
    res.json(db.prepare('SELECT * FROM organisations WHERE id = ?').get(req.params.id))
  } catch (err) {
    logger.error('organisation patch:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/organisations/:id — (admin-only) ──────────────────────────────
// Nullifies org_id on all linked items; members are cascade-deleted.
router.delete('/:id', requireAuth, requirePermission('manage_organisations'), (req, res) => {
  try {
    const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(req.params.id)
    if (!org) return res.status(404).json({ error: 'Organisation not found' })
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM location_organisations WHERE org_id = ?').run(req.params.id)
      db.prepare(`UPDATE locations SET org_id = (
        SELECT lo.org_id FROM location_organisations lo
        WHERE lo.location_id = locations.id ORDER BY lo.org_id LIMIT 1
      ) WHERE org_id = ?`).run(req.params.id)
      db.prepare('UPDATE task_lists      SET org_id = NULL WHERE org_id = ?').run(req.params.id)
      db.prepare('UPDATE shift_templates SET org_id = NULL WHERE org_id = ?').run(req.params.id)
      db.prepare('UPDATE teams           SET org_id = NULL WHERE org_id = ?').run(req.params.id)
      db.prepare('DELETE FROM organisations WHERE id = ?').run(req.params.id)
    })
    tx()
    audit(req.user.id, 'org.delete', 'organisation', req.params.id, org.name, { by: req.user.name })
    res.json({ ok: true })
  } catch (err) {
    logger.error('organisation delete:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/organisations/:id/members — replace full member list (admin-only) ─
router.put('/:id/members', requireAuth, requirePermission('manage_organisations'), (req, res) => {
  try {
    const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(req.params.id)
    if (!org) return res.status(404).json({ error: 'Organisation not found' })
    const { user_ids } = req.body
    if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array.' })
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM organisation_members WHERE org_id = ?').run(req.params.id)
      const ins = db.prepare('INSERT OR IGNORE INTO organisation_members (org_id, user_id) VALUES (?,?)')
      user_ids.forEach(uid => ins.run(req.params.id, uid))
    })
    tx()
    audit(req.user.id, 'org.members_update', 'organisation', req.params.id, org.name, { count: user_ids.length, by: req.user.name })
    res.json({ ok: true })
  } catch (err) {
    logger.error('organisation members put:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
