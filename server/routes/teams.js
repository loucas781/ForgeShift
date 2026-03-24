'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db = require('../db/connection')
const { requireAuth, requireAdmin, requireShiftLead } = require('../middleware/auth')
const audit = require('../audit')

const COLORS = ['#0052cc','#00875a','#6554c0','#ff5630','#ff991f','#36b37e','#00b8d9','#e01e5a','#904ee2','#0065ff']

// Helper: can this user manage this team?
// admin: yes always; shift_lead: only teams they own; member: no
function canManageTeam(user, team) {
  if (user.role === 'admin') return true
  if (user.role === 'shift_lead') return team.owned_by === user.id || team.created_by === user.id
  return false
}

// ── GET /api/teams ────────────────────────────────────────────────────────────
// admin: all teams | shift_lead: own teams | member: teams they're in
router.get('/', requireAuth, (req, res) => {
  const { role, id: userId } = req.user
  let teams

  if (role === 'admin') {
    teams = db.prepare(`
      SELECT t.id, t.name, t.color, t.created_at, t.owned_by,
             COUNT(tm.user_id) AS member_count
      FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
      GROUP BY t.id ORDER BY t.name
    `).all()
  } else if (role === 'shift_lead') {
    // Shift lead sees teams in their orgs, plus teams they own/created (fallback)
    teams = db.prepare(`
      SELECT t.id, t.name, t.color, t.created_at, t.owned_by,
             COUNT(tm.user_id) AS member_count
      FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
      WHERE t.org_id IN (SELECT org_id FROM organisation_members WHERE user_id = ?)
         OR t.owned_by = ? OR t.created_by = ?
      GROUP BY t.id ORDER BY t.name
    `).all(userId, userId, userId)
  } else {
    teams = db.prepare(`
      SELECT t.id, t.name, t.color, t.created_at, t.owned_by,
             COUNT(tm2.user_id) AS member_count
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
      LEFT JOIN team_members tm2 ON tm2.team_id = t.id
      GROUP BY t.id ORDER BY t.name
    `).all(userId)
  }

  if (teams.length) {
    const teamIds = teams.map(t => t.id)
    const members = db.prepare(`
      SELECT tm.team_id, u.id, u.name, u.initials, u.color, u.avatar, u.role, u.is_active
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id IN (${teamIds.map(() => '?').join(',')})
      ORDER BY u.name
    `).all(...teamIds)
    const membersByTeam = {}
    members.forEach(m => {
      if (!membersByTeam[m.team_id]) membersByTeam[m.team_id] = []
      membersByTeam[m.team_id].push({ id: m.id, name: m.name, initials: m.initials, color: m.color, avatar: m.avatar, role: m.role, is_active: m.is_active })
    })
    teams.forEach(t => { t.members = membersByTeam[t.id] || [] })
  } else {
    teams.forEach(t => { t.members = [] })
  }
  res.json(teams)
})

// ── POST /api/teams — create (admin or shift_lead) ────────────────────────────
router.post('/', requireAuth, requireShiftLead, (req, res) => {
  const { name, color, org_id } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Team name is required.' })
  const count = db.prepare('SELECT COUNT(*) AS c FROM teams').get().c
  const teamColor = color || COLORS[count % COLORS.length]
  const id = uuidv4()
  db.prepare('INSERT INTO teams (id, name, color, org_id, created_by, owned_by) VALUES (?,?,?,?,?,?)')
    .run(id, name.trim(), teamColor, org_id || null, req.user.id, req.user.id)
  audit(req.user.id, 'team.create', 'team', id, name.trim(), { by: req.user.name })
  const team = db.prepare('SELECT id, name, color, org_id, created_at, owned_by FROM teams WHERE id = ?').get(id)
  team.members = []
  res.status(201).json(team)
})

// ── PATCH /api/teams/:id — rename / recolour / reassign org ──────────────────
router.patch('/:id', requireAuth, requireShiftLead, (req, res) => {
  const { name, color, org_id } = req.body
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })
  if (!canManageTeam(req.user, team)) return res.status(403).json({ error: 'You can only edit your own teams' })
  const updates = []; const vals = []
  if (name?.trim())         { updates.push('name = ?');   vals.push(name.trim()) }
  if (color)                { updates.push('color = ?');  vals.push(color) }
  if (org_id !== undefined) { updates.push('org_id = ?'); vals.push(org_id || null) }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })
  vals.push(req.params.id)
  db.prepare(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`).run(...vals)
  audit(req.user.id, 'team.update', 'team', req.params.id, name || team.name, { by: req.user.name })
  res.json(db.prepare('SELECT id, name, color, org_id, created_at, owned_by FROM teams WHERE id = ?').get(req.params.id))
})

// ── DELETE /api/teams/:id ─────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireShiftLead, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })
  if (!canManageTeam(req.user, team)) return res.status(403).json({ error: 'You can only delete your own teams' })
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id)
  audit(req.user.id, 'team.delete', 'team', req.params.id, team.name, { by: req.user.name })
  res.json({ ok: true })
})

// ── PUT /api/teams/:id/members — replace full member list ─────────────────────
router.put('/:id/members', requireAuth, requireShiftLead, (req, res) => {
  const { user_ids } = req.body
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array' })
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })
  if (!canManageTeam(req.user, team)) return res.status(403).json({ error: 'You can only manage your own teams' })

  let resolvedIds = user_ids
  if (req.user.role === 'shift_lead' && user_ids.length > 0) {
    // Only allow members (and themselves) — not other admins/shift_leads
    const safePlaceholders = user_ids.map(() => '?').join(',')
    const allowed = db.prepare(`SELECT id FROM users WHERE id IN (${safePlaceholders}) AND role = 'member'`).all(...user_ids).map(u => u.id)
    if (!allowed.includes(req.user.id)) allowed.push(req.user.id)
    resolvedIds = allowed
  }

  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(req.params.id)
  const insert = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)')
  resolvedIds.forEach(uid => insert.run(req.params.id, uid))
  audit(req.user.id, 'team.members_update', 'team', req.params.id, team.name, { count: resolvedIds.length, by: req.user.name })
  res.json({ ok: true })
})

// ── POST /api/teams/:id/members/:userId ───────────────────────────────────────
router.post('/:id/members/:userId', requireAuth, requireShiftLead, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })
  if (!canManageTeam(req.user, team)) return res.status(403).json({ error: 'You can only manage your own teams' })
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.userId)
  if (!user) return res.status(404).json({ error: 'User not found' })
  if (req.user.role === 'shift_lead' && user.role !== 'member' && user.id !== req.user.id)
    return res.status(403).json({ error: 'Shift leads can only add members to teams' })
  db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)').run(req.params.id, req.params.userId)
  res.json({ ok: true })
})

// ── DELETE /api/teams/:id/members/:userId ─────────────────────────────────────
router.delete('/:id/members/:userId', requireAuth, requireShiftLead, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id)
  if (!team) return res.status(404).json({ error: 'Team not found' })
  if (!canManageTeam(req.user, team)) return res.status(403).json({ error: 'You can only manage your own teams' })
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(req.params.id, req.params.userId)
  res.json({ ok: true })
})

module.exports = router
