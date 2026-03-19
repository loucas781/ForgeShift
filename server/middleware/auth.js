'use strict'
const jwt = require('jsonwebtoken')

function requireAuth(req, res, next) {
  const token = req.cookies?.token
  if (!token) {
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' })
    return res.redirect('/login.html')
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
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
