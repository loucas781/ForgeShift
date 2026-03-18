'use strict'
const router  = require('express').Router()
const { hashPassword, comparePassword, getPasswordPolicy, validatePassword } = require('../auth-utils')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db      = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const audit   = require('../audit')
const emailSvc = require('../email')
const { authenticator } = require('otplib')
const fs      = require('fs')
const path    = require('path')

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../../.runtime-overrides.json'), 'utf8')) } catch { return {} }
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}
const COLORS = ['#4f46e5','#059669','#7c3aed','#dc2626','#d97706','#0891b2','#db2777','#065f46','#1d4ed8','#9333ea']
function getInitials(name) {
  return name.trim().split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2)
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

// ── POST /api/auth/signup ──────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const overrides   = loadOverrides()
    const userCount   = db.prepare('SELECT COUNT(*) as c FROM users').get().c
    const allowSignup = (overrides.ALLOW_SIGNUP ?? 'true') !== 'false'
    if (!allowSignup && userCount > 0)
      return res.status(403).json({ error: 'Open registration is disabled. Contact an admin to create an account.' })
    const { name, email: emailAddr, password } = req.body
    if (!name?.trim() || !emailAddr?.trim() || !password)
      return res.status(400).json({ error: 'All fields are required.' })
    if (!/\S+@\S+\.\S+/.test(emailAddr))
      return res.status(400).json({ error: 'Please enter a valid email address.' })
    const pol = getPasswordPolicy(loadOverrides())
    const pv  = validatePassword(password, pol)
    if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })
    const norm = emailAddr.trim().toLowerCase()
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(norm))
      return res.status(409).json({ error: 'An account with this email already exists.' })
    const hash = await hashPassword(password)
    const id   = uuidv4()
    const role = userCount === 0 ? 'admin' : 'member'
    db.prepare('INSERT INTO users (id, name, email, password, initials, color, role) VALUES (?,?,?,?,?,?,?)')
      .run(id, name.trim(), norm, hash, getInitials(name), COLORS[userCount % COLORS.length], role)
    const user = db.prepare('SELECT id, name, email, initials, color, avatar, role FROM users WHERE id = ?').get(id)
    res.cookie('token', makeToken(user), cookieOpts())
    audit(user.id, 'user.signup', 'user', user.id, user.name)
    res.json({ ok: true, user })
  } catch (err) { console.error('signup:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/login ───────────────────────────────────────────────────────
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
    if (needsRehash) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(password), user.id)
    const { password: _, ...pub } = user
    res.cookie('token', makeToken(pub), cookieOpts())
    audit(pub.id, 'user.login', 'user', pub.id, pub.name)
    res.json({ ok: true, user: pub })
  } catch (err) { console.error('login:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/logout ──────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' })
  res.json({ ok: true })
})

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, initials, color, avatar, role, is_active, created_at FROM users WHERE id = ?').get(req.user.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json(user)
})

