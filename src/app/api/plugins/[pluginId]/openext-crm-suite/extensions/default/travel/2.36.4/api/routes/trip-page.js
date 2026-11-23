'use strict';

/**
 * Trip page and Trips report (2.35.0, CRM 3.61.0).
 *
 * A trip is either
 *   - a travel lead (its Travel Information, requirements, quotations, bookings, travellers), or
 *   - a client trip: a ClientTravelRequirement row with no lead (quotation via extensionRecordId, booking via
 *     client_trip_id). A client trip that opened an enquiry lead (lead_id set) IS that lead's trip: it is
 *     shown once, as the lead trip, never twice.
 *
 * GET /trips/lead/:trip_id        everything about one lead trip (trip_id = the lead id), each part linked
 * GET /trips/client/:trip_id      the same for a client trip ({ redirect: { lead } } when it has a lead)
 *                                 (one declared route, /trips/:kind/:trip_id → exports.trip)
 * GET /reports/trips              Reports → Trips: one row per trip (lead trips + client trips), row → Trip page
 *
 * Read-only. Staff only (a client-portal login gets 404). Lead trips follow the sales-agent scope of
 * sdk.crm.leads; client trips need crm.clients.read (like client-trip bookings). Quotations, invoices,
 * proformas and money only with crm.finance.read; bookings with x.travel.bookings.read. Invoices of a client
 * trip are read only through that trip's own quotations, never by client. Travellers: name, age group,
 * relation and passport status only — never passport / Aadhaar / PAN numbers or document files.
 */

const data = require('../services/report-data.js');
const store = require('../services/booking-store.js');
const { readServices } = require('../services/catalog.js');
const { todayIn } = require('../services/availability.js');

const { str, ID_RE } = store;
const { day, keyOf, ACCEPTED, ROOT } = data;

const TRIP_PAGE = '/ext/travel/trip';
const BOOKINGS = '/ext/travel/bookings';
const ITINERARY = '/ext/travel/itinerary';
const MAX_ROWS = 500;
const CLIENT_TRIP_LIMIT = 5000;

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v) => Math.round(num(v) * 100) / 100;
const has = (sdk, key) => {
  try {
    return Boolean(sdk.permissions && sdk.permissions.has(key));
  } catch {
    return false;
  }
};

/** Staff only: a client-portal login never reaches a trip page or the report. */
async function assertStaff(sdk) {
  if (!sdk.access || typeof sdk.access.portal !== 'function') return;
  let portal = null;
  try {
    portal = await sdk.access.portal();
  } catch {
    portal = null;
  }
  if (portal) throw sdk.error(404, 'Trip not found', 'NOT_FOUND');
}

/** Trip details shown at the top (Travel Information keys of a lead or a client trip). */
const DETAIL_KEYS = [
  ['from', 'From'],
  ['to', 'To'],
  ['destination', 'Destination'],
  ['travel_start_date', 'Start date'],
  ['travel_end_date', 'End date'],
  ['nights', 'Nights'],
  ['days', 'Days'],
  ['date_flexibility', 'Date flexibility'],
  ['trip_type', 'Trip type'],
  ['trip_purpose', 'Trip purpose'],
  ['adults', 'Adults'],
  ['children', 'Children'],
  ['infants', 'Infants']
];

function tripOfValues(values, serviceNames) {
  const v = plain(values);
  const details = [];
  for (const [key, label] of DETAIL_KEYS) {
    const raw = v[key];
    if (raw === undefined || raw === null || raw === '') continue;
    details.push({ key, label, value: key.endsWith('_date') ? str(raw).slice(0, 10) : str(raw) });
  }
  const services = (Array.isArray(v.required_services) ? v.required_services : []).map((k) => serviceNames.get(str(k)) || str(k));
  return {
    destination: str(v.destination) || str(v.to),
    from: str(v.from),
    startDate: str(v.travel_start_date).slice(0, 10),
    endDate: str(v.travel_end_date).slice(0, 10),
    expectedTravellers: data.expectedTravellers(v),
    services,
    details
  };
}

