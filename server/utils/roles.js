'use strict'

const db = require('../db/connection')

// Keep permission identifiers stable: they are persisted in custom role JSON and
// consumed by both the web and native clients.
const PERMISSION_CATALOG = [
  { key: 'view_calendar', label: 'View calendar', description: 'Open the calendar and switch between month, week and agenda views.', category: 'Workspace' },
  { key: 'view_shifts', label: 'View shifts', description: 'Read shift details that the account is allowed to access.', category: 'Workspace' },
  { key: 'view_tasks', label: 'View tasks', description: 'Read task lists and assigned task details within the account scope.', category: 'Tasks' },
  { key: 'assign_own_tasks', label: 'Assign task lists to self', description: 'Assign available task lists to the signed-in user without creating or editing task lists.', category: 'Tasks' },
  { key: 'view_templates', label: 'View shift templates', description: 'Browse saved shift templates available to the account.', category: 'Workspace' },
  { key: 'view_own_rota', label: 'View own rota', description: 'View the signed-in user’s own shifts and rota.', category: 'Rota' },
  { key: 'view_other_rotas', label: 'View other users’ rotas', description: 'Legacy compatibility permission. Prefer View team rotas or View all rotas for new roles.', category: 'Legacy', legacy: true },
  { key: 'view_team_rotas', label: 'View team rotas', description: 'View rotas for members of the user’s assigned teams or organisation scope.', category: 'Rota', scope: 'Organisation/team members only' },
  { key: 'view_all_rotas', label: 'View all rotas', description: 'View rotas for every active user across the instance.', category: 'Rota', scope: 'All active users' },
  { key: 'view_teams', label: 'View organisation team members', description: 'See team membership and people in organisations the user can access.', category: 'Teams' },
  { key: 'view_locations', label: 'View locations', description: 'Read configured work locations and their organisation links.', category: 'Workspace' },
  { key: 'view_organisations', label: 'View organisations', description: 'Read organisation details and assigned members.', category: 'Workspace' },
  { key: 'view_settings', label: 'View settings', description: 'Open the settings area permitted for the account.', category: 'Workspace' },
  { key: 'add_own_shifts', label: 'Add own shifts', description: 'Create shifts for the signed-in user.', category: 'Shifts' },
  { key: 'edit_own_shifts', label: 'Edit own shifts', description: 'Change shifts belonging to the signed-in user.', category: 'Shifts' },
  { key: 'delete_own_shifts', label: 'Delete own shifts', description: 'Remove shifts belonging to the signed-in user.', category: 'Shifts' },
  { key: 'add_other_shifts', label: 'Add shifts for other users', description: 'Create shifts for another user within the account scope.', category: 'Shifts' },
  { key: 'edit_other_shifts', label: 'Edit shifts for other users', description: 'Change another user’s shifts within the account scope.', category: 'Shifts' },
  { key: 'delete_other_shifts', label: 'Delete shifts for other users', description: 'Remove another user’s shifts within the account scope.', category: 'Shifts' },
  { key: 'manage_team_shifts', label: 'Manage shifts for your teams', description: 'Add, edit and remove shifts for assigned teams.', category: 'Shifts', scope: 'Organisation/team members only' },
  { key: 'manage_org_shifts', label: 'Manage shifts across your organisation', description: 'Add, edit and remove shifts for organisation members.', category: 'Shifts', scope: 'Organisation members only' },
  { key: 'manage_all_shifts', label: 'Manage all shifts', description: 'Add, edit and remove shifts for any active user.', category: 'Shifts', scope: 'All active users' },
  { key: 'manage_tasks', label: 'Manage tasks and assignments', description: 'Create, edit and assign task lists within the account scope.', category: 'Tasks' },
  { key: 'manage_team_tasks', label: 'Manage tasks for your teams', description: 'Manage task lists and assignments for assigned teams.', category: 'Tasks', scope: 'Organisation/team members only' },
  { key: 'manage_all_tasks', label: 'Manage all tasks', description: 'Manage task lists and assignments across the instance.', category: 'Tasks', scope: 'All active users' },
  { key: 'manage_templates', label: 'Manage shift templates', description: 'Create, edit, apply and remove saved shift templates.', category: 'Administration' },
  { key: 'manage_teams', label: 'Manage teams', description: 'Create and maintain teams and their membership.', category: 'Administration' },
  { key: 'manage_own_teams', label: 'Manage assigned teams', description: 'Manage only teams assigned to or owned by the user.', category: 'Administration', scope: 'Owned or assigned teams' },
  { key: 'manage_all_teams', label: 'Manage all teams', description: 'Manage every team in the instance.', category: 'Administration', scope: 'All teams' },
  { key: 'manage_locations', label: 'Manage locations', description: 'Create, edit and remove work locations.', category: 'Administration' },
  { key: 'manage_organisations', label: 'Manage organisations', description: 'Create, edit and manage organisation membership.', category: 'Administration' },
  { key: 'manage_users', label: 'Manage users', description: 'Invite, edit, deactivate and assign roles to users.', category: 'Administration' },
  { key: 'manage_roles', label: 'Manage roles', description: 'Create and maintain custom roles and their permissions.', category: 'Administration' },
  { key: 'manage_settings', label: 'Manage settings', description: 'Change application and workspace settings.', category: 'Administration' },
  { key: 'view_audit', label: 'View audit log', description: 'Read the record of administrative and security actions.', category: 'Administration' },
  { key: 'manage_backups', label: 'Manage backups', description: 'Create, restore and manage application backups.', category: 'Administration' },
  { key: 'manage_holidays', label: 'Manage holidays', description: 'Configure bank holidays and holiday overrides.', category: 'Administration' },
]
const ALL_PERMISSIONS = PERMISSION_CATALOG.map(p => p.key)

