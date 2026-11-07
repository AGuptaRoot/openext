'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength
} = require('./common.util');

const STAGE_TYPES = [
  'OPEN',
  'SAMPLE_SENT',
  'SAMPLE_APPROVED',
  'QUOTATION_SENT',
  'NEGOTIATION',
  'QUOTATION_ACCEPTED',
  'WON',
  'LOST'
];

const DEFAULT_STAGE_CATALOG = [
  { label: 'Sample Sent', type: 'SAMPLE_SENT', probability: 45 },
  { label: 'Sample Approved', type: 'SAMPLE_APPROVED', probability: 55 },
  { label: 'Quotation Sent', type: 'QUOTATION_SENT', probability: 95 },
  { label: 'Quotation Accepted', type: 'QUOTATION_ACCEPTED', probability: 98 },
  { label: 'Won', type: 'WON', probability: 100 },
  { label: 'Negotiation', type: 'NEGOTIATION', probability: 85 },
  { label: 'Lost', type: 'LOST', probability: 0 }
];

function normalizeStageType(value) {
  const key = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return STAGE_TYPES.includes(key) ? key : 'OPEN';
}

function validateStages(stages, { quotationWorkflowEnabled = true } = {}) {
  const errors = [];
  const list = Array.isArray(stages) ? stages : [];

  if (list.length < 5) {
    errors.push('A pipeline must contain at least 5 stages');
  }

  const normalized = list.map((raw, index) => {
    const source = asObject(raw);
    const label = trimString(source.label) || trimString(source.name) || `Stage ${index + 1}`;
    const type = normalizeStageType(source.type);
    const probability = Number.isFinite(Number(source.probability))
      ? Math.min(100, Math.max(0, Math.round(Number(source.probability))))
      : type === 'WON'
        ? 100
        : type === 'LOST'
          ? 0
          : 50;
    const id =
      trimString(source.id) ||
      `stage_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
    return { id, label, type, probability };
  });

  const labels = new Set();
  for (const stage of normalized) {
    if (!stage.label) errors.push('Every stage needs a label');
    if (stage.label.length > 80) errors.push(`Stage label "${stage.label}" is too long`);
    const key = stage.label.toLowerCase();
    if (labels.has(key)) errors.push(`Duplicate stage label: ${stage.label}`);
    labels.add(key);
  }

  const types = new Set(normalized.map((s) => s.type));
  const hasOpenish = normalized.some((s) => s.type !== 'WON' && s.type !== 'LOST');
  if (!hasOpenish) errors.push('Pipeline must include at least one open/normal sales stage');

  if (!types.has('WON')) errors.push('Pipeline must include a Won stage (type WON)');
  if (!types.has('LOST')) errors.push('Pipeline must include a Lost stage (type LOST)');

  if (quotationWorkflowEnabled) {
    if (!types.has('QUOTATION_SENT')) {
      errors.push('Quotation workflow requires a Quotation Sent stage (type QUOTATION_SENT)');
    }
    if (!types.has('NEGOTIATION')) {
      errors.push('Quotation workflow requires a Negotiation stage (type NEGOTIATION)');
    }
  }

  return { errors, stages: normalized };
}

function validatePipelineCreate(body) {
  const source = asObject(body);
  const errors = [];
  const name = trimString(source.name);
  assertRequired(errors, name, 'Pipeline name');
  assertMaxLength(errors, name, 120, 'Pipeline name');

  const quotationWorkflowEnabled = source.quotationWorkflowEnabled !== false;
  const { errors: stageErrors, stages } = validateStages(source.stages, {
    quotationWorkflowEnabled
  });
  errors.push(...stageErrors);

  if (errors.length) return fail(errors);
  return ok({
    name,
    description: trimString(source.description) || '',
    quotationWorkflowEnabled,
    isEnabled: source.isEnabled !== false,
    stages
  });
}

function validatePipelineUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.name !== undefined) {
    value.name = trimString(source.name);
    assertRequired(errors, value.name, 'Pipeline name');
    assertMaxLength(errors, value.name, 120, 'Pipeline name');
  }
  if (source.description !== undefined) {
    value.description = trimString(source.description) || '';
  }
  if (source.quotationWorkflowEnabled !== undefined) {
    value.quotationWorkflowEnabled = Boolean(source.quotationWorkflowEnabled);
  }
  if (source.isEnabled !== undefined) {
    value.isEnabled = Boolean(source.isEnabled);
  }
  if (source.stages !== undefined) {
    const quotationWorkflowEnabled =
      source.quotationWorkflowEnabled !== undefined
        ? Boolean(source.quotationWorkflowEnabled)
        : true;
    const { errors: stageErrors, stages } = validateStages(source.stages, {
      quotationWorkflowEnabled:
        source.quotationWorkflowEnabled !== undefined
          ? quotationWorkflowEnabled
          : source._quotationWorkflowEnabled !== false
    });
    // Caller may pass existing flag via private hint; prefer explicit body field.
    errors.push(...stageErrors);
    value.stages = stages;
  }

  if (errors.length) return fail(errors);
  if (!Object.keys(value).length) return fail(['No pipeline fields to update']);
  return ok(value);
}

module.exports = {
  STAGE_TYPES,
  DEFAULT_STAGE_CATALOG,
  normalizeStageType,
  validateStages,
  validatePipelineCreate,
  validatePipelineUpdate
};
