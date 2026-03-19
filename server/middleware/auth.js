'use strict'
const jwt = require('jsonwebtoken')
const db  = require('../db/connection')

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
      res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' })
      if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session revoked' })
      return res.redirect('/login.html')
    }
    next()
  } catch (err) {
    res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' })
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' })
    return res.redirect('/login.html')
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies?.token
  if (token) {
    try { req.user = jwt.verify(token, process.env.JWT_SECRET) }
    catch { res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' }) }
  }
  next()
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

// Passes for admin or shift_lead
function requireShiftLead(req, res, next) {
  if (!req.user || !['admin', 'shift_lead'].includes(req.user.role))
    return res.status(403).json({ error: 'Insufficient permissions' })
  next()
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireShiftLead }
