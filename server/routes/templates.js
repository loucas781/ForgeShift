'use strict'
const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db = require('../db/connection')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const audit = require('../audit')
const {
  MAX_PATTERN_CYCLE_LENGTH,
  PATTERN_TEMPLATE_TYPE,
  WEEKLY_TEMPLATE_TYPE,
  loadAllTemplateDays,
  loadTemplateDays,
  normalizeCycleLength,
  normalizeTemplateType,
  sanitizeTemplateDays,
} = require('../utils/template-utils')

function serializeTemplate(template) {
  const templateType = normalizeTemplateType(template.template_type)
  return {
    ...template,
    template_type: templateType,
    cycle_length: templateType === PATTERN_TEMPLATE_TYPE
      ? Number.parseInt(template.cycle_length, 10) || 7
      : 7,
  }
}

function upsertTemplateDays(templateId, templateType, days) {
  if (!Array.isArray(days) || !days.length) return

  if (normalizeTemplateType(templateType) === PATTERN_TEMPLATE_TYPE) {
    const insertPatternDay = db.prepare(`
      INSERT INTO template_pattern_days (
        id, template_id, day_index, location_id, start_time, end_time, notes, note_color, is_off
      )
      VALUES (?,?,?,?,?,?,?,?,?)
    `)
    days.forEach(day => {
      insertPatternDay.run(
        uuidv4(),
        templateId,
        day.index,
        day.location_id,
        day.start_time,
        day.end_time,
        day.notes,
        day.note_color,
        day.is_off
      )
    })
    return
  }

  const insertWeeklyDay = db.prepare(`
    INSERT INTO template_days (
      id, template_id, day_of_week, location_id, start_time, end_time, notes, note_color, is_off
    )
    VALUES (?,?,?,?,?,?,?,?,?)
  `)
  days.forEach(day => {
    insertWeeklyDay.run(
      uuidv4(),
      templateId,
      day.index,
      day.location_id,
      day.start_time,
      day.end_time,
      day.notes,
      day.note_color,
      day.is_off
    )
  })
}

function clearTemplateDays(templateId) {
  db.prepare('DELETE FROM template_days WHERE template_id = ?').run(templateId)
  db.prepare('DELETE FROM template_pattern_days WHERE template_id = ?').run(templateId)
}

function validateTemplatePayload(body) {
  const name = body.name?.trim()
  if (!name) return { error: 'Template name is required.' }

  const templateType = normalizeTemplateType(body.template_type)
  const cycleLength = normalizeCycleLength(templateType, body.cycle_length)
  if (cycleLength == null) {
    return {
      error: `Pattern templates must use between 1 and ${MAX_PATTERN_CYCLE_LENGTH} days.`,
    }
  }

  try {
    const days = sanitizeTemplateDays(templateType, cycleLength, body.days)
    return {
      name,
      description: body.description?.trim() || null,
      org_id: body.org_id || null,
      template_type: templateType,
      cycle_length: cycleLength,
      days_provided: Array.isArray(body.days),
      days,
    }
  } catch (err) {
    return { error: err.message }
  }
}

// ── GET /api/templates ────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  let templates

  if (req.user.role === 'admin') {
    templates = db.prepare(`
      SELECT t.*, u.name as created_by_name,
             o.name as org_name, o.id as org_id
      FROM shift_templates t
      LEFT JOIN users u ON u.id = t.created_by
      LEFT JOIN organisations o ON o.id = t.org_id
      ORDER BY o.name, t.name
    `).all()
  } else {
    templates = db.prepare(`
      SELECT t.*, u.name as created_by_name,
             o.name as org_name, o.id as org_id
      FROM shift_templates t
      LEFT JOIN users u ON u.id = t.created_by
      LEFT JOIN organisations o ON o.id = t.org_id
      WHERE t.org_id IS NULL
         OR t.org_id IN (SELECT org_id FROM organisation_members WHERE user_id = ?)
      ORDER BY o.name, t.name
    `).all(req.user.id)
  }

  const daysByTemplate = loadAllTemplateDays(db)
  res.json(templates.map(template => {
    const serialized = serializeTemplate(template)
    return { ...serialized, days: daysByTemplate[template.id] || [] }
  }))
})

// ── GET /api/templates/:id ────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const template = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id)
  if (!template) return res.status(404).json({ error: 'Template not found' })
  const serialized = serializeTemplate(template)
  const days = loadTemplateDays(db, req.params.id, serialized.template_type)
  res.json({ ...serialized, days })
})

// ── POST /api/templates ───────────────────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const payload = validateTemplatePayload(req.body)
    if (payload.error) return res.status(400).json({ error: payload.error })

    const id = uuidv4()
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO shift_templates (
          id, name, description, org_id, created_by, template_type, cycle_length
        )
        VALUES (?,?,?,?,?,?,?)
      `).run(
        id,
        payload.name,
        payload.description,
        payload.org_id,
        req.user.id,
        payload.template_type,
        payload.cycle_length
      )
      if (payload.days_provided) upsertTemplateDays(id, payload.template_type, payload.days)
    })
    tx()

    const template = serializeTemplate(db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(id))
    const days = loadTemplateDays(db, id, template.template_type)
    audit(req.user.id, 'template.create', 'template', id, payload.name)
    res.status(201).json({ ...template, days })
  } catch (err) {
    console.error('template create:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/templates/:id ────────────────────────────────────────────────────
router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Template not found' })

    const payload = validateTemplatePayload(req.body)
    if (payload.error) return res.status(400).json({ error: payload.error })

    const existingType = normalizeTemplateType(existing.template_type)
    const existingCycleLength = existingType === PATTERN_TEMPLATE_TYPE
      ? Number.parseInt(existing.cycle_length, 10) || 7
      : 7
    const needsDayRewrite = payload.days_provided
      || payload.template_type !== existingType
      || payload.cycle_length !== existingCycleLength
    if (needsDayRewrite && !payload.days_provided) {
      return res.status(400).json({ error: 'days must be provided when changing the template layout.' })
    }

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE shift_templates
        SET name = ?, description = ?, org_id = ?, template_type = ?, cycle_length = ?
        WHERE id = ?
      `).run(
        payload.name,
        payload.description,
        payload.org_id,
        payload.template_type,
        payload.cycle_length,
        req.params.id
      )

      if (payload.days_provided) {
        clearTemplateDays(req.params.id)
        upsertTemplateDays(req.params.id, payload.template_type, payload.days)
      }
    })
    tx()

    const updated = serializeTemplate(db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id))
    const days = loadTemplateDays(db, req.params.id, updated.template_type)
    audit(req.user.id, 'template.update', 'template', req.params.id, updated.name)
    res.json({ ...updated, days })
  } catch (err) {
    console.error('template update:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/templates/:id ─────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const template = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(req.params.id)
    if (!template) return res.status(404).json({ error: 'Template not found' })
    db.prepare('DELETE FROM shift_templates WHERE id = ?').run(req.params.id)
    audit(req.user.id, 'template.delete', 'template', req.params.id, template.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
