'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit  = require('../audit')

// ── GET /api/task-list-groups ─────────────────────────────────────────────────
// Admin: all groups with full member details. Others: only groups they belong to.
router.get('/', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    const groups = db.prepare(`
      SELECT g.id, g.name, g.sort_order
      FROM task_list_groups g
      JOIN user_task_list_groups utlg ON utlg.group_id = g.id
      WHERE utlg.user_id = ?
      ORDER BY g.sort_order, g.name
    `).all(req.user.id)
    return res.json(groups)
  }

  const groups = db.prepare(`
    SELECT g.*, COUNT(DISTINCT tl.id) as list_count, COUNT(DISTINCT utlg.user_id) as member_count
    FROM task_list_groups g
    LEFT JOIN task_lists tl ON tl.group_id = g.id
    LEFT JOIN user_task_list_groups utlg ON utlg.group_id = g.id
    GROUP BY g.id
    ORDER BY g.sort_order, g.name
  `).all()

  const members = db.prepare(`
    SELECT utlg.group_id, u.id, u.name, u.role, u.color, u.initials
    FROM user_task_list_groups utlg
    JOIN users u ON u.id = utlg.user_id
    ORDER BY u.name
  `).all()
  const byGroup = {}
  members.forEach(m => {
    if (!byGroup[m.group_id]) byGroup[m.group_id] = []
    byGroup[m.group_id].push({ id: m.id, name: m.name, role: m.role, color: m.color, initials: m.initials })
  })
  groups.forEach(g => { g.members = byGroup[g.id] || [] })

  res.json(groups)
})

// ── POST /api/task-list-groups ────────────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Group name is required.' })
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM task_list_groups').get()
    const sort_order = (maxSort?.m ?? -1) + 1
    const id = uuidv4()
    db.prepare('INSERT INTO task_list_groups (id, name, sort_order, created_by) VALUES (?,?,?,?)')
      .run(id, name.trim(), sort_order, req.user.id)
    audit(req.user.id, 'task_list_group.create', 'task_list_group', id, name.trim())
    const group = db.prepare('SELECT * FROM task_list_groups WHERE id = ?').get(id)
    group.members = []
    group.list_count = 0
    group.member_count = 0
    res.status(201).json(group)
  } catch (err) {
    console.error('task_list_group create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/task-list-groups/:id ──────────────────────────────────────────
router.patch('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM task_list_groups WHERE id = ?').get(req.params.id)
    if (!group) return res.status(404).json({ error: 'Group not found' })
    const name = req.body.name?.trim() ?? group.name
    if (!name) return res.status(400).json({ error: 'Group name is required.' })
    db.prepare('UPDATE task_list_groups SET name = ? WHERE id = ?').run(name, req.params.id)
    audit(req.user.id, 'task_list_group.update', 'task_list_group', req.params.id, name)
    res.json(db.prepare('SELECT * FROM task_list_groups WHERE id = ?').get(req.params.id))
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/task-list-groups/:id ─────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM task_list_groups WHERE id = ?').get(req.params.id)
    if (!group) return res.status(404).json({ error: 'Group not found' })
    db.prepare('UPDATE task_lists SET group_id = NULL WHERE group_id = ?').run(req.params.id)
    db.prepare('DELETE FROM user_task_list_groups WHERE group_id = ?').run(req.params.id)
    db.prepare('DELETE FROM task_list_groups WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'task_list_group.delete', 'task_list_group', req.params.id, group.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/task-list-groups/:id/members — replace full member list ──────────
router.put('/:id/members', requireAuth, requireAdmin, (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM task_list_groups WHERE id = ?').get(req.params.id)
    if (!group) return res.status(404).json({ error: 'Group not found' })
    const { user_ids } = req.body
    if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array.' })

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM user_task_list_groups WHERE group_id = ?').run(req.params.id)
      const ins = db.prepare('INSERT OR IGNORE INTO user_task_list_groups (user_id, group_id) VALUES (?,?)')
      user_ids.forEach(uid => ins.run(uid, req.params.id))
    })
    tx()
    audit(req.user.id, 'task_list_group.members_updated', 'task_list_group', req.params.id, group.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
