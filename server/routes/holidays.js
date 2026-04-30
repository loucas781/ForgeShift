'use strict'
const router = require('express').Router()
const db     = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit  = require('../audit')
const logger = require('../utils/logger')

// ── Supported live data sources ───────────────────────────────────────────────
// Each source defines how to fetch and map to { 'YYYY-MM-DD': [{name, setId, emoji}] }
const SOURCES = [
  {
    id:    'uk-bank',
    label: 'UK Bank Holidays',
    emoji: '🇬🇧',
    fetch: async () => {
      const res = await fetch('https://www.gov.uk/bank-holidays.json', {
        headers: { 'User-Agent': 'ForgeShift/1.0' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`UK gov API returned ${res.status}`)
      const data = await res.json()
      const map = {}
      // Merge all UK regions — england-and-wales, scotland, northern-ireland
      for (const region of Object.values(data)) {
        for (const event of (region.events || [])) {
          // event.date is already 'YYYY-MM-DD'
          if (!map[event.date]) map[event.date] = []
          // Deduplicate within the same source
          if (!map[event.date].find(e => e.name === event.title)) {
            map[event.date].push({ name: event.title, setId: 'uk-bank', emoji: '🇬🇧' })
          }
        }
      }
      return map
    },
  },

  // Ireland — data.gov.ie public holidays
  {
    id:    'ireland',
    label: 'Irish Public Holidays',
    emoji: '🇮🇪',
    fetch: async () => {
      // Ireland doesn't have a single canonical JSON API, so we derive from
      // the calculated data for now — this slot is reserved for a live source
      // when one becomes available. Return empty to fall through gracefully.
      return {}
    },
  },
]

// ── GET /api/holidays/status ──────────────────────────────────────────────────
// Returns last-fetched timestamp and count of stored override dates (admin only)
router.get('/status', requireAuth, requireAdmin, (req, res) => {
  try {
    const lastFetchedRow = db.prepare("SELECT value FROM app_preferences WHERE key = 'holiday_last_fetched'").get()
    const overridesRow   = db.prepare("SELECT value FROM app_preferences WHERE key = 'holiday_overrides'").get()
    const overrides      = overridesRow ? JSON.parse(overridesRow.value) : {}
    res.json({
      lastFetched: lastFetchedRow?.value || null,
      storedDates: Object.keys(overrides).length,
      sources: SOURCES.map(s => ({ id: s.id, label: s.label, emoji: s.emoji })),
    })
  } catch (err) {
    logger.error('holiday status:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/holidays/fetch ──────────────────────────────────────────────────
// Fetches live data from all supported sources and merges into stored overrides.
// Admin only. Uses Node 18+ native fetch.
router.post('/fetch', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Load existing overrides so we merge rather than overwrite
    const overridesRow = db.prepare("SELECT value FROM app_preferences WHERE key = 'holiday_overrides'").get()
    const existing     = overridesRow ? JSON.parse(overridesRow.value) : {}

    let newDates  = 0
    let newEvents = 0
    const errors  = []

    for (const source of SOURCES) {
      try {
        const fetched = await source.fetch()
        for (const [dateStr, entries] of Object.entries(fetched)) {
          if (!existing[dateStr]) {
            existing[dateStr] = []
            newDates++
          }
          for (const entry of entries) {
            if (!existing[dateStr].find(e => e.name === entry.name)) {
              existing[dateStr].push(entry)
              newEvents++
            }
          }
        }
      } catch (err) {
        logger.error(`holiday fetch [${source.id}]:`, err.message)
        errors.push({ source: source.id, error: err.message })
      }
    }

    const now = new Date().toISOString()

    // Persist merged overrides
    db.prepare(`
      INSERT INTO app_preferences (key, value, updated_at) VALUES ('holiday_overrides', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(existing), now)

    // Persist last-fetched timestamp
    db.prepare(`
      INSERT INTO app_preferences (key, value, updated_at) VALUES ('holiday_last_fetched', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now, now)

    audit(req.user.id, 'holidays.fetch', 'system', null, 'Holiday data fetch', {
      newDates, newEvents, errors: errors.length,
    })

    res.json({
      ok:          true,
      newDates,
      newEvents,
      storedDates: Object.keys(existing).length,
      lastFetched: now,
      errors:      errors.length ? errors : undefined,
    })
  } catch (err) {
    logger.error('holiday fetch:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/holidays/overrides ────────────────────────────────────────────
// Clears all fetched overrides, reverting to calculated-only data. Admin only.
router.delete('/overrides', requireAuth, requireAdmin, (req, res) => {
  try {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO app_preferences (key, value, updated_at) VALUES ('holiday_overrides', '{}', ?)
      ON CONFLICT(key) DO UPDATE SET value = '{}', updated_at = excluded.updated_at
    `).run(now)
    db.prepare(`
      INSERT INTO app_preferences (key, value, updated_at) VALUES ('holiday_last_fetched', '', ?)
      ON CONFLICT(key) DO UPDATE SET value = '', updated_at = excluded.updated_at
    `).run(now)
    audit(req.user.id, 'holidays.clear', 'system', null, 'Holiday overrides cleared')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
