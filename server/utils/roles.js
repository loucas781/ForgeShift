'use strict'

const db = require('../db/connection')

// Keep permission identifiers stable: they are persisted in custom role JSON and
// consumed by both the web and native clients.
const PERMISSION_CATALOG = [
  { key: 'view_own_rota', label: 'View own rota', category: 'Rota' },
  { key: 'view_other_rotas', label: 'View other users’ rotas', category: 'Rota' },
  { key: 'add_own_shifts', label: 'Add own shifts', category: 'Shifts' },
  { key: 'edit_own_shifts', label: 'Edit own shifts', category: 'Shifts' },
  { key: 'delete_own_shifts', label: 'Delete own shifts', category: 'Shifts' },
  { key: 'add_other_shifts', label: 'Add shifts for other users', category: 'Shifts' },
  { key: 'edit_other_shifts', label: 'Edit shifts for other users', category: 'Shifts' },
  { key: 'delete_other_shifts', label: 'Delete shifts for other users', category: 'Shifts' },
  { key: 'manage_tasks', label: 'Manage tasks and assignments', category: 'Administration' },
  { key: 'manage_templates', label: 'Manage shift templates', category: 'Administration' },
  { key: 'manage_teams', label: 'Manage teams', category: 'Administration' },
  { key: 'manage_locations', label: 'Manage locations', category: 'Administration' },
  { key: 'manage_organisations', label: 'Manage organisations', category: 'Administration' },
  { key: 'manage_users', label: 'Manage users', category: 'Administration' },
  { key: 'manage_roles', label: 'Manage roles', category: 'Administration' },
  { key: 'manage_settings', label: 'Manage settings', category: 'Administration' },
  { key: 'view_audit', label: 'View audit log', category: 'Administration' },
  { key: 'manage_backups', label: 'Manage backups', category: 'Administration' },
  { key: 'manage_holidays', label: 'Manage holidays', category: 'Administration' },
]
const ALL_PERMISSIONS = PERMISSION_CATALOG.map(p => p.key)

const BUILTIN = {
  member: {
    id: 'builtin-member', name: 'Member', color: '#059669', is_builtin: 1,
    permissions: ['view_own_rota'],
  },
  shift_lead: {
    id: 'builtin-shift-lead', name: 'Shift Lead', color: '#2563eb', is_builtin: 1,
    permissions: ['view_own_rota', 'view_other_rotas', 'add_own_shifts', 'edit_own_shifts', 'delete_own_shifts', 'add_other_shifts', 'edit_other_shifts', 'delete_other_shifts', 'manage_tasks', 'manage_teams'],
  },
  manager: {
    id: 'builtin-manager', name: 'Manager', color: '#d97706', is_builtin: 1,
    permissions: ['view_own_rota', 'view_other_rotas', 'add_own_shifts', 'edit_own_shifts', 'delete_own_shifts', 'add_other_shifts', 'edit_other_shifts', 'delete_other_shifts', 'manage_tasks', 'manage_templates', 'manage_teams'],
  },
  admin: {
    id: 'builtin-admin', name: 'Admin', color: '#4f46e5', is_builtin: 1,
    permissions: ALL_PERMISSIONS,
  },
  inactive: {
    id: 'system-inactive', name: 'Inactive', color: '#6b7280', is_builtin: 1, is_system: 1,
    permissions: [],
  },
}

function parsePermissions(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]')
    return [...new Set(parsed.filter(p => ALL_PERMISSIONS.includes(p)))]
  } catch { return [] }
}

function rolePermissions(role) {
  if (!role) return []
  if (role.id === BUILTIN.admin.id) return ALL_PERMISSIONS.slice()
  if (role.is_system && role.id === BUILTIN.inactive.id) return []
  const builtinRole = Object.values(BUILTIN).find(item => item.id === role.id)
  if (builtinRole) return builtinRole.permissions.slice()
  // A resolved role id is authoritative. Custom-role users intentionally retain
  // the legacy users.role='member' value for older clients, so that fallback
  // must never replace the custom permission set.
  if (role.id) return parsePermissions(role.permissions)
  if (BUILTIN[role.role]) return BUILTIN[role.role].permissions.slice()
  return parsePermissions(role.permissions)
}

