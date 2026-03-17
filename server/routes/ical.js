'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const db     = require('../db/connection')
const { requireAuth } = require('../middleware/auth')

// ── GET /api/ical/token — get or create feed token for current user ───────────
router.get('/token', requireAuth, (req, res) => {
  let row = db.prepare('SELECT * FROM ical_tokens WHERE user_id = ?').get(req.user.id)
  if (!row) {
    const token = crypto.randomBytes(32).toString('hex')
    db.prepare('INSERT INTO ical_tokens (id, user_id, token) VALUES (?,?,?)').run(uuidv4(), req.user.id, token)
    row = db.prepare('SELECT * FROM ical_tokens WHERE user_id = ?').get(req.user.id)
  }
  const base = process.env.APP_URL || 'http://localhost:3000'
  res.json({ token: row.token, feedUrl: `${base}/api/ical/feed/${row.token}.ics` })
})

// ── DELETE /api/ical/token — regenerate token ─────────────────────────────────
router.delete('/token', requireAuth, (req, res) => {
  db.prepare('DELETE FROM ical_tokens WHERE user_id = ?').run(req.user.id)
  res.json({ ok: true })
})

// ── GET /api/ical/feed/:token.ics — public feed ───────────────────────────────
router.get('/feed/:token', (req, res) => {
  try {
    const tokenParam = req.params.token.replace(/\.ics$/, '')
    const row = db.prepare('SELECT * FROM ical_tokens WHERE token = ?').get(tokenParam)
    if (!row) return res.status(404).end()

    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(row.user_id)
    if (!user) return res.status(404).end()

    const now  = new Date()
    const past = new Date(now); past.setFullYear(past.getFullYear() - 1)
    const fut  = new Date(now); fut.setFullYear(fut.getFullYear() + 2)

    const shifts = db.prepare(`
      SELECT s.*, l.name as location_name, l.address as location_address
      FROM shifts s
      LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.user_id = ? AND s.date >= ? AND s.date <= ?
      ORDER BY s.date
    `).all(user.id, past.toISOString().slice(0,10), fut.toISOString().slice(0,10))

    const appName = process.env.APP_NAME || 'ForgeShift'
    let cal = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//ForgeShift//NONSGML ${appName}//EN`,
      `X-WR-CALNAME:${appName} - ${user.name}`,
      'X-WR-TIMEZONE:UTC',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ]

    for (const shift of shifts) {
      const dtStart = shift.start_time
        ? shift.date.replace(/-/g,'') + 'T' + shift.start_time.replace(':','') + '00Z'
        : shift.date.replace(/-/g,'')
      const dtEnd = shift.end_time
        ? shift.date.replace(/-/g,'') + 'T' + shift.end_time.replace(':','') + '00Z'
        : shift.date.replace(/-/g,'')
      const isAllDay = !shift.start_time

      let summary = shift.is_off ? '🏖️ Day Off' : `Shift - ${shift.location_name || 'No location'}`
      let desc = []
      if (shift.location_name) desc.push(`Location: ${shift.location_name}`)
      if (shift.location_address) desc.push(`Address: ${shift.location_address}`)
      if (shift.start_time && shift.end_time) desc.push(`Time: ${shift.start_time} - ${shift.end_time}`)
      if (shift.notes) desc.push(`Notes: ${shift.notes}`)

      cal.push('BEGIN:VEVENT')
      cal.push(`UID:forgeshift-shift-${shift.id}@forgeshift`)
      cal.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}Z`)
      if (isAllDay) {
        cal.push(`DTSTART;VALUE=DATE:${dtStart}`)
        cal.push(`DTEND;VALUE=DATE:${dtEnd}`)
      } else {
        cal.push(`DTSTART:${dtStart}`)
        cal.push(`DTEND:${dtEnd}`)
      }
      cal.push(`SUMMARY:${summary}`)
      if (desc.length) cal.push(`DESCRIPTION:${desc.join('\\n')}`)
      if (shift.location_name) cal.push(`LOCATION:${shift.location_address || shift.location_name}`)
      cal.push('END:VEVENT')
    }

    cal.push('END:VCALENDAR')

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="forgeshift-${user.name.replace(/\s+/g,'-').toLowerCase()}.ics"`)
    res.setHeader('Cache-Control', 'no-cache, no-store')
    res.send(cal.join('\r\n'))
  } catch (err) {
    console.error('ical feed:', err.message)
    res.status(500).end()
  }
})

module.exports = router
