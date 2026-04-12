'use strict'

/**
 * apns.js — Apple Push Notification service client.
 *
 * Uses Node's built-in `http2` module and `jsonwebtoken` (already a dependency)
 * with ES256 JWT authentication — no extra npm packages required.
 *
 * Required environment variables (all optional — server works without push):
 *   APNS_KEY_ID      10-char key ID from Apple Developer portal
 *   APNS_TEAM_ID     10-char team ID from Apple Developer portal
 *   APNS_KEY_PATH    Path to the .p8 file (e.g. ./config/AuthKey_XXXXXXXXXX.p8)
 *   APNS_BUNDLE_ID   iOS bundle ID (default: com.forgeshift.app)
 *   APNS_PRODUCTION  "true" for production APNs, anything else = sandbox
 */

const http2 = require('node:http2')
const fs = require('node:fs')
const path = require('node:path')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')

// ─── Configuration ──────────────────────────────────────────────────────────

const KEY_ID      = process.env.APNS_KEY_ID
const TEAM_ID     = process.env.APNS_TEAM_ID
const KEY_PATH    = process.env.APNS_KEY_PATH
const BUNDLE_ID   = process.env.APNS_BUNDLE_ID || 'com.forgeshift.app'
const PRODUCTION  = process.env.APNS_PRODUCTION === 'true'

const APNS_HOST = PRODUCTION
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com'

const isConfigured = !!(KEY_ID && TEAM_ID && KEY_PATH)

if (!isConfigured) {
  logger.warn('APNs not configured — push notifications disabled. Set APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH to enable.')
}

// ─── JWT caching ─────────────────────────────────────────────────────────────

let _cachedJwt = null
let _jwtIssuedAt = 0
const JWT_TTL_MS = 45 * 60 * 1000 // 45 minutes (APNs requires < 1 hour)

function getApnsJwt() {
  const now = Date.now()
  if (_cachedJwt && (now - _jwtIssuedAt) < JWT_TTL_MS) {
    return _cachedJwt
  }
  const keyContent = fs.readFileSync(path.resolve(KEY_PATH), 'utf8')
  const iat = Math.floor(now / 1000)
  _cachedJwt = jwt.sign({ iss: TEAM_ID, iat }, keyContent, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: KEY_ID },
  })
  _jwtIssuedAt = now
  return _cachedJwt
}

// ─── HTTP/2 session pool (one persistent connection per host) ─────────────────

let _session = null

function getSession() {
  if (_session && !_session.destroyed) return _session
  _session = http2.connect(`https://${APNS_HOST}`)
  _session.on('error', () => { _session = null })
  _session.on('close', () => { _session = null })
  return _session
}

// ─── Core send ───────────────────────────────────────────────────────────────

/**
 * Send a push notification to a single device token.
 * Silently cleans up stale tokens (HTTP 410 = device unregistered).
 *
 * @param {string} token   APNs device token hex string
 * @param {string} title   Notification title
 * @param {string} body    Notification body
 * @param {object} [data]  Optional extra payload fields merged into the root
 * @returns {Promise<boolean>} true on success
 */
async function sendPush(token, title, body, data = {}) {
  if (!isConfigured) return false

  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: 'default',
      badge: 1,
    },
    ...data,
  })

  return new Promise((resolve) => {
    let session
    try {
      session = getSession()
    } catch {
      resolve(false)
      return
    }

    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${getApnsJwt()}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-expiration': '0',
      'apns-priority': '10',
      'apns-collapse-id': data.collapseId || undefined,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })

    req.write(payload)
    req.end()

    let status = 0
    let responseBody = ''

    req.on(':response', (headers) => { status = headers[':status'] })
    req.on('data', (chunk) => { responseBody += chunk })
    req.on('end', () => {
      if (status === 200) {
        resolve(true)
        return
      }
      // 410 = device token is no longer active — remove it
      if (status === 410) {
        removeStaleToken(token).catch(() => {})
      }
      try {
        const err = JSON.parse(responseBody)
        logger.warn(`APNs error ${status} for token ${token.slice(0, 8)}…: ${err.reason}`)
        if (err.reason === 'BadDeviceToken' || err.reason === 'Unregistered') {
          removeStaleToken(token).catch(() => {})
        }
      } catch { /* ignore parse errors */ }
      resolve(false)
    })
    req.on('error', (e) => {
      logger.warn(`APNs request error: ${e.message}`)
      resolve(false)
    })
  })
}

// ─── Higher-level helpers ─────────────────────────────────────────────────────

/**
 * Send a push to all registered devices for a given user.
 */
async function sendPushToUser(userId, title, body, data = {}) {
  if (!isConfigured) return
  const db = require('../db/connection')
  const rows = db.prepare('SELECT token FROM device_tokens WHERE user_id = ?').all(userId)
  await Promise.allSettled(rows.map(r => sendPush(r.token, title, body, data)))
}

/**
 * Send a push to all registered devices for an array of user IDs.
 */
async function sendPushToMany(userIds, title, body, data = {}) {
  if (!isConfigured || !userIds.length) return
  await Promise.allSettled(userIds.map(id => sendPushToUser(id, title, body, data)))
}

/**
 * Send a push to every user that has a registered device token.
 */
async function sendPushToAll(title, body, data = {}) {
  if (!isConfigured) return
  const db = require('../db/connection')
  const rows = db.prepare('SELECT DISTINCT user_id FROM device_tokens').all()
  await sendPushToMany(rows.map(r => r.user_id), title, body, data)
}

// ─── Token cleanup ────────────────────────────────────────────────────────────

async function removeStaleToken(token) {
  const db = require('../db/connection')
  db.prepare('DELETE FROM device_tokens WHERE token = ?').run(token)
}

module.exports = { sendPush, sendPushToUser, sendPushToMany, sendPushToAll, isConfigured }
