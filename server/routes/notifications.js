'use strict'
const router  = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db      = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const { sendPushToUser, sendPushToMany, sendPushToAll, isConfigured } = require('../push/apns')
const audit   = require('../audit')

// ── POST /api/notifications/register ─────────────────────────────────────────
// Save (or refresh) a device token for the authenticated user.
router.post('/register', requireAuth, (req, res) => {
  try {
    const { token, device_name: deviceName } = req.body
    if (!token || typeof token !== 'string' || token.length < 32) {
      return res.status(400).json({ error: 'Invalid device token.' })
    }

    const id = uuidv4()
    db.prepare(`
      INSERT INTO device_tokens (id, user_id, token, device_name, created_at, last_used_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(token) DO UPDATE SET
        user_id      = excluded.user_id,
        device_name  = excluded.device_name,
        last_used_at = datetime('now')
    `).run(id, req.user.id, token, deviceName || null)

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to register device token.' })
  }
})

// ── DELETE /api/notifications/register ───────────────────────────────────────
// Remove all device tokens for the authenticated user (called on logout).
router.delete('/register', requireAuth, (req, res) => {
  try {
    // If a specific token is provided, remove only that one; otherwise remove all.
    const { token } = req.body || {}
    if (token) {
      db.prepare('DELETE FROM device_tokens WHERE user_id = ? AND token = ?').run(req.user.id, token)
    } else {
      db.prepare('DELETE FROM device_tokens WHERE user_id = ?').run(req.user.id)
    }
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Failed to unregister device token.' })
  }
})

// ── GET /api/notifications/settings ──────────────────────────────────────────
// Return push notification configuration status and feature flags (admin only).
router.get('/settings', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT key, value FROM app_preferences
      WHERE key IN ('feature_push_notifications')
    `).all()
    const prefs = Object.fromEntries(rows.map(r => [r.key, r.value]))

    const deviceCount = db.prepare('SELECT COUNT(*) as n FROM device_tokens').get().n

    res.json({
      configured: isConfigured,
      apnsEnvironment: process.env.APNS_PRODUCTION === 'true' ? 'production' : 'sandbox',
      bundleId: process.env.APNS_BUNDLE_ID || 'com.forgeshift.app',
      pushEnabled: prefs.feature_push_notifications === 'true',
      registeredDevices: deviceCount,
    })
  } catch {
    res.status(500).json({ error: 'Failed to load notification settings.' })
  }
})

// ── PATCH /api/notifications/settings ────────────────────────────────────────
// Toggle auto-push on shift changes (admin only).
router.patch('/settings', requireAdmin, (req, res) => {
  try {
    const { push_enabled: pushEnabled } = req.body
    if (typeof pushEnabled !== 'boolean') {
      return res.status(400).json({ error: 'push_enabled must be a boolean.' })
    }

    db.prepare(`
      INSERT INTO app_preferences (key, value, updated_at) VALUES ('feature_push_notifications', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(pushEnabled ? 'true' : 'false')

    audit(req.user.id, 'notifications.settings', 'app_preferences', 'feature_push_notifications',
      `push_enabled=${pushEnabled}`)

    res.json({ ok: true, pushEnabled })
  } catch {
    res.status(500).json({ error: 'Failed to update notification settings.' })
  }
})

// ── POST /api/notifications/send ─────────────────────────────────────────────
// Send a manual broadcast notification (admin only).
router.post('/send', requireAdmin, async (req, res) => {
  try {
    const { title, body, recipient_type: recipientType = 'all', recipient_id: recipientId } = req.body

    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required.' })
    }
    if (title.length > 100 || body.length > 300) {
      return res.status(400).json({ error: 'title must be ≤100 chars, body ≤300 chars.' })
    }

    let userIds = []

    if (recipientType === 'all') {
      const rows = db.prepare('SELECT DISTINCT user_id FROM device_tokens').all()
      userIds = rows.map(r => r.user_id)
    } else if (recipientType === 'organisation' && recipientId) {
      const rows = db.prepare(`
        SELECT dt.user_id FROM device_tokens dt
        JOIN organisation_members om ON om.user_id = dt.user_id
        WHERE om.org_id = ?
      `).all(recipientId)
      userIds = [...new Set(rows.map(r => r.user_id))]
    } else if (recipientType === 'team' && recipientId) {
      const rows = db.prepare(`
        SELECT dt.user_id FROM device_tokens dt
        JOIN team_members tm ON tm.user_id = dt.user_id
        WHERE tm.team_id = ?
      `).all(recipientId)
      userIds = [...new Set(rows.map(r => r.user_id))]
    } else if (recipientType === 'user' && recipientId) {
      userIds = [recipientId]
    } else {
      return res.status(400).json({ error: 'Invalid recipient_type or missing recipient_id.' })
    }

    if (!userIds.length) {
      return res.json({ ok: true, sent: 0, message: 'No registered devices for the selected recipients.' })
    }

    // Fire-and-forget — respond immediately, send in background
    res.json({ ok: true, sent: userIds.length })

    audit(req.user.id, 'notifications.broadcast', 'notification', null,
      `to=${recipientType}:${recipientId || 'all'} title="${title}"`)

    sendPushToMany(userIds, title, body, { type: 'broadcast' }).catch(() => {})
  } catch {
    res.status(500).json({ error: 'Failed to send notification.' })
  }
})

module.exports = router
