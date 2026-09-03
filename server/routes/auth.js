'use strict'
const router  = require('express').Router()
const { hashPassword, comparePassword, getPasswordPolicy, validatePassword } = require('../auth-utils')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db      = require('../db/connection')
const { requireAuth, clearCookieOpts } = require('../middleware/auth')
const audit   = require('../audit')
const emailSvc = require('../email')
const { authenticator } = require('otplib')
const logger  = require('../utils/logger')
const { loadOverrides } = require('../utils/overrides')
const { rolePermissions, hasPermission, canGrantRole, canManageUserRole } = require('../utils/roles')

const TWO_FA_TRUST_COOKIE = 'fs_2fa_trust'
const TWO_FA_TRUST_DAYS = 30
const TWO_FA_GRACE_SECONDS = 10
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}
const COLORS = ['#4f46e5','#059669','#7c3aed','#dc2626','#d97706','#0891b2','#db2777','#065f46','#1d4ed8','#9333ea']
function getInitials(name) {
  return name.trim().split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2)
}
function addRoleMetadata(user) {
  if (!user) return user
  const role = db.prepare('SELECT id, name, color, permissions, is_builtin, is_system FROM roles WHERE id = ?').get(user.role_id)
  user.role_id = user.role_id || null
  user.role_name = role?.name || null
  user.role_color = role?.color || null
  user.permissions = rolePermissions(role || { role: user.role })
  return user
}
function isHttpsRequest(req) {
  if (!req) return true
  if (req.secure) return true
  const xfProto = String(req.headers?.['x-forwarded-proto'] || '').toLowerCase()
  return xfProto.split(',')[0].trim() === 'https'
}

function cookieOpts(req) {
  const hours  = parseInt(process.env.COOKIE_MAX_AGE_HOURS || '72')
  const secureByConfig = process.env.COOKIE_SECURE === 'true' || process.env.APP_ENV === 'production'
  const secure = secureByConfig && isHttpsRequest(req)
  return { httpOnly: true, secure, sameSite: secure ? 'strict' : 'lax', maxAge: hours * 3600000, path: '/' }
}
function makeToken(user, sessionId) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role, tv: user.token_version || 0, sid: sessionId },
    process.env.JWT_SECRET,
    { expiresIn: `${process.env.COOKIE_MAX_AGE_HOURS || 72}h` }
  )
}

function twoFaTrustCookieOpts(req) {
  const secureByConfig = process.env.COOKIE_SECURE === 'true' || process.env.APP_ENV === 'production'
  const secure = secureByConfig && isHttpsRequest(req)
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'strict' : 'lax',
    maxAge: TWO_FA_TRUST_DAYS * 24 * 3600000,
    path: '/',
  }
}

function trustFingerprint(req) {
  const ua = String(req.headers['user-agent'] || '')
  const lang = String(req.headers['accept-language'] || '')
  return hashToken(`${ua}|${lang}`)
}

function signTwoFaTrustToken(user, req) {
  return jwt.sign(
    {
      twofa_trust: true,
      uid: user.id,
      tv: user.token_version || 0,
      fp: trustFingerprint(req),
    },
    process.env.JWT_SECRET,
    { expiresIn: `${TWO_FA_TRUST_DAYS}d` }
  )
}

function hasValidTrusted2FA(req, user) {
  const raw = req.cookies?.[TWO_FA_TRUST_COOKIE]
  if (!raw) return false
  try {
    const payload = jwt.verify(raw, process.env.JWT_SECRET)
    return !!(
      payload &&
      payload.twofa_trust === true &&
      payload.uid === user.id &&
      payload.tv === (user.token_version || 0) &&
      payload.fp === trustFingerprint(req)
    )
  } catch {
    return false
  }
}

function verifyTotpWithGrace(secret, code) {
  const token = String(code || '').replace(/\s/g, '')
  if (!token) return false

  const stepSeconds = Number(authenticator?.allOptions?.().step || 30)
  const verifyAtEpoch = (epochMs) => {
    const prevOptions = authenticator.options
    try {
      authenticator.options = {
        ...prevOptions,
        window: 0,
        epoch: epochMs,
      }
      return authenticator.verify({ token, secret })
    } finally {
      authenticator.options = prevOptions
    }
  }

  // Always verify the current window first with strict windowing.
  if (verifyAtEpoch(Date.now())) return true

  // Only allow previous-window token briefly after rollover.
  const secondsIntoStep = Math.floor(Date.now() / 1000) % stepSeconds
  if (secondsIntoStep > TWO_FA_GRACE_SECONDS) return false

  return verifyAtEpoch(Date.now() - stepSeconds * 1000)
}

