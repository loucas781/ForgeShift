'use strict'
const router  = require('express').Router()
const crypto  = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { hashPassword, comparePassword, getPasswordPolicy, validatePassword } = require('../auth-utils')
const jwt     = require('jsonwebtoken')
const db      = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const audit   = require('../audit')
const fs      = require('fs')
const path    = require('path')

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../../.runtime-overrides.json'), 'utf8')) } catch { return {} }
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

const COLORS = ['#0052cc','#00875a','#6554c0','#ff5630','#ff991f','#36b37e','#00b8d9','#e01e5a','#904ee2','#0065ff']

function getInitials(name) {
  return name.trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

function cookieOpts() {
  const hours  = parseInt(process.env.COOKIE_MAX_AGE_HOURS || '72')
  const secure = process.env.COOKIE_SECURE === 'true'
  return { httpOnly: true, secure, sameSite: secure ? 'strict' : 'lax', maxAge: hours * 3600000, path: '/' }
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: `${process.env.COOKIE_MAX_AGE_HOURS || 72}h` }
  )
}

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const overrides = loadOverrides()
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c
    const allowSignup = (overrides.ALLOW_SIGNUP ?? 'true') !== 'false'
    if (!allowSignup && userCount > 0)
      return res.status(403).json({ error: 'Open registration is disabled. Contact an admin.' })

    const { name, email: emailAddr, password } = req.body
    if (!name?.trim() || !emailAddr?.trim() || !password)
      return res.status(400).json({ error: 'All fields are required.' })

    const pol = getPasswordPolicy(loadOverrides())
    const pv  = validatePassword(password, pol)
    if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })

    if (!/\S+@\S+\.\S+/.test(emailAddr))
      return res.status(400).json({ error: 'Please enter a valid email address.' })

    const norm = emailAddr.trim().toLowerCase()
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(norm)
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' })

    const hash     = await hashPassword(password)
    const colorIdx = userCount % COLORS.length
    const id       = uuidv4()
    const role     = userCount === 0 ? 'admin' : 'member'

    db.prepare(`INSERT INTO users (id, name, email, password, initials, color, role) VALUES (?,?,?,?,?,?,?)`)
      .run(id, name.trim(), norm, hash, getInitials(name), COLORS[colorIdx], role)

    const user = db.prepare('SELECT id, name, email, initials, color, avatar, role FROM users WHERE id = ?').get(id)
    res.cookie('token', makeToken(user), cookieOpts())
    audit(user.id, 'user.signup', 'user', user.id, user.name)
    res.json({ ok: true, user })
  } catch (err) {
    console.error('signup:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email?.trim() || !password)
      return res.status(400).json({ error: 'Email and password are required.' })

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase())
    if (!user) return res.status(401).json({ error: 'No account found with this email address.' })
    if (user.is_active === 0)
      return res.status(403).json({ error: 'This account has been deactivated. Contact an admin.' })

    const { ok: pwOk, needsRehash } = await comparePassword(password, user.password)
    if (!pwOk) return res.status(401).json({ error: 'Incorrect password.' })

    if (needsRehash) {
      const newHash = await hashPassword(password)
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(newHash, user.id)
    }

    const { password: _, ...pub } = user
    res.cookie('token', makeToken(pub), cookieOpts())
    audit(pub.id, 'user.login', 'user', pub.id, pub.name)
    res.json({ ok: true, user: pub })
  } catch (err) {
    console.error('login:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token')
  res.json({ ok: true })
})

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT id, name, email, initials, color, avatar, role, is_active, created_at FROM users WHERE id = ?').get(req.user.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/auth/profile ───────────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { name, color } = req.body
    const updates = []
    const vals    = []
    if (name?.trim()) { updates.push('name = ?, initials = ?'); vals.push(name.trim(), getInitials(name.trim())) }
    if (color)        { updates.push('color = ?'); vals.push(color) }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })
    vals.push(req.user.id)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals)
    const user = db.prepare('SELECT id, name, email, initials, color, avatar, role FROM users WHERE id = ?').get(req.user.id)
    res.json({ ok: true, user })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/change-password ───────────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    const { ok } = await comparePassword(currentPassword, user.password)
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' })
    const pol = getPasswordPolicy(loadOverrides())
    const pv  = validatePassword(newPassword, pol)
    if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })
    const hash = await hashPassword(newPassword)
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id)
    audit(req.user.id, 'user.password_change', 'user', req.user.id, user.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase())
    // Always return 200 to prevent email enumeration
    if (!user) return res.json({ ok: true })

    const rawToken = crypto.randomBytes(32).toString('hex')
    const hashed   = hashToken(rawToken)
    const expires  = new Date(Date.now() + 3600000).toISOString()

    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id)
    db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)')
      .run(uuidv4(), user.id, hashed, expires)

    // In a real deployment, email this. For now, log it.
    const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password.html?token=${rawToken}`
    console.log(`[password-reset] Reset URL for ${user.email}: ${resetUrl}`)

    audit(user.id, 'user.forgot_password', 'user', user.id, user.name)
    res.json({ ok: true, resetUrl /* remove in production */ })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/validate-reset-token ──────────────────────────────────────
router.post('/validate-reset-token', async (req, res) => {
  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'Token required' })
    const hashed = hashToken(token)
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0').get(hashed)
    if (!row || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Invalid or expired reset link.' })

    // Consume the URL token immediately
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id)

    // Issue a short-lived session key
    const sessionId = crypto.randomBytes(32).toString('hex')
    const expires   = new Date(Date.now() + 900000).toISOString() // 15 min
    db.prepare('INSERT INTO password_reset_sessions (id, user_id, expires_at) VALUES (?,?,?)')
      .run(uuidv4(), row.user_id, expires)

    // Store sessionId in DB keyed by id
    db.prepare('UPDATE password_reset_sessions SET id = ? WHERE user_id = ? AND used = 0')
      .run(sessionId, row.user_id)

    res.json({ ok: true, sessionKey: sessionId })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/reset-password ────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { sessionKey, password } = req.body
    if (!sessionKey || !password) return res.status(400).json({ error: 'Missing fields' })

    const sess = db.prepare('SELECT * FROM password_reset_sessions WHERE id = ? AND used = 0').get(sessionKey)
    if (!sess || new Date(sess.expires_at) < new Date())
      return res.status(400).json({ error: 'Session expired. Please request a new reset link.' })

    const pol = getPasswordPolicy(loadOverrides())
    const pv  = validatePassword(password, pol)
    if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })

    const hash = await hashPassword(password)
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, sess.user_id)
    db.prepare('UPDATE password_reset_sessions SET used = 1 WHERE id = ?').run(sessionKey)

    audit(sess.user_id, 'user.password_reset', 'user', sess.user_id, null)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
