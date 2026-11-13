'use strict';

/**
 * Trip and quotation date rules (2.12.0) the CRM asks for before it saves (api/services/trip-dates.js).
 *
 * POST /lead-values-check     { leadId, values, changed }  leadWorkflow.valuesCheckRoute: before lead values
 *                             are saved → { errors: [text] }. Travel Start Date not in the past (when it is
 *                             changed, workspace time zone); new travel dates must still hold every live
 *                             Travel Requirement (dates inside, nights not more than the trip).
 * POST /sales-flow/quotation-dates  { leadId, opportunityId, leadValues? }  salesFlow.quotationDatesRoute →
 *                             { issueDateMin: today, validTillMax: Travel Start Date, validTillMaxLabel }:
 *                             a travel quotation is not valid after the trip starts.
 *
 * Both only read: nothing is changed here, and Sent / Accepted quotations are never judged.
 */

const rules = require('../services/traveller-rules.js');
const { readServices } = require('../services/catalog.js');
const store = require('../services/requirement-store.js');
const { tripOf, requirementTripCheck } = require('../services/trip-dates.js');

const { ID_RE, str } = store;

async function todayFor(sdk) {
  let zone = rules.DEFAULT_TZ;
  try {
    zone = rules.cleanTimeZone(await sdk.settings.get('timezone'));
  } catch {
    zone = rules.DEFAULT_TZ;
  }
  return rules.todayIso(undefined, zone);
}

/**
 * Problems of a lead's live requirements with a (new) trip, as "Hotel – Goa: Check-In Date must be …".
 * Only services still ticked in Required Services count (an unticked one is hidden, not judged).
 */
async function requirementProblems(sdk, leadId, trip, selected = null) {
  const [services, rows] = await Promise.all([readServices(sdk), store.rowsForLeads(sdk, [leadId])]);
  const out = [];
  for (const row of store.live(rows)) {
    if (Array.isArray(selected) && !selected.includes(str(row.service_key))) continue;
    const service = services.find((s) => s.key === str(row.service_key));
    if (!service) continue;
    const fields = (service.fields || []).filter((f) => f.enabled !== false && f.label);
    const values = row.values && typeof row.values === 'object' ? row.values : {};
    const { errors } = requirementTripCheck(fields, values, trip);
    const name = str(row.label) || service.name;
    for (const e of errors) out.push(`Travel Requirement "${name}": ${e.message} Change the requirement first.`);
  }
  return out;
}

/** Travel Information keys: a save that touches any of them is a travel lead's save. */
const TRAVEL_INFO_KEYS = ['from', 'to', 'travel_start_date', 'travel_end_date', 'date_flexibility', 'required_services'];

/**
 * From and To are required (2.16.0). A lead from before 2.16.0 (it still has a Destination) is not
 * blocked for an empty From / To nobody changed; clearing one is always refused.
 */
function placeErrors(values, changed) {
  if (!TRAVEL_INFO_KEYS.some((k) => changed.has(k))) return [];
  const legacy = Boolean(str(values.destination));
  const out = [];
  for (const [key, label] of [['from', 'From'], ['to', 'To']]) {
    if (str(values[key])) continue;
    if (!legacy || changed.has(key)) out.push(`${label} is required.`);
  }
  return out;
}

exports.leadValuesCheck = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const leadId = str(body.leadId);
  const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  const changed = new Set((Array.isArray(body.changed) ? body.changed : []).map(String));
  const places = placeErrors(values, changed);
  const datesChanged = changed.has('travel_start_date') || changed.has('travel_end_date');
  if (!datesChanged) return { errors: places };
  const trip = tripOf(values);
  const errors = [...places];
  if (changed.has('travel_start_date') && trip.start && trip.start < (await todayFor(sdk))) {
    errors.push('Travel Start Date cannot be in the past.');
  }
  if (trip.start && trip.end && trip.end < trip.start) errors.push('Travel End Date cannot be before Travel Start Date.');
  const selected = Array.isArray(values.required_services) ? values.required_services.map(String) : null;
  if (errors.length === places.length && ID_RE.test(leadId)) errors.push(...(await requirementProblems(sdk, leadId, trip, selected)));
  return { errors: errors.slice(0, 10) };
};

exports.quotationDates = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let leadId = str(body.leadId);
  const opportunityId = str(body.opportunityId);
  const out = { issueDateMin: await todayFor(sdk) };
  if (!ID_RE.test(leadId) && ID_RE.test(opportunityId)) {
    const opp = await sdk.crm.opportunities.findById(opportunityId).catch(() => null);
    leadId = str(opp && opp.leadId);
  }
  let values = body.leadValues && typeof body.leadValues === 'object' && !Array.isArray(body.leadValues) ? body.leadValues : null;
  if (!values && ID_RE.test(leadId)) values = await sdk.values.get('lead', leadId).catch(() => ({}));
  let { start } = tripOf(values || {});
  // A lead without dates: the trip opportunity's own start date, when it has one.
  if (!start && ID_RE.test(opportunityId)) start = tripOf(await sdk.values.get('opportunity', opportunityId).catch(() => ({}))).start;
  if (start) {
    out.validTillMax = start;
    out.validTillMaxLabel = 'Travel Start Date';
  }
  return out;
};