/** A traveller without any document number or file: name, group, relation, passport status. */
function travellerView(t, today) {
  const exp = str(t.passport_expiry_date).slice(0, 10);
  let passport = 'Missing';
  if (exp && exp < today) passport = 'Expired';
  else if (str(t.passport_last4) || exp) passport = exp ? `Valid till ${exp}` : 'On file';
  return {
    id: str(t._id),
    name: `${str(t.first_name)} ${str(t.last_name)}`.trim() || 'Traveller',
    ageCategory: str(t.age_category),
    relation: str(t.relation),
    passport,
    aadhaar: str(t.aadhaar_last4) ? 'On file' : 'Missing'
  };
}

/** Quotations grouped by root: the latest revision of each, with how many revisions it has. */
function quotationViews(quotations) {
  const live = quotations.filter((q) => !q.isArchived);
  const latest = data.latestByRoot(live);
  const revisions = new Map();
  for (const q of live) revisions.set(ROOT(q), (revisions.get(ROOT(q)) || 0) + 1);
  return [...latest.entries()]
    .map(([root, q]) => ({
      id: str(q._id),
      number: str(q.quotationNo),
      title: str(q.title),
      version: num(q.version) || 1,
      revisions: revisions.get(root) || 1,
      status: str(q.status) || 'Draft',
      issueDate: day(q.issueDate || q.createdAt),
      total: money(q.grandTotal),
      currency: str(q.currency),
      link: `/quotations/${str(q._id)}`
    }))
    .sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1));
}

/** Tax invoices and proformas of the given quotations (a converted proforma is history, not a second bill). */
async function invoicesOf(sdk, quotationIds) {
  const ids = [...new Set(quotationIds.filter((id) => ID_RE.test(id)))];
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    rows.push(...(await sdk.crm.invoices.find({ quotationId: { $in: ids.slice(i, i + 100) } }, { limit: 100, sort: { issueDate: -1 } })));
  }
  const view = (inv) => ({
    id: str(inv._id),
    number: str(inv.invoiceNo),
    status: str(inv.status),
    issueDate: day(inv.issueDate),
    dueDate: day(inv.dueDate),
    total: money(inv.grandTotal || inv.total),
    balance: money(inv.balanceDue),
    currency: str(inv.currency),
    convertedTo: str(inv.convertedInvoiceNo),
    link: `/invoices/${str(inv._id)}`
  });
  const live = rows.filter((r) => !r.isArchived);
  return {
    invoices: live.filter((r) => str(r.documentType) !== 'proforma').map(view),
    proformas: live.filter((r) => str(r.documentType) === 'proforma').map(view)
  };
}

/** Paid / balance of the accepted quotation, from the CRM's verified payments only. */
async function paymentOf(sdk, quotations) {
  const accepted = quotations.find((q) => ['Accepted', 'Converted'].includes(q.status));
  if (!accepted || !sdk.finance || typeof sdk.finance.quotationPayment !== 'function') return null;
  const p = await sdk.finance.quotationPayment(accepted.id).catch(() => null);
  if (!p) return null;
  return { quotationNo: accepted.number, total: money(p.total), paid: money(p.paid), balance: money(p.balance), status: str(p.status), currency: str(p.currency) };
}

function bookingView(b, canFinance) {
  return {
    id: str(b._id),
    number: str(b.number),
    status: str(b.status),
    title: str(b.title),
    startDate: str(b.travel_start_date).slice(0, 10),
    endDate: str(b.travel_end_date).slice(0, 10),
    quotationNo: str(b.quotation_no),
    ...(canFinance ? { total: money(b.total), currency: str(b.currency) } : {}),
    link: `${BOOKINGS}?id=${str(b._id)}`
  };
}

const itineraryView = (it) => ({
  id: str(it._id),
  title: str(it.title) || 'Itinerary',
  version: num(it.version) || 1,
  status: str(it.status),
  quotationNo: str(it.quotation_no),
  link: `${ITINERARY}?id=${str(it._id)}`
});

