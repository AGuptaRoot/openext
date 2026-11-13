'use strict';

/**
 * Travel services and their requirement forms (stored in the extension
 * setting "services"). Cleans and checks a services list before it is saved,
 * and gives the enabled services for the Travel Requirement tab.
 */

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'radio', 'multiselect', 'checkbox', 'searchable_select'];
const CHOICE_TYPES = ['select', 'radio', 'multiselect', 'searchable_select'];
const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_SERVICES = 50;
const MAX_FIELDS = 80;
const MAX_OPTIONS = 100;
// T1: the document a confirmed service gets, and how its requirement shows on the day plan.
const VOUCHER_TYPES = ['hotel', 'transport', 'excursion', 'ticket', 'none'];
const ITINERARY_KINDS = ['stay', 'travel', 'transfer', 'activity', 'none']; // '' = automatic (by key)
const TIME_FIELD_TYPES = ['text', 'select', 'radio', 'searchable_select'];
// 2.1.0: quotation line group of a service (manifest salesFlow.quotationLineGroups); '' = automatic.
const QUOTATION_GROUPS = ['flights', 'hotel', 'transfers', 'activities', 'visa', 'insurance', 'other'];
// A date field with no `after` saved yet: the date it cannot be before, by key (first one the form has).
// An admin can clear it (after: '') in Services & Forms.
const DEFAULT_AFTER = {
  check_out_date: ['check_in_date'],
  return_date: ['departure_date', 'journey_date', 'pickup_date'],
  end_date: ['start_date']
};
// 2.12.0 trip rules (api/services/trip-dates.js), each with a default by key that an admin can change:
// a date field is inside the lead's travel dates unless it is not a trip date (birth, expiry, issue,
// appointment, booking, deadline …); a check-out must be strictly after its check-in.
const DATE_CONSTRAINTS = ['lead_travel_range', 'none'];
const NOT_TRIP_DATE_RE = /(birth|dob|expir|issue|appointment|booking|deadline|submission|application|valid)/;
const STRICT_AFTER_RE = /check_?out/;
// Number fields: nights / days of the stay or of the whole trip.
const TRIP_LIMITS = ['nights', 'days', 'none'];
const NIGHTS_RE = /night/;
const DAYS_RE = /(^|_)days?$/;

/**
 * Voucher type of a service when none is saved, by its key: hotel → hotel; transport / rent_a_cab /
 * cab / transfer → transport; excursion → excursion; air / rail / bus / flight / train → ticket; else none.
 */
function defaultVoucherType(key) {
  const k = String(key || '').toLowerCase();
  if (/hotel/.test(k)) return 'hotel';
  if (/transport|(^|_)cab(_|$)|transfer/.test(k)) return 'transport';
  if (/excursion/.test(k)) return 'excursion';
  if (/(^|_)(air|rail|railway|bus|flight|train)(_|$)/.test(k)) return 'ticket';
  return 'none';
}

/**
 * Quotation line group of a service: its saved quotationGroup, else by key (visa, insurance), else by its
 * day-plan kind (saved or automatic): travel → flights, stay → hotel, transfer → transfers,
 * activity → activities; anything else → other.
 */
function quotationGroupOf(service) {
  const s = service || {};
  if (QUOTATION_GROUPS.includes(s.quotationGroup)) return s.quotationGroup;
  const k = String(s.key || '').toLowerCase();
  if (/visa/.test(k)) return 'visa';
  if (/insurance/.test(k)) return 'insurance';
  // Loaded here: itinerary.js does not depend on this file.
  const kind = require('./itinerary.js').itinerarySettings({ ...s, fields: s.fields || [] }).kind;
  return { travel: 'flights', stay: 'hotel', transfer: 'transfers', activity: 'activities' }[kind] || 'other';
}

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function slug(value) {
  return text(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 63);
}

function cleanKey(raw, label, fallback) {
  const direct = text(raw, 63);
  if (KEY_RE.test(direct)) return direct;
  const fromRaw = slug(raw);
  if (KEY_RE.test(fromRaw)) return fromRaw;
  const fromLabel = slug(label);
  if (KEY_RE.test(fromLabel)) return fromLabel;
  return fallback;
}

function order(value, index) {
  const n = Number(value);
  return Number.isFinite(n) ? n : (index + 1) * 10;
}

function sortByOrder(list) {
  return list.slice().sort((a, b) => a.order - b.order);
}

