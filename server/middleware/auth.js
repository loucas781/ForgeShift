'use strict'
const jwt = require('jsonwebtoken')
const db  = require('../db/connection')

function clearCookieOpts() {
  const secure = process.env.COOKIE_SECURE === 'true'
  return { httpOnly: true, secure, sameSite: secure ? 'strict' : 'lax', path: '/' }
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token
  if (!token) {
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' })
    return res.redirect('/login.html')
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    // Validate token_version to support "sign out all devices"
    const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(req.user.id)
    if (!row || (row.token_version || 0) !== (req.user.tv || 0)) {
      res.clearCookie('token', clearCookieOpts())
      if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session revoked' })
      return res.redirect('/login.html')
    }
    // Validate per-device session (JWTs with sid) and update last_used_at
    if (req.user.sid) {
      const sess = db.prepare('SELECT id, last_used_at FROM user_sessions WHERE id = ? AND user_id = ?')
        .get(req.user.sid, req.user.id)
      if (!sess) {
        res.clearCookie('token', clearCookieOpts())
        if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session revoked' })
        return res.redirect('/login.html')
      }
      // Only write last_used_at if more than 60 seconds have passed (avoid excessive writes)
      const lastUsed = new Date(sess.last_used_at).getTime()
      if (Date.now() - lastUsed > 60000) {
        db.prepare("UPDATE user_sessions SET last_used_at = datetime('now') WHERE id = ?").run(req.user.sid)
      }
    }
    next()
  } catch (err) {
    res.clearCookie('token', clearCookieOpts())
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' })
    return res.redirect('/login.html')
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies?.token
  if (token) {
    try { req.user = jwt.verify(token, process.env.JWT_SECRET) }
    catch { res.clearCookie('token', clearCookieOpts()) }
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

// Passes for admin or manager
function requireAdminOrManager(req, res, next) {
  if (!req.user || !['admin', 'manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Admin or manager only' })
  next()
}

// Passes for admin, manager, or shift_lead
function requireShiftLead(req, res, next) {
  if (!req.user || !['admin', 'manager', 'shift_lead'].includes(req.user.role))
    return res.status(403).json({ error: 'Insufficient permissions' })
  next()
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireAdminOrManager, requireShiftLead }
