'use strict'
const db     = require('./db/connection')
const { v4: uuidv4 } = require('uuid')
const logger = require('./utils/logger')

function audit(actorId, action, entityType, entityId, entityName, meta) {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, entity_name, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      actorId    || null,
      action,
      entityType,
      entityId   || null,
      entityName || null,
      meta ? JSON.stringify(meta) : null
    )
  } catch (err) {
    logger.error('[audit] write failed:', err.message)
  }
}

module.exports = audit
