'use strict'
const jwt = require('jsonwebtoken')
const db  = require('../db/connection')
const { getRoleForUser, hasPermission, rolePermissions } = require('../utils/roles')

// ── Inactivity timeout (cached, refreshed every 30s) ──────────────────────────
let _inactivityCache = null
let _inactivityCachedAt = 0
function getInactivityTimeoutMs() {
  if (Date.now() - _inactivityCachedAt < 30000) return _inactivityCache
  try {
    const { loadOverrides } = require('../utils/overrides')
    const ov = loadOverrides()
    const mins = ov.INACTIVITY_TIMEOUT_MINUTES != null ? parseInt(ov.INACTIVITY_TIMEOUT_MINUTES) : 15
    _inactivityCache = mins > 0 ? mins * 60 * 1000 : 0
  } catch { _inactivityCache = 15 * 60 * 1000 }
  _inactivityCachedAt = Date.now()
  return _inactivityCache
}

function isHttpsRequest(req) {
  if (!req) return true
  if (req.secure) return true
  const xfProto = String(req.headers?.['x-forwarded-proto'] || '').toLowerCase()
  return xfProto.split(',')[0].trim() === 'https'
}

function clearCookieOpts(req) {
  const secure = process.env.COOKIE_SECURE === 'true' && isHttpsRequest(req)
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
    // Resolve the account and role on every request.  This makes role/active
    // changes effective immediately instead of waiting for a JWT refresh.
    const row = db.prepare('SELECT token_version, is_active, role, role_id FROM users WHERE id = ?').get(req.user.id)
    if (!row || (row.token_version || 0) !== (req.user.tv || 0)) {
      res.clearCookie('token', clearCookieOpts(req))
      if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session revoked' })
      return res.redirect('/login.html')
    }
    if (!row.is_active) {
      res.clearCookie('token', clearCookieOpts(req))
      if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Account inactive' })
      return res.redirect('/login.html?reason=inactive')
    }
    const role = getRoleForUser(req.user.id)
    req.user.role = row.role
    req.user.role_id = row.role_id || null
    req.user.role_name = role?.name || null
    req.user.role_color = role?.color || null
    req.user.permissions = rolePermissions(role || { role: row.role })
    // Validate per-device session (JWTs with sid) and update last_used_at
    if (req.user.sid) {
      const sess = db.prepare('SELECT id, last_used_at FROM user_sessions WHERE id = ? AND user_id = ?')
        .get(req.user.sid, req.user.id)
      if (!sess) {
        res.clearCookie('token', clearCookieOpts(req))
        if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session revoked' })
        return res.redirect('/login.html')
      }
      // Check inactivity timeout (server-side enforcement, client handles UX)
      const lastUsed = new Date(sess.last_used_at).getTime()
      const inactivityMs = getInactivityTimeoutMs()
      if (inactivityMs > 0 && Date.now() - lastUsed > inactivityMs) {
        db.prepare('DELETE FROM user_sessions WHERE id = ?').run(req.user.sid)
        res.clearCookie('token', clearCookieOpts(req))
        if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Signed out due to inactivity', code: 'INACTIVITY_TIMEOUT' })
        return res.redirect('/login.html?reason=inactivity')
      }
      // Only write last_used_at if more than 60 seconds have passed (avoid excessive writes)
      if (Date.now() - lastUsed > 60000) {
        db.prepare("UPDATE user_sessions SET last_used_at = datetime('now') WHERE id = ?").run(req.user.sid)
      }
    }
    next()
  } catch (err) {
    res.clearCookie('token', clearCookieOpts(req))
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' })
    return res.redirect('/login.html')
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies?.token
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET)
      const row = db.prepare('SELECT token_version, is_active, role, role_id FROM users WHERE id = ?').get(payload.id)
      if (!row || !row.is_active || (row.token_version || 0) !== (payload.tv || 0)) {
        res.clearCookie('token', clearCookieOpts(req))
      } else {
        const role = getRoleForUser(payload.id)
        req.user = {
          ...payload,
          role: row.role,
          role_id: row.role_id || null,
          role_name: role?.name || null,
          role_color: role?.color || null,
          permissions: rolePermissions(role || { role: row.role }),
        }
      }
    } catch { res.clearCookie('token', clearCookieOpts(req)) }
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!req.user || !hasPermission(req, 'manage_users')) return res.status(403).json({ error: 'Admin only' })
  next()
}

// Passes for admin or manager
function requireAdminOrManager(req, res, next) {
  if (!req.user || (!hasPermission(req, 'manage_templates') && !hasPermission(req, 'manage_teams')))
    return res.status(403).json({ error: 'Admin or manager only' })
  next()
}

// Passes for admin, manager, or shift_lead
function requireShiftLead(req, res, next) {
  if (!req.user || (!hasPermission(req, 'manage_tasks') && !hasPermission(req, 'add_other_shifts')))
    return res.status(403).json({ error: 'Insufficient permissions' })
  next()
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req, permission)) return res.status(403).json({ error: 'Insufficient permissions', permission })
    next()
  }
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireAdminOrManager, requireShiftLead, requirePermission, clearCookieOpts }
