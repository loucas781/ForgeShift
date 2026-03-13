'use strict';
/**
 * audit.js — Write entries to the audit_log table.
 * Usage: audit(db, actorId, 'user.login', 'user', userId, userName)
 * Never throws — audit failures must not break the main request.
 */
const { v4: uuidv4 } = require('uuid');

function audit(db, actorId, action, entityType, entityId, entityName, meta) {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, entity_name, meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      actorId    || null,
      action,
      entityType,
      entityId   || null,
      entityName || null,
      meta ? JSON.stringify(meta) : null,
    );
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}

module.exports = audit;
