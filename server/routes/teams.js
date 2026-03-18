'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit = require('../audit')

const COLORS = ['#0052cc','#00875a','#6554c0','#ff5630','#ff991f','#36b37e','#00b8d9','#e01e5a','#904ee2','#0065ff']

// ── GET /api/teams — list all teams with member counts ────────────────────────
router.get('/', requireAuth, (req, res) => {
  const teams = db.prepare(`
    SELECT t.id, t.name, t.color, t.created_at,
           COUNT(tm.user_id) AS member_count
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id
    GROUP BY t.id
    ORDER BY t.name
  `).all()

  // Attach member list
  const members = db.prepare(`
    SELECT tm.team_id, u.id, u.name, u.initials, u.color, u.avatar, u.role, u.is_active
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    ORDER BY u.name
  `).all()

  const membersByTeam = {}
  members.forEach(m => {
    if (!membersByTeam[m.team_id]) membersByTeam[m.team_id] = []
    membersByTeam[m.team_id].push({ id: m.id, name: m.name, initials: m.initials, color: m.color, avatar: m.avatar, role: m.role, is_active: m.is_active })
  })

  teams.forEach(t => { t.members = membersByTeam[t.id] || [] })
  res.json(teams)
})

// ── POST /api/teams — create a team ──────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const { name, color } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Team name is required.' })

  const count = db.prepare('SELECT COUNT(*) AS c FROM teams').get().c
  const teamColor = color || COLORS[count % COLORS.length]
  const id = uuidv4()

  db.prepare('INSERT INTO teams (id, name, color, created_by) VALUES (?,?,?,?)')
    .run(id, name.trim(), teamColor, req.user.id)

  audit(req.user.id, 'team.create', 'team', id, name.trim(), { by: req.user.name })
  const team = db.prepare('SELECT id, name, color, created_at FROM teams WHERE id = ?').get(id)
  team.members = []
  res.status(201).json(team)
})

// ── PATCH /api/teams/:id — rename / recolour ──────────────────────────────────
router.patch('/:id', requireAuth, requireAdmin, (req, res) => {
  const { name, color } = req.body
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })

  const updates = []; const vals = []
  if (name?.trim())  { updates.push('name = ?');  vals.push(name.trim()) }
  if (color)         { updates.push('color = ?'); vals.push(color) }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

  vals.push(req.params.id)
  db.prepare(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`).run(...vals)
  audit(req.user.id, 'team.update', 'team', req.params.id, name || team.name, { by: req.user.name })
  res.json(db.prepare('SELECT id, name, color, created_at FROM teams WHERE id = ?').get(req.params.id))
})

// ── DELETE /api/teams/:id ─────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id)
  audit(req.user.id, 'team.delete', 'team', req.params.id, team.name, { by: req.user.name })
  res.json({ ok: true })
})

// ── PUT /api/teams/:id/members — replace full member list ─────────────────────
router.put('/:id/members', requireAuth, requireAdmin, (req, res) => {
  const { user_ids } = req.body
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array' })

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })

  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(req.params.id)
  const insert = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)')
  user_ids.forEach(uid => insert.run(req.params.id, uid))

  audit(req.user.id, 'team.members_update', 'team', req.params.id, team.name, { count: user_ids.length, by: req.user.name })
  res.json({ ok: true })
})

// ── POST /api/teams/:id/members/:userId — add one member ─────────────────────
router.post('/:id/members/:userId', requireAuth, requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId)
  if (!user) return res.status(404).json({ error: 'User not found' })

  db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)').run(req.params.id, req.params.userId)
  res.json({ ok: true })
})

// ── DELETE /api/teams/:id/members/:userId — remove one member ─────────────────
router.delete('/:id/members/:userId', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(req.params.id, req.params.userId)
  res.json({ ok: true })
})

module.exports = router
