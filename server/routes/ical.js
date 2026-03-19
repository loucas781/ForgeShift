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
  // Derive base URL from the incoming request when behind a trusted reverse proxy,
  // so the feed URL reflects the public HTTPS domain rather than the internal LAN address.
  let base = process.env.APP_URL || 'http://localhost:3000'
  if (process.env.TRUST_PROXY === 'true') {
    const proto = req.headers['x-forwarded-proto'] || req.protocol
    const host  = req.headers['x-forwarded-host']  || req.headers['host']
    if (host) base = `${proto}://${host}`
  }
  res.json({ token: row.token, feedUrl: `${base}/api/ical/feed/${row.token}.ics` })
})

// ── DELETE /api/ical/token — regenerate token ─────────────────────────────────
router.delete('/token', requireAuth, (req, res) => {
  db.prepare('DELETE FROM ical_tokens WHERE user_id = ?').run(req.user.id)
  res.json({ ok: true })
})

function lastSundayOf(year, month) {
  // month is 1-based; find last day of that month then step back to Sunday
  const lastDay = new Date(year, month, 0) // 0th of next month = last day of this month
  const dayOfWeek = lastDay.getDay() // 0=Sun
  lastDay.setDate(lastDay.getDate() - dayOfWeek)
  return lastDay
}

// Format a local time string (HH:MM) on a date string to an iCal datetime
// with the correct UTC offset for Europe/London, using TZID form.
// Returns e.g. "20250406T090000" for DTSTART;TZID=Europe/London
function fmtLocalDT(dateStr, timeStr) {
  const datePart = dateStr.replace(/-/g, '')
  const timePart = timeStr.replace(':', '') + '00'
  return `${datePart}T${timePart}`
}

// Build a correct VTIMEZONE block for Europe/London.
// A single DAYLIGHT + STANDARD pair with RRULE covers all years.
// Clients that understand VTIMEZONE will show the correct local time.
function buildVTimezone() {
  return [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/London',
    'X-LIC-LOCATION:Europe/London',
    // BST (summer): last Sunday in March at 01:00 UTC (UTC+0 → UTC+1)
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0000',
    'TZOFFSETTO:+0100',
    'TZNAME:BST',
    'DTSTART:19700329T010000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    // GMT (winter): last Sunday in October at 02:00 BST (UTC+1 → UTC+0)
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    'TZNAME:GMT',
    'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'END:VTIMEZONE',
  ]
}

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
      'X-WR-TIMEZONE:Europe/London',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      ...buildVTimezone(),
    ]

    for (const shift of shifts) {
      const isAllDay = !shift.start_time

      // Annual leave / day-off: emit as a full-day VEVENT so it shows as an
      // all-day block in external calendars, matching the in-app display.
      // Regular shifts with times: use TZID=Europe/London local time so DST is
      // handled correctly — no more hour-ahead events in summer.
      let dtStart, dtEnd, startProp, endProp

      if (isAllDay) {
        const datePart = shift.date.replace(/-/g, '')
        dtStart = datePart
        dtEnd   = datePart
        startProp = `DTSTART;VALUE=DATE:${dtStart}`
        endProp   = `DTEND;VALUE=DATE:${dtEnd}`
      } else {
        dtStart   = fmtLocalDT(shift.date, shift.start_time)
        dtEnd     = fmtLocalDT(shift.date, shift.end_time || shift.start_time)
        startProp = `DTSTART;TZID=Europe/London:${dtStart}`
        endProp   = `DTEND;TZID=Europe/London:${dtEnd}`
      }

      let summary = shift.is_off ? '🏖️ Annual Leave' : `Shift - ${shift.location_name || 'No location'}`
      let desc = []
      if (shift.location_name)  desc.push(`Location: ${shift.location_name}`)
      if (shift.location_address) desc.push(`Address: ${shift.location_address}`)
      if (shift.start_time && shift.end_time) desc.push(`Time: ${shift.start_time} - ${shift.end_time}`)
      if (shift.notes) desc.push(`Notes: ${shift.notes}`)

      cal.push('BEGIN:VEVENT')
      cal.push(`UID:forgeshift-shift-${shift.id}@forgeshift`)
      cal.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}Z`)
      cal.push(startProp)
      cal.push(endProp)
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
