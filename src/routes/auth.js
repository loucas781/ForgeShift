'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  message:  { error: 'Too many attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/auth/login
router.post('/login', authLimiter, [
  body('identifier').trim().notEmpty().withMessage('Email or username required'),
  body('password').notEmpty().withMessage('Password required'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { identifier, password } = req.body;
  const db = getDb();

  const user = db.prepare(`
    SELECT * FROM users
    WHERE (LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?))
  `).get(identifier, identifier);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!user.active) {
    return res.status(403).json({ error: 'Your account has been deactivated. Contact an administrator.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });

    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.name     = user.name;
    req.session.role     = user.role;
    req.session.email    = user.email;

    res.json({
      success: true,
      user: {
        id:       user.id,
        username: user.username,
        name:     user.name,
        role:     user.role,
        email:    user.email,
      }
    });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// POST /api/auth/register
router.post('/register', authLimiter, [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters'),
  body('username').trim().isAlphanumeric().isLength({ min: 3, max: 30 }).withMessage('Username must be 3–30 alphanumeric characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], (req, res) => {
  const db = getDb();

  // Check signup enabled
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'allow_signup'").get();
  if (!setting || setting.value !== 'true') {
    return res.status(403).json({ error: 'Registration is currently disabled.' });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { name, username, email, password } = req.body;
  const { v4: uuidv4 } = require('uuid');

  const existingEmail    = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  const existingUsername = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);

  if (existingEmail)    return res.status(409).json({ error: 'Email already registered.' });
  if (existingUsername) return res.status(409).json({ error: 'Username already taken.' });

  const hash = bcrypt.hashSync(password, 12);
  const id   = uuidv4();

  db.prepare(`
    INSERT INTO users (id, username, email, password, name, role, active)
    VALUES (?, ?, ?, ?, ?, 'user', 1)
  `).run(id, username, email, hash, name);

  res.status(201).json({ success: true, message: 'Account created. Please sign in.' });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });
  res.json({
    user: {
      id:       req.session.userId,
      username: req.session.username,
      name:     req.session.name,
      role:     req.session.role,
      email:    req.session.email,
    }
  });
});

// GET /api/auth/signup-enabled
router.get('/signup-enabled', (req, res) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'allow_signup'").get();
  res.json({ enabled: setting?.value === 'true' });
});

module.exports = router;
