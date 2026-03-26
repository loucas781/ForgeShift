'use strict'
const fs   = require('fs')
const path = require('path')

const overridesFile = path.join(__dirname, '../../.runtime-overrides.json')

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(overridesFile, 'utf8')) } catch { return {} }
}

module.exports = { loadOverrides }