/** Notes / activities through the CRM (older CRMs without the reader: none, with a note). */
async function timelineOf(sdk, type, id) {
  const read = async (reader) => {
    if (!reader || typeof reader.list !== 'function') return null;
    try {
      return await reader.list(type, id);
    } catch {
      return null;
    }
  };
  const [notes, activities] = await Promise.all([read(sdk.crm.notes), read(sdk.crm.activities)]);
  const note = (n) => ({ id: str(n.id), title: str(n.title), text: str(n.content).slice(0, 600), author: str(n.createdByName), date: str(n.createdAt), private: n.isPrivate === true, pinned: n.isPinned === true });
  const activity = (a) => ({ id: str(a.id), title: str(a.title), type: str(a.eventType), status: str(a.status), date: str(a.eventDate || a.createdAt), text: str(a.description).slice(0, 400), owner: str(a.assignedToName || a.createdByName) });
  return {
    notes: notes ? notes.map(note) : [],
    activities: activities ? activities.map(activity) : [],
    timelineAvailable: Boolean(notes || activities)
  };
}

function counts(out) {
  return {
    quotations: out.quotations ? out.quotations.length : null,
    invoices: out.invoices ? out.invoices.length : null,
    proformas: out.proformas ? out.proformas.length : null,
    activities: out.activities.length,
    notes: out.notes.length,
    requirements: out.requirements.length,
    bookings: out.bookings ? out.bookings.length : null,
    itineraries: out.itineraries.length,
    travellers: out.travellers.length
  };
}

/* ------------------------------------------------------------------ lead trip */

exports.leadTrip = async (req, sdk) => {
  await assertStaff(sdk);
  const leadId = str(req.params && (req.params.lead_id || req.params.trip_id));
  if (!ID_RE.test(leadId)) throw sdk.error(400, 'lead_id is not valid', 'INVALID_INPUT');
  const lead = await sdk.crm.leads.findById(leadId);
  if (!lead) throw sdk.error(404, 'Trip not found', 'NOT_FOUND');
  if (str(lead.mergedIntoId)) return { redirect: { lead: str(lead.mergedIntoId) } };

  const canFinance = has(sdk, 'crm.finance.read');
  const canBookings = has(sdk, 'x.travel.bookings.read');
  const timeZone = await store.timeZoneOf(sdk);
  const today = todayIn(timeZone);
  const [values, services] = await Promise.all([sdk.values.get('lead', leadId).catch(() => ({})), readServices(sdk)]);
  const serviceNames = new Map(services.map((s) => [s.key, s.name]));

  const [reqRows, travellers, itineraries, bookings, quotationRows, timeline] = await Promise.all([
    sdk.models.TravelRequirement.find({ lead_id: leadId }, { limit: 100, sort: { createdAt: 1 } }),
    sdk.models.Traveller.find({ lead_id: leadId }, { limit: 100, sort: { createdAt: 1 } }),
    sdk.models.Itinerary.find({ lead_id: leadId }, { limit: 50, sort: { createdAt: -1 } }),
    canBookings ? sdk.models.Booking.find({ lead_id: leadId }, { limit: 50, sort: { createdAt: -1 } }) : null,
    canFinance ? sdk.crm.quotations.find({ leadId }, { limit: 100, sort: { createdAt: -1 } }) : null,
    timelineOf(sdk, 'lead', leadId)
  ]);

  const quotations = quotationRows ? quotationViews(quotationRows) : null;
  const bills = canFinance ? await invoicesOf(sdk, (quotationRows || []).map((q) => str(q._id))) : null;
  const clientId = str(lead.convertedClientId || lead.clientId);
  const tab = (id) => `/leads/${leadId}?tab=${id}`;
  const out = {
    kind: 'lead',
    id: leadId,
    title: str(lead.title) || str(lead.name) || 'Trip',
    name: str(lead.name),
    company: str(lead.company),
    stage: str(lead.stage),
    assignedTo: str(lead.assignedTo),
    createdAt: day(lead.createdAt),
    trip: tripOfValues(values, serviceNames),
    client: clientId ? { id: clientId, link: `/clients/${clientId}` } : null,
    requirements: reqRows
      .filter((r) => r.removed !== true)
      .map((r) => ({ id: str(r._id), service: str(r.service_name) || serviceNames.get(str(r.service_key)) || str(r.service_key), label: str(r.label), status: str(r.status) || 'Draft' })),
    travellers: travellers.map((t) => travellerView(t, today)),
    itineraries: itineraries.map(itineraryView),
    bookings: bookings ? bookings.map((b) => bookingView(b, canFinance)) : null,
    quotations,
    invoices: bills ? bills.invoices : null,
    proformas: bills ? bills.proformas : null,
    payment: canFinance && quotations ? await paymentOf(sdk, quotations) : null,
    notes: timeline.notes,
    activities: timeline.activities,
    timelineAvailable: timeline.timelineAvailable,
    notesScope: 'trip',
    links: {
      record: `/leads/${leadId}`,
      requirements: tab('ext__travel__travel-requirement'),
      travellers: tab('ext__travel__travellers'),
      bookings: tab('ext__travel__bookings'),
      activities: tab('activities'),
      notes: tab('notes')
    }
  };
  out.counts = counts(out);
  return out;
};

