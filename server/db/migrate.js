'use strict'
/**
 * migrate.js — Creates the SQLite schema for ForgeShift.
 * Run with: node server/db/migrate.js
 * Safe to re-run — uses IF NOT EXISTS throughout.
 */

const path = require('path')
const fs   = require('fs')

// Load env file
const root = path.join(__dirname, '../../')

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false
  fs.readFileSync(filePath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=')
    if (k && !k.startsWith('#') && v.length) {
      const key = k.trim()
      if (!process.env[key]) process.env[key] = v.join('=').trim()
    }
  })
  return true
}

const explicitEnv = process.env.NODE_ENV
if (explicitEnv) loadEnvFile(path.join(root, `.env.${explicitEnv}`))
if (!process.env.SESSION_SECRET) {
  for (const e of ['production', 'staging', 'development']) {
    if (loadEnvFile(path.join(root, `.env.${e}`)) && process.env.SESSION_SECRET) break
  }
}

const db = require('./connection')

function migrate() {
  db.exec(`
    -- ── Users ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      password    TEXT NOT NULL,
      initials    TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#0052cc',
      avatar      TEXT,
      role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      is_active   INTEGER NOT NULL DEFAULT 1,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Locations ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS locations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      address     TEXT,
      color       TEXT NOT NULL DEFAULT '#0052cc',
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Shift Templates ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shift_templates (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Template Days ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS template_days (
      id           TEXT PRIMARY KEY,
      template_id  TEXT NOT NULL REFERENCES shift_templates(id) ON DELETE CASCADE,
      day_of_week  INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      location_id  TEXT REFERENCES locations(id) ON DELETE SET NULL,
      start_time   TEXT,
      end_time     TEXT,
      notes        TEXT,
      note_color   TEXT NOT NULL DEFAULT '#0052cc',
      is_off       INTEGER NOT NULL DEFAULT 0,
      UNIQUE (template_id, day_of_week)
    );

    -- ── Shifts ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shifts (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date         TEXT NOT NULL,
      location_id  TEXT REFERENCES locations(id) ON DELETE SET NULL,
      start_time   TEXT,
      end_time     TEXT,
      notes        TEXT,
      note_color   TEXT NOT NULL DEFAULT '#0052cc',
      is_off       INTEGER NOT NULL DEFAULT 0,
      template_id  TEXT REFERENCES shift_templates(id) ON DELETE SET NULL,
      created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, date)
    );

    -- ── iCal Feed Tokens ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ical_tokens (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      token       TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Password Reset Tokens ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       TEXT NOT NULL UNIQUE,
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Password Reset Sessions ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS password_reset_sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── App Preferences ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS app_preferences (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Audit Log ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   TEXT,
      entity_name TEXT,
      meta        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Indexes ──────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_shifts_user     ON shifts(user_id);
    CREATE INDEX IF NOT EXISTS idx_shifts_date     ON shifts(date);
    CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_tmpl_days_tmpl  ON template_days(template_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_reset_token     ON password_reset_tokens(token);
  `)

  console.log('✓ SQLite schema ready')
}

function migrateAdditive() {
  // Additive migrations — safe to run on existing databases
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name)
  if (!cols.includes('totp_secret')) {
    db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT")
    console.log('✓ Added totp_secret column')
  }
  if (!cols.includes('totp_enabled')) {
    db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0")
    console.log('✓ Added totp_enabled column')
  }
}

try {
  migrate()
  migrateAdditive()
} catch (err) {
  console.error('Migration failed:', err.message)
  process.exit(1)
}
