'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/shifts  – get shifts (admin: all or by userId, user: own)
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { userId, from, to } = req.query;
  const isAdmin = req.session.role === 'admin';

  let sql = `
    SELECT s.*, l.name as location_name, l.color as location_color,
           u.name as user_name
    FROM shifts s
    LEFT JOIN locations l ON s.location_id = l.id
    LEFT JOIN users u ON s.user_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (!isAdmin) {
    sql += ' AND s.user_id = ?';
    params.push(req.session.userId);
  } else if (userId) {
    sql += ' AND s.user_id = ?';
    params.push(userId);
  }

  if (from) { sql += ' AND s.date >= ?'; params.push(from); }
  if (to)   { sql += ' AND s.date <= ?'; params.push(to); }

  sql += ' ORDER BY s.date ASC, s.start_time ASC';

  const shifts = db.prepare(sql).all(...params);
  res.json({ shifts });
});

// GET /api/shifts/:id
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const shift = db.prepare(`
    SELECT s.*, l.name as location_name, l.color as location_color,
           u.name as user_name
    FROM shifts s
    LEFT JOIN locations l ON s.location_id = l.id
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!shift) return res.status(404).json({ error: 'Shift not found' });

  // Non-admin can only see their own
  if (req.session.role !== 'admin' && shift.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ shift });
});

// POST /api/shifts
router.post('/', requireAuth, [
  body('date').isDate().withMessage('Valid date required (YYYY-MM-DD)'),
  body('locationId').notEmpty().withMessage('Location required'),
  body('startTime').matches(/^\d{2}:\d{2}$/).withMessage('Start time required (HH:MM)'),
  body('endTime').matches(/^\d{2}:\d{2}$/).withMessage('End time required (HH:MM)'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const db = getDb();
  const { date, locationId, startTime, endTime, notes, noteColor, userId, templateId } = req.body;

  const isAdmin = req.session.role === 'admin';
  const targetUserId = (isAdmin && userId) ? userId : req.session.userId;

  // Verify location exists
  const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(locationId);
  if (!loc) return res.status(400).json({ error: 'Location not found' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO shifts (id, user_id, location_id, date, start_time, end_time, notes, note_color, template_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, targetUserId, locationId, date, startTime, endTime, notes || null, noteColor || null, templateId || null, req.session.userId);

  const shift = db.prepare('SELECT s.*, l.name as location_name, l.color as location_color FROM shifts s LEFT JOIN locations l ON s.location_id = l.id WHERE s.id = ?').get(id);
  res.status(201).json({ shift });
});

// PUT /api/shifts/:id
router.put('/:id', requireAuth, [
  body('date').isDate().withMessage('Valid date required'),
  body('locationId').notEmpty().withMessage('Location required'),
], (req, res) => {
  const db = getDb();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });

  const isAdmin = req.session.role === 'admin';
  if (!isAdmin && shift.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { date, locationId, startTime, endTime, notes, noteColor, userId } = req.body;
  const targetUserId = (isAdmin && userId) ? userId : shift.user_id;

  db.prepare(`
    UPDATE shifts SET
      user_id = ?, location_id = ?, date = ?, start_time = ?,
      end_time = ?, notes = ?, note_color = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(targetUserId, locationId, date, startTime || '09:00', endTime || '17:00', notes || null, noteColor || null, req.params.id);

  const updated = db.prepare('SELECT s.*, l.name as location_name, l.color as location_color FROM shifts s LEFT JOIN locations l ON s.location_id = l.id WHERE s.id = ?').get(req.params.id);
  res.json({ shift: updated });
});

// DELETE /api/shifts/:id
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });

  const isAdmin = req.session.role === 'admin';
  if (!isAdmin && shift.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
