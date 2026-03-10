'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// ── Templates ────────────────────────────────────────────────────────────────
const templatesRouter = express.Router();

templatesRouter.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const isAdmin = req.session.role === 'admin';
  let templates;

  if (isAdmin) {
    templates = db.prepare(`
      SELECT t.*, u.name as created_by_name FROM templates t
      LEFT JOIN users u ON t.created_by = u.id
      ORDER BY t.created_at DESC
    `).all();
  } else {
    templates = db.prepare(`
      SELECT t.*, u.name as created_by_name FROM templates t
      LEFT JOIN users u ON t.created_by = u.id
      WHERE t.created_by = ? OR t.is_shared = 1
      ORDER BY t.created_at DESC
    `).all(req.session.userId);
  }

  // Attach days
  const getDays = db.prepare('SELECT * FROM template_days WHERE template_id = ? ORDER BY day_index');
  templates = templates.map(t => ({
    ...t,
    days: getDays.all(t.id)
  }));

  res.json({ templates });
});

templatesRouter.post('/', requireAuth, [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name required'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const db = getDb();
  const { name, description, isShared, days } = req.body;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO templates (id, name, description, is_shared, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, description || null, isShared ? 1 : 0, req.session.userId);

  if (days && typeof days === 'object') {
    const insertDay = db.prepare(`
      INSERT OR REPLACE INTO template_days (id, template_id, day_index, location_id, start_time, end_time, notes, note_color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    Object.entries(days).forEach(([idx, d]) => {
      if (d && d.locationId) {
        insertDay.run(uuidv4(), id, parseInt(idx), d.locationId, d.startTime || '09:00', d.endTime || '17:00', d.notes || null, d.noteColor || null);
      }
    });
  }

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  const templateDays = db.prepare('SELECT * FROM template_days WHERE template_id = ? ORDER BY day_index').all(id);
  res.status(201).json({ template: { ...template, days: templateDays } });
});

templatesRouter.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  const isAdmin = req.session.role === 'admin';
  if (!isAdmin && tpl.created_by !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { name, description, isShared, days } = req.body;

  db.prepare(`UPDATE templates SET name=?, description=?, is_shared=?, updated_at=datetime('now') WHERE id=?`)
    .run(name || tpl.name, description ?? tpl.description, isShared ? 1 : 0, req.params.id);

  if (days && typeof days === 'object') {
    db.prepare('DELETE FROM template_days WHERE template_id = ?').run(req.params.id);
    const insertDay = db.prepare(`
      INSERT INTO template_days (id, template_id, day_index, location_id, start_time, end_time, notes, note_color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    Object.entries(days).forEach(([idx, d]) => {
      if (d && d.locationId) {
        insertDay.run(uuidv4(), req.params.id, parseInt(idx), d.locationId, d.startTime || '09:00', d.endTime || '17:00', d.notes || null, d.noteColor || null);
      }
    });
  }

  const updated = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  const updatedDays = db.prepare('SELECT * FROM template_days WHERE template_id = ? ORDER BY day_index').all(req.params.id);
  res.json({ template: { ...updated, days: updatedDays } });
});

templatesRouter.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  const isAdmin = req.session.role === 'admin';
  if (!isAdmin && tpl.created_by !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/templates/:id/apply
templatesRouter.post('/:id/apply', requireAuth, [
  body('date').isDate().withMessage('Valid date required'),
], async (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  const { date, userId } = req.body;
  const isAdmin = req.session.role === 'admin';
  const targetUserId = (isAdmin && userId) ? userId : req.session.userId;

  const d = new Date(date + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

  const templateDays = db.prepare('SELECT * FROM template_days WHERE template_id = ? ORDER BY day_index').all(tpl.id);

  const insertShift = db.prepare(`
    INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes, note_color, template_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const created = [];
  templateDays.forEach(td => {
    if (!td.location_id) return;
    const shiftDate = new Date(monday);
    shiftDate.setUTCDate(monday.getUTCDate() + td.day_index);
    const dateStr = shiftDate.toISOString().split('T')[0];
    const id = uuidv4();
    insertShift.run(id, targetUserId, td.location_id, dateStr, td.start_time, td.end_time, td.notes, td.note_color, tpl.id, req.session.userId);
    created.push(id);
  });

  res.json({ success: true, created: created.length });
});

// ── Locations ────────────────────────────────────────────────────────────────
const locationsRouter = express.Router();

locationsRouter.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const locations = db.prepare('SELECT * FROM locations ORDER BY name ASC').all();
  res.json({ locations });
});

locationsRouter.post('/', requireAuth, [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name required'),
  body('color').matches(/^#[0-9a-fA-F]{6}$/).withMessage('Valid hex color required'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const db = getDb();
  const { name, address, color } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO locations (id, name, address, color, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, address || null, color, req.session.userId);
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  res.status(201).json({ location: loc });
});

locationsRouter.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Location not found' });

  const { name, address, color } = req.body;
  db.prepare('UPDATE locations SET name=?, address=?, color=? WHERE id=?')
    .run(name || loc.name, address ?? loc.address, color || loc.color, req.params.id);
  res.json({ location: db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id) });
});

locationsRouter.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Users ────────────────────────────────────────────────────────────────────
const usersRouter = express.Router();

usersRouter.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, email, name, role, active, created_at FROM users ORDER BY created_at ASC').all();
  res.json({ users });
});

usersRouter.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, email, name, role, active, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user });
});

usersRouter.put('/me', requireAuth, [
  body('name').trim().isLength({ min: 2 }).withMessage('Name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const db = getDb();
  const { name, email } = req.body;

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(email, req.session.userId);
  if (existing) return res.status(409).json({ error: 'Email already in use' });

  db.prepare("UPDATE users SET name=?, email=?, updated_at=datetime('now') WHERE id=?")
    .run(name, email, req.session.userId);

  req.session.name  = name;
  req.session.email = email;

  res.json({ success: true });
});

usersRouter.put('/me/password', requireAuth, [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(req.body.currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(req.body.newPassword, 12);
  db.prepare("UPDATE users SET password=?, updated_at=datetime('now') WHERE id=?").run(hash, req.session.userId);
  res.json({ success: true });
});

usersRouter.post('/', requireAdmin, [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name required'),
  body('username').trim().isAlphanumeric().isLength({ min: 3, max: 30 }).withMessage('Valid username required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const db = getDb();
  const { name, username, email, password, role } = req.body;

  if (db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  if (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users (id, username, email, password, name, role, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(id, username, email, hash, name, role === 'admin' ? 'admin' : 'user');

  const user = db.prepare('SELECT id, username, email, name, role, active, created_at FROM users WHERE id = ?').get(id);
  res.status(201).json({ user });
});

usersRouter.put('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, email, role, active } = req.body;

  if (email && email !== user.email) {
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(email, req.params.id);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
  }

  db.prepare(`UPDATE users SET name=?, email=?, role=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(name ?? user.name, email ?? user.email, role ?? user.role, active !== undefined ? (active ? 1 : 0) : user.active, req.params.id);

  res.json({ user: db.prepare('SELECT id, username, email, name, role, active, created_at FROM users WHERE id = ?').get(req.params.id) });
});

usersRouter.post('/:id/reset-password', requireAdmin, [
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const db = getDb();
  const hash = bcrypt.hashSync(req.body.newPassword, 12);
  db.prepare("UPDATE users SET password=?, updated_at=datetime('now') WHERE id=?").run(hash, req.params.id);
  res.json({ success: true });
});

usersRouter.delete('/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Settings ─────────────────────────────────────────────────────────────────
const settingsRouter = express.Router();

settingsRouter.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ settings });
});

settingsRouter.put('/:key', requireAdmin, (req, res) => {
  const db = getDb();
  const { value } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES(?, ?, datetime('now'))").run(req.params.key, String(value));
  res.json({ success: true });
});

module.exports = { templatesRouter, locationsRouter, usersRouter, settingsRouter };
