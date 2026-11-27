'use strict';

/**
 * 2.22.0: the option rules of the Travel Information fields (json/fields.json → lead → travel_information),
 * for a client Travel Requirement saved before its trip lead exists (the CRM checks the same rules when the
 * values are later saved on the lead). The api/ sandbox cannot read json/, so the rules are mirrored here;
 * tests/client-requirement.test.js keeps this mirror equal to json/fields.json.
 */

const OPTION_FIELDS = Object.freeze([
  { key: 'from', label: 'From', setting: 'from_places', listLabel: 'From Locations' },
  { key: 'to', label: 'To', setting: 'to_places', listLabel: 'To Locations' },
  { key: 'date_flexibility', label: 'Date Flexibility', options: ['Fixed', '±1 Day', '±2 Days', '±3 Days', 'Flexible'] }
]);

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

/**
 * Checks the option fields of `values` and writes back the list's own spelling (a name typed in another
 * letter case is the same place) → errors (empty when fine).
 */
async function checkOptions(sdk, values) {
  const errors = [];
  for (const field of OPTION_FIELDS) {
    const value = str(values[field.key]);
    if (!value) continue;
    const list = field.setting ? await sdk.settings.get(field.setting) : field.options;
    const allowed = (Array.isArray(list) ? list : []).map(str).filter(Boolean);
    const match = allowed.find((v) => v === value) || allowed.find((v) => v.toLowerCase() === value.toLowerCase());
    if (!match) {
      errors.push(field.setting
        ? `${field.label}: "${value}" is not in the ${field.listLabel} list (Settings → Travel). Choose one from the list.`
        : `${field.label} must be one of the options.`);
    } else {
      values[field.key] = match;
    }
  }
  return errors;
}

module.exports = { OPTION_FIELDS, checkOptions };