function cleanOptions(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const isObj = item && typeof item === 'object';
    const value = text(isObj ? item.value || item.label : item, 200);
    const label = text(isObj ? item.label || item.value : item, 200);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ label: label || value, value });
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

function cleanField(raw, index, serviceName, errors) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const label = text(source.label, 120);
  const type = FIELD_TYPES.includes(source.type) ? source.type : 'text';
  const field = {
    key: cleanKey(source.key, label, `field_${index + 1}`),
    label,
    type,
    required: source.required === true,
    placeholder: text(source.placeholder, 200),
    helpText: text(source.helpText, 300),
    options: CHOICE_TYPES.includes(type) ? cleanOptions(source.options) : [],
    order: order(source.order, index),
    enabled: source.enabled !== false,
    // Never printed on a voucher (read by the voucher builder, api/services/booking-store.js).
    hideOnVoucher: source.hideOnVoucher === true
  };
  // Searchable combobox and optionsFrom support
  if (source.type === 'searchable_select' || source.searchable === true) {
    field.searchable = true;
  }
  if (source.optionsFrom) {
    field.optionsFrom = typeof source.optionsFrom === 'string' ? text(source.optionsFrom, 100) : source.optionsFrom;
  }
  // Date order rule, checked against the form's other date fields in normalizeServices
  // (minField / endAfterField are accepted as other names of `after`).
  if (type === 'date') {
    const after = source.after !== undefined && source.after !== null ? source.after : source.minField !== undefined && source.minField !== null ? source.minField : source.endAfterField;
    field.after = after === undefined || after === null ? undefined : text(after, 63);
    field.afterStrict = source.afterStrict === undefined || source.afterStrict === null ? undefined : source.afterStrict === true;
    field.dateConstraint = DATE_CONSTRAINTS.includes(source.dateConstraint) ? source.dateConstraint : undefined;
  }
  // Nights between two dates of the form, or at most the trip's nights / days (resolved in normalizeServices).
  if (type === 'number') {
    field.nightsFrom = source.nightsFrom === undefined || source.nightsFrom === null ? undefined : text(source.nightsFrom, 63);
    field.nightsTo = source.nightsTo === undefined || source.nightsTo === null ? undefined : text(source.nightsTo, 63);
    field.tripLimit = TRIP_LIMITS.includes(source.tripLimit) ? source.tripLimit : undefined;
  }
  if (!label) errors.push(`${serviceName}: every field needs a label`);
  if (CHOICE_TYPES.includes(type) && !field.options.length && !field.optionsFrom) {
    errors.push(`${serviceName} → ${label || 'field'}: add at least one option`);
  }
  return field;
}

/**
 * Clean a services list. Returns the cleaned list and every problem found;
 * the list is only safe to save when `errors` is empty.
 */
