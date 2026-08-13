'use strict'

const fs = require('fs')
const path = require('path')

const ROUTE_GROUPS = [
  { id: 'core', label: 'Core & diagnostics', file: 'index.js', receiver: 'app', prefix: '', description: 'Health, configuration, feature flags, live updates, and instance diagnostics.' },
  { id: 'auth', label: 'Authentication & account', file: 'routes/auth.js', receiver: 'router', prefix: '/api/auth', description: 'Sign-in, profile, preferences, sessions, passwords, and two-factor authentication.' },
  { id: 'passkeys', label: 'Passkeys', file: 'routes/passkeys.js', receiver: 'router', prefix: '/api/passkeys', description: 'WebAuthn registration and passwordless authentication.' },
  { id: 'users', label: 'Users', file: 'routes/users.js', receiver: 'router', prefix: '/api/users', description: 'User directory, account administration, and profile photos.' },
  { id: 'roles', label: 'Roles & permissions', file: 'routes/roles.js', receiver: 'router', prefix: '/api/roles', description: 'Custom role definitions and the permission catalogue.' },
  { id: 'shifts', label: 'Shifts', file: 'routes/shifts.js', receiver: 'router', prefix: '/api/shifts', description: 'Shift reads, edits, exports, and template application.' },
  { id: 'locations', label: 'Locations', file: 'routes/locations.js', receiver: 'router', prefix: '/api/locations', description: 'Location records and their member visibility.' },
  { id: 'teams', label: 'Teams', file: 'routes/teams.js', receiver: 'router', prefix: '/api/teams', description: 'Teams, ownership, and membership.' },
  { id: 'organisations', label: 'Organisations', file: 'routes/organisations.js', receiver: 'router', prefix: '/api/organisations', description: 'Organisation records and access membership.' },
  { id: 'templates', label: 'Shift templates', file: 'routes/templates.js', receiver: 'router', prefix: '/api/templates', description: 'Reusable weekly and pattern-based shift templates.' },
  { id: 'template-groups', label: 'Template groups', file: 'routes/template-groups.js', receiver: 'router', prefix: '/api/template-groups', description: 'Template visibility groups and membership.' },
  { id: 'tasks', label: 'Tasks', file: 'routes/tasks.js', receiver: 'router', prefix: '/api/tasks', description: 'Task lists and dated task assignments.' },
  { id: 'task-list-groups', label: 'Task list groups', file: 'routes/task-list-groups.js', receiver: 'router', prefix: '/api/task-list-groups', description: 'Task-list visibility groups and membership.' },
  { id: 'ical', label: 'Calendar feeds', file: 'routes/ical.js', receiver: 'router', prefix: '/api/ical', description: 'Personal iCal subscription tokens and feeds.' },
  { id: 'holidays', label: 'Bank holidays', file: 'routes/holidays.js', receiver: 'router', prefix: '/api/holidays', description: 'Holiday source status, refreshes, and overrides.' },
  { id: 'backup', label: 'Backup & restore', file: 'routes/backup.js', receiver: 'router', prefix: '/api/backup', description: 'Full-instance backup export and restore.' },
]

// Stable endpoints used by the native/mobile client. The contract check fails
// if one is renamed or removed, making accidental breaking route changes visible.
const MOBILE_API_CONTRACT = [
  'GET /api/health',
  'GET /api/config',
  'POST /api/auth/login',
  'POST /api/auth/2fa/login',
  'POST /api/auth/logout',
  'GET /api/auth/me',
  'PATCH /api/auth/profile',
  'GET /api/auth/prefs',
  'PATCH /api/auth/prefs',
  'GET /api/auth/sessions',
  'DELETE /api/auth/sessions/:id',
  'GET /api/passkeys',
  'POST /api/passkeys/auth-options',
  'POST /api/passkeys/auth-verify',
  'POST /api/passkeys/register-options',
  'POST /api/passkeys/register-verify',
  'GET /api/users',
  'GET /api/users/me',
  'GET /api/users/:id',
  'GET /api/users/:id/avatar',
  'POST /api/users/me/avatar',
  'DELETE /api/users/me/avatar',
  'GET /api/shifts',
  'GET /api/shifts/:id',
  'POST /api/shifts',
  'PUT /api/shifts/:id',
  'DELETE /api/shifts/:id',
  'GET /api/locations',
  'GET /api/teams',
  'GET /api/teams/:id/members',
  'GET /api/organisations',
  'GET /api/templates',
  'GET /api/templates/:id',
  'GET /api/tasks/lists',
  'GET /api/tasks/assignments',
  'GET /api/ical/token',
  'DELETE /api/ical/token',
]

const ACCESS_OVERRIDES = new Map([
  ['GET /api/config', 'Optional session'],
  ['GET /api/health', 'Public'],
  ['GET /api/ical/feed/:token', 'Feed token'],
  ['GET /api/auth/admin/reset-link/:userId', 'Permission: manage users'],
  ['POST /api/auth/admin/reset-link/:userId/send', 'Permission: manage users'],
  ['POST /api/auth/invite', 'Permission: manage users'],
  ['POST /api/roles', 'Role manager'],
  ['PATCH /api/roles/:id', 'Role manager'],
  ['DELETE /api/roles/:id', 'Role manager'],
  ['POST /api/shifts', 'Permission: add own/other shifts'],
  ['PUT /api/shifts/:id', 'Permission: edit own/other shifts'],
  ['DELETE /api/shifts/:id', 'Permission: delete own/other shifts'],
  ['GET /api/shifts/export/csv', 'Permission: view own/other rotas'],
  ['POST /api/shifts/apply-template', 'Permission: add/edit own/other shifts'],
  ['GET /api/ical/token', 'Permission: view own rota'],
  ['DELETE /api/passkeys/:id', 'Owner / permission: manage users'],
  ['GET /api/backup/export', 'Permission: manage backups'],
  ['POST /api/backup/restore', 'Permission: manage backups'],
  ['GET /api/endpoints', 'Admin'],
  ['GET /api/features', 'Permission: manage settings'],
  ['PATCH /api/features', 'Permission: manage settings'],
  ['PATCH /api/config', 'Permission: manage settings'],
  ['PATCH /api/config/password-policy', 'Permission: manage settings'],
  ['GET /api/audit', 'Permission: view audit'],
  ['GET /api/audit/export', 'Permission: view audit'],
  ['DELETE /api/audit', 'Permission: manage settings'],
  ['GET /api/stats', 'Permission: manage settings'],
  ['GET /api/config/email', 'Permission: manage settings'],
  ['PATCH /api/config/email', 'Permission: manage settings'],
  ['POST /api/config/email/test', 'Permission: manage settings'],
])