function parseDeviceLabel(ua = '') {
  let browser = 'Unknown browser'
  let os      = 'Unknown OS'
  if (/Edg\//.test(ua))            browser = 'Edge'
  else if (/Chrome\//.test(ua))    browser = 'Chrome'
  else if (/Firefox\//.test(ua))   browser = 'Firefox'
  else if (/Safari\//.test(ua))    browser = 'Safari'
  else if (/OPR\//.test(ua))       browser = 'Opera'
  if (/Windows/.test(ua))          os = 'Windows'
  else if (/Macintosh/.test(ua))   os = 'macOS'
  else if (/Linux/.test(ua))       os = 'Linux'
  else if (/Android/.test(ua))     os = 'Android'
  else if (/iPhone|iPad/.test(ua)) os = 'iOS'
  return `${browser} on ${os}`
}

function createSession(req, userId) {
  const id = uuidv4()
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.ip || null
  const ua = req.headers['user-agent'] || null
  db.prepare('INSERT INTO user_sessions (id, user_id, ip, user_agent) VALUES (?,?,?,?)').run(id, userId, ip, ua)
  // Keep abandoned/device sessions bounded. The newest session is always
  // retained; this does not affect JWT/native-client login semantics.
  const maxSessions = Math.max(1, Math.min(100, parseInt(process.env.MAX_SESSIONS_PER_USER || '20', 10) || 20))
  db.prepare(`
    DELETE FROM user_sessions
    WHERE user_id = ? AND id != ? AND id NOT IN (
      SELECT id FROM user_sessions WHERE user_id = ? AND id != ?
      ORDER BY last_used_at DESC, created_at DESC LIMIT ?
    )
  `).run(userId, id, userId, id, Math.max(0, maxSessions - 1))
  return id
}

function getPublicOrigin(req) {
  const overrides = loadOverrides()
  const configured = String(overrides.APP_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '')
  if (configured) return configured

  const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim()
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
  const host = forwardedHost || String(req.headers?.host || '').trim()
  const proto = forwardedProto || req.protocol || (req.secure ? 'https' : 'http')

  if (host) return `${proto}://${host}`
  return `http://localhost:${process.env.PORT || 3000}`
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
    if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or fewer.' })
    if (emailAddr.trim().length > 254) return res.status(400).json({ error: 'Email address is too long.' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddr.trim()))
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
    db.prepare('INSERT INTO users (id, name, email, password, initials, color, role, role_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name.trim(), norm, hash, getInitials(name), COLORS[userCount % COLORS.length], role, `builtin-${role.replace('_', '-')}`)
    const user = addRoleMetadata(db.prepare('SELECT id, name, email, initials, color, avatar, role, role_id FROM users WHERE id = ?').get(id))
    const sessionId = createSession(req, user.id)
    res.cookie('token', makeToken(user, sessionId), cookieOpts(req))
    audit(user.id, 'user.signup', 'user', user.id, user.name)
    res.json({ ok: true, user })
  } catch (err) { logger.error('signup:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email?.trim() || !password)
      return res.status(400).json({ error: 'Email and password are required.' })
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase())
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' })
    // Use the same response for unknown and inactive accounts to avoid account enumeration.
    if (user.is_active === 0)
      return res.status(401).json({ error: 'Invalid email or password.' })
    const { ok: pwOk, needsRehash } = await comparePassword(password, user.password)
    if (!pwOk) return res.status(401).json({ error: 'Invalid email or password.' })
    if (needsRehash) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(password), user.id)
    // If 2FA is enabled, allow trusted devices to skip the prompt.
    if (user.totp_enabled) {
      if (hasValidTrusted2FA(req, user)) {
        const { password: _, ...pubTrusted } = user
        addRoleMetadata(pubTrusted)
        const trustedSessionId = createSession(req, pubTrusted.id)
        res.cookie('token', makeToken(pubTrusted, trustedSessionId), cookieOpts(req))
        const trustedIp = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.ip || null
        audit(pubTrusted.id, 'user.login', 'user', pubTrusted.id, pubTrusted.name, {
          ip: trustedIp,
          ua: req.headers['user-agent'],
          twofaTrustedDevice: true,
        })
        return res.json({ ok: true, user: pubTrusted })
      }
      const pendingToken = jwt.sign(
        { totp_pending: true, uid: user.id },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      )
      return res.json({ ok: true, requiresTOTP: true, pendingToken })
    }
    const { password: _, ...pub } = user
    addRoleMetadata(pub)
    const sessionId = createSession(req, pub.id)
    res.cookie('token', makeToken(pub, sessionId), cookieOpts(req))
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.ip || null
    audit(pub.id, 'user.login', 'user', pub.id, pub.name, { ip, ua: req.headers['user-agent'] })
    res.json({ ok: true, user: pub })
  } catch (err) { logger.error('login:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/2fa/login ───────────────────────────────────────────────────
router.post('/2fa/login', async (req, res) => {
  try {
    const { pendingToken, code, rememberDevice } = req.body
    if (!pendingToken || !code)
      return res.status(400).json({ error: 'Pending token and code are required.' })
    let payload
    try {
      payload = jwt.verify(pendingToken, process.env.JWT_SECRET)
    } catch {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' })
    }
    if (!payload.totp_pending || !payload.uid)
      return res.status(401).json({ error: 'Invalid token.' })
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid)
    if (!user || !user.is_active || !user.totp_enabled || !user.totp_secret)
      return res.status(401).json({ error: 'Invalid token.' })
    const isValid = verifyTotpWithGrace(user.totp_secret, code)
    if (!isValid) return res.status(401).json({ error: 'Invalid authentication code.' })
    const { password: _, ...pub } = user
    addRoleMetadata(pub)
    const sessionId = createSession(req, pub.id)
    res.cookie('token', makeToken(pub, sessionId), cookieOpts(req))
    if (rememberDevice) {
      res.cookie(TWO_FA_TRUST_COOKIE, signTwoFaTrustToken(pub, req), twoFaTrustCookieOpts(req))
    }
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.ip || null
    audit(pub.id, 'user.login', 'user', pub.id, pub.name, { ip, ua: req.headers['user-agent'] })
    res.json({ ok: true, user: pub })
  } catch (err) { logger.error('2fa/login:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/logout ──────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  try {
    const token = req.cookies?.token
    if (token) {
      const decoded = jwt.decode(token)
      if (decoded?.sid) db.prepare('DELETE FROM user_sessions WHERE id = ?').run(decoded.sid)
    }
  } catch {}
  res.clearCookie('token', clearCookieOpts(req))
  res.json({ ok: true })
})

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const user = addRoleMetadata(db.prepare(`SELECT id, name, email, initials, color, avatar, role, role_id, is_active, created_at FROM users WHERE id = ?`).get(req.user.id))
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
      // Changing a password revokes every other browser/mobile session.
      updates.push('password = ?', 'token_version = token_version + 1'); vals.push(await hashPassword(newPassword))
    }
    if (updates.length) { vals.push(user.id); db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals) }
    const updated = addRoleMetadata(db.prepare('SELECT id, name, email, initials, color, avatar, role, role_id, token_version FROM users WHERE id = ?').get(user.id))
    // Rotate session: delete old, create new so the session list stays accurate
    if (req.user?.sid) db.prepare('DELETE FROM user_sessions WHERE id = ?').run(req.user.sid)
    const newSid = createSession(req, updated.id)
    res.cookie('token', makeToken(updated, newSid), cookieOpts(req))
    audit(user.id, 'user.profile_update', 'user', user.id, updated.name)
    res.json({ ok: true, user: updated })
  } catch (err) { logger.error('profile:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/email-change/request ───────────────────────────────────────
// Sends a verification link to the new email address.
// Requires SMTP — returns 400 if not configured (UI should show "contact admin").
router.post('/email-change/request', requireAuth, async (req, res) => {
  try {
    const smtp = emailSvc.getSmtpConfig()
    if (!smtp.enabled) return res.status(400).json({ error: 'Email changes require SMTP. Contact your administrator.' })

    const { newEmail } = req.body
    if (!newEmail?.trim()) return res.status(400).json({ error: 'New email address is required.' })
    const norm = newEmail.trim().toLowerCase()
    if (norm.length > 254) return res.status(400).json({ error: 'Email address is too long.' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return res.status(400).json({ error: 'Please enter a valid email address.' })

    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.id)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (norm === user.email) return res.status(400).json({ error: 'This is already your current email address.' })
    if (db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(norm, user.id))
      return res.status(409).json({ error: 'This email address is already in use.' })

    // Invalidate any previous pending requests for this user
    db.prepare('UPDATE email_change_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id)

    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expires   = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour
    db.prepare('INSERT INTO email_change_tokens (id, user_id, new_email, token, expires_at) VALUES (?,?,?,?,?)')
      .run(uuidv4(), user.id, norm, tokenHash, expires)

    const origin    = getPublicOrigin(req)
    const verifyUrl = `${origin}/api/auth/email-change/confirm?token=${rawToken}`
    await emailSvc.sendEmailChangeVerification({ to: norm, name: user.name, verifyUrl })

    audit(user.id, 'user.email_change_requested', 'user', user.id, user.name, { newEmail: norm })
    res.json({ ok: true })
  } catch (err) { logger.error('email-change/request:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── GET /api/auth/email-change/confirm ────────────────────────────────────────
// Validates the token from the verification email, updates the user's email,
// then redirects to profile with a success flag.
router.get('/email-change/confirm', async (req, res) => {
  const { token } = req.query
  const failUrl = '/profile.html?emailChangeFailed=1'
  if (!token) return res.redirect(failUrl)
  try {
    const tokenHash = hashToken(token)
    const row = db.prepare(`
      SELECT e.id, e.user_id, e.new_email, e.used, e.expires_at, u.name, u.email AS old_email
      FROM email_change_tokens e JOIN users u ON u.id = e.user_id
      WHERE e.token = ?
    `).get(tokenHash)

    if (!row || row.used || new Date(row.expires_at) < new Date()) return res.redirect(failUrl)

    // Check new_email is still available (could have been taken since request)
    if (db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(row.new_email, row.user_id))
      return res.redirect(failUrl + '&reason=taken')

    db.prepare('UPDATE email_change_tokens SET used = 1 WHERE id = ?').run(row.id)
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(row.new_email, row.user_id)
    // Invalidate all existing sessions so the new email is reflected everywhere
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(row.user_id)
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(row.user_id)

    audit(row.user_id, 'user.email_changed', 'user', row.user_id, row.name, { from: row.old_email, to: row.new_email })
    res.redirect('/profile.html?emailChanged=1')
  } catch (err) { logger.error('email-change/confirm:', err.message); res.redirect(failUrl) }
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
      const origin   = getPublicOrigin(req)
      const resetUrl = `${origin}/reset-password.html?token=${rawToken}`
      const result   = await emailSvc.sendPasswordReset({ to: emailAddr.toLowerCase().trim(), name: user.name, resetUrl })
      emailSent = result.ok
    }

    audit(user.id, 'user.forgot_password', 'user', user.id, user.name)
    res.json({ ok: true, emailSent })
  } catch (err) { logger.error('forgot-password:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── GET /api/auth/admin/reset-link/:userId ────────────────────────────────────
// Admin-only. Generates a one-time reset URL — the only way to reset when SMTP is off.
router.get('/admin/reset-link/:userId', requireAuth, async (req, res) => {
  if (!hasPermission(req, 'manage_users')) return res.status(403).json({ error: 'Admin only' })
  try {
    const user = db.prepare('SELECT id, name, email, role, role_id FROM users WHERE id = ?').get(req.params.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!canManageUserRole(req, user)) return res.status(403).json({ error: 'You cannot manage a user with permissions above your own.' })
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id)
    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expires   = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)')
      .run(uuidv4(), user.id, tokenHash, expires)
    const origin   = getPublicOrigin(req)
    const resetUrl = `${origin}/reset-password.html?token=${rawToken}`
    audit(req.user.id, 'user.admin_reset_link', 'user', user.id, user.name)
    res.json({ ok: true, resetUrl, expiresIn: '15 minutes' })
  } catch (err) { logger.error('admin reset-link:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/admin/reset-link/:userId/send ─────────────────────────────
// Admin-only. Generates a one-time reset URL and emails it directly to the user.
router.post('/admin/reset-link/:userId/send', requireAuth, async (req, res) => {
  if (!hasPermission(req, 'manage_users')) return res.status(403).json({ error: 'Admin only' })
  try {
    const smtp = emailSvc.getSmtpConfig()
    if (!smtp.enabled) return res.status(400).json({ error: 'SMTP is not configured.' })

    const user = db.prepare('SELECT id, name, email, role, role_id FROM users WHERE id = ?').get(req.params.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!canManageUserRole(req, user)) return res.status(403).json({ error: 'You cannot manage a user with permissions above your own.' })

    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id)
    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expires   = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)')
      .run(uuidv4(), user.id, tokenHash, expires)

    const origin   = getPublicOrigin(req)
    const resetUrl = `${origin}/reset-password.html?token=${rawToken}`
    const sent = await emailSvc.sendPasswordReset({ to: user.email, name: user.name, resetUrl })
    if (!sent.ok) return res.status(400).json({ error: sent.error || 'Failed to send reset email.' })

    audit(req.user.id, 'user.admin_reset_link', 'user', user.id, user.name, { delivery: 'email' })
    res.json({ ok: true, sentTo: user.email })
  } catch (err) {
    logger.error('admin reset-link/send:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
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
  } catch (err) { logger.error('reset validate:', err.message); res.status(500).json({ error: 'Server error' }) }
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
    // A recovery flow must revoke any sessions created before the reset.
    db.prepare('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?').run(await hashPassword(password), session.user_id)
    db.prepare('UPDATE password_reset_sessions SET used = 1 WHERE id = ?').run(session.id)
    audit(session.user_id, 'user.password_reset', 'user', session.user_id, null)
    res.json({ ok: true })
  } catch (err) { logger.error('reset-password:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// ── POST /api/auth/invite — admin creates account (works when signup disabled) ──
router.post('/invite', requireAuth, async (req, res) => {
  if (!hasPermission(req, 'manage_users')) return res.status(403).json({ error: 'Admin only' })
  const { name, email: emailAddr, role = 'member', role_id } = req.body
  if (!name?.trim() || !emailAddr?.trim()) return res.status(400).json({ error: 'Name and email required.' })
  if (name.trim().length > 100) return res.status(400).json({ error: 'Name must be 100 characters or fewer.' })
  if (emailAddr.trim().length > 254) return res.status(400).json({ error: 'Email address is too long.' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddr.trim())) return res.status(400).json({ error: 'Invalid email address.' })
  try {
    const norm = emailAddr.trim().toLowerCase()
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(norm))
      return res.status(409).json({ error: 'An account with this email already exists.' })
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c
    const tempPassword = crypto.randomBytes(8).toString('base64url') + 'A1!'
    const id = uuidv4()
    const selectedRole = role_id
      ? db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id)
      : db.prepare('SELECT * FROM roles WHERE id = ?').get(`builtin-${role.replace('_', '-')}`)
    const resolvedRole = selectedRole && !selectedRole.is_system ? selectedRole : db.prepare("SELECT * FROM roles WHERE id='builtin-member'").get()
    if (!canGrantRole(req, resolvedRole)) return res.status(403).json({ error: 'You cannot assign a role with permissions you do not have.' })
    const legacyRole = resolvedRole.id.startsWith('builtin-')
      ? resolvedRole.id.slice('builtin-'.length).replaceAll('-', '_')
      : 'member'
    db.prepare('INSERT INTO users (id, name, email, password, initials, color, role, role_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name.trim(), norm, await hashPassword(tempPassword), getInitials(name.trim()), COLORS[count % COLORS.length], legacyRole, resolvedRole.id)

    // Send invite email if SMTP is configured
    const smtp = emailSvc.getSmtpConfig()
    let emailSent = false
    if (smtp.enabled) {
      const origin = getPublicOrigin(req)
      const result = await emailSvc.sendAdminInvite({ to: norm, name: name.trim(), tempPassword, loginUrl: origin + '/login.html' })
      emailSent = result.ok
    }

    audit(req.user.id, 'user.invite', 'user', id, name.trim(), { by: req.user.name })
    res.json({ ok: true, emailSent, tempPassword: emailSent ? null : tempPassword })
  } catch (err) { logger.error('invite:', err.message); res.status(500).json({ error: 'Server error' }) }
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
    logger.error('2fa setup:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/2fa/verify — confirm code and enable 2FA ──────────────────
router.post('/2fa/verify', requireAuth, (req, res) => {
  const { secret, code } = req.body
  if (!secret || !code) return res.status(400).json({ error: 'Secret and code required' })
  try {
    const valid = verifyTotpWithGrace(secret, code)
    if (!valid) return res.status(400).json({ error: 'Invalid code — try again' })
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, req.user.id)
    audit(req.user.id, 'user.2fa_enabled', 'user', req.user.id, req.user.name)
    res.json({ ok: true })
  } catch (err) {
    logger.error('2fa verify:', err.message)
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
    const valid = verifyTotpWithGrace(user.totp_secret, code)
    if (!valid) return res.status(400).json({ error: 'Invalid code' })
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.user.id)
    res.clearCookie(TWO_FA_TRUST_COOKIE, clearCookieOpts(req))
    audit(req.user.id, 'user.2fa_disabled', 'user', req.user.id, req.user.name)
    res.json({ ok: true })
  } catch (err) {
    logger.error('2fa disable:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/auth/sessions — list all active sessions for current user ────────
router.get('/sessions', requireAuth, (req, res) => {
  try {
    const maxAgeHours = Math.max(1, Math.min(24 * 30, parseInt(process.env.COOKIE_MAX_AGE_HOURS || '72', 10) || 72))
    // JWT cookies cannot remain valid beyond their configured lifetime. Remove
    // abandoned rows so the session list reflects genuinely active sessions.
    db.prepare("DELETE FROM user_sessions WHERE user_id = ? AND last_used_at < datetime('now', ?)")
      .run(req.user.id, `-${maxAgeHours} hours`)
    const rows = db.prepare(
      'SELECT id, ip, user_agent, created_at, last_used_at FROM user_sessions WHERE user_id = ? ORDER BY last_used_at DESC'
    ).all(req.user.id)
    const sessions = rows.map(r => ({
      id:          r.id,
      label:       parseDeviceLabel(r.user_agent || ''),
      ip:          r.ip,
      createdAt:   r.created_at,
      lastUsedAt:  r.last_used_at,
      isCurrent:   r.id === req.user.sid,
    }))
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/auth/sessions/:id — revoke a specific session ─────────────────
router.delete('/sessions/:id', requireAuth, (req, res) => {
  try {
    const sess = db.prepare('SELECT id FROM user_sessions WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)
    if (!sess) return res.status(404).json({ error: 'Session not found' })
    db.prepare('DELETE FROM user_sessions WHERE id = ?').run(req.params.id)
    const isCurrent = req.params.id === req.user.sid
    if (isCurrent) res.clearCookie('token', clearCookieOpts(req))
    res.json({ ok: true, logout: isCurrent })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/auth/login-history — last 10 logins for current user ─────────────
router.get('/login-history', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, meta, created_at FROM audit_log
      WHERE actor_id = ? AND action = 'user.login'
      ORDER BY created_at DESC LIMIT 10
    `).all(req.user.id)
    const history = rows.map(r => {
      let meta = {}
      try { meta = JSON.parse(r.meta || '{}') } catch {}
      return {
        id:        r.id,
        createdAt: r.created_at,
        ip:        meta.ip || null,
        label:     parseDeviceLabel(meta.ua || ''),
      }
    })
    res.json({ history })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/logout-all — clear cookie and delete all sessions ──────────
router.post('/logout-all', requireAuth, (req, res) => {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(req.user.id)
  res.clearCookie('token', clearCookieOpts(req))
  res.clearCookie(TWO_FA_TRUST_COOKIE, clearCookieOpts(req))
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
    logger.error('export error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/revoke-all — invalidate all JWTs + delete all sessions ─────
router.post('/revoke-all', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id)
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(req.user.id)
  res.clearCookie('token', clearCookieOpts(req))
  res.clearCookie(TWO_FA_TRUST_COOKIE, clearCookieOpts(req))
  audit(req.user.id, 'user.revoke_all', 'user', req.user.id, req.user.name)
  res.json({ ok: true })
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
    res.clearCookie('token', clearCookieOpts(req))
    res.json({ ok: true })
  } catch (err) {
    logger.error('delete account:', err.message)
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
    const ALLOWED = ['weekStartDay', 'defaultView', 'showWeekNumbers', 'holidays', 'defaultShiftStart', 'defaultShiftEnd', 'compactChips', 'shiftPanelSide']
    const DEFAULT_VIEWS = new Set(['month', 'week', 'agenda'])
    const normalizeDefaultView = value => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
      return DEFAULT_VIEWS.has(normalized) ? normalized : 'month'
    }
    const incoming = req.body || {}
    for (const k of ALLOWED) {
      if (k in incoming) {
        existing[k] = k === 'defaultView' ? normalizeDefaultView(incoming[k]) : incoming[k]
      }
    }
    if ('defaultView' in existing && !DEFAULT_VIEWS.has(existing.defaultView)) {
      existing.defaultView = normalizeDefaultView(existing.defaultView)
    }
    db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(existing), req.user.id)
    res.json(existing)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
