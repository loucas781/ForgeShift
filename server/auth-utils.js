'use strict'
/**
 * auth-utils.js — Centralised password hashing with HMAC-SHA256 pepper.
 *
 * WHY A PEPPER?
 * A pepper is a secret stored ONLY on the server (never in the DB).
 * Passwords are HMAC-SHA256'd with the pepper before bcrypt, so a stolen
 * database dump is useless without the server secret.
 *
 * ROTATION:
 * Set PASSWORD_PEPPER_OLD=<old value> to enable transparent re-hash on login.
 */

const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const db     = require('./db/connection')

const BCRYPT_ROUNDS = 12

let cachedPepper = null
let cachedOldPeppers = null

function readStoredPepper() {
  try {
    const row = db.prepare("SELECT value FROM app_preferences WHERE key = 'security_password_pepper'").get()
    return row?.value ? String(row.value) : null
  } catch {
    return null
  }
}

function writeStoredPepper(pepper) {
  try {
    db.prepare(`
      INSERT INTO app_preferences (key, value, updated_at)
      VALUES ('security_password_pepper', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(pepper)
  } catch {
    // Ignore write failures and continue using in-memory/env fallback.
  }
}

function parseOldPeppers(raw) {
  return String(raw || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
}

function getPepper() {
  if (cachedPepper !== null) return cachedPepper

  const stored = readStoredPepper()
  if (stored) {
    cachedPepper = stored
    return cachedPepper
  }

  const envPepper = String(process.env.PASSWORD_PEPPER || '').trim()
  if (envPepper) {
    writeStoredPepper(envPepper)
    cachedPepper = envPepper
    return cachedPepper
  }

  // Last-resort bootstrap for misconfigured instances.
  const generated = crypto.randomBytes(32).toString('hex')
  writeStoredPepper(generated)
  cachedPepper = generated
  return cachedPepper
}

function getOldPeppers() {
  if (cachedOldPeppers !== null) return cachedOldPeppers

  const active = getPepper()
  const envCurrent = String(process.env.PASSWORD_PEPPER || '').trim()
  const envOld = parseOldPeppers(process.env.PASSWORD_PEPPER_OLD)

  cachedOldPeppers = [envCurrent, ...envOld]
    .filter(Boolean)
    .filter((pepper, idx, arr) => arr.indexOf(pepper) === idx)
    .filter(pepper => pepper !== active)

  return cachedOldPeppers
}

function applyPepper(password, pepper) {
  if (!pepper) return password
  return crypto.createHmac('sha256', pepper).update(password).digest('hex')
}

async function hashPassword(password) {
  const peppered = applyPepper(password, getPepper())
  return bcrypt.hash(peppered, BCRYPT_ROUNDS)
}

async function comparePassword(password, storedHash) {
  const peppered = applyPepper(password, getPepper())
  if (await bcrypt.compare(peppered, storedHash)) return { ok: true, needsRehash: false }

  const oldPeppers = getOldPeppers()
  for (const oldPepper of oldPeppers) {
    const oldPeppered = applyPepper(password, oldPepper)
    if (await bcrypt.compare(oldPeppered, storedHash)) {
      return { ok: true, needsRehash: true }
    }
  }

  return { ok: false, needsRehash: false }
}

const DEFAULT_POLICY = {
  minLength:      12,
  requireUpper:   true,
  requireLower:   true,
  requireNumber:  true,
  requireSpecial: false,
  noSequential:   false,
}

function getPasswordPolicy(overrides = {}) {
  const stored = overrides.PASSWORD_POLICY || {}
  return { ...DEFAULT_POLICY, ...stored }
}

function validatePassword(password, policy) {
  const errors = []
  if (!password) return { ok: false, errors: ['Password is required.'] }
  if (policy.minLength && password.length < policy.minLength)
    errors.push(`At least ${policy.minLength} characters.`)
  if (policy.requireUpper && !/[A-Z]/.test(password))
    errors.push('At least one uppercase letter (A–Z).')
  if (policy.requireLower && !/[a-z]/.test(password))
    errors.push('At least one lowercase letter (a–z).')
  if (policy.requireNumber && !/[0-9]/.test(password))
    errors.push('At least one number (0–9).')
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password))
    errors.push('At least one special character.')
  return { ok: errors.length === 0, errors }
}

module.exports = { hashPassword, comparePassword, getPasswordPolicy, validatePassword, DEFAULT_POLICY }
