'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength
} = require('./common.util');

const FIELD_TYPES = ['text', 'number', 'select', 'radio', 'multiselect'];

function slugifyKey(value, fallback = 'field') {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
  return base || fallback;
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOption(raw, index) {
  const source = asObject(raw);
  const label = trimString(source.label) || trimString(source.value) || `Option ${index + 1}`;
  const value = trimString(source.value) || label;
  return {
    id: trimString(source.id) || makeId(`opt_${index}`),
    label: label.slice(0, 120),
    value: value.slice(0, 120)
  };
}

function normalizeField(raw, index, usedKeys) {
  const source = asObject(raw);
  const label = trimString(source.label) || `Field ${index + 1}`;
  let key = slugifyKey(source.key || label, `field_${index + 1}`);
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${slugifyKey(source.key || label, `field_${index + 1}`)}_${suffix}`;
    suffix += 1;
  }
  usedKeys.add(key);

  let type = String(source.type || 'text').trim().toLowerCase();
  if (!FIELD_TYPES.includes(type)) type = 'text';

  const needsOptions = type === 'select' || type === 'radio' || type === 'multiselect';
  const options = needsOptions
    ? (Array.isArray(source.options) ? source.options : []).map(normalizeOption)
    : [];

  const matchValues = Array.isArray(source.matchValues)
    ? source.matchValues.map((v) => String(v || '').trim()).filter(Boolean)
    : [];

  const minRaw = source.matchNumberMin;
  const maxRaw = source.matchNumberMax;
  const matchNumberMin =
    minRaw === '' || minRaw === undefined || minRaw === null ? null : Number(minRaw);
  const matchNumberMax =
    maxRaw === '' || maxRaw === undefined || maxRaw === null ? null : Number(maxRaw);

  return {
    id: trimString(source.id) || makeId(`fld_${index}`),
    key,
    label: label.slice(0, 120),
    type,
    required: Boolean(source.required),
    placeholder: trimString(source.placeholder).slice(0, 200),
    helpText: trimString(source.helpText).slice(0, 500),
    options,
    matchValues,
    matchNumberMin: Number.isFinite(matchNumberMin) ? matchNumberMin : null,
    matchNumberMax: Number.isFinite(matchNumberMax) ? matchNumberMax : null,
    matchEnabled: source.matchEnabled !== false
  };
}

function validateFields(fields) {
  const errors = [];
  const list = Array.isArray(fields) ? fields : [];
  const usedKeys = new Set();
  const normalized = list.map((item, index) => normalizeField(item, index, usedKeys));

  for (const field of normalized) {
    if (!field.label) errors.push('Every field needs a label');
    if (!field.key) errors.push('Every field needs a unique key');
    if (
      (field.type === 'select' || field.type === 'radio' || field.type === 'multiselect') &&
      field.options.length < 1
    ) {
      errors.push(`Field "${field.label}" needs at least one option`);
    }
  }

  return { errors, fields: normalized };
}

function validateRequestTypeCreate(body) {
  const source = asObject(body);
  const errors = [];
  const name = trimString(source.name);
  assertRequired(errors, name, 'Request type name');
  assertMaxLength(errors, name, 120, 'Request type name');

  const key = slugifyKey(source.key || name, 'request_type');
  assertRequired(errors, key, 'Request type key');
  assertMaxLength(errors, key, 80, 'Request type key');

  const { errors: fieldErrors, fields } = validateFields(source.fields);
  errors.push(...fieldErrors);

  if (errors.length) return fail(errors);
  return ok({
    name,
    key,
    description: trimString(source.description).slice(0, 500),
    isEnabled: source.isEnabled !== false,
    fields,
    sortOrder: Number.isFinite(Number(source.sortOrder)) ? Number(source.sortOrder) : 0
  });
}

function validateRequestTypeUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.name !== undefined) {
    value.name = trimString(source.name);
    assertRequired(errors, value.name, 'Request type name');
    assertMaxLength(errors, value.name, 120, 'Request type name');
  }
  if (source.description !== undefined) {
    value.description = trimString(source.description).slice(0, 500);
  }
  if (source.isEnabled !== undefined) {
    value.isEnabled = Boolean(source.isEnabled);
  }
  if (source.sortOrder !== undefined) {
    value.sortOrder = Number.isFinite(Number(source.sortOrder)) ? Number(source.sortOrder) : 0;
  }
  if (source.fields !== undefined) {
    const { errors: fieldErrors, fields } = validateFields(source.fields);
    errors.push(...fieldErrors);
    value.fields = fields;
  }

  if (errors.length) return fail(errors);
  if (!Object.keys(value).length) return fail(['No request type fields to update']);
  return ok(value);
}

module.exports = {
  FIELD_TYPES,
  slugifyKey,
  makeId,
  validateFields,
  validateRequestTypeCreate,
  validateRequestTypeUpdate
};
