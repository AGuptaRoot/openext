'use strict';

/**
 * Travel Reports (2.9.0, CRM 3.29.0 json/reports.json) — the records every report section reads, loaded once
 * per request and filtered the same way, so every card and chart follows the same filters.
 *
 * Scope ("universe"): the leads this user may see (sdk.crm applies tenant and sales-agent rules), narrowed by
 * the lead filters (sales person, lead source, destination, travel service) and by the record filters
 * (opportunity stage, booking status, payment status: leads that have such a record). Every figure then
 * counts the universe's records by their own date (lead created, opportunity created, quotation sent /
 * accepted, booking created, payment date).
 *
 * Accuracy rules:
 *  - quotation revisions count once (per root quotation); an opportunity with an accepted quotation is one
 *    conversion, whatever earlier revisions exist
 *  - money only through sdk.finance.summary (verified payments, advance moved onto the tax invoice counted once)
 *  - cancelled bookings never count as bookings or value
 *  - no passport / Aadhaar numbers, file ids or document images are read into reports (only expiry dates and
 *    whether the last 4 digits exist)
 */

const { readServices } = require('./catalog.js');
const { todayIn } = require('./availability.js');
const store = require('./booking-store.js');

const { str, ID_RE } = store;
const MAX_LEADS = 5000;
const IN = 500;

const day = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const keyOf = (label) => str(label).toLowerCase().replace(/\s+/g, ' ').trim();
const chunks = (list, size = IN) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** Every row of a core reader (pages of 100), up to max. */
async function scanCore(reader, filter, max = MAX_LEADS) {
  // Paged oldest first (sdk.crm sorts on record fields only, not _id); a row seen twice is kept once.
  const rows = new Map();
  for (let skip = 0; skip < max; skip += 100) {
    const page = await reader.find(filter, { limit: 100, skip, sort: { createdAt: 1 } });
    for (const row of page) rows.set(str(row._id), row);
    if (page.length < 100) break;
  }
  return [...rows.values()];
}

/** Rows of a core reader whose field is in a list of ids (chunks of 500). */
async function coreIn(reader, field, ids, extra = {}) {
  const rows = [];
  for (const part of chunks([...new Set(ids)].filter(Boolean))) rows.push(...(await scanCore(reader, { ...extra, [field]: { $in: part } }, 20000)));
  return rows;
}

/** Rows of an extension model whose field is in a list of ids (chunks of 500, pages of 500). */
async function modelIn(Model, field, ids, extra = {}) {
  const rows = [];
  if (!Model) return rows;
  const seen = new Set();
  for (const part of chunks([...new Set(ids)].filter(Boolean))) {
    for (let skip = 0; skip < 50000; skip += 500) {
      const page = await Model.find({ ...extra, [field]: { $in: part } }, { limit: 500, skip, sort: { createdAt: 1 } });
      for (const row of page) {
        if (seen.has(str(row._id))) continue;
        seen.add(str(row._id));
        rows.push(row);
      }
      if (page.length < 500) break;
    }
  }
  return rows;
}

/** The query → a clean filter set. */
function readFilters(query = {}) {
  const q = query || {};
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : '');
  return {
    from: iso(q.from),
    to: iso(q.to),
    owner: str(q.owner).slice(0, 60),
    source: str(q.source).slice(0, 80),
    destination: keyOf(q.destination).slice(0, 80),
    service: str(q.service).slice(0, 60),
    stage: str(q.stage).slice(0, 80),
    bookingStatus: str(q.booking_status).slice(0, 40),
    paymentStatus: str(q.payment_status).slice(0, 40),
    upcomingDays: ['7', '15', '30'].includes(str(q.p_upcoming_trips)) ? Number(q.p_upcoming_trips) : 15
  };
}

const ROOT = (q) => str(q.revisionOf) || str(q._id);
const SENT = (q) => str(q.status) !== 'Draft' || Boolean(q.sentAt);
const ACCEPTED = (q) => ['Accepted', 'Converted'].includes(str(q.status));
const sentDay = (q) => day(q.sentAt || q.issueDate || q.createdAt);
const acceptedDay = (q) => day((q.acceptedMetadata && q.acceptedMetadata.acceptedAt) || q.updatedAt);

/**
 * Load and filter everything the report sections need.
 * @returns {Promise<object>} ctx
 */
