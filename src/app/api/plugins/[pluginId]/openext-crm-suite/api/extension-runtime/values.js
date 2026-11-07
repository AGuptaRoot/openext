'use strict';

/**
 * Value and query hygiene for the extension runtime.
 *
 * Everything an extension hands to the CRM (filters, documents, response
 * bodies) passes through here first:
 *   - `cloneJson` copies into this realm as plain JSON. That strips functions,
 *     getters, prototypes and objects created inside the extension's vm
 *     context, and caps the size.
 *   - `sanitizeFilter` allows a small set of query operators and only
 *     declared field names, so `$where`, `$function`, `$expr` and friends
 *     never reach MongoDB.
 *   - `coerceDocument` converts values to the declared field types and
 *     rejects unknown keys.
 */

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_REGEX_LENGTH = 200;
const COMPARISON_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$options']);
const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor']);
const SYSTEM_FIELDS = new Set(['_id', 'createdAt', 'updatedAt']);
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function runtimeError(status, message, code, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code || (status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST');
  if (details) error.details = details;
  error.isRuntimeError = true;
  return error;
}

/** Plain JSON copy in this realm. Throws 413 when larger than `limit` bytes. */
function cloneJson(value, limit = MAX_JSON_BYTES, label = 'value') {
  if (value === undefined) return undefined;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw runtimeError(400, `${label} is not serialisable: ${error.message}`, 'NOT_SERIALISABLE');
  }
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw runtimeError(413, `${label} is larger than ${Math.round(limit / 1024)} KB`, 'PAYLOAD_TOO_LARGE');
  }
  return JSON.parse(text);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ filters */

/**
 * @param {object} filter            caller's filter (any realm)
 * @param {(key: string) => boolean} isAllowedField
 * @param {number} depth
 */
function sanitizeFilter(filter, isAllowedField, depth = 0) {
  if (filter === undefined || filter === null) return {};
  const source = depth === 0 ? cloneJson(filter, 64 * 1024, 'filter') : filter;
  if (!isPlainObject(source)) throw runtimeError(400, 'filter must be an object', 'INVALID_FILTER');
  if (depth > 4) throw runtimeError(400, 'filter is nested too deeply', 'INVALID_FILTER');

  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (LOGICAL_OPERATORS.has(key)) {
      if (!Array.isArray(value) || !value.length || value.length > 20) {
        throw runtimeError(400, `${key} must be a list of 1–20 filters`, 'INVALID_FILTER');
      }
      out[key] = value.map((item) => sanitizeFilter(item, isAllowedField, depth + 1));
      continue;
    }
    if (key.startsWith('$')) throw runtimeError(400, `operator ${key} is not allowed here`, 'INVALID_FILTER');
    if (!isAllowedField(key)) throw runtimeError(400, `cannot filter on "${key}"`, 'INVALID_FILTER');
    out[key] = sanitizeCondition(key, value);
  }
  return out;
}

function sanitizeCondition(key, value) {
  if (!isPlainObject(value)) {
    if (Array.isArray(value)) return { $in: value.slice(0, 500) };
    return value;
  }
  const out = {};
  for (const [op, operand] of Object.entries(value)) {
    if (!COMPARISON_OPERATORS.has(op)) {
      throw runtimeError(400, `operator ${op} is not allowed (on "${key}")`, 'INVALID_FILTER');
    }
    if ((op === '$in' || op === '$nin') && (!Array.isArray(operand) || operand.length > 500)) {
      throw runtimeError(400, `${op} on "${key}" must be a list of up to 500 values`, 'INVALID_FILTER');
    }
    if (op === '$regex') {
      if (typeof operand !== 'string' || operand.length > MAX_REGEX_LENGTH) {
        throw runtimeError(400, `$regex on "${key}" must be a string of up to ${MAX_REGEX_LENGTH} characters`, 'INVALID_FILTER');
      }
    }
    if (op === '$options' && !/^[imsx]{0,4}$/.test(String(operand))) {
      throw runtimeError(400, `$options on "${key}" is invalid`, 'INVALID_FILTER');
    }
    if (op !== '$in' && op !== '$nin' && isPlainObject(operand)) {
      throw runtimeError(400, `${op} on "${key}" cannot take an object`, 'INVALID_FILTER');
    }
    out[op] = operand;
  }
  return out;
}