const CORE_ADMIN_PATHS = new Set([
  '/api/endpoints',
  '/api/features',
  '/api/config/password-policy',
  '/api/audit',
  '/api/audit/export',
  '/api/stats',
  '/api/config/email',
  '/api/config/email/test',
])

const SUMMARY_OVERRIDES = new Map([
  ['GET /api/health', 'Check API and database availability'],
  ['GET /api/config', 'Load app configuration and signed-in user context'],
  ['GET /api/endpoints', 'List the administrator API reference'],
  ['GET /api/sse', 'Open the real-time invalidation stream'],
  ['POST /api/auth/login', 'Start an authenticated session'],
  ['POST /api/auth/logout', 'End the current session'],
  ['GET /api/auth/me', 'Load the current account'],
  ['GET /api/auth/prefs', 'Load personal app preferences'],
  ['PATCH /api/auth/prefs', 'Update personal app preferences'],
  ['GET /api/shifts', 'List visible shifts for a date range'],
  ['GET /api/shifts/:id', 'Load one visible shift'],
  ['POST /api/shifts', 'Create a shift'],
  ['PUT /api/shifts/:id', 'Update a shift'],
  ['DELETE /api/shifts/:id', 'Delete a shift'],
  ['GET /api/locations', 'List locations visible to the account'],
  ['GET /api/teams', 'List teams visible to the account'],
  ['GET /api/teams/:id/members', 'List members for a visible team'],
  ['GET /api/tasks/lists', 'List visible task lists'],
  ['GET /api/tasks/assignments', 'List visible task assignments'],
])

const PUBLIC_GROUPS = new Set(['auth', 'passkeys', 'ical'])
const METHOD_ACTION = {
  GET: 'Read',
  POST: 'Create or run',
  PUT: 'Replace',
  PATCH: 'Update',
  DELETE: 'Delete or revoke',
}

function joinRoute(prefix, routePath) {
  return prefix + (routePath === '/' ? '' : routePath)
}

function inferAccess(group, method, routePath, declaration) {
  const key = `${method} ${routePath}`
  if (ACCESS_OVERRIDES.has(key)) return ACCESS_OVERRIDES.get(key)
  if (group.id === 'core') {
    if (routePath === '/api/config' && method === 'PATCH') return 'Admin'
    if (CORE_ADMIN_PATHS.has(routePath)) return 'Admin'
  }
  if (declaration.includes('requireAdminOrManager')) return 'Admin / Manager'
  if (declaration.includes('requireShiftLead')) return 'Shift lead+'
  if (declaration.includes('requireAdmin')) return 'Permission: manage users'
  const permission = declaration.match(/requirePermission\(\s*['"]([^'"]+)['"]\s*\)/)
  if (permission) return `Permission: ${permission[1].replaceAll('_', ' ')}`
  if (declaration.includes('requireAuth')) return 'Signed in'
  if (group.id === 'backup') return 'Admin'
  return PUBLIC_GROUPS.has(group.id) ? 'Public' : 'Signed in'
}

function inferSummary(method, routePath) {
  const key = `${method} ${routePath}`
  if (SUMMARY_OVERRIDES.has(key)) return SUMMARY_OVERRIDES.get(key)
  const segments = routePath.split('/').filter(Boolean)
  const resource = [...segments].reverse().find(segment => !segment.startsWith(':')) || 'resource'
  const readable = resource.replace(/[-_]/g, ' ')
  return `${METHOD_ACTION[method] || 'Use'} ${readable}`
}

function extractGroupRoutes(group) {
  const sourcePath = path.join(__dirname, group.file)
  const source = fs.readFileSync(sourcePath, 'utf8')
  const pattern = new RegExp(
    `${group.receiver}\\.(get|post|put|patch|delete)\\(\\s*(['"])` +
    `([^'"]+)\\2\\s*,([^\\n]*)`,
    'gi'
  )
  const routes = []
  let match
  while ((match = pattern.exec(source))) {
    const method = match[1].toUpperCase()
    const routePath = joinRoute(group.prefix, match[3])
    if (!routePath.startsWith('/api/')) continue
    const key = `${method} ${routePath}`
    routes.push({
      method,
      path: routePath,
      access: inferAccess(group, method, routePath, match[4]),
      summary: inferSummary(method, routePath),
      mobile: MOBILE_API_CONTRACT.includes(key),
    })
  }
  return routes
}

function buildApiCatalog() {
  return ROUTE_GROUPS.map(group => ({
    id: group.id,
    label: group.label,
    description: group.description,
    endpoints: extractGroupRoutes(group),
  })).filter(group => group.endpoints.length > 0)
}

module.exports = {
  API_CATALOG_VERSION: 2,
  MOBILE_API_CONTRACT,
  buildApiCatalog,
}
