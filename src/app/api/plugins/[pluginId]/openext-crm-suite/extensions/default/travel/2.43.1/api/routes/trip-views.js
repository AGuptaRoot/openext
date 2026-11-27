'use strict';

/**
 * Read-only travel sections on CRM record pages.
 *
 * GET /quotations/:quotation_id/travel      quotation detail → "Booking & itinerary": the booking made from it
 *                                           and its itinerary versions
 * GET /opportunities/:opportunity_id/trip   opportunity detail → "Trip": the trip saved with the opportunity
 *                                           (TripPlan; else its declared values; else the lead's trip), the lead's
 *                                           services and travellers (the opportunity prefill panels; nothing editable)
 */

const store = require('../services/booking-store.js');
const { _summary: itinerarySummary } = require('./itineraries.js');

const { str, ID_RE } = store;

exports.quotationTravel = async (req, sdk) => {
  const qid = store.idParam(req, 'quotation_id');
  const q = ID_RE.test(qid) ? await sdk.crm.quotations.findById(qid) : null;
  if (!q) throw sdk.error(404, 'Quotation not found', 'NOT_FOUND');
  const can = store.permissionsOf(sdk);
  const [booking, itineraries] = await Promise.all([
    can.read ? sdk.models.Booking.findOne({ quotation_id: qid }) : null,
    sdk.models.Itinerary.find({ quotation_id: qid }, { limit: 20, sort: { version: -1 } })
  ]);
  return {
    quotation: { id: qid, number: str(q.quotationNo), version: Number(q.version) || 1, status: str(q.status) || 'Draft' },
    booking: booking ? { id: booking._id, number: str(booking.number), status: str(booking.status) } : null,
    itineraries: itineraries.map(itinerarySummary),
    canCreateBooking: can.write && ['Accepted', 'Converted'].includes(q.status) && !booking && Array.isArray(q.lineItems) && q.lineItems.length > 0,
    canGenerate: can.itinerary && q.status !== 'Rejected',
    can
  };
};

/** Trip fields shown on the "Trip" tab (TripPlan columns = the opportunity's declared Trip fields). */
const TRIP_KEYS = [
  'from_city', 'destination', 'trip_type', 'trip_purpose', 'travel_start_date', 'travel_end_date', 'nights', 'days',
  'date_flexibility', 'adults', 'children', 'infants', 'total_travellers', 'budget_min', 'budget_max', 'special_requests'
];

function tripValues(source) {
  const out = {};
  for (const k of TRIP_KEYS) {
    const v = source ? source[k] : undefined;
    if (v === undefined || v === null || v === '') continue;
    out[k] = k.endsWith('_date') ? str(v).slice(0, 10) : v;
  }
  return out;
}

/**
 * 2.1.0: the opportunity's own declared values (kept by the CRM, always current) win; its TripPlan copy
 * (written by /sales-flow/opportunity-saved) only when the values cannot be read; one without either
 * shows the lead's trip as before. Services and travellers panels always come from the lead.
 */
exports.opportunityTrip = async (req, sdk) => {
  const oid = store.idParam(req, 'opportunity_id');
  const opp = ID_RE.test(oid) ? await sdk.crm.opportunities.findById(oid) : null;
  if (!opp) throw sdk.error(404, 'Opportunity not found', 'NOT_FOUND');
  const leadId = str(opp.leadId);
  const [plan, declared] = await Promise.all([
    sdk.models.TripPlan ? sdk.models.TripPlan.findOne({ opportunity_id: oid }) : null,
    sdk.values.get('opportunity', oid).catch(() => ({}))
  ]);
  const fromValues = tripValues(declared);
  const useValues = Object.keys(fromValues).length > 0;
  const own = useValues ? fromValues : plan ? tripValues(plan) : {};
  const source = useValues ? 'opportunity' : plan ? 'trip_plan' : 'lead';
  if (!ID_RE.test(leadId)) {
    if (source === 'lead') return { available: false, message: 'This opportunity has no lead, so there is no trip to show.' };
    return { available: true, leadId: '', source, title: str(opp.title), values: own, currency: str((plan && plan.currency) || opp.currency), panels: [], warnings: [] };
  }
  // Loaded here so the other sections keep working if the prefill module cannot load.
  const { opportunityPrefill } = require('../services/sales-prefill.js');
  const trip = await opportunityPrefill(sdk, leadId);
  return {
    available: true,
    leadId,
    source,
    title: source === 'lead' ? str(trip.title) : str(opp.title) || str(trip.title),
    values: source === 'lead' ? trip.values || {} : own,
    currency: str((plan && plan.currency) || opp.currency),
    panels: Array.isArray(trip.panels) ? trip.panels : [],
    warnings: Array.isArray(trip.warnings) ? trip.warnings : []
  };
};
