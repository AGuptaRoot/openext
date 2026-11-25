'use strict';

/**
 * Travel Reports (2.9.0, CRM 3.29.0 json/reports.json) — the records every report section reads, loaded once
 * per request and filtered the same way, so every card and chart follows the same filters.
 *
 * Scope ("universe"): the leads this user may see (sdk.crm applies tenant and sales-agent rules), narrowed by
 * the lead filters (sales person, lead source, destination, travel service) and by the record filters
 * (booking status, payment status: leads that have such a record). Every figure then counts the universe's
 * records by their own date (lead created, quotation sent / accepted, booking created, payment date).
 * Opportunities are hidden in Travel: reports read leads, quotations and bookings only.
 *
 * Accuracy rules:
 *  - quotation revisions count once (per root quotation); an accepted quotation is one conversion, whatever
 *    earlier revisions exist
 *  - money only through sdk.finance.summary (verified payments, advance moved onto the tax invoice counted once)
 *  - cancelled bookings never count as bookings or value
 *  - no passport / Aadhaar numbers, file ids or document images are read into reports (only expiry dates and
 *    whether the last 4 digits exist)
 *
 * Speed (2.37.0):
 *  - leads are paged by record id (CRM 3.65.0 find { after }): no 5,000-lead limit, and page 50 costs the same
 *    as page 1. An older CRM keeps the old paging (and its limit).
 *  - extension records are paged by id as well, and independent reads run side by side (a few at a time).
 *  - calls of the same user + filters that arrive while a load is running share it (and for 2 s after): the
 *    Reports page asks 3 routes at once, they now read the data once. Nothing older is ever reused.
 *  - load(sdk, query, { light: true }) (the Dashboard): no Travel Requirements, and travel values only for the
 *    leads that have bookings (the Dashboard reads no others; it fetches the few more it shows itself).
 */

const { readServices } = require('./catalog.js');
const { todayIn } = require('./availability.js');
const store = require('./booking-store.js');

const { str, ID_RE } = store;
const MAX_LEADS = 5000; // only with an older CRM (skip paging)
const MAX_ROWS = 100000; // safety stop for id paging
const IN = 500;
const PARALLEL = 4; // reads at the same time
const GRACE_MS = 2000; // a finished load is reused this long, no more
const CACHE_MAX = 30;

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

/** Oldest first (as before 2.37.0, when pages were read by createdAt): equal dates keep their id order. */
const oldestFirst = (rows) => rows.map((row, i) => [row, i]).sort((a, b) => {
  const x = str(a[0].createdAt);
  const y = str(b[0].createdAt);
  return x < y ? -1 : x > y ? 1 : a[1] - b[1];
}).map(([row]) => row);

/** Run fn over items, at most `limit` at a time; results in the items' order. */
async function eachLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every row of a core reader (pages of 100). By id with CRM 3.65.0; else oldest first with skip, up to max. */
async function scanCore(reader, filter, max = MAX_LEADS) {
  const rows = new Map();
  if (reader && reader.paging === 'after') {
    let after = '';
    while (rows.size < MAX_ROWS) {
      const page = await reader.find(filter, { limit: 100, after });
      for (const row of page) rows.set(str(row._id), row);
      if (page.length < 100) break;
      const last = str(page[page.length - 1]._id);
      if (!last || last === after) break;
      after = last;
    }
    return oldestFirst([...rows.values()]);
  }
  // An older CRM: sdk.crm sorts on record fields only, not _id; a row seen twice is kept once.
  for (let skip = 0; skip < max; skip += 100) {
    const page = await reader.find(filter, { limit: 100, skip, sort: { createdAt: 1 } });
    for (const row of page) rows.set(str(row._id), row);
    if (page.length < 100) break;
  }
  return [...rows.values()];
}

/** Rows of a core reader whose field is in a list of ids (chunks of 500, a few chunks at a time). */
async function coreIn(reader, field, ids, extra = {}) {
  const parts = await eachLimited(chunks([...new Set(ids)].filter(Boolean)), PARALLEL, (part) => scanCore(reader, { ...extra, [field]: { $in: part } }, 20000));
  return parts.flat();
}

