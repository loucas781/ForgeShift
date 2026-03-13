#!/usr/bin/env node
/**
 * ForgeShift — Database Migration
 * Run with: npm run migrate
 * Safe to re-run — uses IF NOT EXISTS throughout.
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const dbPath = process.env.DB_PATH || './data/forgeshift.db';
const dir    = path.dirname(dbPath);
if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); console.log(`📁 Created: ${dir}`); }

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log('🔄 Running migrations...');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password     TEXT NOT NULL,
    name         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    active       INTEGER NOT NULL DEFAULT 1,
    totp_secret  TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS locations (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    address    TEXT,
    color      TEXT NOT NULL DEFAULT '#3b82f6',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    is_shared   INTEGER NOT NULL DEFAULT 0,
    created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS template_days (
    id          TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    day_index   INTEGER NOT NULL CHECK(day_index BETWEEN 0 AND 6),
    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
    start_time  TEXT NOT NULL DEFAULT '09:00',
    end_time    TEXT NOT NULL DEFAULT '17:00',
    notes       TEXT,
    note_color  TEXT,
    UNIQUE(template_id, day_index)
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
    date        TEXT NOT NULL,
    start_time  TEXT NOT NULL DEFAULT '09:00',
    end_time    TEXT NOT NULL DEFAULT '17:00',
    notes       TEXT,
    note_color  TEXT,
    template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shifts_user_id  ON shifts(user_id);
  CREATE INDEX IF NOT EXISTS idx_shifts_date      ON shifts(date);
  CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);

  CREATE TABLE IF NOT EXISTS ical_tokens (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ical_tokens_hash ON ical_tokens(token_hash);

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO settings(key,value) VALUES
    ('allow_signup','true'),
    ('app_name','ForgeShift'),
    ('ical_enabled','true'),
    ('ical_cal_name','ForgeShift');

  -- Password reset tokens: URL token is SHA-256 hashed before storage.
  -- Raw token only lives in the emailed/admin-generated link.
  -- Token is consumed immediately on /validate and exchanged for a
  -- short-lived session key — the URL can never be replayed.
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    request_ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON password_reset_tokens(token_hash);

  -- Post-token-exchange session (5 min, JS-memory only — never in URL/storage).
  CREATE TABLE IF NOT EXISTS password_reset_sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
  CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity_type, entity_id);
`);

// Additive column migrations — safe for existing installs
// SQLite has no ADD COLUMN IF NOT EXISTS, so we check manually.
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);

const uc = cols('users');
if (!uc.includes('totp_secret'))  db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);
if (!uc.includes('totp_enabled')) db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);

const rc = cols('password_reset_tokens');
if (!rc.includes('request_ip')) db.exec(`ALTER TABLE password_reset_tokens ADD COLUMN request_ip TEXT`);

console.log('✅ Migrations complete.');
db.close();
