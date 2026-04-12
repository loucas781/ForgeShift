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

// ── Avatar upload storage ──────────────────────────────────────────────────────
const AVATARS_DIR = path.join(__dirname, '../../public/uploads/avatars')
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true })

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (req, _file, cb) => cb(null, `${req.user.id}.jpg`),
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
const COLORS = ['#0052cc','#00875a','#6554c0','#ff5630','#ff991f','#36b37e','#00b8d9','#e01e5a','#904ee2','#0065ff']

// ── GET /api/users ────────────────────────────────────────────────────────────
// Supports optional ?limit=N&offset=N pagination. Without these params returns all users.
router.get('/', requireAuth, (req, res) => {
  res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=30')
  if (req.query.limit !== undefined || req.query.offset !== undefined) {
    const limit  = Math.min(Math.max(parseInt(req.query.limit  || '50'), 1), 200)
    const offset = Math.max(parseInt(req.query.offset || '0'), 0)
    const users  = db.prepare(
      'SELECT id, name, email, initials, color, avatar, role, is_active, created_at FROM users ORDER BY name LIMIT ? OFFSET ?'
    ).all(limit, offset)
    const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c
    return res.json({ users, total, limit, offset })
  }
  const users = db.prepare(
    `SELECT u.id, u.name, u.email, u.initials, u.color, u.avatar, u.role, u.is_active, u.created_at,
            tm.team_id
     FROM users u LEFT JOIN team_members tm ON tm.user_id = u.id
     ORDER BY u.name`
  ).all()
  res.json(users)
})

// ── GET /api/users/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(
    'SELECT id, name, email, initials, color, avatar, role, is_active, created_at FROM users WHERE id = ?'
  ).get(req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json(user)
})

// ── GET /api/users/:id/avatar — serve avatar image ───────────────────────────
router.get('/:id/avatar', requireAuth, (req, res) => {
  const filePath = path.join(AVATARS_DIR, `${req.params.id}.jpg`)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No avatar' })
  res.sendFile(filePath)
})

// ── GET /api/users/:id ────────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const user = db.prepare(
    'SELECT id, name, email, initials, color, avatar, role, is_active, created_at FROM users WHERE id = ?'
  ).get(req.params.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json(user)
})

// ── POST /api/users — admin creates a user ────────────────────────────────────
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body
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

    db.prepare(`INSERT INTO users (id, name, email, password, initials, color, role) VALUES (?,?,?,?,?,?,?)`)
      .run(id, name.trim(), norm, hash, getInitials(name.trim()), COLORS[colorIdx], role || 'member')

    const user = db.prepare('SELECT id, name, email, initials, color, avatar, role, is_active FROM users WHERE id = ?').get(id)
    audit(req.user.id, 'user.create', 'user', id, name.trim(), { createdBy: req.user.name })
    res.status(201).json(user)
  } catch (err) {
    logger.error('user create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/users/:id — admin edits user ───────────────────────────────────
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, role, is_active } = req.body
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Last-admin guard
    if (user.role === 'admin' && role && role !== 'admin') {
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
    if (role)               { updates.push('role = ?'); vals.push(['admin','manager','shift_lead','member'].includes(role) ? role : 'member') }
    if (is_active !== undefined) { updates.push('is_active = ?'); vals.push(is_active ? 1 : 0) }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    vals.push(req.params.id)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals)

    const updated = db.prepare('SELECT id, name, email, initials, color, avatar, role, is_active FROM users WHERE id = ?').get(req.params.id)
    audit(req.user.id, 'user.update', 'user', req.params.id, updated.name, { by: req.user.name })
    res.json(updated)
  } catch (err) {
    logger.error('user patch:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/users/:id/reset-password — admin resets password ────────────────
router.post('/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
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

module.exports = router
