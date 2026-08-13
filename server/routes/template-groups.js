'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { hasPermission } = require('../utils/roles')
const audit  = require('../audit')
const logger = require('../utils/logger')

// ── GET /api/template-groups ──────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  if (!hasPermission(req, 'view_templates') && !hasPermission(req, 'manage_templates')) {
    return res.status(403).json({ error: 'You do not have permission to view templates.' })
  }
  const canViewAllGroups = req.user.role === 'admin' || hasPermission(req, 'manage_templates')
  const groups = canViewAllGroups
    ? db.prepare(`
        SELECT g.*, COUNT(DISTINCT t.id) as template_count, COUNT(DISTINCT utg.user_id) as member_count
        FROM template_groups g
        LEFT JOIN shift_templates t ON t.group_id = g.id
        LEFT JOIN user_template_groups utg ON utg.group_id = g.id
        GROUP BY g.id
        ORDER BY g.sort_order, g.name
      `).all()
    : db.prepare(`
        SELECT g.*, COUNT(DISTINCT t.id) as template_count, COUNT(DISTINCT utg.user_id) as member_count
        FROM template_groups g
        JOIN user_template_groups visible_utg ON visible_utg.group_id = g.id AND visible_utg.user_id = ?
        LEFT JOIN shift_templates t ON t.group_id = g.id
        LEFT JOIN user_template_groups utg ON utg.group_id = g.id
        GROUP BY g.id
        ORDER BY g.sort_order, g.name
      `).all(req.user.id)

  // Attach member list (id + name + role) to each group for admin display
  if (req.user.role === 'admin' || hasPermission(req, 'manage_templates')) {
    const members = db.prepare(`
      SELECT utg.group_id, u.id, u.name, u.role, u.color, u.initials
      FROM user_template_groups utg
      JOIN users u ON u.id = utg.user_id
      ORDER BY u.name
    `).all()
    const byGroup = {}
    members.forEach(m => {
      if (!byGroup[m.group_id]) byGroup[m.group_id] = []
      byGroup[m.group_id].push({ id: m.id, name: m.name, role: m.role, color: m.color, initials: m.initials })
    })
    groups.forEach(g => { g.members = byGroup[g.id] || [] })
  }

  res.json(groups)
})

// ── POST /api/template-groups ─────────────────────────────────────────────────
router.post('/', requireAuth, requirePermission('manage_templates'), (req, res) => {
  try {
    const { name } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Group name is required.' })
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM template_groups').get()
    const sort_order = (maxSort?.m ?? -1) + 1
    const id = uuidv4()
    db.prepare('INSERT INTO template_groups (id, name, sort_order, created_by) VALUES (?,?,?,?)')
      .run(id, name.trim(), sort_order, req.user.id)
    audit(req.user.id, 'template_group.create', 'template_group', id, name.trim())
    const group = db.prepare('SELECT * FROM template_groups WHERE id = ?').get(id)
    group.members = []
    group.template_count = 0
    group.member_count = 0
    res.status(201).json(group)
  } catch (err) {
    logger.error('template_group create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/template-groups/:id ───────────────────────────────────────────
router.patch('/:id', requireAuth, requirePermission('manage_templates'), (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM template_groups WHERE id = ?').get(req.params.id)
    if (!group) return res.status(404).json({ error: 'Group not found' })
    const name = req.body.name?.trim() ?? group.name
    if (!name) return res.status(400).json({ error: 'Group name is required.' })
    db.prepare('UPDATE template_groups SET name = ? WHERE id = ?').run(name, req.params.id)
    audit(req.user.id, 'template_group.update', 'template_group', req.params.id, name)
    res.json(db.prepare('SELECT * FROM template_groups WHERE id = ?').get(req.params.id))
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/template-groups/:id ──────────────────────────────────────────
router.delete('/:id', requireAuth, requirePermission('manage_templates'), (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM template_groups WHERE id = ?').get(req.params.id)
    if (!group) return res.status(404).json({ error: 'Group not found' })
    db.prepare('UPDATE shift_templates SET group_id = NULL WHERE group_id = ?').run(req.params.id)
    db.prepare('DELETE FROM user_template_groups WHERE group_id = ?').run(req.params.id)
    db.prepare('DELETE FROM template_groups WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'template_group.delete', 'template_group', req.params.id, group.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/template-groups/:id/members — replace full member list ───────────
router.put('/:id/members', requireAuth, requirePermission('manage_templates'), (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM template_groups WHERE id = ?').get(req.params.id)
    if (!group) return res.status(404).json({ error: 'Group not found' })
    const { user_ids } = req.body
    if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array.' })

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM user_template_groups WHERE group_id = ?').run(req.params.id)
      const ins = db.prepare('INSERT OR IGNORE INTO user_template_groups (user_id, group_id) VALUES (?,?)')
      user_ids.forEach(uid => ins.run(uid, req.params.id))
    })
    tx()
    audit(req.user.id, 'template_group.members_updated', 'template_group', req.params.id, group.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
