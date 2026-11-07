'use strict';

/**
 * Travel copies of saved CRM sales records (CRM 3.18.0 salesFlow.opportunityForm / quotationForm savedRoute).
 *
 *   POST /sales-flow/opportunity-saved  { opportunityId }  → TripPlan (one per opportunity)
 *   POST /sales-flow/quotation-saved    { quotationId }    → QuotationTravel (one per quotation version)
 *
 * The CRM calls these after it saved the record and its declared values. Only the id is taken from the
 * body: the record is read again through sdk.crm (tenant and permission checked) and its stored values
 * through sdk.values (body values are ignored). Idempotent (upsert by the record id); audited on
 * create. Logs never carry record data.
 */

const { utf8Bytes } = require('./itinerary.js');

const ID_RE = /^[a-f0-9]{24}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const GROUP_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_SNAPSHOT_BYTES = 60 * 1024;
const MAX_VALUES = 60;
const MAX_LINES = 200;

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function day(v) {
  const text = str(v).slice(0, 10);
  return ISO_DAY.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : '';
}

/** A number within [min, max], or null. */
function amount(v, min = 0, max = 1e12) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const count = (v) => {
  const n = amount(v, 0, 500);
  return n === null ? null : Math.floor(n);
};

const round2 = (n) => Math.round(n * 100) / 100;

function currencyOf(record) {
  const c = str(record && record.currency).toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'INR';
}

/** Declared values as a small JSON snapshot: scalars and short lists only, at most 60 KB. */
function snapshot(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_VALUES)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 5000);
    else if (Array.isArray(value)) out[key] = value.filter((v) => ['string', 'number'].includes(typeof v)).slice(0, 50).map((v) => (typeof v === 'string' ? v.slice(0, 200) : v));
  }
  // Long texts are the only thing that can make it large: drop them, longest first.
  const keys = Object.keys(out).filter((k) => typeof out[k] === 'string').sort((a, b) => out[b].length - out[a].length);
  while (utf8Bytes(JSON.stringify(out)) > MAX_SNAPSHOT_BYTES && keys.length) delete out[keys.shift()];
  return out;
}

function idFrom(sdk, body, key) {
  const id = str(body && body[key]);
  if (!ID_RE.test(id)) throw sdk.error(400, `${key} must be a record id`, 'INVALID_INPUT');
  return id;
}

/**
 * Stored declared values of a record, read through the CRM (never taken from the request body).
 * A failed read throws, so a temporary error never overwrites a saved plan with empty values.
 */
async function storedValues(sdk, type, id) {
  const values = await sdk.values.get(type, id);
  return isPlainObject(values) ? values : {};
}

/** Create or update the one row of `Model` keyed by `key` = `id`. Returns { row, created }. */
async function upsert(Model, key, id, data) {
  const existing = await Model.findOne({ [key]: id });
  if (existing) return { row: await Model.updateById(existing._id, data), created: false };
  try {
    return { row: await Model.create({ [key]: id, ...data }), created: true };
  } catch (error) {
    // Two saves at the same moment: the other one created it (unique key); update that row.
    if (!error || (error.status !== 409 && error.code !== 'DUPLICATE')) throw error;
    const row = await Model.findOne({ [key]: id });
    if (!row) throw error;
    return { row: await Model.updateById(row._id, data), created: false };
  }
}