// ── PATCH /api/auth/profile ────────────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { name, color, email, currentPassword, newPassword } = req.body
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const updates = []; const vals = []
    if (name?.trim())  { updates.push('name = ?, initials = ?'); vals.push(name.trim(), getInitials(name.trim())) }
    if (color)         { updates.push('color = ?'); vals.push(color) }
    if (email?.trim()) {
      const norm = email.trim().toLowerCase()
      if (norm !== user.email) {
        if (db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(norm, user.id))
          return res.status(409).json({ error: 'Email is already in use.' })
        updates.push('email = ?'); vals.push(norm)
      }
    }
    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required.' })
      const { ok: curOk } = await comparePassword(currentPassword, user.password)
      if (!curOk) return res.status(401).json({ error: 'Current password is incorrect.' })
      const pol = getPasswordPolicy(loadOverrides())
      const pv  = validatePassword(newPassword, pol)
      if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })
      updates.push('password = ?'); vals.push(await hashPassword(newPassword))
    }
    if (updates.length) { vals.push(user.id); db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals) }
    const updated = db.prepare('SELECT id, name, email, initials, color, avatar, role FROM users WHERE id = ?').get(user.id)
    res.cookie('token', makeToken(updated), cookieOpts())
    audit(user.id, 'user.profile_update', 'user', user.id, updated.name)
    res.json({ ok: true, user: updated })
  } catch (err) { console.error('profile:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Never leaks the token in the response. Token stored for admin to retrieve.
router.post('/forgot-password', async (req, res) => {
  const { email: emailAddr } = req.body
  if (!emailAddr) return res.status(400).json({ error: 'Email required' })
  const GENERIC = { ok: true, emailSent: false }
  try {
    const user = db.prepare("SELECT id, name FROM users WHERE email = ? AND is_active = 1")
      .get(emailAddr.toLowerCase().trim())
    if (!user) return res.json(GENERIC)
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id)
    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expires   = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)')
      .run(uuidv4(), user.id, tokenHash, expires)

    // If SMTP is configured, email the link. Otherwise the admin retrieves it via the reset-link endpoint.
    const smtp = emailSvc.getSmtpConfig()
    let emailSent = false
    if (smtp.enabled) {
      const origin   = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
      const resetUrl = `${origin}/reset-password.html?token=${rawToken}`
      const result   = await emailSvc.sendPasswordReset({ to: emailAddr.toLowerCase().trim(), name: user.name, resetUrl })
      emailSent = result.ok
    }

    audit(user.id, 'user.forgot_password', 'user', user.id, user.name)
    res.json({ ok: true, emailSent })
  } catch (err) { console.error('forgot-password:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── GET /api/auth/admin/reset-link/:userId ────────────────────────────────────
// Admin-only. Generates a one-time reset URL — the only way to reset when SMTP is off.
router.get('/admin/reset-link/:userId', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  try {
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.params.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id)
    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expires   = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)')
      .run(uuidv4(), user.id, tokenHash, expires)
    const origin   = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
    const resetUrl = `${origin}/reset-password.html?token=${rawToken}`
    audit(req.user.id, 'user.admin_reset_link', 'user', user.id, user.name)
    res.json({ ok: true, resetUrl, expiresIn: '15 minutes' })
  } catch (err) { console.error('admin reset-link:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── GET /api/auth/reset-password/validate ─────────────────────────────────────
// Validates + immediately consumes the URL token. Issues a 5-min session key.
router.get('/reset-password/validate', async (req, res) => {
  const { token } = req.query
  if (!token) return res.status(400).json({ error: 'Token required' })
  try {
    const tokenHash = hashToken(token)
    const row = db.prepare(`
      SELECT r.id, r.user_id, r.used, r.expires_at, u.name, u.email
      FROM password_reset_tokens r JOIN users u ON u.id = r.user_id
      WHERE r.token = ?
    `).get(tokenHash)
    if (!row || row.used || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Invalid or expired reset link.' })
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id)
    const sessionKey = crypto.randomBytes(32).toString('hex')
    const sessionExp = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    db.prepare('INSERT INTO password_reset_sessions (id, user_id, expires_at) VALUES (?,?,?)').run(sessionKey, row.user_id, sessionExp)
    res.json({ ok: true, sessionKey, name: row.name, email: row.email })
  } catch (err) { console.error('reset validate:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { sessionKey, password } = req.body
  if (!sessionKey || !password) return res.status(400).json({ error: 'Session key and password required' })
  const pol = getPasswordPolicy(loadOverrides())
  const pv  = validatePassword(password, pol)
  if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') })
  try {
    const session = db.prepare('SELECT id, user_id, expires_at, used FROM password_reset_sessions WHERE id = ?').get(sessionKey)
    if (!session)      return res.status(400).json({ error: 'Invalid or expired session.' })
    if (session.used)  return res.status(400).json({ error: 'This reset session has already been used.' })
    if (new Date(session.expires_at) < new Date()) return res.status(400).json({ error: 'Reset session has expired.' })
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(password), session.user_id)
    db.prepare('UPDATE password_reset_sessions SET used = 1 WHERE id = ?').run(session.id)
    audit(session.user_id, 'user.password_reset', 'user', session.user_id, null)
    res.json({ ok: true })
  } catch (err) { console.error('reset-password:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/invite — admin creates account (works when signup disabled) ──
router.post('/invite', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const { name, email: emailAddr, role = 'member' } = req.body
  if (!name?.trim() || !emailAddr?.trim()) return res.status(400).json({ error: 'Name and email required.' })
  if (!/\S+@\S+\.\S+/.test(emailAddr)) return res.status(400).json({ error: 'Invalid email address.' })
  try {
    const norm = emailAddr.trim().toLowerCase()
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(norm))
      return res.status(409).json({ error: 'An account with this email already exists.' })
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c
    const tempPassword = crypto.randomBytes(8).toString('base64url') + 'A1!'
    const id = uuidv4()
    db.prepare('INSERT INTO users (id, name, email, password, initials, color, role) VALUES (?,?,?,?,?,?,?)')
      .run(id, name.trim(), norm, await hashPassword(tempPassword), getInitials(name.trim()), COLORS[count % COLORS.length], ['admin','member'].includes(role) ? role : 'member')

    // Send invite email if SMTP is configured
    const smtp = emailSvc.getSmtpConfig()
    let emailSent = false
    if (smtp.enabled) {
      const origin = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
      const result = await emailSvc.sendAdminInvite({ to: norm, name: name.trim(), tempPassword, loginUrl: origin + '/login.html' })
      emailSent = result.ok
    }

    audit(req.user.id, 'user.invite', 'user', id, name.trim(), { by: req.user.name })
    res.json({ ok: true, emailSent, tempPassword: emailSent ? null : tempPassword })
  } catch (err) { console.error('invite:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── GET /api/auth/2fa/status ──────────────────────────────────────────────────
router.get('/2fa/status', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id)
    res.json({ enabled: !!(user?.totp_enabled) })
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/2fa/setup — generate pending TOTP secret ──────────────────
router.post('/2fa/setup', requireAuth, (req, res) => {
  try {
    const secret  = authenticator.generateSecret()
    const appName = process.env.APP_NAME || 'ForgeShift'
    const user    = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id)
    const otpauth = authenticator.keyuri(user.email, appName, secret)
    // Store pending secret (not yet confirmed — totp_enabled remains 0)
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user.id)
    res.json({ secret, otpauth })
  } catch (err) {
    console.error('2fa setup:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/2fa/verify — confirm code and enable 2FA ──────────────────
router.post('/2fa/verify', requireAuth, (req, res) => {
  const { secret, code } = req.body
  if (!secret || !code) return res.status(400).json({ error: 'Secret and code required' })
  try {
    const valid = authenticator.verify({ token: String(code).replace(/\s/g, ''), secret })
    if (!valid) return res.status(400).json({ error: 'Invalid code — try again' })
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, req.user.id)
    audit(req.user.id, 'user.2fa_enabled', 'user', req.user.id, req.user.name)
    res.json({ ok: true })
  } catch (err) {
    console.error('2fa verify:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/2fa/disable — verify code then disable 2FA ────────────────
router.post('/2fa/disable', requireAuth, (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'Code required' })
  try {
    const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id)
    if (!user?.totp_secret) return res.status(400).json({ error: '2FA is not set up' })
    const valid = authenticator.verify({ token: String(code).replace(/\s/g, ''), secret: user.totp_secret })
    if (!valid) return res.status(400).json({ error: 'Invalid code' })
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.user.id)
    audit(req.user.id, 'user.2fa_disabled', 'user', req.user.id, req.user.name)
    res.json({ ok: true })
  } catch (err) {
    console.error('2fa disable:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/auth/sessions — return current session info ─────────────────────
// ForgeShift uses stateless JWTs with one cookie per browser — there is no
// server-side session store, so we return a single "current session" entry
// derived from the decoded JWT payload, matching ForgeTrack's UI shape.
router.get('/sessions', requireAuth, (req, res) => {
  try {
    const ua = req.headers['user-agent'] || ''
    // Simple browser/OS detection from UA string
    let browser = 'Unknown browser'
    let os      = 'Unknown OS'
    if (/Edg\//.test(ua))          browser = 'Edge'
    else if (/Chrome\//.test(ua))  browser = 'Chrome'
    else if (/Firefox\//.test(ua)) browser = 'Firefox'
    else if (/Safari\//.test(ua))  browser = 'Safari'
    else if (/OPR\//.test(ua))     browser = 'Opera'
    if (/Windows/.test(ua))        os = 'Windows'
    else if (/Macintosh/.test(ua)) os = 'macOS'
    else if (/Linux/.test(ua))     os = 'Linux'
    else if (/Android/.test(ua))   os = 'Android'
    else if (/iPhone|iPad/.test(ua)) os = 'iOS'
    res.json({
      sessions: [{
        id:        'current',
        label:     `${browser} on ${os}`,
        isCurrent: true,
      }],
      note: 'ForgeShift uses HTTP-only cookies — only one active session per browser is tracked.',
    })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/logout-all — clear cookie (only session this browser has) ──
router.post('/logout-all', requireAuth, (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' })
  audit(req.user.id, 'user.logout_all', 'user', req.user.id, req.user.name)
  res.json({ ok: true })
})

// ── GET /api/auth/export — download a JSON export of the user's own data ──────
router.get('/export', requireAuth, (req, res) => {
  try {
    const uid  = req.user.id
    const user = db.prepare('SELECT id, name, email, initials, color, role, created_at FROM users WHERE id = ?').get(uid)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const shifts    = db.prepare('SELECT * FROM shifts    WHERE user_id = ? ORDER BY date').all(uid)
    const icalTokens = db.prepare('SELECT created_at FROM ical_tokens WHERE user_id = ?').all(uid)
    const payload = {
      exported_at: new Date().toISOString(),
      account: user,
      shifts,
      ical_tokens: icalTokens.map(t => ({ created_at: t.created_at, note: 'raw token omitted for security' })),
    }
    const filename = `forgeshift-export-${user.name.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0,10)}.json`
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Type', 'application/json')
    res.send(JSON.stringify(payload, null, 2))
    audit(uid, 'user.data_export', 'user', uid, user.name)
  } catch (err) {
    console.error('export error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/auth/account — permanently delete current user's account ──────
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account.' })
    const uid  = req.user.id
    const user = db.prepare('SELECT id, name, password, role FROM users WHERE id = ?').get(uid)
    if (!user) return res.status(404).json({ error: 'User not found' })
    const ok = await comparePassword(password, user.password)
    if (!ok) return res.status(401).json({ error: 'Incorrect password.' })
    // Last-admin guard
    if (user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the only admin account. Promote another user to admin first.' })
    }
    // Delete associated data then the user
    db.prepare('DELETE FROM shifts       WHERE user_id = ?').run(uid)
    db.prepare('DELETE FROM ical_tokens  WHERE user_id = ?').run(uid)
    db.prepare('DELETE FROM users        WHERE id      = ?').run(uid)
    audit(null, 'user.self_deleted', 'user', uid, user.name)
    res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' })
    res.json({ ok: true })
  } catch (err) {
    console.error('delete account:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/auth/prefs — get current user's preferences ─────────────────────
router.get('/prefs', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(req.user.id)
    let prefs = {}
    try { prefs = JSON.parse(row?.prefs || '{}') } catch {}
    res.json(prefs)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PATCH /api/auth/prefs — update current user's preferences ─────────────────
router.patch('/prefs', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(req.user.id)
    let existing = {}
    try { existing = JSON.parse(row?.prefs || '{}') } catch {}
    // Merge incoming keys — only allow known preference keys
    const ALLOWED = ['weekStartDay', 'defaultView', 'showWeekNumbers', 'holidays', 'defaultShiftStart', 'defaultShiftEnd', 'compactChips']
    const incoming = req.body || {}
    for (const k of ALLOWED) {
      if (k in incoming) existing[k] = incoming[k]
    }
    db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(existing), req.user.id)
    res.json(existing)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
