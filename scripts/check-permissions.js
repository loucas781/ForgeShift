'use strict'

// Fast, dependency-free regression check for the role catalogue. This does not
// open the database or start the server, so it is safe to run in CI and in a
// development container before migrations are available.
const fs = require('fs')
const path = require('path')

const rolesSource = fs.readFileSync(path.join(__dirname, '..', 'server/utils/roles.js'), 'utf8')
const catalogueSource = rolesSource.match(/const PERMISSION_CATALOG = \[([\s\S]*?)\n\]/)?.[1] || ''
const permissionKeys = [...catalogueSource.matchAll(/\bkey:\s*'([^']+)'/g)].map(match => match[1])
const builtinSource = rolesSource.match(/const BUILTIN = \{([\s\S]*?)\n\}\n\nfunction parsePermissions/)?.[1] || ''
const builtinPermissionKeys = [...builtinSource.matchAll(/permissions:\s*\[([^\]]*)\]/g)]
  .flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(permission => permission[1]))
const builtinCount = (builtinSource.match(/^  [a-z_]+:\s*\{/gm) || []).length

const required = [
  'view_calendar', 'view_shifts', 'view_tasks', 'view_templates', 'view_teams',
  'view_team_rotas', 'view_all_rotas', 'manage_team_shifts', 'manage_all_shifts',
  'manage_team_tasks', 'manage_all_tasks', 'manage_own_teams', 'manage_all_teams',
]
const keys = new Set(permissionKeys)
const missing = required.filter(key => !keys.has(key))
if (missing.length) throw new Error(`Permission catalogue missing: ${missing.join(', ')}`)

const unknownBuiltins = builtinPermissionKeys.filter(permission => !keys.has(permission))
if (unknownBuiltins.length) throw new Error(`Built-in roles contain unknown permissions: ${[...new Set(unknownBuiltins)].join(', ')}`)

const routeFiles = ['server/routes/shifts.js', 'server/routes/tasks.js', 'server/routes/teams.js', 'server/routes/users.js']
for (const file of routeFiles) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  if (!source.includes('view_team_rotas') && file.endsWith('shifts.js')) throw new Error(`${file} does not enforce team rota scope`)
  if (!source.includes('manage_team_tasks') && file.endsWith('tasks.js')) throw new Error(`${file} does not enforce team task scope`)
  if (file.endsWith('users.js')) {
    for (const permission of ['view_team_rotas', 'view_all_rotas', 'manage_team_shifts', 'manage_org_shifts', 'manage_all_shifts']) {
      if (!source.includes(`'${permission}'`)) throw new Error(`${file} does not expose users for ${permission}`)
    }
  }
}

const configSource = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8')
for (const permission of ['view_team_rotas', 'view_all_rotas', 'manage_team_shifts', 'manage_org_shifts', 'manage_all_shifts', 'manage_team_tasks', 'manage_all_tasks', 'manage_own_teams', 'manage_all_teams']) {
  if (!configSource.includes(`'${permission}'`)) throw new Error(`/api/config section access does not recognise ${permission}`)
}

console.log(`Permissions OK: ${permissionKeys.length} catalogue entries; ${builtinCount} built-in roles checked.`)
