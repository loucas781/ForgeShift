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

    -- ── Teams ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS teams (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#0052cc',
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Team Members ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS team_members (
      team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
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
  if (!cols.includes('prefs')) {
    db.exec("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'")
    console.log('✓ Added prefs column')
  }

  // On-call support
  const shiftCols = db.prepare("PRAGMA table_info(shifts)").all().map(c => c.name)
  if (!shiftCols.includes('is_oncall')) {
    db.exec("ALTER TABLE shifts ADD COLUMN is_oncall INTEGER NOT NULL DEFAULT 0")
    console.log('✓ Added is_oncall column to shifts')
  }

  // Migrate task_assignments: rename week_start -> date if the old schema is present.
  // This MUST run before the CREATE TABLE IF NOT EXISTS block so the table is in the
  // correct shape before any code tries to reference the 'date' column.
  {
    const taskAssignCols = db.prepare("PRAGMA table_info(task_assignments)").all().map(c => c.name)
    if (taskAssignCols.includes('week_start') && !taskAssignCols.includes('date')) {
      console.log('Migrating task_assignments week_start -> date...')
      db.pragma('foreign_keys = OFF')
      try {
        db.exec(`CREATE TABLE task_assignments_new (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          task_list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
          date         TEXT NOT NULL,
          created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (user_id, task_list_id, date)
        )`)
        db.exec(`INSERT INTO task_assignments_new (id, user_id, task_list_id, date, created_by, created_at)
          SELECT id, user_id, task_list_id, week_start, created_by, created_at FROM task_assignments`)
        db.exec(`DROP TABLE task_assignments`)
        db.exec(`ALTER TABLE task_assignments_new RENAME TO task_assignments`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_task_assignments_user ON task_assignments(user_id)`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_task_assignments_date ON task_assignments(date)`)
        console.log('✓ Migrated task_assignments week_start -> date')
      } finally {
        db.pragma('foreign_keys = ON')
      }
    }
  }

  // Task lists feature — safe to run after the migration above has fixed any old schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_lists (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#0052cc',
      description TEXT,
      location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_assignments (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_list_id TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
      date         TEXT NOT NULL,
      created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, task_list_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_task_assignments_user  ON task_assignments(user_id);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_date  ON task_assignments(date);
  `)
  console.log('✓ Task lists schema ready')

  // Migrate task_lists: add description and location_id columns if missing
  const taskListCols = db.prepare("PRAGMA table_info(task_lists)").all().map(c => c.name)
  if (!taskListCols.includes('description')) {
    db.exec("ALTER TABLE task_lists ADD COLUMN description TEXT")
    console.log('✓ Added description to task_lists')
  }
  if (!taskListCols.includes('location_id')) {
    db.exec("ALTER TABLE task_lists ADD COLUMN location_id TEXT REFERENCES locations(id) ON DELETE SET NULL")
    console.log('✓ Added location_id to task_lists')
  }

  // Expand role CHECK to include shift_lead — SQLite can't ALTER constraints
  // so we check if the constraint is already expanded and rebuild if not.
  // IMPORTANT: must disable foreign_keys during the rebuild to prevent CASCADE
  // deletes from wiping shifts, team_members, tokens, etc.
  const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()
  if (tableSQL && !tableSQL.sql.includes('shift_lead')) {
    db.pragma('foreign_keys = OFF')
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE users_new (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          email       TEXT NOT NULL UNIQUE,
          password    TEXT NOT NULL,
          initials    TEXT NOT NULL,
          color       TEXT NOT NULL DEFAULT '#0052cc',
          avatar      TEXT,
          role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','shift_lead','member')),
          is_active   INTEGER NOT NULL DEFAULT 1,
          totp_secret TEXT,
          totp_enabled INTEGER NOT NULL DEFAULT 0,
          prefs       TEXT NOT NULL DEFAULT '{}',
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users_new SELECT id, name, email, password, initials, color, avatar, role, is_active, totp_secret, totp_enabled, COALESCE(prefs,'{}'), created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        COMMIT;
      `)
      console.log('✓ Expanded users.role CHECK to include shift_lead')
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  // team_owned_by: track which shift_lead owns a team
  const teamCols = db.prepare("PRAGMA table_info(teams)").all().map(c => c.name)
  if (!teamCols.includes('owned_by')) {
    db.exec("ALTER TABLE teams ADD COLUMN owned_by TEXT REFERENCES users(id) ON DELETE SET NULL")
    console.log('✓ Added owned_by column to teams')
  }

  // Template groups
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_groups (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_template_groups_sort ON template_groups(sort_order);
  `)
  const tmplCols = db.prepare("PRAGMA table_info(shift_templates)").all().map(c => c.name)
  if (!tmplCols.includes('group_id')) {
    db.exec("ALTER TABLE shift_templates ADD COLUMN group_id TEXT REFERENCES template_groups(id) ON DELETE SET NULL")
    console.log('✓ Added group_id column to shift_templates')
  }

  // User → template group assignments
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_template_groups (
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES template_groups(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_utg_user  ON user_template_groups(user_id);
    CREATE INDEX IF NOT EXISTS idx_utg_group ON user_template_groups(group_id);
  `)
  console.log('✓ Template groups schema ready')

  // Session invalidation: token_version for JWT revocation across all devices
  {
    const tvCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name)
    if (!tvCols.includes('token_version')) {
      db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0")
      console.log('✓ Added token_version column to users')
    }
  }

  // Passkey / WebAuthn credentials
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key  TEXT NOT NULL,
      counter     INTEGER NOT NULL DEFAULT 0,
      device_name TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_credentials(user_id);
  `)
  console.log('✓ Passkey credentials schema ready')
}

try {
  migrate()
  migrateAdditive()
  migrateTeams()
  migrateHolidays()
} catch (err) {
  console.error('Migration failed:', err.message)
  process.exit(1)
}

// Additive: teams support (safe on existing DBs)
function migrateTeams() {
  // teams table
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#0052cc',
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
  `)
  console.log('✓ Teams schema ready')
}

// Additive: holiday override storage (safe on existing DBs)
function migrateHolidays() {
  const db = require('./connection')
  db.prepare(`
    INSERT OR IGNORE INTO app_preferences (key, value, updated_at)
    VALUES ('holiday_overrides', '{}', datetime('now'))
  `).run()
  db.prepare(`
    INSERT OR IGNORE INTO app_preferences (key, value, updated_at)
    VALUES ('holiday_last_fetched', '', datetime('now'))
  `).run()
  console.log('✓ Holiday overrides schema ready')
}
