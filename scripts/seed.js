#!/usr/bin/env node
/**
 * ForgeShift Seed Script
 * Creates default admin user and sample locations
 * Safe to run multiple times (uses INSERT OR IGNORE)
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath = process.env.DB_PATH || './data/forgeshift.db';

let db;
try {
  db = new Database(dbPath);
} catch (e) {
  console.error('❌ Database not found. Run "npm run migrate" first.');
  process.exit(1);
}

db.pragma('foreign_keys = ON');

console.log('🌱 Seeding database...');

// ── Admin User ──────────────────────────────────────────────────────────────
const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@forgeshift.app';
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const adminName     = process.env.ADMIN_NAME     || 'Administrator';

const existingAdmin = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');

if (!existingAdmin) {
  const hash = bcrypt.hashSync(adminPassword, 12);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO users (id, username, email, password, name, role, active)
    VALUES (?, ?, ?, ?, ?, 'admin', 1)
  `).run(id, adminUsername, adminEmail, hash, adminName);

  console.log(`✅ Admin user created:`);
  console.log(`   Email:    ${adminEmail}`);
  console.log(`   Username: ${adminUsername}`);
  console.log(`   Password: ${adminPassword}`);
  console.log(`   ⚠️  Please change the admin password after first login!`);
} else {
  console.log('ℹ️  Admin user already exists, skipping.');
}

// ── Default Locations ───────────────────────────────────────────────────────
const defaultLocations = [
  { name: 'Head Office',  color: '#3b82f6', address: '1 Main Street' },
  { name: 'Branch A',     color: '#10b981', address: '22 Branch Road' },
  { name: 'Remote',       color: '#8b5cf6', address: 'Work from Home' },
  { name: 'Site B',       color: '#f59e0b', address: '5 Industrial Park' },
  { name: 'Client Site',  color: '#ef4444', address: 'Various' },
];

const locCount = db.prepare('SELECT COUNT(*) as n FROM locations').get().n;
if (locCount === 0) {
  const adminUser = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  const insertLoc = db.prepare(
    'INSERT INTO locations (id, name, address, color, created_by) VALUES (?, ?, ?, ?, ?)'
  );
  defaultLocations.forEach(loc => {
    insertLoc.run(uuidv4(), loc.name, loc.address, loc.color, adminUser?.id || null);
  });
  console.log(`✅ Created ${defaultLocations.length} default locations.`);
} else {
  console.log('ℹ️  Locations already exist, skipping.');
}

console.log('\n🚀 Seed complete. You can now start the server with: npm start');
db.close();
