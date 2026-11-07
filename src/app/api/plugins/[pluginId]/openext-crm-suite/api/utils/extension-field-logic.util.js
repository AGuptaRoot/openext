'use strict';

/**
 * Runtime logic of declared extension fields that is shared by every
 * extension (and mirrored in OpenNextCRMRefactor/src/utils/extensionFieldLogic.ts):
 *
 *   - optionsFrom: a choice field takes its options from one of the
 *     extension's own settings (a `list` of strings, or a `json` list of objects)
 *   - formula:     a read-only field computed from other fields of the record
 *
 * Nothing here knows about a specific extension.
 */

function str(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Options of a field for the current settings values.
 * @returns {Array<{ label: string, value: string }>}
 */
function resolveOptions(field, settingsValues) {
  if (!field || !field.optionsFrom) return Array.isArray(field && field.options) ? field.options : [];
  const settingKey = typeof field.optionsFrom === 'string' ? field.optionsFrom.replace(/^settings\./, '') : field.optionsFrom.setting;
  const source = settingsValues && settingKey ? settingsValues[settingKey] : undefined;
  const list = Array.isArray(source) ? source : [];
  const { value: valueKey, label: labelKey, enabledKey } = typeof field.optionsFrom === 'object' && field.optionsFrom !== null ? field.optionsFrom : {};
  const out = [];
  const seen = new Set();
  for (const item of list) {
    let value;
    let label;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if (enabledKey && item[enabledKey] === false) continue;
      value = str(valueKey ? item[valueKey] : item.value);
      label = str(labelKey ? item[labelKey] : item.label) || value;
    } else {
      value = str(item);
      label = value;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ label, value });
  }
  // Static options declared next to optionsFrom act as a fallback.
  if (!out.length && Array.isArray(field.options)) return field.options;
  return out;
}

function parseDate(value) {
  const text = str(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const date = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Value of one formula for the given values; null when inputs are missing. */
function evaluateFormula(formula, values) {
  if (!formula) return null;
  if (formula.op === 'sum') {
    let total = 0;
    let any = false;
    for (const key of formula.of) {
      const n = Number(values[key]);
      if (values[key] !== '' && values[key] !== null && values[key] !== undefined && Number.isFinite(n)) {
        total += n;
        any = true;
      }
    }
    return any ? total : null;
  }
  if (formula.op === 'days_between') {
    const from = parseDate(values[formula.from]);
    const to = parseDate(values[formula.to]);
    if (!from || !to) return null;
    // A negative difference (end before start) is no answer; the inclusive day is added only after.
    const diff = Math.round((to.getTime() - from.getTime()) / 86400000);
    if (diff < 0) return null;
    return diff + (formula.inclusive ? 1 : 0);
  }
  if (formula.op === 'month_of') {
    const date = parseDate(values[formula.of]);
    if (!date) return null;
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Compute every formula field.
 * @param {Iterable<object>} fields  declared fields of the record
 * @param {object} values            current values (stored merged with the update)
 * @returns {object}                 { [formulaFieldKey]: value | null }
 */
function computeFormulas(fields, values) {
  const out = {};
  for (const field of fields) {
    if (field && field.formula) out[field.key] = evaluateFormula(field.formula, values || {});
  }
  return out;
}

module.exports = { resolveOptions, evaluateFormula, computeFormulas };