/** `{ field: 1 | -1 }` or `"field"` / `"-field"`; only allowed fields. */
function sanitizeSort(sort, isAllowedField) {
  if (!sort) return undefined;
  const entries = typeof sort === 'string'
    ? sort.split(',').map((part) => part.trim()).filter(Boolean).map((part) => (part.startsWith('-') ? [part.slice(1), -1] : [part, 1]))
    : isPlainObject(sort)
      ? Object.entries(sort).map(([k, v]) => [k, Number(v) < 0 ? -1 : 1])
      : null;
  if (!entries) throw runtimeError(400, 'sort must be an object or a string', 'INVALID_SORT');
  const out = {};
  for (const [key, dir] of entries.slice(0, 3)) {
    if (!isAllowedField(key)) throw runtimeError(400, `cannot sort on "${key}"`, 'INVALID_SORT');
    out[key] = dir;
  }
  return out;
}

function clampLimit(limit, fallback = 50, max = 500) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function clampSkip(skip) {
  const n = Number(skip);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100000) : 0;
}

/* --------------------------------------------------------------- documents */

function isEmpty(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}

/** Convert one value to the field's declared type; returns { value } or { error }. */
function coerceValue(field, raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { value: field.type === 'checkbox' ? false : field.type === 'multiselect' ? [] : null };
  }
  const options = new Set((field.options || []).map((o) => o.value));
  switch (field.type) {
    case 'number':
    case 'currency': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${field.key} must be a number` };
      if (field.min !== undefined && field.min !== null && n < field.min) return { error: `${field.key} must be at least ${field.min}` };
      if (field.max !== undefined && field.max !== null && n > field.max) return { error: `${field.key} must be at most ${field.max}` };
      return { value: n };
    }
    case 'checkbox':
      return { value: raw === true || raw === 'true' || raw === 1 || raw === '1' };
    case 'date': {
      const text = String(raw).slice(0, 30);
      if (Number.isNaN(Date.parse(text))) return { error: `${field.key} must be a date (YYYY-MM-DD)` };
      return { value: /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date(text).toISOString() };
    }
    case 'select':
    case 'radio': {
      const v = String(raw);
      if (options.size && !options.has(v)) return { error: `${field.key} must be one of ${[...options].join(', ')}` };
      return { value: v };
    }
    case 'multiselect': {
      const list = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v));
      const bad = list.filter((v) => options.size && !options.has(v));
      if (bad.length) return { error: `${field.key} has values that are not options: ${bad.join(', ')}` };
      return { value: [...new Set(list)].slice(0, 100) };
    }
    case 'json':
      return { value: cloneJson(raw, 64 * 1024, field.key) };
    case 'ref':
    case 'user':
      return { value: String(raw).slice(0, 64) };
    case 'textarea':
      return { value: String(raw).slice(0, 20000) };
    default:
      return { value: String(raw).slice(0, 2000) };
  }
}

/**
 * Coerce a whole document against declared fields.
 * @param {object} raw
 * @param {Array} fields  declared model fields
 * @param {{ partial: boolean }} options  partial = PATCH (only given keys)
 */
function coerceDocument(raw, fields, { partial = false } = {}) {
  const source = cloneJson(raw === undefined ? {} : raw, 256 * 1024, 'document');
  if (!isPlainObject(source)) throw runtimeError(400, 'document must be an object', 'INVALID_DOCUMENT');
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const errors = [];
  const out = {};

  for (const [key, value] of Object.entries(source)) {
    if (SYSTEM_FIELDS.has(key) || key === 'id') continue; // ignored, never written
    const field = byKey.get(key);
    if (!field) {
      errors.push(`unknown field "${key}"`);
      continue;
    }
    const result = coerceValue(field, value);
    if (result.error) errors.push(result.error);
    else out[key] = result.value;
  }

  if (!partial) {
    for (const field of fields) {
      if (out[field.key] === undefined && field.default !== undefined) {
        const result = coerceValue(field, field.default === 'today' ? new Date().toISOString().slice(0, 10) : field.default);
        if (!result.error) out[field.key] = result.value;
      }
    }
  }
  for (const field of fields) {
    if (!field.required) continue;
    const given = Object.prototype.hasOwnProperty.call(out, field.key);
    if (partial ? given && isEmpty(out[field.key]) : isEmpty(out[field.key])) {
      errors.push(`${field.key} is required`);
    }
  }
  if (errors.length) throw runtimeError(400, `Invalid ${partial ? 'update' : 'document'}: ${errors.join('; ')}`, 'INVALID_DOCUMENT', errors);
  return out;
}

module.exports = {
  MAX_JSON_BYTES,
  OBJECT_ID_RE,
  SYSTEM_FIELDS,
  runtimeError,
  cloneJson,
  isPlainObject,
  sanitizeFilter,
  sanitizeSort,
  clampLimit,
  clampSkip,
  coerceValue,
  coerceDocument
};