/* ---------------------------------------------------------------- client trip */

exports.clientTrip = async (req, sdk) => {
  await assertStaff(sdk);
  const tripId = str(req.params && req.params.trip_id);
  if (!ID_RE.test(tripId)) throw sdk.error(400, 'trip_id is not valid', 'INVALID_INPUT');
  if (!has(sdk, 'crm.clients.read') || !sdk.models.ClientTravelRequirement) throw sdk.error(404, 'Trip not found', 'NOT_FOUND');
  const row = await sdk.models.ClientTravelRequirement.findById(tripId).catch(() => null);
  if (!row) throw sdk.error(404, 'Trip not found', 'NOT_FOUND');
  // Opened as an enquiry lead: the lead holds this trip now (shown once, as the lead trip).
  if (str(row.lead_id)) return { redirect: { lead: str(row.lead_id) } };
  const clientId = str(row.client_id);
  const client = ID_RE.test(clientId) ? await sdk.crm.clients.findById(clientId).catch(() => null) : null;
  if (!client) throw sdk.error(404, 'Trip not found', 'NOT_FOUND');

  const canFinance = has(sdk, 'crm.finance.read');
  const canBookings = has(sdk, 'x.travel.bookings.read');
  const timeZone = await store.timeZoneOf(sdk);
  const today = todayIn(timeZone);
  const services = await readServices(sdk);
  const serviceNames = new Map(services.map((s) => [s.key, s.name]));
  const travellerIds = (Array.isArray(row.traveller_ids) ? row.traveller_ids : []).map(str).filter((id) => ID_RE.test(id));

  const [travellers, bookingRows, quotationRows, timeline] = await Promise.all([
    travellerIds.length ? sdk.models.Traveller.find({ _id: { $in: travellerIds.slice(0, 100) } }, { limit: 100 }) : [],
    canBookings ? sdk.models.Booking.find({ client_trip_id: tripId }, { limit: 50, sort: { createdAt: -1 } }) : null,
    canFinance ? sdk.crm.quotations.find({ extensionRecordId: tripId }, { limit: 100, sort: { createdAt: -1 } }) : null,
    timelineOf(sdk, 'client', clientId)
  ]);
  // Older rows: the quotation / booking ids kept on the trip itself.
  let quotes = (quotationRows || []).filter((q) => str(q.clientId) === clientId);
  if (canFinance && ID_RE.test(str(row.quotation_id)) && !quotes.some((q) => str(q._id) === str(row.quotation_id))) {
    const q = await sdk.crm.quotations.findById(str(row.quotation_id)).catch(() => null);
    if (q && str(q.clientId) === clientId) quotes = quotes.concat(q);
  }
  let bookings = bookingRows;
  if (bookings && ID_RE.test(str(row.booking_id)) && !bookings.some((b) => str(b._id) === str(row.booking_id))) {
    const b = await sdk.models.Booking.findById(str(row.booking_id)).catch(() => null);
    if (b && str(b.client_id) === clientId) bookings = bookings.concat(b);
  }
  const itineraries = quotes.length ? await sdk.models.Itinerary.find({ quotation_id: { $in: quotes.map((q) => str(q._id)) } }, { limit: 50, sort: { createdAt: -1 } }) : [];
  const quotations = canFinance ? quotationViews(quotes) : null;
  const bills = canFinance ? await invoicesOf(sdk, quotes.map((q) => str(q._id))) : null;
  const reqs = plain(row.requirements);
  const clientTab = (id) => `/clients/${clientId}?tab=${id}`;
  const out = {
    kind: 'client',
    id: tripId,
    title: str(client.name) || 'Client trip',
    name: str(client.name),
    company: str(client.name),
    stage: str(row.status) || 'Draft',
    assignedTo: str(row.created_by),
    createdAt: day(row.createdAt),
    trip: tripOfValues(row.values, serviceNames),
    client: { id: clientId, name: str(client.name), link: `/clients/${clientId}` },
    requirements: Object.keys(reqs).map((key) => ({ id: key, service: serviceNames.get(key) || key, label: '', status: Object.keys(plain(reqs[key])).length ? 'Filled' : 'Draft' })),
    travellers: travellers.map((t) => travellerView(t, today)),
    itineraries: itineraries.map(itineraryView),
    bookings: bookings ? bookings.map((b) => bookingView(b, canFinance)) : null,
    quotations,
    invoices: bills ? bills.invoices : null,
    proformas: bills ? bills.proformas : null,
    payment: canFinance && quotations ? await paymentOf(sdk, quotations) : null,
    notes: timeline.notes,
    activities: timeline.activities,
    timelineAvailable: timeline.timelineAvailable,
    // Client notes and activities belong to the client, not to one trip.
    notesScope: 'client',
    links: {
      record: `/clients/${clientId}`,
      requirements: clientTab('ext:travel_requirement'),
      travellers: clientTab('ext:travellers'),
      bookings: clientTab('ext:bookings'),
      activities: clientTab('timeline'),
      notes: clientTab('notes'),
      quotations: clientTab('quotations'),
      invoices: clientTab('invoices')
    }
  };
  out.counts = counts(out);
  return out;
};

