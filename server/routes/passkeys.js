'use strict'
/**
 * passkeys.js — WebAuthn / Passkey routes
 *
 * Uses @simplewebauthn/server (ESM-only ≥ v9) via dynamic import().
 *
 * Endpoints:
 *   GET    /api/passkeys              — list registered passkeys for current user
 *   POST   /api/passkeys/register-options   — generate registration challenge
 *   POST   /api/passkeys/register-verify    — verify & save credential
 *   POST   /api/passkeys/auth-options       — generate authentication challenge (unauthenticated)
 *   POST   /api/passkeys/auth-verify        — verify credential, issue JWT cookie
 *   DELETE /api/passkeys/:id               — remove a passkey
 */

const express       = require('express')
const { v4: uuid }  = require('uuid')
const db            = require('../db/connection')
const { requireAuth } = require('../middleware/auth')
const jwt           = require('jsonwebtoken')
const logger        = require('../utils/logger')

const router = express.Router()

// ── Helpers ────────────────────────────────────────────────────────────────

/** Derive RP config from request — works for localhost dev and HTTPS prod */
function rpConfig(req) {
  const trustProxy = process.env.TRUST_PROXY === 'true'
  const proto = (trustProxy && req.headers['x-forwarded-proto']) || req.protocol || 'https'
  const hostHeader = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host || 'localhost'
  const rpID   = hostHeader.split(':')[0]   // strip port
  const origin = `${proto}://${hostHeader}`
  return { rpID, origin, rpName: process.env.APP_NAME || 'ForgeShift' }
}

/** In-memory challenge store with 5-minute TTL */
const _challenges = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _challenges) { if (v.exp < now) _challenges.delete(k) }
}, 60_000)

function storeChallenge(key, challenge) {
  _challenges.set(key, { challenge, exp: Date.now() + 300_000 })
}
function popChallenge(key) {
  const entry = _challenges.get(key)
  _challenges.delete(key)
  if (!entry || entry.exp < Date.now()) return null
  return entry.challenge
}

/** Issue a JWT cookie for a user (mirrors auth.js makeToken) */
function issueSession(res, user) {
  const tv = user.token_version || 0
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role, tv },
    process.env.JWT_SECRET,
    { expiresIn: `${process.env.COOKIE_MAX_AGE_HOURS || 72}h` }
  )
  const maxAge = parseInt(process.env.COOKIE_MAX_AGE_HOURS || '72', 10) * 3600 * 1000
  const secure = process.env.COOKIE_SECURE === 'true'
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: secure ? 'strict' : 'lax',
    secure,
    maxAge
  })
}

// ── GET /api/passkeys — list passkeys ──────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, device_name, created_at FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id)
  res.json(rows)
})

// ── POST /api/passkeys/register-options ───────────────────────────────────
router.post('/register-options', requireAuth, async (req, res) => {
  try {
    const { generateRegistrationOptions } = await import('@simplewebauthn/server')
    const { rpID, rpName } = rpConfig(req)

    // Existing credentials so the browser doesn't re-register the same device
    const existing = db.prepare('SELECT id FROM passkey_credentials WHERE user_id = ?').all(req.user.id)
    const excludeCredentials = existing.map(c => ({ id: c.id, type: 'public-key' }))

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID:          Buffer.from(req.user.id),
      userName:        req.user.email,
      userDisplayName: req.user.name,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey:      'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials,
    })

    storeChallenge(`reg:${req.user.id}`, options.challenge)
    res.json(options)
  } catch (err) {
    logger.error('passkey register-options error:', err.message)
    res.status(500).json({ error: 'Failed to generate registration options' })
  }
})