/** Rows of an extension model whose field is in a list of ids (chunks of 500, pages of 500 by id). */
async function modelIn(Model, field, ids, extra = {}) {
  if (!Model) return [];
  const parts = await eachLimited(chunks([...new Set(ids)].filter(Boolean)), PARALLEL, async (part) => {
    const rows = [];
    let after = '';
    for (let n = 0; n < 100; n += 1) {
      const where = { ...extra, [field]: { $in: part }, ...(after ? { _id: { $gt: after } } : {}) };
      const page = await Model.find(where, { limit: 500, sort: { _id: 1 } });
      rows.push(...page);
      if (page.length < 500) break;
      after = str(page[page.length - 1]._id);
      if (!after) break;
    }
    return oldestFirst(rows);
  });
  const seen = new Set();
  return parts.flat().filter((row) => {
    const id = str(row._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Travel values of leads, 100 per read, a few reads at a time. */
async function valuesOf(sdk, ids) {
  const out = {};
  const parts = await eachLimited(chunks([...new Set(ids)].filter(Boolean), 100), PARALLEL, (part) => sdk.values.getMany('lead', part));
  for (const part of parts) Object.assign(out, part || {});
  return out;
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

/* 2.37.0: one running load shared by the same user + filters (the Reports page asks 3 routes at once). */
const recent = new Map();

function cacheKey(sdk, f, light) {
  const userId = str(sdk.user && sdk.user.id);
  const finance = Boolean(sdk.permissions && sdk.permissions.has('crm.finance.read'));
  const bookingsRead = Boolean(sdk.permissions && sdk.permissions.has('x.travel.bookings.read'));
  return JSON.stringify([userId, finance, bookingsRead, light, f]);
}

/**
 * Load and filter everything the report sections need. The answer is shared: callers must not change it.
 * @param {object} [options] { light } — the Dashboard's smaller load (see the top of this file)
 * @returns {Promise<object>} ctx
 */
function load(sdk, query, options = {}) {
  const f = readFilters(query);
  const light = Boolean(options && options.light) && !f.destination && !f.service;
  const key = cacheKey(sdk, f, light);
  const now = Date.now();
  for (const [k, v] of recent) if (v.doneAt && now - v.doneAt > GRACE_MS) recent.delete(k);
  const hit = recent.get(key);
  if (hit) return hit.pending;
  const pending = loadFresh(sdk, f, light);
  const entry = { pending, doneAt: 0 };
  recent.set(key, entry);
  pending.then(
    () => {
      entry.doneAt = Date.now();
    },
    () => recent.delete(key)
  );
  while (recent.size > CACHE_MAX) recent.delete(recent.keys().next().value);
  return pending;
}

async function loadFresh(sdk, f, light) {
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

  // Without a destination / service filter the lead list is final now: the next reads run side by side.
  const early = !f.destination && !f.service;
  const earlyIds = leads.map((l) => str(l._id));
  const earlyQuotes = early && canFinance ? coreIn(sdk.crm.quotations, 'leadId', earlyIds) : null;
  const earlyBookings = early ? modelIn(sdk.models.Booking, 'lead_id', earlyIds) : null;
  const earlyReqs = early && !light ? modelIn(sdk.models.TravelRequirement, 'lead_id', earlyIds) : null;
  // Keep the side reads from being unhandled while the values load (they are awaited below).
  for (const p of [earlyQuotes, earlyBookings, earlyReqs]) if (p) p.catch(() => undefined);

  // Travel values of the leads (destination, dates, travellers, required services). The Dashboard (light)
  // reads only those of the leads with bookings, below.
  const [values, services, destinationList] = await Promise.all([
    light ? Promise.resolve({}) : valuesOf(sdk, leads.map((l) => str(l._id))),
    readServices(sdk),
    sdk.settings.get('destinations')
  ]);
  const destinationLabel = new Map((Array.isArray(destinationList) ? destinationList : []).map((d) => [keyOf(d), str(d)]));
  const destOf = (leadId) => {
    const v = values[leadId] || {};
    return str(v.destination) || str(v.to);
  };
  if (f.destination) leads = leads.filter((l) => keyOf(destOf(str(l._id))) === f.destination);

  let leadIds = leads.map((l) => str(l._id));
  const requirements = light ? [] : (await (earlyReqs || modelIn(sdk.models.TravelRequirement, 'lead_id', leadIds))).filter((r) => r.removed !== true);
  if (f.service) {
    const withService = new Set(requirements.filter((r) => str(r.service_key) === f.service).map((r) => str(r.lead_id)));
    for (const l of leads) {
      const req = values[str(l._id)] && values[str(l._id)].required_services;
      if (Array.isArray(req) && req.includes(f.service)) withService.add(str(l._id));
    }
    leads = leads.filter((l) => withService.has(str(l._id)));
    leadIds = leads.map((l) => str(l._id));
  }

  // Quotations are made from the lead (no opportunities in Travel).
  let quotations = [];
  if (canFinance) {
    const seen = new Map();
    for (const q of await (earlyQuotes || coreIn(sdk.crm.quotations, 'leadId', leadIds))) seen.set(str(q._id), q);
    quotations = [...seen.values()].filter((q) => !q.isArchived);
  }
  let bookings = await (earlyBookings || modelIn(sdk.models.Booking, 'lead_id', leadIds));
  if (light) Object.assign(values, await valuesOf(sdk, bookings.map((b) => str(b.lead_id))));

  // Money of the accepted quotations (the CRM's rules), and each one's payment group.
  let finance = null;
  if (canFinance) {
    const accepted = quotations.filter(ACCEPTED).map((q) => str(q._id));
    finance = await sdk.finance.summary({ quotationIds: accepted, from: f.from, to: f.to });
  }

  // Record filters: leads that have such a booking / payment state.
  const keepLeads = (set) => {
    leads = leads.filter((l) => set.has(str(l._id)));
    leadIds = leads.map((l) => str(l._id));
  };
  const leadOfQuotation = (q) => str(q.leadId);
  if (f.bookingStatus) keepLeads(new Set(bookings.filter((b) => str(b.status) === f.bookingStatus).map((b) => str(b.lead_id))));
  if (f.paymentStatus && finance) {
    keepLeads(new Set(quotations.filter((q) => ACCEPTED(q) && finance.quotations[str(q._id)] && finance.quotations[str(q._id)].paymentGroup === f.paymentStatus).map(leadOfQuotation)));
  }
  if (f.bookingStatus || (f.paymentStatus && finance)) {
    const set = new Set(leadIds);
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

/** One conversion per root quotation (or per opportunity on older data): the accepted quotation. */
function conversions(quotations) {
  const out = new Map();
  for (const q of quotations.filter(ACCEPTED)) {
    const key = str(q.opportunityId || q.dealId) || ROOT(q);
    if (!out.has(key)) out.set(key, q);
  }
  return [...out.values()];
}

module.exports = { load, valuesOf, scanCore, modelIn, eachLimited, chunks, oldestFirst, readFilters, expectedTravellers, latestByRoot, conversions, keyOf, day, ROOT, SENT, ACCEPTED, sentDay, acceptedDay };