function normalizeServices(input) {
  const errors = [];
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_SERVICES) errors.push(`At most ${MAX_SERVICES} services are allowed`);
  const serviceKeys = new Set();
  const services = list.slice(0, MAX_SERVICES).map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const name = text(source.name, 120);
    const label = name || `Service ${index + 1}`;
    if (!name) errors.push('Every service needs a name');
    const key = cleanKey(source.key, name, `service_${index + 1}`);
    if (serviceKeys.has(key)) errors.push(`Duplicate service key "${key}"`);
    serviceKeys.add(key);

    const rawFields = Array.isArray(source.fields) ? source.fields : [];
    if (rawFields.length > MAX_FIELDS) errors.push(`${label}: at most ${MAX_FIELDS} fields are allowed`);
    const fieldKeys = new Set();
    const fields = rawFields.slice(0, MAX_FIELDS).map((f, i) => {
      const field = cleanField(f, i, label, errors);
      if (fieldKeys.has(field.key)) errors.push(`${label}: duplicate field key "${field.key}"`);
      fieldKeys.add(field.key);
      return field;
    });
    const dateKeys = new Set(fields.filter((f) => f.type === 'date').map((f) => f.key));
    for (const field of fields) {
      if (field.type !== 'date') continue;
      if (field.after === undefined) field.after = (DEFAULT_AFTER[field.key] || []).find((k) => dateKeys.has(k)) || '';
      if (field.after === field.key || !dateKeys.has(field.after)) field.after = '';
      if (field.afterStrict === undefined) field.afterStrict = STRICT_AFTER_RE.test(field.key);
      if (!field.after) field.afterStrict = false;
      if (field.dateConstraint === undefined) field.dateConstraint = NOT_TRIP_DATE_RE.test(field.key) ? 'none' : 'lead_travel_range';
    }
    for (const field of fields) {
      if (field.type !== 'number') continue;
      if (field.nightsFrom === undefined && field.nightsTo === undefined) {
        // A nights field of a form with a check-in / check-out style pair counts that stay.
        const pair = NIGHTS_RE.test(field.key) ? fields.find((f) => f.type === 'date' && f.after && f.afterStrict) : null;
        field.nightsFrom = pair ? pair.after : '';
        field.nightsTo = pair ? pair.key : '';
      }
      if (!dateKeys.has(field.nightsFrom) || !dateKeys.has(field.nightsTo) || field.nightsFrom === field.nightsTo) {
        field.nightsFrom = '';
        field.nightsTo = '';
      }
      if (field.tripLimit === undefined) field.tripLimit = NIGHTS_RE.test(field.key) ? 'nights' : DAYS_RE.test(field.key) ? 'days' : 'none';
    }
    // Day-plan fields must be fields of this form: start / end are date fields (end ≠ start),
    // time is a text / select / radio field. Anything else is cleared ('' = automatic).
    const keyOfType = (raw, types) => {
      const k = text(raw, 63);
      return k && fields.some((f) => f.key === k && types.includes(f.type)) ? k : '';
    };
    const itineraryStartField = keyOfType(source.itineraryStartField, ['date']);
    let itineraryEndField = keyOfType(source.itineraryEndField, ['date']);
    if (itineraryEndField && itineraryEndField === itineraryStartField) itineraryEndField = '';
    const enabled = source.enabled !== false;
    // A service without a single field can never be filled in: switch it off or add a field.
    if (enabled && !fields.some((f) => f.enabled && f.label)) errors.push(`${label}: add at least one field, or switch the service off`);

    return {
      key,
      name,
      description: text(source.description, 300),
      enabled,
      // Travellers of a lead with this service need passport details (number, expiry, country).
      requiresPassport: source.requiresPassport === true,
      // Quotation lines: per_person (Adult / Child / Infant lines), per_room_night, per_unit.
      pricing: ['per_person', 'per_room_night', 'per_unit'].includes(source.pricing) ? source.pricing : 'per_unit',
      // GST % a quotation line of this service starts with (0–100, default 18).
      // T1: voucher document type (default by key) and whether quoting needs an availability check.
      voucherType: VOUCHER_TYPES.includes(source.voucherType) ? source.voucherType : defaultVoucherType(key),
      availabilityRequired: source.availabilityRequired !== false,
      // T10: day-plan settings; '' = automatic (api/services/itinerary.js decides by key / field names).
      itineraryKind: ITINERARY_KINDS.includes(source.itineraryKind) ? source.itineraryKind : '',
      itineraryStartField,
      itineraryEndField,
      itineraryTimeField: keyOfType(source.itineraryTimeField, TIME_FIELD_TYPES),
      // 2.1.0: group of its quotation lines ('' = automatic, quotationGroupOf).
      quotationGroup: QUOTATION_GROUPS.includes(source.quotationGroup) ? source.quotationGroup : '',
      taxRate: Number.isFinite(Number(source.taxRate)) && source.taxRate !== '' && source.taxRate !== null && Number(source.taxRate) >= 0 && Number(source.taxRate) <= 100 ? Number(source.taxRate) : 18,
      order: order(source.order, index),
      fields: sortByOrder(fields)
    };
  });
  return { services: sortByOrder(services), errors: [...new Set(errors)] };
}

/** Saved services as a clean list (problems are ignored when reading). */
async function readServices(sdk) {
  return normalizeServices(await sdk.settings.get('services')).services;
}

/** One enabled service with only its enabled fields, or null. */
function activeService(services, key) {
  const service = services.find((s) => s.key === key && s.enabled !== false);
  if (!service) return null;
  return { ...service, fields: service.fields.filter((f) => f.enabled !== false && f.label) };
}

module.exports = { DATE_CONSTRAINTS, TRIP_LIMITS, FIELD_TYPES, CHOICE_TYPES, VOUCHER_TYPES, ITINERARY_KINDS, QUOTATION_GROUPS, quotationGroupOf, defaultVoucherType, normalizeServices, readServices, activeService, sortByOrder };
