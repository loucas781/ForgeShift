'use strict'
const db = require('../db/connection')

/**
 * Returns a Set of user IDs that a shift_lead is allowed to see/manage.
 *
 * Primary: all members of any organisation the shift_lead belongs to.
 * Fallback (no orgs configured): members of teams they own/created (legacy behaviour).
 * Always includes the shift_lead themselves.
 */
function getShiftLeadScope(userId) {
  // Check which organisations this shift_lead belongs to
  const orgRows = db.prepare('SELECT org_id FROM organisation_members WHERE user_id = ?').all(userId)
  const orgIds = orgRows.map(r => r.org_id)

  if (orgIds.length) {
    const placeholders = orgIds.map(() => '?').join(',')
    const members = db.prepare(
      `SELECT DISTINCT user_id FROM organisation_members WHERE org_id IN (${placeholders})`
    ).all(...orgIds)
    const ids = new Set(members.map(m => m.user_id))
    ids.add(userId)
    return ids
  }

  // Fallback: teams they own, created, or are a member of (pre-organisations behaviour)
  const teams = db.prepare(`
    SELECT DISTINCT t.id FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id
    WHERE t.owned_by = ? OR t.created_by = ? OR tm.user_id = ?
  `).all(userId, userId, userId)
  if (!teams.length) return new Set([userId])
  const teamIds = teams.map(t => t.id)
  const members = db.prepare(
    `SELECT DISTINCT user_id FROM team_members WHERE team_id IN (${teamIds.map(() => '?').join(',')})`
  ).all(...teamIds)
  const ids = new Set(members.map(m => m.user_id))
  ids.add(userId)
  return ids
}

// Scope used by custom roles that explicitly receive team-level permissions.
// It follows the same organisation-first, team-membership fallback as the
// historical Shift Lead scope without depending on a literal role name.
function getOrganisationScope(userId) {
  const orgRows = db.prepare('SELECT org_id FROM organisation_members WHERE user_id = ?').all(userId)
  if (orgRows.length) {
    const placeholders = orgRows.map(() => '?').join(',')
    const rows = db.prepare(`SELECT DISTINCT user_id FROM organisation_members WHERE org_id IN (${placeholders})`).all(...orgRows.map(row => row.org_id))
    const ids = new Set(rows.map(row => row.user_id)); ids.add(userId); return ids
  }
  const rows = db.prepare(`
    SELECT DISTINCT tm2.user_id
    FROM team_members tm1 JOIN team_members tm2 ON tm2.team_id = tm1.team_id
    WHERE tm1.user_id = ?
  `).all(userId)
  const ids = new Set(rows.map(row => row.user_id)); ids.add(userId); return ids
}

module.exports = { getShiftLeadScope, getOrganisationScope }
