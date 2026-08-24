'use strict'
const router  = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const { hashPassword, getPasswordPolicy, validatePassword } = require('../auth-utils')
const db      = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit   = require('../audit')
const fs      = require('fs')
const path    = require('path')
const multer  = require('multer')
const logger  = require('../utils/logger')
const { loadOverrides } = require('../utils/overrides')
const { getShiftLeadScope, getOrganisationScope } = require('../utils/scope')
const { BUILTIN, parsePermissions, hasPermission, canGrantRole, canManageUserRole } = require('../utils/roles')

// ── Avatar upload storage ──────────────────────────────────────────────────────
const AVATARS_DIR = path.join(__dirname, '../../public/uploads/avatars')
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true })

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (req, _file, cb) => cb(null, `${req.avatarTargetId || req.user.id}.jpg`),
})
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'))
    cb(null, true)
  },
})

function getInitials(name) {
  return name.trim().split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2)
}
function canViewFullUserDirectory(req) {
  return req.user.role === 'admin' || hasPermission(req, 'manage_users')
}
function serializeUser(user, req) {
  if (!user) return user
  if (typeof user.permissions === 'string') user.permissions = parsePermissions(user.permissions)
  if (req && user.id !== req.user.id && !canViewFullUserDirectory(req)) {
    delete user.email
    delete user.permissions
    delete user.previous_role_id
    delete user.created_at
  }
  return user
}
function canListUsers(req) {
  return [
    'view_other_rotas',
    'view_team_rotas',
    'view_all_rotas',
    'view_teams',
    'add_other_shifts',
    'edit_other_shifts',
    'delete_other_shifts',
    'manage_team_shifts',
    'manage_org_shifts',
    'manage_all_shifts',
    'manage_team_tasks',
    'manage_all_tasks',
    'manage_users',
    'manage_teams',
    'manage_own_teams',
    'manage_all_teams',
    'manage_locations',
    'manage_organisations',
    'manage_tasks',
  ]
    .some(permission => hasPermission(req, permission))
}

function canListAllUsers(req) {
  return req.user.role === 'admin' || [
    'view_all_rotas',
    'manage_all_shifts',
    'manage_all_tasks',
    'manage_all_teams',
    'manage_tasks',
    'manage_teams',
    'manage_locations',
    'manage_organisations',
    'manage_users',
  ].some(permission => hasPermission(req, permission))
}

function getVisibleUserScope(req) {
  // Built-in Manager and Shift Lead remain organisation/team scoped even though
  // they retain several legacy generic management permissions.
  if (req.user.role === 'admin') return null
  if (req.user.role === 'shift_lead') return getShiftLeadScope(req.user.id)
  if (req.user.role === 'manager') return getOrganisationScope(req.user.id)
  if (canListAllUsers(req)) return null
  if (canListUsers(req)) return getOrganisationScope(req.user.id)
  return new Set([req.user.id])
}
const COLORS = ['#0052cc','#00875a','#6554c0','#ff5630','#ff991f','#36b37e','#00b8d9','#e01e5a','#904ee2','#0065ff']

function canViewUser(req, userId) {
  if (userId === req.user.id) return true
  if (!canListUsers(req)) return false
  const visibleIds = getVisibleUserScope(req)
  return visibleIds === null || visibleIds.has(userId)
}