/** TripPlan columns from an opportunity's declared values (B1 fields). */
function tripPlanData(opp, values) {
  const text = (k, max = 200) => str(values[k]).slice(0, max);
  const start = day(values.travel_start_date);
  const end = day(values.travel_end_date);
  const span = start && end && end >= start ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) : null;
  const adults = count(values.adults);
  const children = count(values.children);
  const infants = count(values.infants);
  const pax = [adults, children, infants];
  return {
    lead_id: ID_RE.test(str(opp.leadId)) ? str(opp.leadId) : '',
    title: str(opp.title).slice(0, 200),
    from_city: text('from_city'),
    destination: text('destination'),
    trip_type: text('trip_type', 40),
    trip_purpose: text('trip_purpose', 40),
    travel_start_date: start,
    travel_end_date: end,
    nights: count(values.nights) !== null ? count(values.nights) : span,
    days: count(values.days) !== null ? count(values.days) : span === null ? null : span + 1,
    date_flexibility: text('date_flexibility', 40),
    adults,
    children,
    infants,
    total_travellers: pax.some((n) => n !== null) ? pax.reduce((a, n) => a + (n || 0), 0) : count(values.total_travellers),
    budget_min: amount(values.budget_min),
    budget_max: amount(values.budget_max),
    currency: currencyOf(opp),
    special_requests: str(values.special_requests).slice(0, 5000),
    internal_notes: str(values.internal_notes).slice(0, 5000),
    values: snapshot(values),
    synced_at: new Date().toISOString()
  };
}

async function opportunitySaved(sdk, body) {
  const id = idFrom(sdk, body, 'opportunityId');
  const opp = await sdk.crm.opportunities.findById(id);
  if (!opp) throw sdk.error(404, 'Opportunity not found', 'NOT_FOUND');
  const values = await storedValues(sdk, 'opportunity', id);
  const { row, created } = await upsert(sdk.models.TripPlan, 'opportunity_id', id, tripPlanData(opp, values));
  if (created) await sdk.audit('created', 'Trip plan saved for an opportunity', { opportunityId: id, tripPlanId: String(row._id) });
  return { ok: true, created, id: String(row._id) };
}

/** Selected lines per group: { flights: { count, amount }, … } (ungrouped lines under "other"). */
function linesByGroup(lines) {
  const out = {};
  for (const line of (Array.isArray(lines) ? lines : []).slice(0, MAX_LINES)) {
    if (!isPlainObject(line) || line.selected === false) continue;
    const g = GROUP_RE.test(str(line.group)) ? str(line.group) : 'other';
    const qty = amount(line.qty !== undefined ? line.qty : line.quantity) || 0;
    const rate = amount(line.rate !== undefined ? line.rate : line.unitPrice) || 0;
    const lineAmount = amount(line.amount);
    if (!out[g]) out[g] = { count: 0, amount: 0 };
    out[g].count += 1;
    out[g].amount = round2(out[g].amount + (lineAmount !== null ? lineAmount : qty * rate));
  }
  return out;
}

async function quotationSaved(sdk, body) {
  const id = idFrom(sdk, body, 'quotationId');
  const q = await sdk.crm.quotations.findById(id);
  if (!q) throw sdk.error(404, 'Quotation not found', 'NOT_FOUND');
  const values = await storedValues(sdk, 'quotation', id);
  const travellers = count(values.travellers) || 0;
  const grandTotal = amount(q.grandTotal) || 0;
  const data = {
    quotation_no: str(q.quotationNo).slice(0, 60),
    version: Math.max(1, Math.floor(amount(q.version, 1, 10000) || 1)),
    lead_id: ID_RE.test(str(q.leadId)) ? str(q.leadId) : '',
    opportunity_id: ID_RE.test(str(q.opportunityId)) ? str(q.opportunityId) : '',
    status: str(q.status).slice(0, 40),
    travellers,
    per_person: travellers > 0 ? round2(grandTotal / travellers) : 0,
    grand_total: round2(grandTotal),
    currency: currencyOf(q),
    lines_by_group: linesByGroup(q.lineItems),
    valid_till: day(q.expiryDate),
    special_requests: str(values.special_requests).slice(0, 5000),
    values: snapshot(values),
    synced_at: new Date().toISOString()
  };
  const { row, created } = await upsert(sdk.models.QuotationTravel, 'quotation_id', id, data);
  if (created) await sdk.audit('created', 'Travel details saved for a quotation', { quotationId: id, quotationTravelId: String(row._id) });
  return { ok: true, created, id: String(row._id) };
}

module.exports = { opportunitySaved, quotationSaved, tripPlanData, linesByGroup, snapshot };