// ── POST /api/passkeys/register-verify ────────────────────────────────────
router.post('/register-verify', requireAuth, async (req, res) => {
  try {
    const { verifyRegistrationResponse } = await import('@simplewebauthn/server')
    const { rpID, origin } = rpConfig(req)

    const expectedChallenge = popChallenge(`reg:${req.user.id}`)
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired or not found' })

    const { credential, deviceName } = req.body
    if (!credential) return res.status(400).json({ error: 'Missing credential' })

    const verification = await verifyRegistrationResponse({
      response:          credential,
      expectedChallenge,
      expectedOrigin:    origin,
      expectedRPID:      rpID,
      requireUserVerification: false,
    })

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' })
    }

    // Support both v9 (top-level credentialID/credentialPublicKey/counter) and
    // v10+ (nested under registrationInfo.credential)
    const regInfo = verification.registrationInfo
    const credId  = regInfo.credential?.id  ?? regInfo.credentialID
    const credPK  = regInfo.credential?.publicKey ?? regInfo.credentialPublicKey
    const counter = regInfo.credential?.counter ?? regInfo.counter
    const pubKey  = Buffer.from(credPK).toString('base64')

    db.prepare(`
      INSERT INTO passkey_credentials (id, user_id, public_key, counter, device_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(credId, req.user.id, pubKey, counter || 0, deviceName || null)

    res.json({ ok: true })
  } catch (err) {
    logger.error('passkey register-verify error:', err.message)
    res.status(500).json({ error: 'Verification failed' })
  }
})

// ── POST /api/passkeys/auth-options ───────────────────────────────────────
// Public (no auth required) — user may not be logged in yet
router.post('/auth-options', async (req, res) => {
  try {
    const { generateAuthenticationOptions } = await import('@simplewebauthn/server')
    const { rpID } = rpConfig(req)

    // If email provided, scope to that user's credentials (faster + UX)
    let allowCredentials = []
    if (req.body && req.body.email) {
      const user = db.prepare('SELECT id FROM users WHERE email = ? AND is_active = 1').get(req.body.email)
      if (user) {
        const creds = db.prepare('SELECT id FROM passkey_credentials WHERE user_id = ?').all(user.id)
        allowCredentials = creds.map(c => ({ id: c.id, type: 'public-key' }))
      }
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      allowCredentials: allowCredentials.length ? allowCredentials : undefined,
    })

    // Use a nonce so we can look up the challenge even without a session
    const nonce = uuid()
    storeChallenge(`auth:${nonce}`, options.challenge)
    // Keep both keys temporarily for compatibility with older/newer clients.
    res.json({ ...options, nonce, _nonce: nonce })
  } catch (err) {
    logger.error('passkey auth-options error:', err.message)
    res.status(500).json({ error: 'Failed to generate authentication options' })
  }
})

// ── POST /api/passkeys/auth-verify ────────────────────────────────────────
// Public (no auth required)
router.post('/auth-verify', async (req, res) => {
  try {
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server')
    const { rpID, origin } = rpConfig(req)

    const { credential, nonce, _nonce } = req.body
    const challengeNonce = nonce || _nonce
    if (!credential || !challengeNonce) return res.status(400).json({ error: 'Missing credential or nonce' })

    const expectedChallenge = popChallenge(`auth:${challengeNonce}`)
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired or not found' })

    // Look up the stored credential
    const credId = credential.id
    const stored = db.prepare('SELECT * FROM passkey_credentials WHERE id = ?').get(credId)
    if (!stored) return res.status(400).json({ error: 'Passkey not recognised' })

    const publicKey = Buffer.from(stored.public_key, 'base64')

    // Pass both v9 (authenticator) and v10 (credential) forms — the library
    // uses whichever it recognises and ignores the other.
    const verification = await verifyAuthenticationResponse({
      response:          credential,
      expectedChallenge,
      expectedOrigin:    origin,
      expectedRPID:      rpID,
      // v10+ API
      credential: {
        id:         stored.id,
        publicKey,
        counter:    stored.counter,
        transports: credential.response?.transports,
      },
      // v9 API (authenticator renamed to credential in v10)
      authenticator: {
        credentialID:        stored.id,
        credentialPublicKey: publicKey,
        counter:             stored.counter,
        transports:          credential.response?.transports,
      },
      requireUserVerification: false,
    })

    if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed' })

    // Update counter
    db.prepare('UPDATE passkey_credentials SET counter = ? WHERE id = ?')
      .run(verification.authenticationInfo.newCounter, stored.id)

    // Load user & issue session
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(stored.user_id)
    if (!user) return res.status(401).json({ error: 'Account not found or inactive' })

    issueSession(res, user)
    res.json({ ok: true, redirectTo: '/' })
  } catch (err) {
    logger.error('passkey auth-verify error:', err.message)
    res.status(500).json({ error: 'Authentication failed' })
  }
})

// ── DELETE /api/passkeys/:id ───────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, user_id FROM passkey_credentials WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Passkey not found' })
  if (row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }
  db.prepare('DELETE FROM passkey_credentials WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

module.exports = router
