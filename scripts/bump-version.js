#!/usr/bin/env node
/**
 * ForgeShift — Version Bump Script
 *
 * Increments the build counter in version.json and records
 * the current git commit SHA, branch, and timestamp.
 *
 * Called automatically by GitHub Actions on every push.
 * Can also be run manually: node scripts/bump-version.js
 *
 * Optional env vars:
 *   GITHUB_SHA          — full commit SHA (set by GitHub Actions)
 *   GITHUB_REF_NAME     — branch or tag name (set by GitHub Actions)
 *   VERSION_BUMP        — "patch" | "minor" | "major" (default: none, only bumps build)
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const versionPath = path.join(__dirname, '../version.json');

// ── Read current version ───────────────────────────────────────────
let current;
try {
  current = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
} catch {
  current = { version: '1.0.0', build: 0, commit: 'local', branch: 'main', builtAt: new Date().toISOString() };
}

// ── Resolve commit SHA ─────────────────────────────────────────────
let commit = process.env.GITHUB_SHA || current.commit;
if (commit === 'local' || !commit) {
  try { commit = execSync('git rev-parse HEAD', { stdio: ['pipe','pipe','pipe'] }).toString().trim(); }
  catch { commit = 'local'; }
}
// Short SHA (7 chars)
const shortCommit = commit.length > 7 ? commit.slice(0, 7) : commit;

// ── Resolve branch ─────────────────────────────────────────────────
let branch = process.env.GITHUB_REF_NAME || current.branch;
if (!branch || branch === 'main') {
  try { branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['pipe','pipe','pipe'] }).toString().trim(); }
  catch { branch = 'main'; }
}

// ── Bump semver if requested ───────────────────────────────────────
let [major, minor, patch] = (current.version || '1.0.0').split('.').map(Number);
const bump = process.env.VERSION_BUMP || process.argv[2];
if (bump === 'major') { major++; minor = 0; patch = 0; }
else if (bump === 'minor') { minor++; patch = 0; }
else if (bump === 'patch') { patch++; }

const version = `${major}.${minor}.${patch}`;

// ── Increment build counter ────────────────────────────────────────
const build = (current.build || 0) + 1;

// ── Write updated version.json ────────────────────────────────────
const updated = {
  version,
  build,
  commit: shortCommit,
  branch,
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(versionPath, JSON.stringify(updated, null, 2) + '\n');

console.log(`✅ Version bumped:`);
console.log(`   version  : ${version}`);
console.log(`   build    : ${build}`);
console.log(`   commit   : ${shortCommit}`);
console.log(`   branch   : ${branch}`);
console.log(`   builtAt  : ${updated.builtAt}`);
