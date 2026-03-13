'use strict';
const express   = require('express');
const crypto    = require('crypto');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../config/database');
const { hashPassword, comparePassword, validatePassword } = require('../auth-utils');
const audit     = require('../audit');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  message:  { error: 'Too many attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Tighter limiter for password reset — prevents token farming
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      5,
  message:  { error: 'Too many reset attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', authLimiter, [
  body('identifier').trim().notEmpty().withMessage('Email or username required'),
  body('password').notEmpty().withMessage('Password required'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { identifier, password } = req.body;
  const db = getDb();

  const user = db.prepare(`
    SELECT * FROM users
    WHERE (LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?))
  `).get(identifier, identifier);

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.active) return res.status(403).json({ error: 'Your account has been deactivated. Contact an administrator.' });

  const { ok: pwOk, needsRehash } = comparePassword(password, user.password);
  if (!pwOk) return res.status(401).json({ error: 'Invalid credentials' });

  // Transparent pepper rotation: re-hash with new pepper on successful login
  if (needsRehash) {
    const newHash = hashPassword(password);
    db.prepare("UPDATE users SET password=?, updated_at=datetime('now') WHERE id=?").run(newHash, user.id);
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.name     = user.name;
    req.session.role     = user.role;
    req.session.email    = user.email;

    audit(db, user.id, 'user.login', 'user', user.id, user.name);
    res.json({
      success: true,
      user: { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email },
    });
  });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const db = getDb();
  const userId = req.session?.userId;
  const name   = req.session?.name;
  req.session.destroy(() => {
    res.clearCookie('forgeshift.sid');
    if (userId) audit(db, userId, 'user.logout', 'user', userId, name);
    res.json({ success: true });
  });
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', authLimiter, [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters'),
  body('username').trim().isAlphanumeric().isLength({ min: 3, max: 30 }).withMessage('Username must be 3–30 alphanumeric characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], (req, res) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'allow_signup'").get();
  if (!setting || setting.value !== 'true')
    return res.status(403).json({ error: 'Registration is currently disabled.' });

  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const pv = validatePassword(req.body.password);
  if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') });

  const { name, username, email, password } = req.body;

  if (db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email))
    return res.status(409).json({ error: 'Email already registered.' });
  if (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username))
    return res.status(409).json({ error: 'Username already taken.' });

  const id   = uuidv4();
  const hash = hashPassword(password);
  db.prepare(`INSERT INTO users (id, username, email, password, name, role, active) VALUES (?, ?, ?, ?, ?, 'user', 1)`)
    .run(id, username, email, hash, name);

  audit(db, id, 'user.signup', 'user', id, name);
  res.status(201).json({ success: true, message: 'Account created. Please sign in.' });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });
  res.json({
    user: {
      id:       req.session.userId,
      username: req.session.username,
      name:     req.session.name,
      role:     req.session.role,
      email:    req.session.email,
    },
  });
});

// ── GET /api/auth/signup-enabled ──────────────────────────────────────────────
router.get('/signup-enabled', (req, res) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'allow_signup'").get();
  res.json({ enabled: setting?.value === 'true' });
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Rate-limited tightly. Identical response regardless of outcome — prevents
// email enumeration. Token is hashed before DB storage; raw token only ever
// appears in the reset URL sent to the user's email (or via admin reset-link).
// When SMTP is not configured, the response is generic — use admin reset-link.
router.post('/forgot-password', resetLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
], (req, res) => {
  // Always return the same shape regardless of whether the email exists
  const GENERIC = { success: true, emailSent: false };
  const errors  = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { email } = req.body;
  const db = getDb();

  const user = db.prepare('SELECT id, name FROM users WHERE LOWER(email) = LOWER(?) AND active = 1').get(email);
  if (!user) return res.json(GENERIC);  // Don't reveal whether email exists

  // Invalidate all existing unused tokens for this user
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const requestIp = req.ip || req.connection?.remoteAddress || '';

  db.prepare(`
    INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, request_ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), user.id, tokenHash, expiresAt, requestIp);

  // TODO: wire up your email transport here (nodemailer etc.)
  // const resetUrl = `${process.env.APP_URL}/reset-password?token=${rawToken}`;
  // await sendPasswordResetEmail({ to: email, name: user.name, resetUrl });
  // If email sent successfully: return res.json({ success: true, emailSent: true });

  // SMTP not configured — don't expose the token in the response.
  // Admin can generate a reset link from Settings → Users → Reset Link.
  res.json(GENERIC);
});

// ── GET /api/auth/admin/reset-link/:userId ────────────────────────────────────
// Admin-only. The only way to get a reset URL when SMTP isn't configured.
// Token is consumed immediately on /validate — cannot be replayed.
router.get('/admin/reset-link/:userId', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Authentication required' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const db = getDb();
  const target = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Invalidate any existing unused tokens first
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(target.id);

  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, request_ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), target.id, tokenHash, expiresAt, 'admin-generated');

  const appUrl   = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const resetUrl = `${appUrl}/reset-password?token=${rawToken}`;

  audit(db, req.session.userId, 'user.admin_reset_link', 'user', target.id, target.name);
  res.json({ success: true, resetUrl, expiresIn: '15 minutes' });
});

// ── GET /api/auth/reset-password/validate ─────────────────────────────────────
// Called once when the reset page loads. Validates + immediately consumes the
// URL token, then issues a short-lived (5 min) server-side sessionKey.
// The URL token is destroyed here — the browser holds only sessionKey in memory.
router.get('/reset-password/validate', resetLimiter, (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const db        = getDb();
  const tokenHash = hashToken(token);
  const row       = db.prepare(`
    SELECT r.id, r.user_id, r.used, r.expires_at, u.name, u.email
    FROM password_reset_tokens r
    JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ?
  `).get(tokenHash);

  if (!row || row.used || new Date(row.expires_at) < new Date())
    return res.status(400).json({ error: 'Invalid or expired reset link' });

  // Consume the URL token immediately — it can never be used again
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);

  // Issue a short-lived (5 min) server-side session key
  const sessionKey = crypto.randomBytes(32).toString('hex');
  const sessionExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO password_reset_sessions (id, user_id, expires_at) VALUES (?, ?, ?)
  `).run(sessionKey, row.user_id, sessionExp);

  res.json({ success: true, sessionKey, name: row.name, email: row.email });
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
// Accepts sessionKey (from /validate step), not the original URL token.
// sessionKey lives only in JS memory — never in URL, localStorage, or cookies.
router.post('/reset-password', resetLimiter, [
  body('sessionKey').notEmpty().withMessage('Session key required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { sessionKey, password } = req.body;
  const pv = validatePassword(password);
  if (!pv.ok) return res.status(400).json({ error: pv.errors.join(' ') });

  const db      = getDb();
  const session = db.prepare(
    'SELECT id, user_id, expires_at, used FROM password_reset_sessions WHERE id = ?'
  ).get(sessionKey);

  if (!session)     return res.status(400).json({ error: 'Invalid or expired session' });
  if (session.used) return res.status(400).json({ error: 'This reset session has already been used' });
  if (new Date(session.expires_at) < new Date()) return res.status(400).json({ error: 'Reset session has expired' });

  const hash = hashPassword(password);
  db.prepare("UPDATE users SET password=?, updated_at=datetime('now') WHERE id=?").run(hash, session.user_id);
  db.prepare('UPDATE password_reset_sessions SET used = 1 WHERE id = ?').run(session.id);

  audit(db, session.user_id, 'user.password_reset', 'user', session.user_id, null);
  res.json({ success: true });
});

module.exports = router;
