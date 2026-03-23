'use strict'

const { DEFAULT_NOTE_COLOR, resolveStoredColor } = require('./color-utils')

const WEEKLY_TEMPLATE_TYPE = 'weekly'
const PATTERN_TEMPLATE_TYPE = 'pattern'
const MAX_PATTERN_CYCLE_LENGTH = 42

function normalizeTemplateType(value) {
  return value === PATTERN_TEMPLATE_TYPE ? PATTERN_TEMPLATE_TYPE : WEEKLY_TEMPLATE_TYPE
}

function normalizeCycleLength(templateType, value) {
  if (normalizeTemplateType(templateType) === WEEKLY_TEMPLATE_TYPE) return 7
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PATTERN_CYCLE_LENGTH) return null
  return parsed
}

function loadTemplateDays(db, templateId, templateType) {
  if (normalizeTemplateType(templateType) === PATTERN_TEMPLATE_TYPE) {
    return db.prepare(`
      SELECT id, template_id, day_index, location_id, start_time, end_time, notes, note_color, is_off
      FROM template_pattern_days
      WHERE template_id = ?
      ORDER BY day_index
    `).all(templateId)
  }

  return db.prepare(`
    SELECT id, template_id, day_of_week, day_of_week AS day_index,
           location_id, start_time, end_time, notes, note_color, is_off
    FROM template_days
    WHERE template_id = ?
    ORDER BY day_of_week
  `).all(templateId)
}

function loadAllTemplateDays(db) {
  const byTemplate = {}

  const weeklyDays = db.prepare(`
    SELECT id, template_id, day_of_week, day_of_week AS day_index,
           location_id, start_time, end_time, notes, note_color, is_off
    FROM template_days
    ORDER BY day_of_week
  `).all()
  weeklyDays.forEach(day => {
    if (!byTemplate[day.template_id]) byTemplate[day.template_id] = []
    byTemplate[day.template_id].push(day)
  })

  const hasPatternTable = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'template_pattern_days'
  `).get()

  if (hasPatternTable) {
    const patternDays = db.prepare(`
      SELECT id, template_id, day_index, location_id, start_time, end_time, notes, note_color, is_off
      FROM template_pattern_days
      ORDER BY day_index
    `).all()
    patternDays.forEach(day => {
      if (!byTemplate[day.template_id]) byTemplate[day.template_id] = []
      byTemplate[day.template_id].push(day)
    })
  }

  return byTemplate
}

function sanitizeTemplateDays(templateType, cycleLength, days) {
  if (!Array.isArray(days)) return []

  const normalizedType = normalizeTemplateType(templateType)
  const maxIndex = normalizedType === PATTERN_TEMPLATE_TYPE ? cycleLength - 1 : 6
  const fieldName = normalizedType === PATTERN_TEMPLATE_TYPE ? 'day_index' : 'day_of_week'
  const seen = new Set()

  return days.map(day => {
    const rawIndex = day?.[fieldName] ?? day?.day_index ?? day?.day_of_week
    const index = Number.parseInt(rawIndex, 10)
    if (!Number.isInteger(index) || index < 0 || index > maxIndex) {
      throw new Error(
        normalizedType === PATTERN_TEMPLATE_TYPE
          ? `Pattern days must be between Day 1 and Day ${cycleLength}.`
          : 'Template days must be between Monday and Sunday.'
      )
    }
    if (seen.has(index)) {
      throw new Error(
        normalizedType === PATTERN_TEMPLATE_TYPE
          ? `Day ${index + 1} appears more than once in this pattern.`
          : 'A weekday can only appear once in a weekly template.'
      )
    }
    seen.add(index)

    return {
      index,
      location_id: day.location_id || null,
      start_time: day.start_time || null,
      end_time: day.end_time || null,
      notes: typeof day.notes === 'string' ? day.notes.trim() || null : null,
      note_color: resolveStoredColor(day.note_color, DEFAULT_NOTE_COLOR),
      is_off: day.is_off ? 1 : 0,
    }
  })
}

module.exports = {
  MAX_PATTERN_CYCLE_LENGTH,
  PATTERN_TEMPLATE_TYPE,
  WEEKLY_TEMPLATE_TYPE,
  loadAllTemplateDays,
  loadTemplateDays,
  normalizeCycleLength,
  normalizeTemplateType,
  sanitizeTemplateDays,
}