function getRoleForUser(userId) {
  return db.prepare(`
    SELECT u.id AS user_id, u.role AS legacy_role, u.role AS role, u.role_id, u.is_active,
           r.id, r.name, r.color, r.permissions, r.is_builtin, r.is_system
      FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?
  `).get(userId) || null
}

function hasPermission(userOrReq, permission) {
  const userId = userOrReq?.id || userOrReq?.user?.id
  const legacyRole = userOrReq?.role || userOrReq?.user?.role
  const row = userId ? getRoleForUser(userId) : null
  if (row) {
    if (!row.is_active) return false
    return rolePermissions(row.id ? row : { role: row.legacy_role }).includes(permission)
  }
  return rolePermissions({ role: legacyRole }).includes(permission)
}

function serializeRole(role) {
  if (!role) return null
  return {
    id: role.id, name: role.name, color: role.color,
    permissions: rolePermissions(role),
    is_builtin: !!role.is_builtin, is_system: !!role.is_system,
    deletable: !role.is_builtin && !role.is_system,
    assigned_count: Number(role.assigned_count || 0),
  }
}

function canGrantRole(userOrReq, targetRole) {
  if (!targetRole) return false
  const userId = userOrReq?.id || userOrReq?.user?.id
  const legacyRole = userOrReq?.role || userOrReq?.user?.role
  const actorRole = userId ? getRoleForUser(userId) : null
  if (actorRole?.id === BUILTIN.admin.id || (!actorRole && legacyRole === 'admin')) return true
  if (targetRole.is_system) return false
  const actorPermissions = new Set(rolePermissions(actorRole || { role: legacyRole }))
  return rolePermissions(targetRole).every(permission => actorPermissions.has(permission))
}

function canManageUserRole(userOrReq, targetUser) {
  if (!targetUser) return false
  const parkedRoleId = targetUser.role_id === BUILTIN.inactive.id
    ? (targetUser.previous_role_id || db.prepare('SELECT previous_role_id FROM users WHERE id = ?').get(targetUser.id)?.previous_role_id)
    : targetUser.role_id
  const targetRole = parkedRoleId
    ? db.prepare('SELECT * FROM roles WHERE id = ?').get(parkedRoleId)
    : null
  return canGrantRole(userOrReq, targetRole || { role: targetUser.role })
}

function ensureBuiltinRoles() {
  db.exec(`CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#0052cc',
    permissions TEXT NOT NULL DEFAULT '[]', is_builtin INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0, created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const stmt = db.prepare(`INSERT INTO roles (id,name,color,permissions,is_builtin,is_system)
    VALUES (@id,@name,@color,@permissions,@is_builtin,@is_system)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color,
      permissions=excluded.permissions, is_builtin=excluded.is_builtin, is_system=excluded.is_system`)
  for (const role of Object.values(BUILTIN)) {
    stmt.run({ ...role, is_system: role.is_system || 0, permissions: JSON.stringify(role.permissions) })
  }
  // Legacy accounts receive a stable role_id. Do not overwrite custom choices.
  const users = db.prepare('SELECT id, role, role_id, previous_role_id, is_active FROM users').all()
  const updateActive = db.prepare('UPDATE users SET role_id = ? WHERE id = ? AND (role_id IS NULL OR role_id = "")')
  const parkInactive = db.prepare(`UPDATE users SET role_id = ?, previous_role_id = COALESCE(previous_role_id, ?)
    WHERE id = ? AND (role_id IS NULL OR role_id = "" OR role_id != ?)`)
  for (const user of users) {
    const legacyRoleId = BUILTIN[user.role]?.id || BUILTIN.member.id
    if (user.is_active) updateActive.run(legacyRoleId, user.id)
    else parkInactive.run(BUILTIN.inactive.id, user.role_id || legacyRoleId, user.id, BUILTIN.inactive.id)
  }
}

module.exports = {
  PERMISSION_CATALOG,
  ALL_PERMISSIONS,
  BUILTIN,
  parsePermissions,
  rolePermissions,
  getRoleForUser,
  hasPermission,
  serializeRole,
  canGrantRole,
  canManageUserRole,
  ensureBuiltinRoles,
}
