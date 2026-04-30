'use strict'

const DEFAULT_COLOR = '#0052cc'
const DEFAULT_NOTE_COLOR = '#4f46e5'
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function normalizeColorInput(value) {
  if (value === undefined) return undefined
  if (value === null) return ''
  const color = String(value).trim()
  if (!color) return ''
  return HEX_COLOR_RE.test(color) ? color : ''
}

function resolveStoredColor(value, fallback = DEFAULT_COLOR) {
  if (value === undefined) return fallback
  return normalizeColorInput(value)
}

module.exports = {
  DEFAULT_COLOR,
  DEFAULT_NOTE_COLOR,
  normalizeColorInput,
  resolveStoredColor,
}