async function load(sdk, query) {
  const f = readFilters(query);
  const canFinance = Boolean(sdk.permissions && sdk.permissions.has('crm.finance.read'));
  // No range: everything counts; with one, a record needs its date inside it.
  const inRange = (d) => (!f.from && !f.to) || (Boolean(d) && (!f.from || d >= f.from) && (!f.to || d <= f.to));
  const timeZone = await store.timeZoneOf(sdk);
  const today = todayIn(timeZone);

  // Leads (tenant + sales-agent scope by sdk.crm), lead filters applied in the query where they are core fields.
  const leadFilter = {};
  if (f.owner) leadFilter.assignedTo = f.owner;
  if (f.source) leadFilter.source = f.source;
  let leads = (await scanCore(sdk.crm.leads, leadFilter)).filter((l) => !l.mergedIntoId);

  // Travel values of the leads (destination, dates, travellers, required services), 100 at a time.
  const values = {};
  for (const part of chunks(leads.map((l) => str(l._id)), 100)) Object.assign(values, await sdk.values.getMany('lead', part));
  const [services, destinationList] = await Promise.all([readServices(sdk), sdk.settings.get('destinations')]);
  const destinationLabel = new Map((Array.isArray(destinationList) ? destinationList : []).map((d) => [keyOf(d), str(d)]));
  const destOf = (leadId) => {
    const v = values[leadId] || {};
    return str(v.destination) || str(v.to);
  };
  if (f.destination) leads = leads.filter((l) => keyOf(destOf(str(l._id))) === f.destination);

  let leadIds = leads.map((l) => str(l._id));
  const requirements = (await modelIn(sdk.models.TravelRequirement, 'lead_id', leadIds)).filter((r) => r.removed !== true);
  if (f.service) {
    const withService = new Set(requirements.filter((r) => str(r.service_key) === f.service).map((r) => str(r.lead_id)));
    for (const l of leads) {
      const req = values[str(l._id)] && values[str(l._id)].required_services;
      if (Array.isArray(req) && req.includes(f.service)) withService.add(str(l._id));
    }
    leads = leads.filter((l) => withService.has(str(l._id)));
    leadIds = leads.map((l) => str(l._id));
  }

  let opportunities = (await coreIn(sdk.crm.opportunities, 'leadId', leadIds)).filter((o) => !o.isDeleted);
  const oppIds = opportunities.map((o) => str(o._id));
  let quotations = [];
  if (canFinance) {
    const byLead = await coreIn(sdk.crm.quotations, 'leadId', leadIds);
    const byOpp = await coreIn(sdk.crm.quotations, 'opportunityId', oppIds);
    const seen = new Map();
    for (const q of [...byLead, ...byOpp]) seen.set(str(q._id), q);
    quotations = [...seen.values()].filter((q) => !q.isArchived);
  }
  let bookings = await modelIn(sdk.models.Booking, 'lead_id', leadIds);

  // Money of the accepted quotations (the CRM's rules), and each one's payment group.
  let finance = null;
  if (canFinance) {
    const accepted = quotations.filter(ACCEPTED).map((q) => str(q._id));
    finance = await sdk.finance.summary({ quotationIds: accepted, from: f.from, to: f.to });
  }

  // Record filters: leads that have such an opportunity / booking / payment state.
  const keepLeads = (set) => {
    leads = leads.filter((l) => set.has(str(l._id)));
    leadIds = leads.map((l) => str(l._id));
  };
  const leadOfOpp = new Map(opportunities.map((o) => [str(o._id), str(o.leadId)]));
  const leadOfQuotation = (q) => str(q.leadId) || leadOfOpp.get(str(q.opportunityId || q.dealId)) || '';
  if (f.stage) keepLeads(new Set(opportunities.filter((o) => str(o.stage) === f.stage).map((o) => str(o.leadId))));
  if (f.bookingStatus) keepLeads(new Set(bookings.filter((b) => str(b.status) === f.bookingStatus).map((b) => str(b.lead_id))));
  if (f.paymentStatus && finance) {
    keepLeads(new Set(quotations.filter((q) => ACCEPTED(q) && finance.quotations[str(q._id)] && finance.quotations[str(q._id)].paymentGroup === f.paymentStatus).map(leadOfQuotation)));
  }
  if (f.stage || f.bookingStatus || (f.paymentStatus && finance)) {
    const set = new Set(leadIds);
    opportunities = opportunities.filter((o) => set.has(str(o.leadId)));
    quotations = quotations.filter((q) => set.has(leadOfQuotation(q)));
    bookings = bookings.filter((b) => set.has(str(b.lead_id)));
    if (canFinance) {
      finance = await sdk.finance.summary({ quotationIds: quotations.filter(ACCEPTED).map((q) => str(q._id)), from: f.from, to: f.to });
    }
  }

  const finalLeads = new Set(leadIds);
  const bookingIds = bookings.map((b) => str(b._id));
  const [bookingServices, travellers, vouchers] = await Promise.all([
    modelIn(sdk.models.BookingService, 'booking_id', bookingIds),
    modelIn(sdk.models.Traveller, 'lead_id', leadIds),
    modelIn(sdk.models.Voucher, 'booking_id', bookingIds)
  ]);

  return {
    f,
    canFinance,
    inRange,
    today,
    timeZone,
    leads,
    leadIds,
    values,
    services,
    destOf,
    destinationLabel,
    requirements: requirements.filter((r) => finalLeads.has(str(r.lead_id))),
    opportunities,
    quotations,
    leadOfQuotation,
    bookings,
    bookingServices,
    travellers,
    vouchers,
    finance
  };
}

/** Expected travellers on a lead (adults + children + infants of its travel details). */
function expectedTravellers(values) {
  const v = values || {};
  const n = ['adults', 'children', 'infants'].reduce((sum, k) => sum + (Number.isFinite(Number(v[k])) ? Math.max(0, Number(v[k])) : 0), 0);
  return n || (Number.isFinite(Number(v.travellers)) ? Number(v.travellers) : 0);
}

/** Quotations grouped by root (revisions once): the latest revision of each root. */
function latestByRoot(quotations) {
  const roots = new Map();
  for (const q of quotations) {
    const root = ROOT(q);
    const cur = roots.get(root);
    if (!cur || Number(q.version || q.revisionNumber || 0) > Number(cur.version || cur.revisionNumber || 0) || (Number(q.version || 0) === Number(cur.version || 0) && day(q.createdAt) > day(cur.createdAt))) roots.set(root, q);
  }
  return roots;
}

/** One conversion per opportunity (or per root quotation without one): the accepted quotation. */
function conversions(quotations) {
  const out = new Map();
  for (const q of quotations.filter(ACCEPTED)) {
    const key = str(q.opportunityId || q.dealId) || ROOT(q);
    if (!out.has(key)) out.set(key, q);
  }
  return [...out.values()];
}

module.exports = { load, readFilters, expectedTravellers, latestByRoot, conversions, keyOf, day, ROOT, SENT, ACCEPTED, sentDay, acceptedDay };
