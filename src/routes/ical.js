'use strict';
const express  = require('express');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── iCal helpers ────────────────────────────────────────────────────────────

function icalDate(dateStr, timeStr) {
  const d = dateStr.replace(/-/g, '');
  const t = (timeStr || '00:00').replace(':', '') + '00';
  return `${d}T${t}00`;
}

function escapeIcal(str) {
  if (!str) return '';
  return str.replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n').replace(/\r/g,'');
}

function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < bytes.length) { parts.push(bytes.slice(i, i + 75).toString('utf8')); i += 75; }
  return parts.join('\r\n ');
}

function buildIcal(calName, events) {
  const now = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0',
    'PRODID:-//ForgeShift//ForgeShift Rota Manager//EN',
    'CALSCALE:GREGORIAN','METHOD:PUBLISH',
    foldLine(`X-WR-CALNAME:${escapeIcal(calName)}`),
    'X-WR-TIMEZONE:Europe/London',
    'X-WR-CALDESC:ForgeShift work rota feed',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  events.forEach(ev => {
    const uid  = ev.id ? `${ev.id}@forgeshift` : `${uuidv4()}@forgeshift`;
    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${uid}`));
    lines.push(`DTSTAMP:${now}`);
    lines.push(foldLine(`DTSTART;TZID=Europe/London:${icalDate(ev.date, ev.start_time)}`));
    lines.push(foldLine(`DTEND;TZID=Europe/London:${icalDate(ev.date, ev.end_time)}`));
    lines.push(foldLine(`SUMMARY:${escapeIcal(ev.summary)}`));
    if (ev.location)    lines.push(foldLine(`LOCATION:${escapeIcal(ev.location)}`));
    if (ev.description) lines.push(foldLine(`DESCRIPTION:${escapeIcal(ev.description)}`));
    if (ev.note_color) {
      lines.push(`COLOR:${ev.note_color}`);
      lines.push(`X-APPLE-CALENDAR-COLOR:${ev.note_color}`);
    }
    lines.push('STATUS:CONFIRMED','TRANSP:OPAQUE','END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function buildEvents(shifts, includeUser = false) {
  return shifts.map(s => {
    const locName  = s.location_name || 'Unknown Location';
    const summary  = includeUser && s.user_name ? `${locName} — ${s.user_name}` : locName;
    let desc = '';
    if (s.notes)                           desc += s.notes;
    if (includeUser && s.user_name)        desc += (desc ? '\n\n' : '') + `Staff: ${s.user_name}`;
    if (s.start_time && s.end_time)        desc += (desc ? '\n' : '')   + `Hours: ${s.start_time} – ${s.end_time}`;
    return { id:s.id, date:s.date, start_time:s.start_time, end_time:s.end_time,
             summary, location:s.location_name||'', description:desc, note_color:s.note_color };
  });
}

function resolveToken(token) {
  const db     = getDb();
  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  const row    = db.prepare(`
    SELECT u.id, u.role, u.active, u.name FROM ical_tokens t
    JOIN users u ON t.user_id = u.id WHERE t.token_hash = ?
  `).get(hashed);
  if (row) {
    db.prepare("UPDATE ical_tokens SET last_used_at=datetime('now') WHERE token_hash=?").run(hashed);
  }
  return row || null;
}

function icalHeaders(res, filename) {
  res.set({
    'Content-Type':        'text/calendar; charset=utf-8',
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control':       'no-store, no-cache, must-revalidate',
    'Pragma':              'no-cache', 'Expires': '0',
  });
}

function dateRange() {
  const from = new Date(); from.setMonth(from.getMonth() - 3);
  const to   = new Date(); to.setMonth(to.getMonth() + 12);
  return [from.toISOString().split('T')[0], to.toISOString().split('T')[0]];
}

// GET /api/ical/:token/my-shifts.ics
router.get('/:token/my-shifts.ics', (req, res) => {
  const user = resolveToken(req.params.token);
  if (!user || !user.active) return res.status(401).type('text/plain').send('Invalid iCal token.');
  const db = getDb();
  const appName = process.env.ICAL_CALENDAR_NAME || 'ForgeShift';
  const [from, to] = dateRange();
  const shifts = db.prepare(`
    SELECT s.*, l.name as location_name, l.color as location_color, l.address
    FROM shifts s LEFT JOIN locations l ON s.location_id = l.id
    WHERE s.user_id=? AND s.date>=? AND s.date<=?
    ORDER BY s.date ASC, s.start_time ASC
  `).all(user.id, from, to);
  icalHeaders(res, 'my-shifts.ics');
  res.send(buildIcal(`${appName} — ${user.name}`, buildEvents(shifts, false)));
});

// GET /api/ical/:token/team.ics  (admin only)
router.get('/:token/team.ics', (req, res) => {
  const user = resolveToken(req.params.token);
  if (!user || !user.active) return res.status(401).type('text/plain').send('Invalid iCal token.');
  if (user.role !== 'admin')  return res.status(403).type('text/plain').send('Admin token required.');
  const db = getDb();
  const appName = process.env.ICAL_CALENDAR_NAME || 'ForgeShift';
  const [from, to] = dateRange();
  const shifts = db.prepare(`
    SELECT s.*, l.name as location_name, l.color as location_color, u.name as user_name
    FROM shifts s LEFT JOIN locations l ON s.location_id=l.id LEFT JOIN users u ON s.user_id=u.id
    WHERE s.date>=? AND s.date<=? ORDER BY s.date ASC, u.name ASC, s.start_time ASC
  `).all(from, to);
  icalHeaders(res, 'team-shifts.ics');
  res.send(buildIcal(`${appName} — Full Team`, buildEvents(shifts, true)));
});

// GET /api/ical/:token/user/:userId.ics  (admin only)
router.get('/:token/user/:userId.ics', (req, res) => {
  const user = resolveToken(req.params.token);
  if (!user || !user.active) return res.status(401).type('text/plain').send('Invalid iCal token.');
  if (user.role !== 'admin')  return res.status(403).type('text/plain').send('Admin token required.');
  const db = getDb();
  const target = db.prepare('SELECT id, name FROM users WHERE id=?').get(req.params.userId);
  if (!target) return res.status(404).type('text/plain').send('User not found.');
  const appName = process.env.ICAL_CALENDAR_NAME || 'ForgeShift';
  const [from, to] = dateRange();
  const shifts = db.prepare(`
    SELECT s.*, l.name as location_name FROM shifts s
    LEFT JOIN locations l ON s.location_id=l.id
    WHERE s.user_id=? AND s.date>=? AND s.date<=? ORDER BY s.date ASC, s.start_time ASC
  `).all(target.id, from, to);
  icalHeaders(res, `${target.name.replace(/\s+/g,'-')}-shifts.ics`);
  res.send(buildIcal(`${appName} — ${target.name}`, buildEvents(shifts, false)));
});

// ── Token management (session auth) ─────────────────────────────────────────

// GET /api/ical/token
router.get('/token', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT created_at, last_used_at FROM ical_tokens WHERE user_id=?').get(req.session.userId);
  res.json({ hasToken: !!row, createdAt: row?.created_at, lastUsed: row?.last_used_at });
});

// POST /api/ical/token/generate
router.post('/token/generate', requireAuth, (req, res) => {
  const db     = getDb();
  const raw    = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  db.prepare(`
    INSERT INTO ical_tokens(user_id, token_hash, created_at) VALUES(?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at, last_used_at=NULL
  `).run(req.session.userId, hashed);
  res.json({ token: raw });
});

// DELETE /api/ical/token
router.delete('/token', requireAuth, (req, res) => {
  getDb().prepare('DELETE FROM ical_tokens WHERE user_id=?').run(req.session.userId);
  res.json({ success: true });
});

module.exports = router;
