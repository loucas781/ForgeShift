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

const BCRYPT_ROUNDS = 12

function getPepper()    { return process.env.PASSWORD_PEPPER     || '' }
function getOldPepper() { return process.env.PASSWORD_PEPPER_OLD || null }

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

  const oldPepper = getOldPepper()
  if (oldPepper) {
    const oldPeppered = applyPepper(password, oldPepper)
    if (await bcrypt.compare(oldPeppered, storedHash)) return { ok: true, needsRehash: true }
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
