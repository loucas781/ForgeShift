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

  // Fallback: teams they own or created (pre-organisations behaviour)
  const teams = db.prepare('SELECT id FROM teams WHERE owned_by = ? OR created_by = ?').all(userId, userId)
  if (!teams.length) return new Set([userId])
  const teamIds = teams.map(t => t.id)
  const members = db.prepare(
    `SELECT DISTINCT user_id FROM team_members WHERE team_id IN (${teamIds.map(() => '?').join(',')})`
  ).all(...teamIds)
  const ids = new Set(members.map(m => m.user_id))
  ids.add(userId)
  return ids
}

module.exports = { getShiftLeadScope }
