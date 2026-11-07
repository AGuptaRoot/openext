'use strict';

/**
 * Type-ahead suggestions for the text fields of the Travel Requirement forms.
 *
 * Each text field keeps its own list of values (FieldSuggestion, one row per field key + value): every
 * value saved on a requirement is added (or counted again), and a user can add a new value from the
 * form ("Add …"). Fields with the same key share one list (the From city of a domestic and an
 * international flight). Text fields that hold personal details (phone, email, passport, Aadhaar,
 * address, a person's name) never get a shared list, so one customer's details never surface on
 * another lead.
 */

const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
// Personal details: never shared between leads.
const PERSONAL_RE = /(phone|mobile|whats_?app|e_?mail|passport|aadhaar|aadhar|\bpan\b|pan_no|pan_number|address|dob|birth|(guest|traveller|traveler|passenger|contact|customer|person|lead|client)_?name|^name$)/i;
const MAX_VALUE = 120;
const MAX_LIST = 500;

const str = (v) => (v === null || v === undefined ? '' : String(v));
const clean = (v) => str(v).replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);

/** True for a text field whose values may be suggested on other requirements. */
function suggestible(field) {
  if (!field || field.type !== 'text' || field.internal) return false;
  const key = str(field.key);
  if (!KEY_RE.test(key)) return false;
  return !PERSONAL_RE.test(key) && !PERSONAL_RE.test(str(field.label).replace(/\s+/g, '_'));
}

/** The suggestible text field with this key on any active service, or null. */
function findField(services, fieldKey) {
  const key = str(fieldKey);
  if (!KEY_RE.test(key)) return null;
  for (const service of services || []) {
    if (service.enabled === false) continue;
    const field = (service.fields || []).find((f) => f && f.key === key && f.enabled !== false);
    if (field && suggestible(field)) return field;
  }
  return null;
}

/** Adds a value to a field's list, or counts it once more. Returns the stored value. */
async function record(sdk, fieldKey, rawValue) {
  const value = clean(rawValue);
  if (!value || !KEY_RE.test(str(fieldKey))) return '';
  const fieldValue = `${fieldKey}:${value.toLowerCase()}`;
  const now = new Date().toISOString();
  const existing = await sdk.models.FieldSuggestion.findOne({ field_value: fieldValue });
  if (existing) {
    await sdk.models.FieldSuggestion.updateById(existing._id, { uses: (Number(existing.uses) || 0) + 1, last_used_at: now });
    return str(existing.value);
  }
  try {
    await sdk.models.FieldSuggestion.create({ field_key: fieldKey, value, field_value: fieldValue, uses: 1, last_used_at: now });
  } catch (error) {
    // Two saves at once: the other one created it.
    const again = await sdk.models.FieldSuggestion.findOne({ field_value: fieldValue });
    if (!again) throw error;
    return str(again.value);
  }
  return value;
}

/** After a requirement is saved: its text values join their fields' lists. Never throws. */
async function recordFromValues(sdk, service, values) {
  try {
    const data = values && typeof values === 'object' ? values : {};
    for (const field of (service && service.fields) || []) {
      if (!suggestible(field)) continue;
      const value = clean(data[field.key]);
      if (value) await record(sdk, field.key, value);
    }
  } catch (error) {
    if (sdk.logger) sdk.logger.warn(`field suggestions not recorded: ${str(error && error.message)}`);
  }
}

/** Values of a field matching the typed text (most used first). */
async function search(sdk, fieldKey, query, limit = 15) {
  const q = clean(query).toLowerCase();
  const rows = await sdk.models.FieldSuggestion.find({ field_key: str(fieldKey) }, { limit: MAX_LIST, sort: { uses: -1 } });
  const values = [];
  for (const row of rows) {
    const value = str(row.value);
    if (!value || (q && !value.toLowerCase().includes(q))) continue;
    values.push(value);
    if (values.length >= limit) break;
  }
  // Starts-with first, then contains.
  if (q) values.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)));
  return values;
}

module.exports = { suggestible, findField, record, recordFromValues, search, clean, MAX_VALUE };
