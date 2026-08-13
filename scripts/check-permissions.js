'use strict'

// Fast, dependency-free regression check for the role catalogue. This does not
// open the database or start the server, so it is safe to run in CI and in a
// development container before migrations are available.
const fs = require('fs')
const path = require('path')
const { PERMISSION_CATALOG, BUILTIN } = require('../server/utils/roles')

const required = [
  'view_calendar', 'view_shifts', 'view_tasks', 'view_templates', 'view_teams',
  'view_team_rotas', 'view_all_rotas', 'manage_team_shifts', 'manage_org_shifts', 'manage_all_shifts',
  'manage_team_tasks', 'manage_all_tasks', 'manage_own_teams', 'manage_all_teams',
]
const keys = new Set(PERMISSION_CATALOG.map(permission => permission.key))
const missing = required.filter(key => !keys.has(key))
if (missing.length) throw new Error(`Permission catalogue missing: ${missing.join(', ')}`)

for (const [roleName, role] of Object.entries(BUILTIN)) {
  const unknown = role.permissions.filter(permission => !keys.has(permission))
  if (unknown.length) throw new Error(`${roleName} contains unknown permissions: ${unknown.join(', ')}`)
}

const routeFiles = ['server/routes/shifts.js', 'server/routes/tasks.js', 'server/routes/teams.js']
for (const file of routeFiles) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  if (!source.includes('view_team_rotas') && file.endsWith('shifts.js')) throw new Error(`${file} does not enforce team rota scope`)
  if (!source.includes('manage_team_tasks') && file.endsWith('tasks.js')) throw new Error(`${file} does not enforce team task scope`)
}

console.log(`Permissions OK: ${PERMISSION_CATALOG.length} catalogue entries; ${Object.keys(BUILTIN).length} built-in roles checked.`)