const BUILTIN = {
  member: {
    id: 'builtin-member', name: 'Member', description: 'Personal access to your own calendar, shifts, tasks and settings.', color: '#059669', is_builtin: 1,
    permissions: ['view_calendar', 'view_shifts', 'view_tasks', 'assign_own_tasks', 'view_settings', 'view_own_rota'],
  },
  shift_lead: {
    id: 'builtin-shift-lead', name: 'Shift Lead', description: 'Day-to-day team operations: manage team rotas, tasks and assigned team members.', color: '#2563eb', is_builtin: 1,
    permissions: ['view_calendar', 'view_shifts', 'view_tasks', 'assign_own_tasks', 'view_templates', 'view_settings', 'view_own_rota', 'view_other_rotas', 'view_team_rotas', 'view_teams', 'view_locations', 'view_organisations', 'add_own_shifts', 'edit_own_shifts', 'delete_own_shifts', 'add_other_shifts', 'edit_other_shifts', 'delete_other_shifts', 'manage_team_shifts', 'manage_tasks', 'manage_team_tasks', 'manage_teams', 'manage_own_teams'],
  },
  manager: {
    id: 'builtin-manager', name: 'Manager', description: 'Organisation-level oversight: manage organisation rotas, locations, templates and teams.', color: '#d97706', is_builtin: 1,
    permissions: ['view_calendar', 'view_shifts', 'view_tasks', 'assign_own_tasks', 'view_templates', 'view_settings', 'view_own_rota', 'view_other_rotas', 'view_team_rotas', 'view_teams', 'view_locations', 'view_organisations', 'add_own_shifts', 'edit_own_shifts', 'delete_own_shifts', 'add_other_shifts', 'edit_other_shifts', 'delete_other_shifts', 'manage_org_shifts', 'manage_tasks', 'manage_team_tasks', 'manage_templates', 'manage_teams', 'manage_own_teams'],
  },
  admin: {
    id: 'builtin-admin', name: 'Admin', description: 'Full instance access, including global rotas, users, roles, settings and backups.', color: '#4f46e5', is_builtin: 1,
    permissions: ALL_PERMISSIONS,
  },
  inactive: {
    id: 'system-inactive', name: 'Inactive', description: 'System role for disabled accounts. Cannot sign in until re-enabled.', color: '#6b7280', is_builtin: 1, is_system: 1,
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
  const builtin = Object.values(BUILTIN).find(item => item.id === role.id)
  return {
    id: role.id, name: role.name, description: role.description || builtin?.description || null, color: role.color,
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
  // Keep this helper safe when it is invoked against a partially migrated
  // database (for example, an interrupted roles migration).
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  if (!userCols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'")
  if (!userCols.includes('is_active')) db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1')
  if (!userCols.includes('role_id')) db.exec('ALTER TABLE users ADD COLUMN role_id TEXT REFERENCES roles(id) ON DELETE SET NULL')
  if (!userCols.includes('previous_role_id')) db.exec('ALTER TABLE users ADD COLUMN previous_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL')
  const users = db.prepare('SELECT id, role, role_id, previous_role_id, is_active FROM users').all()
  const updateActive = db.prepare("UPDATE users SET role_id = ? WHERE id = ? AND (role_id IS NULL OR role_id = '')")
  const parkInactive = db.prepare(`UPDATE users SET role_id = ?, previous_role_id = COALESCE(previous_role_id, ?)
    WHERE id = ? AND (role_id IS NULL OR role_id = '' OR role_id != ?)`)
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