/** GET /trips/:kind/:trip_id — kind "lead" or "client". */
exports.trip = async (req, sdk) => {
  const kind = str(req.params && req.params.kind);
  if (kind === 'lead') return exports.leadTrip(req, sdk);
  if (kind === 'client') return exports.clientTrip(req, sdk);
  throw sdk.error(404, 'Trip not found', 'NOT_FOUND');
};

/* ---------------------------------------------------------------- Trips report */

/** Client trips with no lead (a client trip with a lead is that lead's trip), oldest first. */
async function clientTripRows(sdk) {
  const Model = sdk.models.ClientTravelRequirement;
  if (!Model) return [];
  const rows = [];
  for (let skip = 0; skip < CLIENT_TRIP_LIMIT; skip += 500) {
    const page = await Model.find({}, { limit: 500, skip, sort: { createdAt: 1 } });
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows.filter((r) => !str(r.lead_id) && ID_RE.test(str(r.client_id)));
}

exports.report = async (req, sdk) => {
  await assertStaff(sdk);
  const ctx = await data.load(sdk, req.query);
  const { f, inRange, canFinance } = ctx;
  const canBookings = has(sdk, 'x.travel.bookings.read');
  const liveBookings = (list) => list.filter((b) => str(b.status) !== 'Cancelled');
  const bookingLabel = (list) => {
    const live = liveBookings(list).sort((a, b) => (day(a.createdAt) < day(b.createdAt) ? 1 : -1));
    if (live.length) return live[0].status ? str(live[0].status) : 'Booked';
    return list.length ? 'Cancelled' : '';
  };
  const paymentLabel = (quotes) => {
    if (!ctx.finance) return '';
    const accepted = quotes.find(ACCEPTED);
    if (!accepted) return '';
    const st = ctx.finance.quotations[str(accepted._id)];
    return st ? st.paymentGroup : 'Unpaid';
  };

  // Lead trips (the report universe: scope and lead filters already applied by report-data).
  const quotesByLead = new Map();
  for (const q of ctx.quotations) {
    const id = ctx.leadOfQuotation(q);
    if (!quotesByLead.has(id)) quotesByLead.set(id, []);
    quotesByLead.get(id).push(q);
  }
  const bookingsByLead = new Map();
  for (const b of ctx.bookings) {
    const id = str(b.lead_id);
    if (!bookingsByLead.has(id)) bookingsByLead.set(id, []);
    bookingsByLead.get(id).push(b);
  }
  const travellersByLead = new Map();
  for (const t of ctx.travellers) travellersByLead.set(str(t.lead_id), (travellersByLead.get(str(t.lead_id)) || 0) + 1);

  const rows = [];
  for (const lead of ctx.leads) {
    if (!inRange(day(lead.createdAt))) continue;
    const id = str(lead._id);
    const v = plain(ctx.values[id]);
    const quotes = (quotesByLead.get(id) || []).filter((q) => !q.isArchived);
    const bookingList = bookingsByLead.get(id) || [];
    const expected = data.expectedTravellers(v);
    const have = travellersByLead.get(id) || 0;
    rows.push({
      created: day(lead.createdAt),
      source: 'Lead',
      trip: str(lead.title) || str(lead.name) || 'Trip',
      client: str(lead.company) || str(lead.name),
      destination: ctx.destOf(id),
      date: str(v.travel_start_date).slice(0, 10),
      travellers: expected ? `${have} of ${expected}` : String(have),
      status: str(lead.stage),
      owner: str(lead.assignedTo),
      ...(canFinance ? { quotations: data.latestByRoot(quotes).size, payment: paymentLabel(quotes) } : {}),
      ...(canBookings ? { booking: bookingLabel(bookingList) } : {}),
      _link: `${TRIP_PAGE}?lead=${id}`,
      _booked: liveBookings(bookingList).length > 0
    });
  }

  // Client trips (no lead): need crm.clients.read; lead-only filters (lead source, payment of a lead) skip them.
  let clientCount = 0;
  if (has(sdk, 'crm.clients.read') && !f.source) {
    let trips = (await clientTripRows(sdk)).filter((r) => inRange(day(r.createdAt)));
    if (f.owner) trips = trips.filter((r) => str(r.created_by) === f.owner);
    if (f.destination) trips = trips.filter((r) => keyOf(str(plain(r.values).destination) || str(plain(r.values).to)) === f.destination);
    if (f.service) trips = trips.filter((r) => (Array.isArray(plain(r.values).required_services) ? plain(r.values).required_services : []).includes(f.service));
    const tripIds = trips.map((r) => str(r._id));
    const clientIds = [...new Set(trips.map((r) => str(r.client_id)))];
    const clients = new Map();
    for (let i = 0; i < clientIds.length; i += 100) {
      for (const c of await sdk.crm.clients.findByIds(clientIds.slice(i, i + 100))) clients.set(str(c._id), c);
    }
    const quotesByTrip = new Map();
    if (canFinance && tripIds.length) {
      for (let i = 0; i < tripIds.length; i += 100) {
        const part = tripIds.slice(i, i + 100);
        for (let skip = 0; skip < 5000; skip += 100) {
          const page = await sdk.crm.quotations.find({ extensionRecordId: { $in: part } }, { limit: 100, skip, sort: { createdAt: 1 } });
          for (const q of page) {
            const k = str(q.extensionRecordId);
            if (!quotesByTrip.has(k)) quotesByTrip.set(k, []);
            quotesByTrip.get(k).push(q);
          }
          if (page.length < 100) break;
        }
      }
    }
    let tripFinance = null;
    if (canFinance && sdk.finance && typeof sdk.finance.summary === 'function') {
      const accepted = [...quotesByTrip.values()].flat().filter(ACCEPTED).map((q) => str(q._id));
      if (accepted.length) tripFinance = await sdk.finance.summary({ quotationIds: accepted }).catch(() => null);
    }
    const bookingsByTrip = new Map();
    if (canBookings && tripIds.length) {
      for (let i = 0; i < tripIds.length; i += 500) {
        for (const b of await sdk.models.Booking.find({ client_trip_id: { $in: tripIds.slice(i, i + 500) } }, { limit: 500 })) {
          const k = str(b.client_trip_id);
          if (!bookingsByTrip.has(k)) bookingsByTrip.set(k, []);
          bookingsByTrip.get(k).push(b);
        }
      }
    }
    for (const r of trips) {
      const id = str(r._id);
      const client = clients.get(str(r.client_id));
      if (!client) continue; // a client this user may not open
      const v = plain(r.values);
      const quotes = (quotesByTrip.get(id) || []).filter((q) => !q.isArchived && str(q.clientId) === str(r.client_id));
      const bookingList = (bookingsByTrip.get(id) || []).filter((b) => str(b.client_id) === str(r.client_id));
      if (f.bookingStatus && !bookingList.some((b) => str(b.status) === f.bookingStatus)) continue;
      const accepted = quotes.find(ACCEPTED);
      const pay = tripFinance && accepted ? (tripFinance.quotations[str(accepted._id)] || {}).paymentGroup || 'Unpaid' : '';
      if (f.paymentStatus && pay !== f.paymentStatus) continue;
      const expected = data.expectedTravellers(v);
      const have = Array.isArray(r.traveller_ids) ? r.traveller_ids.length : 0;
      clientCount += 1;
      rows.push({
        created: day(r.createdAt),
        source: 'Client',
        trip: `${str(v.destination) || str(v.to) || 'Trip'} – ${str(client.name)}`,
        client: str(client.name),
        destination: str(v.destination) || str(v.to),
        date: str(v.travel_start_date).slice(0, 10),
        travellers: expected ? `${have} of ${expected}` : String(have),
        status: str(r.status) || 'Draft',
        owner: str(r.created_by),
        ...(canFinance ? { quotations: data.latestByRoot(quotes).size, payment: pay } : {}),
        ...(canBookings ? { booking: bookingLabel(bookingList) } : {}),
        _link: `${TRIP_PAGE}?client_trip=${id}`,
        _booked: liveBookings(bookingList).length > 0
      });
    }
  }

  rows.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  const leadCount = rows.length - clientCount;
  const booked = rows.filter((r) => r._booked).length;
  const upcoming = rows.filter((r) => r.date && r.date >= ctx.today).length;
  return {
    trips: {
      items: [
        { key: 'total', label: 'Total Trips', value: rows.length },
        { key: 'leads', label: 'From Leads', value: leadCount, tone: 'info' },
        { key: 'clients', label: 'From Clients', value: clientCount, tone: 'info' },
        ...(canBookings ? [{ key: 'booked', label: 'Booked', value: booked, tone: 'success' }] : []),
        { key: 'upcoming', label: 'Travel Date Ahead', value: upcoming }
      ],
      columns: [
        { key: 'created', label: 'Created', type: 'date' },
        { key: 'source', label: 'From', type: 'status' },
        { key: 'trip', label: 'Trip', type: 'text' },
        { key: 'client', label: 'Client / Lead', type: 'text' },
        { key: 'destination', label: 'Destination', type: 'text' },
        { key: 'date', label: 'Travel Date', type: 'date' },
        { key: 'travellers', label: 'Travellers', type: 'text' },
        { key: 'status', label: 'Status', type: 'status' },
        ...(canFinance ? [{ key: 'quotations', label: 'Quotations', type: 'number' }] : []),
        ...(canBookings ? [{ key: 'booking', label: 'Booking', type: 'status' }] : []),
        ...(canFinance ? [{ key: 'payment', label: 'Payment', type: 'status' }] : []),
        { key: 'owner', label: 'Sales Person', type: 'user' }
      ],
      rows: rows.slice(0, MAX_ROWS).map(({ _booked, ...r }) => r),
      total: rows.length
    }
  };
};
