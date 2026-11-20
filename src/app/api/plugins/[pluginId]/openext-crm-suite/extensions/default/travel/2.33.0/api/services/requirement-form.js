'use strict';

/**
 * Checks the values of one service's requirement form and works out the
 * requirement status on the server: "Complete" when every required field is
 * filled in, otherwise "Draft". Values for fields the form does not have are
 * dropped.
 *
 * A choice whose option was removed later in Services & Forms is dropped with a
 * warning (never a 400: the agent could not fix it otherwise). A date field with an
 * `after` rule cannot be before that other date of the form (afterStrict: must be after it, e.g.
 * check-out after check-in).
 *
 * 2.12.0: with the lead's trip (context.trip, api/services/trip-dates.js) dates must lie inside the
 * travel dates and nights / days cannot exceed the stay or the trip; a nights field left empty is
 * calculated from its two dates. `fieldErrors` gives each problem by field key.
 */

const { requirementTripCheck } = require('./trip-dates.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isEmpty(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function allowedValues(field) {
  return new Set((field.options || []).map((o) => o.value));
}

/** Returns { value } or { error } for one field; { value, dropped: [...] } when removed options were left out. */
function coerce(field, raw) {
  const label = field.label || field.key;
  if (raw === undefined || raw === null) return { value: field.type === 'checkbox' ? false : field.type === 'multiselect' ? [] : '' };
  switch (field.type) {
    case 'number': {
      if (raw === '') return { value: '' };
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${label} must be a number` };
      return { value: n };
    }
    case 'date': {
      const v = String(raw).trim();
      if (!v) return { value: '' };
      if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) return { error: `${label} must be a date (YYYY-MM-DD)` };
      return { value: v };
    }
    case 'select':
    case 'radio': {
      const v = String(raw).trim();
      if (!v) return { value: '' };
      // An option removed since it was saved: dropped (with a warning), so the form can still be saved.
      if (!allowedValues(field).has(v)) return { value: '', dropped: [v] };
      return { value: v };
    }
    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : [raw];
      const allowed = allowedValues(field);
      const out = [];
      const dropped = [];
      for (const item of list) {
        const v = String(item === undefined || item === null ? '' : item).trim();
        if (!v) continue;
        if (!allowed.has(v)) {
          if (!dropped.includes(v)) dropped.push(v);
          continue;
        }
        if (!out.includes(v)) out.push(v);
      }
      return dropped.length ? { value: out, dropped } : { value: out };
    }
    case 'checkbox':
      return { value: raw === true || raw === 'true' || raw === 1 || raw === '1' };
    case 'textarea':
      return { value: String(raw).trim().slice(0, 5000) };
    case 'text':
    default:
      return { value: String(raw).trim().slice(0, 500) };
  }
}

/**
 * @param {{ fields: object[] }} service  an active service (enabled fields only)
 * @param {object} input                  values sent by the browser
 * @param {{ trip?: { start, end, nights, days } }} context  the lead's trip (2.12.0)
 * @returns {{ values: object, missing: string[], errors: string[], fieldErrors: object, warnings: string[], status: 'Draft'|'Complete' }}
 */
function checkValues(service, input, context = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = Array.isArray(service && service.fields) ? service.fields : [];
  const values = {};
  const errors = [];
  const warnings = [];
  const missing = [];
  const fieldErrors = {};
  const fail = (key, message) => {
    errors.push(message);
    if (!fieldErrors[key]) fieldErrors[key] = message;
  };
  for (const field of fields) {
    const result = coerce(field, source[field.key]);
    if (result.error) {
      fail(field.key, result.error);
      continue;
    }
    values[field.key] = result.value;
    if (result.dropped) {
      const list = result.dropped.map((v) => `"${v}"`).join(', ');
      warnings.push(`${field.label || field.key}: ${list} ${result.dropped.length === 1 ? 'is' : 'are'} no longer offered and ${result.dropped.length === 1 ? 'was' : 'were'} removed`);
    }
  }
  for (const problem of dateOrderProblems(fields, values)) fail(problem.key, problem.message);
  if (context && context.trip) {
    const trip = requirementTripCheck(fields, values, context.trip);
    Object.assign(values, trip.auto);
    for (const problem of trip.errors) fail(problem.key, problem.message);
  }
  for (const field of fields) {
    if (!(field.key in values)) continue;
    const empty = field.type === 'checkbox' ? values[field.key] !== true : isEmpty(values[field.key]);
    if (field.required && empty) missing.push(field.label || field.key);
  }
  return { values, missing, errors, fieldErrors, warnings, status: missing.length ? 'Draft' : 'Complete' };
}

/** `after` rules: a date before the date it must follow (afterStrict: not after it), both filled in. */
function dateOrderProblems(fields, values) {
  const out = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const field of fields) {
    if (field.type !== 'date' || !field.after || !byKey.has(field.after)) continue;
    const mine = values[field.key];
    const other = values[field.after];
    if (!mine || !other || !DATE_RE.test(String(mine)) || !DATE_RE.test(String(other))) continue;
    const before = byKey.get(field.after);
    const otherLabel = (before && before.label) || field.after;
    if (field.afterStrict === true && String(mine) <= String(other)) {
      out.push({ key: field.key, message: `${field.label || field.key} must be after ${otherLabel}.` });
    } else if (String(mine) < String(other)) {
      out.push({ key: field.key, message: `${field.label || field.key} cannot be before ${otherLabel}` });
    }
  }
  return out;
}

function dateOrderErrors(fields, values) {
  return dateOrderProblems(fields, values).map((p) => p.message);
}

/** Draft / Complete of saved values against a (possibly changed) form, without changing them. */
function statusOf(service, savedValues) {
  return checkValues(service, savedValues).missing.length ? 'Draft' : 'Complete';
}

module.exports = { checkValues, coerce, isEmpty, dateOrderErrors, statusOf };
