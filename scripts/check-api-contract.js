'use strict'

const { buildApiCatalog, MOBILE_API_CONTRACT } = require('../server/api-catalog')

const groups = buildApiCatalog()
const endpointKeys = groups.flatMap(group =>
  group.endpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`)
)
const available = new Set(endpointKeys)
const duplicates = endpointKeys.filter((key, index) => endpointKeys.indexOf(key) !== index)
const missingMobileEndpoints = MOBILE_API_CONTRACT.filter(key => !available.has(key))
const catalogueEndpoint = groups
  .flatMap(group => group.endpoints)
  .find(endpoint => endpoint.method === 'GET' && endpoint.path === '/api/endpoints')
const catalogueIsAdminOnly = catalogueEndpoint?.access === 'Admin'

if (duplicates.length || missingMobileEndpoints.length || !catalogueIsAdminOnly) {
  if (duplicates.length) {
    console.error(`Duplicate API catalogue entries: ${[...new Set(duplicates)].join(', ')}`)
  }
  if (missingMobileEndpoints.length) {
    console.error(`Mobile API contract endpoints missing: ${missingMobileEndpoints.join(', ')}`)
  }
  if (!catalogueIsAdminOnly) {
    console.error('The API catalogue endpoint must remain admin-only.')
  }
  process.exit(1)
}

console.log(`API contract OK: ${endpointKeys.length} endpoints catalogued; ${MOBILE_API_CONTRACT.length} mobile endpoints preserved.`)
