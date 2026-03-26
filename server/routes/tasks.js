'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db     = require('../db/connection')
const { requireAuth, requireAdmin, requireShiftLead } = require('../middleware/auth')
const audit  = require('../audit')
const { getShiftLeadScope } = require('../utils/scope')
const { DEFAULT_COLOR, normalizeColorInput, resolveStoredColor } = require('../utils/color-utils')
const logger = require('../utils/logger')

// ── GET /api/tasks/lists — list all task lists ────────────────────────────────
// Admin: all lists. Others: unassigned lists (org_id IS NULL) + lists in their orgs.
router.get('/lists', requireAuth, (req, res) => {
  try {
    let lists
    if (req.user.role === 'admin') {
      lists = db.prepare(`
        SELECT t.*, u.name as created_by_name, l.name as location_name, l.color as location_color,
               o.name as org_name, o.id as org_id, g.name as group_name
        FROM task_lists t
        LEFT JOIN users u ON u.id = t.created_by
        LEFT JOIN locations l ON l.id = t.location_id
        LEFT JOIN organisations o ON o.id = t.org_id
        LEFT JOIN task_list_groups g ON g.id = t.group_id
        ORDER BY o.name, t.sort_order, t.name
      `).all()
    } else {
      lists = db.prepare(`
        SELECT t.*, u.name as created_by_name, l.name as location_name, l.color as location_color,
               o.name as org_name, o.id as org_id, g.name as group_name
        FROM task_lists t
        LEFT JOIN users u ON u.id = t.created_by
        LEFT JOIN locations l ON l.id = t.location_id
        LEFT JOIN organisations o ON o.id = t.org_id
        LEFT JOIN task_list_groups g ON g.id = t.group_id
        WHERE t.org_id IS NULL
           OR t.org_id IN (SELECT org_id FROM organisation_members WHERE user_id = ?)
        ORDER BY o.name, t.sort_order, t.name
      `).all(req.user.id)
    }
    res.json(lists)
  } catch (err) {
    logger.error('tasks/lists get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/tasks/lists — create a task list ────────────────────────────────
router.post('/lists', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, color, description, location_id, sort_order, org_id, label } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' })
    const id = uuidv4()
    db.prepare('INSERT INTO task_lists (id, name, color, description, location_id, sort_order, org_id, label, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        name.trim(),
        resolveStoredColor(color, DEFAULT_COLOR),
        description?.trim() || null,
        location_id || null,
        sort_order ?? 0,
        org_id || null,
        label?.trim() || null,
        req.user.id
      )
    const list = db.prepare(`
      SELECT t.*, l.name as location_name, l.color as location_color, o.name as org_name
      FROM task_lists t
      LEFT JOIN locations l ON l.id = t.location_id
      LEFT JOIN organisations o ON o.id = t.org_id
      WHERE t.id = ?`).get(id)
    audit(req.user.id, 'task_list.create', 'task_list', id, name.trim())
    res.status(201).json(list)
  } catch (err) {
    logger.error('task list create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/tasks/lists/:id — update a task list ─────────────────────────────
router.put('/lists/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM task_lists WHERE id = ?').get(req.params.id)
    if (!list) return res.status(404).json({ error: 'Task list not found' })
    const { name, color, description, location_id, sort_order, org_id, label } = req.body
    db.prepare('UPDATE task_lists SET name=?, color=?, description=?, location_id=?, sort_order=?, org_id=?, label=? WHERE id=?')
      .run(
        name?.trim() || list.name,
        color !== undefined ? normalizeColorInput(color) : list.color,
        description !== undefined ? (description?.trim() || null) : list.description,
        location_id !== undefined ? (location_id || null) : list.location_id,
        sort_order ?? list.sort_order,
        org_id !== undefined ? (org_id || null) : list.org_id,
        label !== undefined ? (label?.trim() || null) : list.label,
        req.params.id
      )
    const updated = db.prepare(`
      SELECT t.*, l.name as location_name, l.color as location_color,
             o.name as org_name
      FROM task_lists t
      LEFT JOIN locations l ON l.id = t.location_id
      LEFT JOIN organisations o ON o.id = t.org_id
      WHERE t.id = ?`).get(req.params.id)
    audit(req.user.id, 'task_list.update', 'task_list', req.params.id, updated.name)
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
    audit(req.user.id, 'task_list.delete', 'task_list', req.params.id, list.name)
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
             tl.name as task_list_name, tl.color as task_list_color,
             tl.description as task_list_description,
             l.name as location_name, l.color as location_color, l.id as location_id
      FROM task_assignments a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN task_lists tl ON tl.id = a.task_list_id
      LEFT JOIN locations l ON l.id = tl.location_id
      WHERE 1=1
    `
    const params = []
    if (start)   { sql += ' AND a.date >= ?'; params.push(start) }
    if (end)     { sql += ' AND a.date <= ?'; params.push(end) }
    if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id) }

    if (req.user.role === 'admin' || req.user.role === 'manager') {
      // no extra filter — admins and managers see all assignments
    } else if (req.user.role === 'shift_lead') {
      // Always constrain to team scope whether or not a specific user_id was requested.
      const scope = getShiftLeadScope(req.user.id)
      const scopeIds = [...scope]
      if (user_id) {
        // Specific user requested — must be in scope
        if (!scope.has(user_id)) return res.status(403).json({ error: 'That user is not in your team.' })
        // user_id filter already applied to SQL above; no extra IN clause needed
      } else {
        sql += ` AND a.user_id IN (${scopeIds.map(() => '?').join(',')})`
        params.push(...scopeIds)
      }
    } else {
      if (!user_id) { sql += ' AND a.user_id = ?'; params.push(req.user.id) }
    }

    sql += ' ORDER BY a.date, u.name'
    const assignments = db.prepare(sql).all(...params)
    res.json(assignments)
  } catch (err) {
    logger.error('assignments get:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/tasks/assignments — create an assignment ────────────────────────
// Body: { user_id, task_list_id, date }
// To remove: send task_list_id = null (clears all for user+date) or DELETE /:id
router.post('/assignments', requireAuth, requireShiftLead, (req, res) => {
  try {
    const { user_id, task_list_id, date } = req.body
    if (!user_id || !date) return res.status(400).json({ error: 'user_id and date are required.' })

    // task_list_id null = clear all assignments for that user+date
    if (task_list_id === null || task_list_id === '') {
      db.prepare('DELETE FROM task_assignments WHERE user_id = ? AND date = ?').run(user_id, date)
      return res.json({ ok: true, cleared: true })
    }

    // Prevent duplicate (user+list+date)
    const existing = db.prepare(
      'SELECT id FROM task_assignments WHERE user_id = ? AND task_list_id = ? AND date = ?'
    ).get(user_id, task_list_id, date)
    if (existing) return res.status(409).json({ error: 'This task is already assigned to that user on this date.' })

    const id = uuidv4()
    db.prepare('INSERT INTO task_assignments (id, user_id, task_list_id, date, created_by) VALUES (?,?,?,?,?)')
      .run(id, user_id, task_list_id, date, req.user.id)
    const assignment = db.prepare(`
      SELECT a.*, tl.name as task_list_name, tl.color as task_list_color,
             tl.description as task_list_description,
             l.name as location_name, l.color as location_color
      FROM task_assignments a
      LEFT JOIN task_lists tl ON tl.id = a.task_list_id
      LEFT JOIN locations l ON l.id = tl.location_id
      WHERE a.id = ?`).get(id)
    audit(req.user.id, 'task_assignment.create', 'task_assignment', id, date, { user_id, task_list_id })
    res.status(201).json(assignment)
  } catch (err) {
    logger.error('assignment create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/tasks/assignments/bulk — assign a task list to multiple dates ────
// Body: { user_id, task_list_id, dates: ['YYYY-MM-DD', ...] }
// Skips silently any date that already has this user+list combo (idempotent).
router.post('/assignments/bulk', requireAuth, requireShiftLead, (req, res) => {
  try {
    const { user_id, task_list_id, dates } = req.body
    if (!user_id || !task_list_id) return res.status(400).json({ error: 'user_id and task_list_id are required.' })
    if (!Array.isArray(dates) || !dates.length) return res.status(400).json({ error: 'dates must be a non-empty array.' })

    const insert = db.prepare(
      'INSERT OR IGNORE INTO task_assignments (id, user_id, task_list_id, date, created_by) VALUES (?,?,?,?,?)'
    )
    const created = []
    const bulkTx = db.transaction(() => {
      for (const date of dates) {
        const id = uuidv4()
        const info = insert.run(id, user_id, task_list_id, date, req.user.id)
        if (info.changes > 0) created.push({ id, date })
      }
    })
    bulkTx()

    if (created.length) {
      audit(req.user.id, 'task_assignment.bulk_create', 'task_assignment', user_id,
        `${created.length} date(s)`, { task_list_id, dates: created.map(c => c.date) })
    }
    res.status(201).json({ created: created.length, skipped: dates.length - created.length })
  } catch (err) {
    logger.error('assignment bulk create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})


router.delete('/assignments/:id', requireAuth, requireShiftLead, (req, res) => {
  try {
    const a = db.prepare('SELECT * FROM task_assignments WHERE id = ?').get(req.params.id)
    if (!a) return res.status(404).json({ error: 'Assignment not found' })
    db.prepare('DELETE FROM task_assignments WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'task_assignment.delete', 'task_assignment', req.params.id, a.date, { user_id: a.user_id })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