// ── GET /api/users ────────────────────────────────────────────────────────────
// Supports optional ?limit=N&offset=N pagination. Without these params returns all users.
router.get('/', requireAuth, (req, res) => {
  res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=30')
  const mayListUsers = canListUsers(req)
  const visibleIds = mayListUsers ? getVisibleUserScope(req) : new Set([req.user.id])
  if (!mayListUsers) {
    const user = db.prepare(
      `SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
              r.name AS role_name, r.color AS role_color, r.permissions AS permissions,
              u.previous_role_id, u.is_active, u.created_at FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id = ?`
    ).get(req.user.id)
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50'), 1), 200)
      const offset = Math.max(parseInt(req.query.offset || '0'), 0)
      return res.json({ users: user && offset === 0 ? [serializeUser(user, req)] : [], total: user ? 1 : 0, limit, offset })
    }
    return res.json(user ? [serializeUser(user, req)] : [])
  }
  const activeOnly = !canViewFullUserDirectory(req)
  if (req.query.limit !== undefined || req.query.offset !== undefined) {
    const limit  = Math.min(Math.max(parseInt(req.query.limit  || '50'), 1), 200)
    const offset = Math.max(parseInt(req.query.offset || '0'), 0)
    const conditions = []
    if (visibleIds) conditions.push(`u.id IN (${[...visibleIds].map(() => '?').join(',')})`)
    if (activeOnly) conditions.push('u.is_active = 1')
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const baseParams = visibleIds ? [...visibleIds] : []
    const users  = db.prepare(
      `SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
              r.name AS role_name, r.color AS role_color, r.permissions AS permissions,
              u.previous_role_id, u.is_active, u.created_at FROM users u LEFT JOIN roles r ON r.id=u.role_id${where} ORDER BY u.name LIMIT ? OFFSET ?`
    ).all(...baseParams, limit, offset)
    const total = db.prepare(`SELECT COUNT(*) as c FROM users u${where}`).get(...baseParams).c
      return res.json({ users: users.map(user => serializeUser(user, req)), total, limit, offset })
  }
  const conditions = []
  if (visibleIds) conditions.push(`u.id IN (${[...visibleIds].map(() => '?').join(',')})`)
  if (activeOnly) conditions.push('u.is_active = 1')
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const users = db.prepare(
    `SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
            r.name AS role_name, r.color AS role_color, r.permissions AS permissions, u.previous_role_id, u.is_active, u.created_at,
            MIN(tm.team_id) AS team_id
     FROM users u LEFT JOIN team_members tm ON tm.user_id = u.id LEFT JOIN roles r ON r.id=u.role_id${where}
     GROUP BY u.id
     ORDER BY u.name`
  ).all(...(visibleIds ? [...visibleIds] : []))
  res.json(users.map(user => serializeUser(user, req)))
})

// ── GET /api/users/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(
    `SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
            r.name AS role_name, r.color AS role_color, r.permissions AS permissions, u.is_active, u.created_at
       FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id = ?`
  ).get(req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json(serializeUser(user, req))
})

// ── GET /api/users/:id/avatar — serve avatar image ───────────────────────────
router.get('/:id/avatar', requireAuth, (req, res) => {
  if (!canViewUser(req, req.params.id)) return res.status(403).json({ error: 'Forbidden' })
  const filePath = path.join(AVATARS_DIR, `${req.params.id}.jpg`)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No avatar' })
  res.sendFile(filePath)
})

// ── GET /api/users/:id ────────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  if (!canViewUser(req, req.params.id)) return res.status(403).json({ error: 'Forbidden' })
  const user = db.prepare(
    `SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
            r.name AS role_name, r.color AS role_color, r.permissions AS permissions, u.is_active, u.created_at
       FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id = ?`
  ).get(req.params.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json(serializeUser(user, req))
})

