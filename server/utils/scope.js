'use strict'
const db = require('../db/connection')

/**
 * Returns a Set of user IDs that a shift_lead is allowed to see/manage.
 * Includes all members of teams they own plus themselves.
 */
function getShiftLeadScope(userId) {
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
