'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db = require('../db/connection')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { PERMISSION_CATALOG, serializeRole, parsePermissions, BUILTIN, canGrantRole } = require('../utils/roles')
const { normalizeColorInput } = require('../utils/color-utils')
const audit = require('../audit')

function roleRow(id) { return db.prepare('SELECT * FROM roles WHERE id = ?').get(id) }
function validatePayload(body, existing) {
  const name = String(body.name ?? existing?.name ?? '').trim()
  if (!name) return { error: 'Role name is required.' }
  if (name.length > 80) return { error: 'Role name is too long.' }
  const color = normalizeColorInput(body.color ?? existing?.color)
  if (!color) return { error: 'A valid role colour is required.' }
  const permissions = parsePermissions(body.permissions ?? existing?.permissions)
  if (body.permissions !== undefined && !Array.isArray(body.permissions)) return { error: 'permissions must be an array.' }
  return { name, color, permissions }
}

router.get('/catalog', requireAuth, (_req, res) => res.json({ permissions: PERMISSION_CATALOG }))

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id OR u.previous_role_id = r.id) AS assigned_count
    FROM roles r ORDER BY r.is_system DESC, r.is_builtin DESC, r.name COLLATE NOCASE`).all()
  // Everyone may read the catalogue/list for native clients; permissions remain
  // authoritative only on the server and inactive accounts never pass auth.
  res.json(rows.map(serializeRole))
})

router.post('/', requireAuth, requirePermission('manage_roles'), (req, res) => {
  const payload = validatePayload(req.body)
  if (payload.error) return res.status(400).json({ error: payload.error })
  if (!canGrantRole(req, { permissions: payload.permissions })) {
    return res.status(403).json({ error: 'You cannot grant permissions you do not have.' })
  }
  if (db.prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)').get(payload.name)) return res.status(409).json({ error: 'A role with that name already exists.' })
  const id = uuidv4()
  try {
    db.prepare(`INSERT INTO roles (id,name,color,permissions,is_builtin,is_system,created_by)
      VALUES (?,?,?, ?,0,0,?)`).run(id, payload.name, payload.color, JSON.stringify(payload.permissions), req.user.id)
    const role = roleRow(id)
    audit(req.user.id, 'role.create', 'role', id, role.name)
    res.status(201).json(serializeRole(role))
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'A role with that name already exists.' })
    res.status(500).json({ error: 'Server error' })
  }
})

router.patch('/:id', requireAuth, requirePermission('manage_roles'), (req, res) => {
  const role = roleRow(req.params.id)
  if (!role) return res.status(404).json({ error: 'Role not found' })
  if (role.is_builtin || role.is_system) return res.status(400).json({ error: 'Built-in roles cannot be changed.' })
  if (!canGrantRole(req, role)) return res.status(403).json({ error: 'You cannot manage a role with permissions above your own.' })
  const payload = validatePayload(req.body, role)
  if (payload.error) return res.status(400).json({ error: payload.error })
  if (!canGrantRole(req, { ...role, id: null, permissions: payload.permissions })) {
    return res.status(403).json({ error: 'You cannot grant permissions you do not have.' })
  }
  if (db.prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id <> ?').get(payload.name, role.id)) return res.status(409).json({ error: 'A role with that name already exists.' })
  try {
    db.prepare(`UPDATE roles SET name=?, color=?, permissions=?, updated_at=datetime('now') WHERE id=?`)
      .run(payload.name, payload.color, JSON.stringify(payload.permissions), role.id)
    const updated = roleRow(role.id)
    audit(req.user.id, 'role.update', 'role', role.id, updated.name)
    res.json(serializeRole(updated))
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'A role with that name already exists.' })
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id', requireAuth, requirePermission('manage_roles'), (req, res) => {
  const role = roleRow(req.params.id)
  if (!role) return res.status(404).json({ error: 'Role not found' })
  if (role.is_builtin || role.is_system || Object.values(BUILTIN).some(r => r.id === role.id)) {
    return res.status(400).json({ error: 'Built-in roles cannot be deleted.' })
  }
  if (!canGrantRole(req, role)) return res.status(403).json({ error: 'You cannot manage a role with permissions above your own.' })
  const assigned = db.prepare('SELECT COUNT(*) AS count FROM users WHERE role_id = ? OR previous_role_id = ?').get(role.id, role.id).count
  if (assigned > 0) return res.status(409).json({ error: 'Reassign all users before deleting this role.', assigned })
  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id)
  audit(req.user.id, 'role.delete', 'role', role.id, role.name)
  res.json({ ok: true })
})

module.exports = router