// ── POST /api/users — admin creates a user ────────────────────────────────────
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role, role_id } = req.body
    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' })

    const pol = getPasswordPolicy(loadOverrides())
    const pv  = validatePassword(password, pol)
    if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })

    const norm = email.trim().toLowerCase()
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(norm))
      return res.status(409).json({ error: 'Email already in use.' })

    const hash     = await hashPassword(password)
    const id       = uuidv4()
    const count    = db.prepare('SELECT COUNT(*) as c FROM users').get().c
    const colorIdx = count % COLORS.length

    const selectedRole = role_id
      ? db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id)
      : db.prepare('SELECT * FROM roles WHERE id = ?').get(BUILTIN[role] ? BUILTIN[role].id : BUILTIN.member.id)
    if (!selectedRole || selectedRole.is_system) return res.status(400).json({ error: 'Invalid role.' })
    if (!canGrantRole(req, selectedRole)) return res.status(403).json({ error: 'You cannot assign a role with permissions you do not have.' })
    const legacyRole = Object.entries(BUILTIN).find(([, r]) => r.id === selectedRole.id)?.[0] || 'member'
    db.prepare(`INSERT INTO users (id, name, email, password, initials, color, role, role_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, name.trim(), norm, hash, getInitials(name.trim()), COLORS[colorIdx], legacyRole === 'inactive' ? 'member' : legacyRole, selectedRole.id)

    const user = db.prepare(`SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
      r.name AS role_name, r.color AS role_color, r.permissions AS permissions, u.is_active
      FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id = ?`).get(id)
    audit(req.user.id, 'user.create', 'user', id, name.trim(), { createdBy: req.user.name })
    res.status(201).json(serializeUser(user, req))
  } catch (err) {
    logger.error('user create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/users/:id — admin edits user ───────────────────────────────────
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, role, role_id, is_active } = req.body
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!canManageUserRole(req, user)) return res.status(403).json({ error: 'You cannot manage a user with permissions above your own.' })

    // Last-admin guard
    let selectedRole = null
    if (role_id || role) {
      selectedRole = role_id
        ? db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id)
        : db.prepare('SELECT * FROM roles WHERE id = ?').get(BUILTIN[role]?.id)
      if (!selectedRole || selectedRole.is_system) return res.status(400).json({ error: 'Invalid role.' })
      if (!canGrantRole(req, selectedRole)) return res.status(403).json({ error: 'You cannot assign a role with permissions you do not have.' })
    }
    const requestedLegacyRole = selectedRole ? (Object.entries(BUILTIN).find(([, r]) => r.id === selectedRole.id)?.[0] || 'member') : user.role
    if (user.role === 'admin' && selectedRole && requestedLegacyRole !== 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND is_active=1").get().c
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot demote the only admin.' })
    }
    if (user.is_active === 1 && is_active === 0) {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND is_active=1").get().c
      if (user.role === 'admin' && adminCount <= 1)
        return res.status(400).json({ error: 'Cannot deactivate the only admin.' })
    }

    const updates = []
    const vals    = []
    if (name?.trim())       { updates.push('name = ?, initials = ?'); vals.push(name.trim(), getInitials(name.trim())) }
    if (email?.trim())      { updates.push('email = ?'); vals.push(email.trim().toLowerCase()) }
    const restoringActive = !!(selectedRole && !user.is_active && is_active)
    const stayingInactive = !!(selectedRole && !user.is_active && !is_active)
    if (selectedRole && !restoringActive && !stayingInactive) { updates.push('role = ?, role_id = ?'); vals.push(requestedLegacyRole, selectedRole.id) }
    if (restoringActive) { updates.push('role = ?'); vals.push(requestedLegacyRole) }
    if (stayingInactive) { updates.push('role = ?, previous_role_id = ?'); vals.push(requestedLegacyRole, selectedRole.id) }
    if (is_active !== undefined) {
      const active = is_active ? 1 : 0
      if (!active && user.is_active && user.role_id && user.role_id !== BUILTIN.inactive.id) {
        updates.push('previous_role_id = ?, role_id = ?, is_active = ?')
        vals.push(selectedRole?.id || user.role_id, BUILTIN.inactive.id, 0)
      } else if (active && !user.is_active) {
        updates.push('role_id = ?, previous_role_id = NULL, is_active = ?')
        vals.push(selectedRole ? selectedRole.id : (user.previous_role_id || BUILTIN.member.id), 1)
      } else updates.push('is_active = ?'), vals.push(active)
    }
    if (selectedRole || is_active !== undefined) { updates.push('token_version = token_version + 1') }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    vals.push(req.params.id)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals)

    const updated = db.prepare(`SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.role_id,
      u.previous_role_id, r.name AS role_name, r.color AS role_color, r.permissions AS permissions, u.is_active
      FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id = ?`).get(req.params.id)
    audit(req.user.id, 'user.update', 'user', req.params.id, updated.name, { by: req.user.name })
    res.json(serializeUser(updated, req))
  } catch (err) {
    logger.error('user patch:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/users/:id/reset-password — admin resets password ────────────────
router.post('/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetUser = db.prepare('SELECT id, role, role_id FROM users WHERE id = ?').get(req.params.id)
    if (!targetUser) return res.status(404).json({ error: 'User not found' })
    if (!canManageUserRole(req, targetUser)) return res.status(403).json({ error: 'You cannot manage a user with permissions above your own.' })
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password required' })
    const pol = getPasswordPolicy(loadOverrides())
    const pv  = validatePassword(password, pol)
    if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })
    const hash = await hashPassword(password)
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id)
    audit(req.user.id, 'user.admin_password_reset', 'user', req.params.id, null, { by: req.user.name })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/users/:id ─────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!canManageUserRole(req, user)) return res.status(403).json({ error: 'You cannot manage a user with permissions above your own.' })
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account.' })
    if (user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the only admin.' })
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'user.delete', 'user', req.params.id, user.name, { by: req.user.name })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/users/me/avatar — upload profile photo ─────────────────────────
router.post('/me/avatar', requireAuth, (req, res) => {
  req.avatarTargetId = req.user.id
  avatarUpload.single('avatar')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    // Store a cache-busted URL path (served as static)
    const avatarUrl = `/uploads/avatars/${req.user.id}.jpg?v=${Date.now()}`
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id)
    audit(req.user.id, 'user.avatar_upload', 'user', req.user.id, null)
    res.json({ ok: true, avatar: avatarUrl })
  })
})

// ── DELETE /api/users/me/avatar — remove profile photo ───────────────────────
router.delete('/me/avatar', requireAuth, (req, res) => {
  try {
    const filePath = path.join(AVATARS_DIR, `${req.user.id}.jpg`)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.user.id)
    audit(req.user.id, 'user.avatar_remove', 'user', req.user.id, null)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/users/:id/avatar — admin upload profile photo ──────────────────
router.post('/:id/avatar', requireAuth, requireAdmin, (req, res) => {
  req.avatarTargetId = req.params.id
  const targetUser = db.prepare('SELECT id, name, role, role_id FROM users WHERE id = ?').get(req.params.id)
  if (!targetUser) return res.status(404).json({ error: 'User not found' })
  if (!canManageUserRole(req, targetUser)) return res.status(403).json({ error: 'You cannot manage a user with permissions above your own.' })

  avatarUpload.single('avatar')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const avatarUrl = `/uploads/avatars/${req.params.id}.jpg?v=${Date.now()}`
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.params.id)
    audit(req.user.id, 'user.avatar_upload', 'user', req.params.id, targetUser.name, { by: req.user.name })
    res.json({ ok: true, avatar: avatarUrl })
  })
})

// ── DELETE /api/users/:id/avatar — admin remove profile photo ────────────────
router.delete('/:id/avatar', requireAuth, requireAdmin, (req, res) => {
  try {
    const targetUser = db.prepare('SELECT id, name, role, role_id FROM users WHERE id = ?').get(req.params.id)
    if (!targetUser) return res.status(404).json({ error: 'User not found' })
    if (!canManageUserRole(req, targetUser)) return res.status(403).json({ error: 'You cannot manage a user with permissions above your own.' })
    const filePath = path.join(AVATARS_DIR, `${req.params.id}.jpg`)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'user.avatar_remove', 'user', req.params.id, targetUser.name, { by: req.user.name })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
