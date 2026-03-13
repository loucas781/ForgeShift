'use strict';
/**
 * auth-utils.js — Centralised password hashing with pepper.
 *
 * WHY A PEPPER?
 * bcrypt hashes are stored in the database. If an attacker steals the DB
 * file, they can run an offline dictionary attack against every hash.
 * A pepper is a secret stored ONLY in the environment (never in the DB).
 * The password is HMAC-SHA256'd with the pepper before bcrypt, so the
 * hashes are useless without the server secret — even if the DB is leaked.
 *
 * SETUP:
 *   Add PASSWORD_PEPPER to your .env file:
 *     PASSWORD_PEPPER=<64 hex chars>  (generate: openssl rand -hex 32)
 *   The setup scripts generate this automatically for new installs.
 *
 * ROTATION:
 *   Set PASSWORD_PEPPER_OLD=<old value>, PASSWORD_PEPPER=<new value>.
 *   hashPassword() uses the new pepper. comparePassword() tries the new
 *   pepper first, then falls back to the old one and transparently re-hashes
 *   on success so the database migrates forward automatically.
 */

const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');

const BCRYPT_ROUNDS = 12;

function getPepper()    { return process.env.PASSWORD_PEPPER     || ''; }
function getOldPepper() { return process.env.PASSWORD_PEPPER_OLD || null; }

function applyPepper(password, pepper) {
  if (!pepper) return password;
  return crypto.createHmac('sha256', pepper).update(password).digest('hex');
}

/**
 * Hash a password with pepper + bcrypt.
 * @param {string} password
 * @returns {string} bcrypt hash
 */
function hashPassword(password) {
  const peppered = applyPepper(password, getPepper());
  return bcrypt.hashSync(peppered, BCRYPT_ROUNDS);
}

/**
 * Compare a plain-text password against a stored bcrypt hash.
 * Tries current pepper first, then old pepper for transparent rotation.
 *
 * @param {string} password
 * @param {string} storedHash
 * @returns {{ ok: boolean, needsRehash: boolean }}
 */
function comparePassword(password, storedHash) {
  const peppered = applyPepper(password, getPepper());
  if (bcrypt.compareSync(peppered, storedHash)) {
    return { ok: true, needsRehash: false };
  }
  const oldPepper = getOldPepper();
  if (oldPepper) {
    const oldPeppered = applyPepper(password, oldPepper);
    if (bcrypt.compareSync(oldPeppered, storedHash)) {
      return { ok: true, needsRehash: true };
    }
  }
  return { ok: false, needsRehash: false };
}

// ── Password policy ───────────────────────────────────────────────────────────

const DEFAULT_POLICY = {
  minLength:      8,
  requireUpper:   true,
  requireLower:   true,
  requireNumber:  true,
  requireSpecial: false,
  noSequential:   false,
};

/**
 * Validate a password against a policy.
 * @param {string} password
 * @param {object} [policy]
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validatePassword(password, policy = DEFAULT_POLICY) {
  const errors = [];
  if (!password) return { ok: false, errors: ['Password is required.'] };

  if (policy.minLength && password.length < policy.minLength)
    errors.push(`At least ${policy.minLength} characters.`);
  if (policy.requireUpper && !/[A-Z]/.test(password))
    errors.push('At least one uppercase letter (A–Z).');
  if (policy.requireLower && !/[a-z]/.test(password))
    errors.push('At least one lowercase letter (a–z).');
  if (policy.requireNumber && !/[0-9]/.test(password))
    errors.push('At least one number (0–9).');
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password))
    errors.push('At least one special character (e.g. !@#$%^&*).');

  return { ok: errors.length === 0, errors };
}

module.exports = { hashPassword, comparePassword, validatePassword, DEFAULT_POLICY };
