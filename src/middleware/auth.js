'use strict';

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function loadUser(req, res, next) {
  if (req.session?.userId) {
    res.locals.user = {
      id:       req.session.userId,
      username: req.session.username,
      name:     req.session.name,
      role:     req.session.role,
      email:    req.session.email,
    };
  }
  next();
}

module.exports = { requireAuth, requireAdmin, loadUser };
