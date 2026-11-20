'use strict';

/**
 * CRM sales-flow contract (crm-extension.json → salesFlow).
 *
 * POST /opportunity-prefill           { leadId } → { title, expectedCloseDate, description, lines, values, checks, warnings }
 * POST /quotation-prefill             { leadId, opportunityId? } → { lines (with group), values, validTill, validTillMax,
 *                                     checks, sections, panels, warnings }
 * POST /sales-flow/opportunity-saved  { opportunityId } → { ok }   upserts the TripPlan (CRM 3.18.0 savedRoute)
 * POST /sales-flow/quotation-saved    { quotationId } → { ok }     upserts the QuotationTravel
 * POST /sales-flow/invoice-prefill    { quotationId, leadId } → { summary }  read-only trip facts for the invoice page
 *
 * The CRM checks and caps what comes back before showing it; the user edits everything.
 */

const { opportunityPrefill, quotationPrefill, dateRange } = require('../services/sales-prefill.js');
const { opportunitySaved, quotationSaved } = require('../services/sales-sync.js');

const leadIdOf = (req, sdk) => {
  const id = req.body && typeof req.body.leadId === 'string' ? req.body.leadId : '';
  if (!id) throw sdk.error(400, 'leadId is required', 'INVALID_INPUT');
  return id;
};
const opportunityIdOf = (req) => (req.body && typeof req.body.opportunityId === 'string' ? req.body.opportunityId.trim() : '');

exports.opportunity = async (req, sdk) => opportunityPrefill(sdk, leadIdOf(req, sdk));
exports.quotation = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // 2.28.0 (CRM 3.51.0): a client trip — the client + its trip record, no lead.
  if (typeof body.recordId === 'string' && body.recordId && !body.leadId) {
    return quotationPrefill(sdk, '', '', { recordId: body.recordId.trim(), clientId: String(body.clientId || '').trim() });
  }
  return quotationPrefill(sdk, leadIdOf(req, sdk), opportunityIdOf(req));
};
/** Only people who may change the record (the CRM calls these right after they saved it); never portal users. */
function requireAny(sdk, keys) {
  if (!keys.some((k) => sdk.permissions.has(k))) throw sdk.error(403, `This needs one of: ${keys.join(', ')}`, 'FORBIDDEN');
}

exports.opportunitySaved = async (req, sdk) => {
  requireAny(sdk, ['crm.opportunities.write', 'crm.leads.write']);
  return opportunitySaved(sdk, req.body || {});
};
exports.quotationSaved = async (req, sdk) => {
  requireAny(sdk, ['crm.quotes.write', 'crm.finance.write']);
  return quotationSaved(sdk, req.body || {});
};

const REC_RE = /^[a-f0-9]{24}$/i;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The invoice page's Travel Summary (read-only): booking number, destination, travel dates, travellers —
 * from the booking of the quotation, else its saved travel details, else the lead. Changes nothing.
 */
exports.invoice = async (req, sdk) => {
  const body = req.body || {};
  const quotationId = String(body.quotationId || '');
  if (!REC_RE.test(quotationId)) throw sdk.error(400, 'quotationId is required', 'INVALID_INPUT');
  const quote = await sdk.crm.quotations.findById(quotationId);
  if (!quote) throw sdk.error(404, 'Quotation not found', 'NOT_FOUND');
  const leadId = REC_RE.test(String(body.leadId || '')) ? String(body.leadId) : String(quote.leadId || '');
  const [bookings, snapshots, values] = await Promise.all([
    sdk.models.Booking.find({ quotation_id: quotationId }, { limit: 1 }),
    sdk.models.QuotationTravel.find({ quotation_id: quotationId }, { limit: 1, sort: { createdAt: -1 } }),
    REC_RE.test(leadId) ? sdk.values.get('lead', leadId) : Promise.resolve({})
  ]);
  const booking = bookings[0] || null;
  const snapshot = snapshots[0] || null;
  const v = values || {};
  const destination = String((booking && booking.destination) || v.destination || v.to || '');
  const start = String((booking && booking.travel_start_date) || v.travel_start_date || '').slice(0, 10);
  const end = String((booking && booking.travel_end_date) || v.travel_end_date || '').slice(0, 10);
  const planned = [v.adults, v.children, v.infants].map(num);
  const travellers =
    booking && Array.isArray(booking.traveller_ids) && booking.traveller_ids.length
      ? booking.traveller_ids.length
      : snapshot && num(snapshot.travellers)
        ? num(snapshot.travellers)
        : planned.some((n) => n !== null)
          ? planned.reduce((sum, n) => sum + (n || 0), 0)
          : null;
  const summary = [
    booking ? { icon: 'flight', label: 'Booking number', value: String(booking.number || '') } : null,
    { icon: 'beach', label: 'Destination', value: destination },
    { icon: 'event', label: 'Travel dates', value: dateRange(start, end) },
    travellers ? { icon: 'group', label: 'Travellers', value: `${travellers} traveller${travellers === 1 ? '' : 's'}` } : null
  ].filter((s) => s && s.value);
  return { summary };
};
