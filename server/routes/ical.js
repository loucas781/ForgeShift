'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const db     = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const logger = require('../utils/logger')
const { loadOverrides } = require('../utils/overrides')
const { hasPermission } = require('../utils/roles')

function blockTokenDuringMaintenance(req, res, next) {
  const overrides = loadOverrides()
  if (String(overrides.MAINTENANCE_MODE || 'false') !== 'true') return next()
  if (req.user?.role === 'admin') return next()
  return res.status(503).json({
    error: 'Maintenance mode is enabled. Access is currently limited to administrators.',
    maintenanceMode: true,
  })
}

function escapeIcalText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

function foldIcalLine(line) {
  const max = 75
  let out = ''
  let current = ''
  for (const char of String(line)) {
    const next = current + char
    if (Buffer.byteLength(next, 'utf8') > max) {
      out += current + '\r\n '
      current = char
    } else {
      current = next
    }
  }
  return out + current
}

function sendIcal(res, lines, filename) {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.send(lines.map(foldIcalLine).join('\r\n') + '\r\n')
}

// ── GET /api/ical/token — get or create feed token for current user ───────────
router.get('/token', requireAuth, blockTokenDuringMaintenance, (req, res) => {
  if (!hasPermission(req, 'view_own_rota')) return res.status(403).json({ error: 'You do not have permission to view your rota.' })
  let row = db.prepare('SELECT * FROM ical_tokens WHERE user_id = ?').get(req.user.id)
  if (!row) {
    const token = crypto.randomBytes(32).toString('hex')
    db.prepare('INSERT INTO ical_tokens (id, user_id, token) VALUES (?,?,?)').run(uuidv4(), req.user.id, token)
    row = db.prepare('SELECT * FROM ical_tokens WHERE user_id = ?').get(req.user.id)
  }
  // Build a public origin that matches reset-link behavior:
  // 1) explicit APP_URL override (from Settings) wins
  // 2) then forwarded host/proto from reverse proxy
  // 3) then request host/protocol fallback
  // 4) then localhost fallback
  const overrides = loadOverrides()
  const configured = String(overrides.APP_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '')
  let base = configured
  if (!base) {
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim()
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    const host = forwardedHost || String(req.headers?.host || '').trim()
    const proto = forwardedProto || req.protocol || (req.secure ? 'https' : 'http')
    base = host ? `${proto}://${host}` : `http://localhost:${process.env.PORT || 3000}`
  }
  res.json({ token: row.token, feedUrl: `${base}/api/ical/feed/${row.token}.ics` })
})

// ── DELETE /api/ical/token — regenerate token ─────────────────────────────────
router.delete('/token', requireAuth, blockTokenDuringMaintenance, (req, res) => {
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
function timeToMins(timeStr) {
  if (!timeStr) return null
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + (m || 0)
}
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function fmtUtcDT(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
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
    // The URL contains a bearer token. Prevent intermediary/browser caching
    // and referrer propagation of the private feed.
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' })
    const tokenParam = req.params.token.replace(/\.ics$/, '')
    const row = db.prepare('SELECT * FROM ical_tokens WHERE token = ?').get(tokenParam)
    if (!row) return res.status(404).end()

    const user = db.prepare('SELECT id, name, email, is_active FROM users WHERE id = ?').get(row.user_id)
    if (!user?.is_active || !hasPermission(user, 'view_own_rota')) return res.status(404).end()

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
      `X-WR-CALNAME:${escapeIcalText(`${appName} - ${user.name}`)}`,
      'X-WR-TIMEZONE:Europe/London',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      ...buildVTimezone(),
    ]

    const generatedAt = fmtUtcDT()
    for (const shift of shifts) {
      const isAllDay = !shift.start_time

      // Annual leave / day-off: emit as a full-day VEVENT so it shows as an
      // all-day block in external calendars, matching the in-app display.
      // Regular shifts with times: use TZID=Europe/London local time so DST is
      // handled correctly — no more hour-ahead events in summer.
      let dtStart, dtEnd, startProp, endProp

      if (isAllDay) {
        const datePart = shift.date.replace(/-/g, '')
        const endDatePart = addDaysToDateStr(shift.date, 1).replace(/-/g, '')
        dtStart = datePart
        dtEnd   = endDatePart
        startProp = `DTSTART;VALUE=DATE:${dtStart}`
        endProp   = `DTEND;VALUE=DATE:${dtEnd}`
      } else {
        let endDate = shift.date
        const startMins = timeToMins(shift.start_time)
        const endMins = timeToMins(shift.end_time || shift.start_time)
        if (startMins !== null && endMins !== null && endMins < startMins) {
          endDate = addDaysToDateStr(shift.date, 1)
        }
        dtStart   = fmtLocalDT(shift.date, shift.start_time)
        dtEnd     = fmtLocalDT(endDate, shift.end_time || shift.start_time)
        startProp = `DTSTART;TZID=Europe/London:${dtStart}`
        endProp   = `DTEND;TZID=Europe/London:${dtEnd}`
      }

      const onCallOnly = !!shift.is_oncall && !shift.is_off && !shift.location_name
      let summary = shift.is_off
        ? (shift.absence_type === 'absent' ? 'Absent' : 'Annual Leave')
        : (onCallOnly ? 'ON CALL' : `Work - ${shift.location_name || 'Shift'}`)
      let desc = []
      if (shift.is_oncall) desc.push('On call')
      if (shift.location_name)  desc.push(`Location: ${shift.location_name}`)
      if (shift.location_address) desc.push(`Address: ${shift.location_address}`)
      if (shift.start_time && shift.end_time) desc.push(`Time: ${shift.start_time} - ${shift.end_time}`)
      if (shift.notes) desc.push(`Notes: ${shift.notes}`)

      cal.push('BEGIN:VEVENT')
      cal.push(`UID:forgeshift-shift-${escapeIcalText(shift.id)}@forgeshift`)
      cal.push(`DTSTAMP:${generatedAt}`)
      cal.push(startProp)
      if (dtEnd !== dtStart) cal.push(endProp)
      cal.push(`SUMMARY:${escapeIcalText(summary)}`)
      if (desc.length) cal.push(`DESCRIPTION:${escapeIcalText(desc.join('\n'))}`)
      if (shift.location_name) cal.push(`LOCATION:${escapeIcalText(shift.location_address || shift.location_name)}`)
      cal.push('END:VEVENT')
    }

    cal.push('END:VCALENDAR')

    const filenameName = user.name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'calendar'
    sendIcal(res, cal, `forgeshift-${filenameName}.ics`)
  } catch (err) {
    logger.error('ical feed:', err.message)
    res.status(500).end()
  }
})

module.exports = router
