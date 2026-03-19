'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin, requireShiftLead } = require('../middleware/auth')
const audit  = require('../audit')

// ── GET /api/tasks/lists — list all task lists ────────────────────────────────
router.get('/lists', requireAuth, (req, res) => {
  try {
    const lists = db.prepare(`
      SELECT t.*, u.name as created_by_name
      FROM task_lists t
      LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.sort_order, t.name
    `).all()
    res.json(lists)
  } catch (err) {
    console.error('tasks/lists get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/tasks/lists — create a task list ────────────────────────────────
router.post('/lists', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, color, sort_order } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' })
    const id = uuidv4()
    db.prepare('INSERT INTO task_lists (id, name, color, sort_order, created_by) VALUES (?,?,?,?,?)')
      .run(id, name.trim(), color || '#0052cc', sort_order ?? 0, req.user.id)
    const list = db.prepare('SELECT * FROM task_lists WHERE id = ?').get(id)
    audit(req.user.id, 'tasklist.create', 'task_list', id, name.trim())
    res.status(201).json(list)
  } catch (err) {
    console.error('task list create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/tasks/lists/:id — update a task list ─────────────────────────────
router.put('/lists/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM task_lists WHERE id = ?').get(req.params.id)
    if (!list) return res.status(404).json({ error: 'Task list not found' })
    const { name, color, sort_order } = req.body
    db.prepare('UPDATE task_lists SET name=?, color=?, sort_order=? WHERE id=?')
      .run(name?.trim() || list.name, color || list.color, sort_order ?? list.sort_order, req.params.id)
    const updated = db.prepare('SELECT * FROM task_lists WHERE id = ?').get(req.params.id)
    audit(req.user.id, 'tasklist.update', 'task_list', req.params.id, updated.name)
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/tasks/lists/:id — delete a task list ─────────────────────────
router.delete('/lists/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM task_lists WHERE id = ?').get(req.params.id)
    if (!list) return res.status(404).json({ error: 'Task list not found' })
    db.prepare('DELETE FROM task_lists WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'tasklist.delete', 'task_list', req.params.id, list.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/tasks/assignments ────────────────────────────────────────────────
router.get('/assignments', requireAuth, (req, res) => {
  try {
    const { start, end, user_id } = req.query
    let sql = `
      SELECT a.*, u.name as user_name, u.initials as user_initials, u.color as user_color,
             tl.name as task_list_name, tl.color as task_list_color
      FROM task_assignments a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN task_lists tl ON tl.id = a.task_list_id
      WHERE 1=1
    `
    const params = []
    if (start)   { sql += ' AND a.week_start >= ?'; params.push(start) }
    if (end)     { sql += ' AND a.week_start <= ?'; params.push(end) }
    if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id) }

    if (req.user.role === 'admin') {
      // no extra filter
    } else if (req.user.role === 'shift_lead') {
      if (!user_id) {
        // Scope to own team members
        const teams = db.prepare('SELECT id FROM teams WHERE owned_by = ? OR created_by = ?').all(req.user.id, req.user.id)
        if (teams.length) {
          const teamIds = teams.map(t => t.id)
          const members = db.prepare(
            `SELECT DISTINCT user_id FROM team_members WHERE team_id IN (${teamIds.map(() => '?').join(',')})`
          ).all(...teamIds).map(m => m.user_id)
          members.push(req.user.id)
          sql += ` AND a.user_id IN (${members.map(() => '?').join(',')})`
          params.push(...members)
        } else {
          sql += ' AND a.user_id = ?'; params.push(req.user.id)
        }
      }
    } else {
      if (!user_id) { sql += ' AND a.user_id = ?'; params.push(req.user.id) }
    }

    sql += ' ORDER BY a.week_start, u.name'
    const assignments = db.prepare(sql).all(...params)
    res.json(assignments)
  } catch (err) {
    console.error('assignments get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/tasks/assignments — create/update an assignment ─────────────────
router.post('/assignments', requireAuth, requireShiftLead, (req, res) => {
  try {
    const { user_id, task_list_id, week_start } = req.body
    if (!user_id || !week_start) return res.status(400).json({ error: 'user_id and week_start are required.' })

    // task_list_id null = clear assignment
    if (task_list_id === null || task_list_id === '') {
      db.prepare('DELETE FROM task_assignments WHERE user_id = ? AND week_start = ?').run(user_id, week_start)
      return res.json({ ok: true, cleared: true })
    }

    const existing = db.prepare('SELECT id FROM task_assignments WHERE user_id = ? AND week_start = ?').get(user_id, week_start)
    if (existing) {
      db.prepare('UPDATE task_assignments SET task_list_id=?, created_by=? WHERE id=?')
        .run(task_list_id, req.user.id, existing.id)
      const updated = db.prepare(`
        SELECT a.*, tl.name as task_list_name, tl.color as task_list_color
        FROM task_assignments a LEFT JOIN task_lists tl ON tl.id = a.task_list_id
        WHERE a.id = ?`).get(existing.id)
      audit(req.user.id, 'task_assignment.update', 'task_assignment', existing.id, week_start, { user_id, task_list_id })
      return res.json(updated)
    }

    const id = uuidv4()
    db.prepare('INSERT INTO task_assignments (id, user_id, task_list_id, week_start, created_by) VALUES (?,?,?,?,?)')
      .run(id, user_id, task_list_id, week_start, req.user.id)
    const assignment = db.prepare(`
      SELECT a.*, tl.name as task_list_name, tl.color as task_list_color
      FROM task_assignments a LEFT JOIN task_lists tl ON tl.id = a.task_list_id
      WHERE a.id = ?`).get(id)
    audit(req.user.id, 'task_assignment.create', 'task_assignment', id, week_start, { user_id, task_list_id })
    res.status(201).json(assignment)
  } catch (err) {
    console.error('assignment create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
