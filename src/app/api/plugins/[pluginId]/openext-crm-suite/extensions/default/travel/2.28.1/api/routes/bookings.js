'use strict';

/**
 * Bookings (spec §6.5): one booking per accepted quotation, one booking service per quotation line.
 *
 * POST /bookings/from-quotation            record action "Create Booking" { recordId } → { message, navigate }
 * POST /sales-flow/quotation-accepted      CRM hook after a quotation is accepted → booking made automatically
 *                                          (setting auto_create_booking_on_accept) → { ok, skipped?, message }
 * POST /sales-flow/quotation-paid          CRM hook after each verified payment → the same, once paid enough
 *
 * Payment rule: a booking needs the CRM's verified payments to allow it (sdk.finance.quotationPayment
 * bookingEligible: the advance when Settings → General allows it, otherwise the full amount) —
 * 409 QUOTATION_NOT_PAID. One booking per quotation (quotation_id unique).
 * GET  /bookings                           list: status / q / from / to / lead_id / after (cursor), counts
 * GET  /bookings/:id                       booking + travellers (masked) + services, history, vouchers, itineraries
 * GET  /bookings/:id/traveller-options     travellers of the lead and of the contact's other leads
 * PUT  /bookings/:id                       notes, travellers, travel dates
 * POST /bookings/:id/cancel                reason required; cancels services and live vouchers
 * POST /bookings/:id/complete              Confirmed and the trip has ended (setting allow_early_completion)
 * GET  /leads/:lead_id/bookings            bookings and itineraries of a lead (lead tab)
 * GET  /clients/:client_id/bookings        bookings of a client, from its leads and opportunities (client tab)
 *
 * Money (rate, amount, total) only for users with crm.finance.read. Audit entries carry ids, never
 * document numbers or prices.
 */

const store = require('../services/booking-store.js');
const voucherDoc = require('../services/voucher-doc.js');
const { itinerarySettings } = require('../services/itinerary.js');
const { BOOKING_STATUSES } = require('../services/booking-status.js');
const { todayIn } = require('../services/availability.js');
const rules = require('../services/traveller-rules.js');
const leadAccess = require('../services/lead-access.js');

const { str, ID_RE } = store;
const PAGE_SIZE = 25;

// Accepted, or Accepted and already invoiced (the CRM marks an invoiced quotation Converted).
const BOOKABLE = ['Accepted', 'Converted'];

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function bookingExists(sdk, booking) {
  const error = sdk.error(409, `Booking ${booking.number} already exists for this quotation`, 'BOOKING_EXISTS');
  error.details = [store.bookingLink(booking._id)];
  return error;
}

async function leadIdOf(sdk, q) {
  if (ID_RE.test(str(q.leadId))) return str(q.leadId);
  if (ID_RE.test(str(q.opportunityId))) {
    try {
      const opp = await sdk.crm.opportunities.findById(q.opportunityId);
      if (opp && ID_RE.test(str(opp.leadId))) return str(opp.leadId);
    } catch {
      /* no opportunity read permission: the quotation needs its own lead */
    }
  }
  return '';
}

async function loadChecks(sdk, ids) {
  const Checks = sdk.models.AvailabilityCheck;
  if (!Checks || !ids.length) return [];
  try {
    return await Checks.find({ _id: { $in: ids } }, { limit: 200 });
  } catch {
    return [];
  }
}

/**
 * Every booking-service row of a quotation, built and checked before anything is written.
 * Line sourceRef "<requirementId>:<availabilityCheckId>" links the requirement (of this lead only)
 * and the availability check the price came from.
 */
/**
 * 2.28.0: the client trip (ClientTravelRequirement) a quotation without a lead was made for
 * (CRM 3.51.0 quotation.extensionRecordId), checked against the quotation's client; else null.
 */
async function clientTripOfQuotation(sdk, q) {
  const tripId = str(q && q.extensionRecordId);
  const clientId = str(q && q.clientId);
  if (!ID_RE.test(tripId) || !ID_RE.test(clientId) || !sdk.models.ClientTravelRequirement) return null;
  const trip = await sdk.models.ClientTravelRequirement.findById(tripId).catch(() => null);
  if (!trip || str(trip.client_id) !== clientId || str(trip.lead_id)) return null;
  return trip;
}

async function buildServiceRows(sdk, q, leadId, trip = null) {
  const lines = Array.isArray(q.lineItems) ? q.lineItems : [];
  const refs = lines.map((l) => str(l && l.sourceRef).slice(0, 64));
  const reqIds = [...new Set(refs.map((r) => r.split(':')[0]).filter((id) => ID_RE.test(id)))];
  const checkIds = [...new Set(refs.map((r) => r.split(':')[1] || '').filter((id) => ID_RE.test(id)))];
  const [services, requirements, checks] = await Promise.all([
    store.readServicesFull(sdk),
    reqIds.length ? sdk.models.TravelRequirement.find({ _id: { $in: reqIds } }, { limit: 200 }) : [],
    loadChecks(sdk, checkIds)
  ]);
  const byKey = new Map(services.map((s) => [s.key, s]));
  const reqById = new Map(requirements.filter((r) => str(r.lead_id) === leadId).map((r) => [str(r._id), r]));
  // 2.28.0: a client trip's lines link "trip-<service key>" to the trip's saved service form.
  if (trip) {
    const { TRIP_REF_PREFIX } = require('../services/sales-prefill.js');
    const forms = trip.requirements && typeof trip.requirements === 'object' ? trip.requirements : {};
    for (const ref of refs) {
      const key = ref.split(':')[0];
      if (!key.startsWith(TRIP_REF_PREFIX)) continue;
      const serviceKey = key.slice(TRIP_REF_PREFIX.length);
      if (forms[serviceKey] && typeof forms[serviceKey] === 'object') reqById.set(key, { _id: '', service_key: serviceKey, values: forms[serviceKey] });
    }
  }
  const checkById = new Map(checks.map((c) => [str(c._id), c]));
  const errors = [];
  const rows = lines.map((line, index) => {
    const l = line && typeof line === 'object' ? line : {};
    const ref = refs[index];
    const [reqId, checkId] = ref.split(':');
    const requirement = reqById.get(reqId) || null;
    const service = requirement ? byKey.get(str(requirement.service_key)) || null : null;
    const check = checkId ? checkById.get(checkId) || null : null;
    const usableCheck = check && (!str(check.requirement_id) || str(check.requirement_id) === reqId) ? check : null;
    const extra = l.extra && typeof l.extra === 'object' ? l.extra : {};
    const snapshot = {
      status: str(usableCheck ? usableCheck.status : extra.availability).slice(0, 40),
      provider: str(usableCheck ? usableCheck.provider : extra.provider).slice(0, 120),
      valid_until: usableCheck ? str(usableCheck.valid_until) : '',
      checked_at: usableCheck ? str(usableCheck.checked_at) : ''
    };
    const values = requirement && requirement.values && typeof requirement.values === 'object' ? requirement.values : {};
    const cfg = service ? itinerarySettings(service) : null;
    const start = cfg && cfg.start && store.isDay(str(values[cfg.start]).slice(0, 10)) ? str(values[cfg.start]).slice(0, 10) : '';
    const end = cfg && cfg.end && store.isDay(str(values[cfg.end]).slice(0, 10)) ? str(values[cfg.end]).slice(0, 10) : '';
    const name = (str(l.name) || str(l.description).split('\n')[0] || (service && service.name) || '').slice(0, 200);
    if (!name) errors.push(`Line ${index + 1} has no name`);
    for (const [label, v] of [['quantity', l.qty], ['rate', l.rate], ['amount', l.amount]]) {
      if (v !== undefined && v !== null && v !== '' && (num(v) === null || num(v) < 0)) errors.push(`Line ${index + 1}: ${label} is not a number`);
    }
    return {
      line_index: index,
      source_ref: ref,
      requirement_id: requirement ? str(requirement._id) : '',
      service_key: service ? service.key : '',
      voucher_type: service ? store.voucherTypeOf(service) : 'none',
      name,
      description: str(l.description).slice(0, 2000),
      unit: str(l.unit).slice(0, 60),
      quantity: num(l.qty),
      rate: num(l.rate),
      amount: num(l.amount),
      start_date: start,
      end_date: end && end >= start ? end : '',
      service_details: store.detailRows(service, values),
      availability_snapshot: snapshot,
      provider: snapshot.provider,
      status: 'Not Requested',
      documents: []
    };
  });
  if (errors.length) {
    const error = sdk.error(400, `The quotation lines cannot be booked: ${errors.slice(0, 5).join('; ')}`, 'INVALID_QUOTATION_LINES');
    error.details = errors.slice(0, 20);
    throw error;
  }
  return rows;
}

const bookingLine = (bookingId, lineIndex) => `${bookingId}:${lineIndex}`;

/**
 * Creates the rows whose line_index is not there yet (idempotent: a half-created booking is completed).
 * Every row carries the unique booking_line "<bookingId>:<line_index>", so two resumes at the same
 * moment cannot create one line twice (DUPLICATE = the other request made it). Older rows get the key here.
 */
async function createMissing(sdk, booking, rows) {
  const have = await sdk.models.BookingService.find({ booking_id: booking._id }, { limit: 500 });
  const done = new Set(have.map((s) => Number(s.line_index)));
  for (const s of have) {
    const key = bookingLine(booking._id, Number(s.line_index) || 0);
    if (str(s.booking_line) === key) continue;
    try {
      await sdk.models.BookingService.updateById(s._id, { booking_line: key });
    } catch (error) {
      // An older duplicate of the same line: the first one keeps the key.
      if (!(error && (error.status === 409 || error.code === 'DUPLICATE'))) throw error;
    }
  }
  let created = 0;
  for (const row of rows) {
    if (done.has(row.line_index)) continue;
    try {
      await sdk.models.BookingService.create({ ...row, booking_id: booking._id, booking_line: bookingLine(booking._id, row.line_index) });
      created += 1;
    } catch (error) {
      if (!(error && (error.status === 409 || error.code === 'DUPLICATE'))) throw error;
    }
  }
  return created;
}

async function linkItineraries(sdk, quotationId, bookingId) {
  const finals = await sdk.models.Itinerary.find({ quotation_id: quotationId, status: 'Final' }, { limit: 20 });
  for (const it of finals) if (str(it.booking_id) !== bookingId) await sdk.models.Itinerary.updateById(it._id, { booking_id: bookingId });
}

/* ------------------------------------------------------- create from quotation */

/**
 * CRM hook (salesFlow.quotationForm.acceptedRoute), called after a quotation is accepted — by the
 * client, on the portal link, or by a payment. Makes the booking at once, so it shows in Bookings
 * without anyone pressing "Create Booking". Expected refusals (already booked, no lines, no lead)
 * are reported as skipped; nothing here can undo the acceptance.
 */
// Expected refusals of an automatic booking: reported as skipped, never an error for the CRM.
const SKIPPED = ['BOOKING_EXISTS', 'QUOTATION_NO_LINES', 'QUOTATION_NO_LEAD', 'QUOTATION_NOT_ACCEPTED', 'QUOTATION_NOT_PAID'];

exports.quotationAccepted = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const qid = str(body.quotationId);
  if (!ID_RE.test(qid)) throw sdk.error(400, 'quotationId is not valid', 'INVALID_INPUT');
  if ((await sdk.settings.get('auto_create_booking_on_accept')) === false) {
    return { ok: true, skipped: true, message: 'Automatic bookings are off (Settings → Travel)' };
  }
  try {
    const made = await exports.fromQuotation({ ...req, body: { recordId: qid, recordType: 'quotation' } }, sdk);
    return { ok: true, message: made.message, booking: made.booking };
  } catch (error) {
    const code = error && error.code;
    if (SKIPPED.includes(code)) {
      return { ok: true, skipped: true, message: error.message };
    }
    throw error;
  }
};

/**
 * CRM hook (salesFlow.quotationForm.paidRoute), called after every verified payment on a quotation —
 * Razorpay, a webhook or staff. Makes the booking once the payment rule allows it (advance or full,
 * CRM Settings → General). Repeated calls find the booking already made: one booking per quotation.
 */
exports.quotationPaid = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const qid = str(body.quotationId);
  if (!ID_RE.test(qid)) throw sdk.error(400, 'quotationId is not valid', 'INVALID_INPUT');
  return exports.quotationAccepted(req, sdk);
};

exports.fromQuotation = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const qid = str(body.recordId);
  if (!ID_RE.test(qid) || (body.recordType && body.recordType !== 'quotation')) {
    throw sdk.error(400, 'recordId must be a quotation id', 'INVALID_INPUT');
  }
  const q = await sdk.crm.quotations.findById(qid);
  if (!q) throw sdk.error(404, 'Quotation not found', 'NOT_FOUND');
  if (!BOOKABLE.includes(q.status)) {
    throw sdk.error(400, `Only an accepted quotation can be booked (this one is ${q.status || 'Draft'})`, 'QUOTATION_NOT_ACCEPTED');
  }
  if (!Array.isArray(q.lineItems) || !q.lineItems.length) {
    throw sdk.error(400, 'This quotation has no lines — there is nothing to book', 'QUOTATION_NO_LINES');
  }
  const leadId = await leadIdOf(sdk, q);
  // 2.28.0: a client quotation made for the client's trip record (no lead).
  const trip = leadId ? null : await clientTripOfQuotation(sdk, q);
  if (!leadId && !trip) throw sdk.error(400, 'This quotation has no lead — a booking needs the lead and its travellers', 'QUOTATION_NO_LEAD');
  const lead = leadId ? await sdk.crm.leads.findById(leadId) : null;
  if (leadId && !lead) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  const tripClient = trip ? await sdk.crm.clients.findById(str(q.clientId)).catch(() => null) : null;
  if (trip && !tripClient) throw sdk.error(404, 'Client not found', 'NOT_FOUND');

  // Build and check every service row first, so a bad line never leaves a half-made booking.
  const rows = await buildServiceRows(sdk, q, leadId, trip);

  const existing = await sdk.models.Booking.findOne({ quotation_id: qid });
  if (existing) {
    const have = await sdk.models.BookingService.count({ booking_id: existing._id });
    if (have >= rows.length || !store.isOpen(existing)) throw bookingExists(sdk, existing);
    const added = await createMissing(sdk, existing, rows);
    await sdk.audit('updated', `Booking ${existing.number} completed from quotation ${q.quotationNo || qid} (${added} services added)`, { bookingId: existing._id, quotationId: qid, added });
    return { message: `Booking ${existing.number} completed`, navigate: store.bookingLink(existing._id), booking: { id: existing._id, number: existing.number } };
  }

  // Payment rule (CRM Settings → General, verified payments only): advance or full amount first.
  const gate = await store.paymentGate(sdk, qid);
  if (!gate.bookingEligible) {
    throw sdk.error(409, `No booking yet: ${gate.bookingReason}`, 'QUOTATION_NOT_PAID');
  }

  const tripTravellerIds = trip ? (Array.isArray(trip.traveller_ids) ? trip.traveller_ids : []).map(str).filter((id) => ID_RE.test(id)).slice(0, 200) : [];
  const [values, travellers, prefixSetting] = await Promise.all([
    trip ? Promise.resolve(trip.values && typeof trip.values === 'object' ? trip.values : {}) : sdk.values.get('lead', leadId),
    trip
      ? tripTravellerIds.length ? sdk.models.Traveller.find({ _id: { $in: tripTravellerIds } }, { limit: 200, sort: { createdAt: 1 } }) : Promise.resolve([])
      : sdk.models.Traveller.find({ lead_id: leadId }, { limit: 200, sort: { createdAt: 1 } }),
    sdk.settings.get('booking_prefix')
  ]);
  const dates = rows.flatMap((r) => [r.start_date, r.end_date]).filter(Boolean).sort();
  const start = store.isDay(str(values.travel_start_date).slice(0, 10)) ? str(values.travel_start_date).slice(0, 10) : dates[0] || '';
  const endRaw = store.isDay(str(values.travel_end_date).slice(0, 10)) ? str(values.travel_end_date).slice(0, 10) : dates[dates.length - 1] || '';
  const destination = str(values.destination) || str(values.to);
  const prefix = str(prefixSetting).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10) || 'BK';
  const number = `${prefix}-${String(await sdk.sequence.next('booking')).padStart(4, '0')}`;

  let booking;
  try {
    booking = await sdk.models.Booking.create({
      number,
      // 2.28.0: a client trip's booking has no lead; it belongs to the client and its trip record.
      ...(leadId ? { lead_id: leadId } : {}),
      ...(trip ? { client_id: str(q.clientId), client_trip_id: str(trip._id) } : {}),
      contact_id: lead ? str(lead.contactId) : '',
      opportunity_id: str(q.opportunityId),
      quotation_id: qid,
      quotation_no: str(q.quotationNo),
      quotation_version: Number(q.version) || 1,
      title: (str(q.title) || (lead ? str(lead.title) : '') || `${destination || 'Trip'} booking`).slice(0, 200),
      guest_name: (lead ? str(lead.name) : str(tripClient && tripClient.name)).slice(0, 120),
      // Snapshot: a later change of the Contact / lead company never rewrites this booking.
      company_name: (lead ? str(lead.company) : str(tripClient && tripClient.name)).slice(0, 120),
      travel_start_date: start,
      travel_end_date: endRaw && endRaw >= start ? endRaw : start,
      destination: destination.slice(0, 120),
      traveller_ids: travellers.map((t) => str(t._id)),
      status: 'Pending',
      currency: str(q.currency) || 'INR',
      total: num(q.grandTotal) || 0,
      notes: ''
    });
  } catch (error) {
    // Two clicks at once: quotation_id is unique, the second create fails here.
    if (error && (error.status === 409 || error.code === 'DUPLICATE')) {
      const again = await sdk.models.Booking.findOne({ quotation_id: qid });
      if (again) throw bookingExists(sdk, again);
    }
    throw error;
  }
  await createMissing(sdk, booking, rows);
  await linkItineraries(sdk, qid, booking._id);
  // 2.28.0: the client trip is booked (closed): the client's next Travel Requirement starts a new trip.
  if (trip) {
    await sdk.models.ClientTravelRequirement.updateById(trip._id, { status: 'Booked', booking_id: str(booking._id), quotation_id: qid });
  }
  await sdk.audit('created', `Booking ${number} created from quotation ${q.quotationNo || qid} (${rows.length} services)`, {
    bookingId: booking._id,
    quotationId: qid,
    leadId,
    ...(trip ? { clientId: str(q.clientId), clientTripId: str(trip._id) } : {}),
    services: rows.length
  });
  return { message: `Booking ${number} created`, navigate: store.bookingLink(booking._id), booking: { id: booking._id, number } };
};

/**
 * Record action "Open Booking" on an invoice (page invoiceDetail): the booking of the invoice's quotation.
 * POST /bookings/for-invoice { recordId } → { navigate } | 404 NO_BOOKING (with why: payment rule)
 */
exports.forInvoice = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const invoiceId = str(body.recordId);
  if (!ID_RE.test(invoiceId) || (body.recordType && body.recordType !== 'invoice')) {
    throw sdk.error(400, 'recordId must be an invoice id', 'INVALID_INPUT');
  }
  const invoice = sdk.crm.invoices ? await sdk.crm.invoices.findById(invoiceId) : null;
  if (!invoice) throw sdk.error(404, 'Invoice not found', 'NOT_FOUND');
  const qid = str(invoice.quotationId) || str(invoice.convertedQuotationId);
  const booking = ID_RE.test(qid) ? await sdk.models.Booking.findOne({ quotation_id: qid }) : null;
  if (booking) {
    // A sales agent opens only the bookings of their own leads (2.28.0: a client trip's through its client).
    await leadAccess.assertBookingVisible(sdk, booking);
    return { navigate: store.bookingLink(booking._id), booking: { id: booking._id, number: booking.number } };
  }
  const gate = ID_RE.test(qid) ? await store.paymentGate(sdk, qid) : { bookingEligible: false, bookingReason: '' };
  throw sdk.error(404, ID_RE.test(qid)
    ? gate.bookingEligible ? 'No booking yet for this invoice — use Create Booking on its quotation.' : `No booking yet: ${gate.bookingReason}`
    : 'This invoice is not from a quotation, so it has no booking.', 'NO_BOOKING');
};

/* ----------------------------------------------------------------- list */

function listFilter(query) {
  const where = {};
  const leadId = str(query.lead_id);
  if (ID_RE.test(leadId)) where.lead_id = leadId;
  const term = str(query.q).slice(0, 80);
  if (term) {
    const re = { $regex: store.escapeRegex(term), $options: 'i' };
    where.$or = [{ number: re }, { title: re }, { guest_name: re }, { destination: re }, { quotation_no: re }];
  }
  const from = str(query.from).slice(0, 10);
  const to = str(query.to).slice(0, 10);
  const range = {};
  if (store.isDay(from)) range.$gte = from;
  if (store.isDay(to)) range.$lte = to;
  if (Object.keys(range).length) where.travel_start_date = range;
  return where;
}

exports.list = async (req, sdk) => {
  const query = req.query || {};
  // A sales agent sees the bookings of their own leads only (counts included); 2.28.0: plus client trips.
  const base = await leadAccess.withVisibleBookings(sdk, listFilter(query));
  const status = BOOKING_STATUSES.includes(str(query.status)) ? str(query.status) : '';
  const where = { ...base };
  if (status) where.status = status;
  const after = str(query.after);
  const cut = after.match(/^(.{10,40})\|([a-f0-9]{24})$/i);
  // 2.28.0: the next page keeps the visibility clause (it used to replace it).
  if (cut) where.$and = [...(Array.isArray(base.$and) ? base.$and : []), { $or: [{ createdAt: { $lt: cut[1] } }, { createdAt: cut[1], _id: { $lt: cut[2] } }] }];
  const [rows, ...counts] = await Promise.all([
    sdk.models.Booking.find(where, { limit: PAGE_SIZE + 1, sort: { createdAt: -1, _id: -1 } }),
    sdk.models.Booking.count(base),
    ...BOOKING_STATUSES.map((s) => sdk.models.Booking.count({ ...base, status: s }))
  ]);
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  const out = { All: counts[0] };
  BOOKING_STATUSES.forEach((s, i) => { out[s] = counts[i + 1]; });
  return {
    bookings: page.map((r) => store.presentBooking(r)),
    counts: out,
    next: rows.length > PAGE_SIZE && last ? `${last.createdAt}|${last._id}` : null,
    can: store.permissionsOf(sdk)
  };
};

/* --------------------------------------------------------------- detail */

function presentTraveller(t, referenceDate, timeZone) {
  const info = rules.ageInfo({ dob: str(t.dob).slice(0, 10), yearOfBirth: t.year_of_birth }, referenceDate);
  const expiry = str(t.passport_expiry_date).slice(0, 10);
  const first = str(t.first_name);
  const last = str(t.last_name);
  return {
    id: str(t._id),
    lead_id: str(t.lead_id),
    fullName: [first, last].filter(Boolean).join(' ') || 'Traveller',
    ageCategory: info.ageCategory || '',
    age: info.age === undefined ? null : info.age,
    gender: str(t.gender),
    relation: str(t.relation),
    nationality: str(t.nationality),
    passport: {
      numberMasked: rules.maskPassport(str(t.passport_last4)),
      expiryDate: expiry,
      expiryWarning: expiry ? rules.expiryWarning(expiry, referenceDate, undefined, timeZone) : ''
    }
  };
}

/** The trip's start, else "today" in the workspace time zone (Settings → Travel → Time zone). */
function referenceDateOf(booking, timeZone) {
  const d = str(booking.travel_start_date).slice(0, 10);
  return rules.isValidDate(d) ? d : rules.todayIso(undefined, timeZone);
}

async function travellersByIds(sdk, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter((id) => ID_RE.test(id)).slice(0, 200);
  if (!list.length) return [];
  const rows = await sdk.models.Traveller.find({ _id: { $in: list } }, { limit: 200 });
  const byId = new Map(rows.map((r) => [str(r._id), r]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

function itinerarySummary(row) {
  return {
    id: row._id,
    version: Number(row.version) || 1,
    status: str(row.status) || 'Draft',
    title: str(row.title),
    quotation_id: str(row.quotation_id),
    quotation_no: str(row.quotation_no),
    booking_id: str(row.booking_id),
    start_date: str(row.start_date).slice(0, 10),
    end_date: str(row.end_date).slice(0, 10),
    edited: row.edited === true,
    finalized_at: str(row.finalized_at),
    has_file: Boolean(row.file_id),
    updatedAt: row.updatedAt
  };
}

exports.getOne = async (req, sdk) => {
  const booking = await store.loadBooking(sdk, store.idParam(req));
  const can = store.permissionsOf(sdk);
  const [services, history, vouchers, travellers, itineraries, evidenceRule, timeZone] = await Promise.all([
    sdk.models.BookingService.find({ booking_id: booking._id }, { limit: 200, sort: { line_index: 1 } }),
    sdk.models.ServiceConfirmation.find({ booking_id: booking._id }, { limit: 500, sort: { createdAt: -1 } }),
    sdk.models.Voucher.find({ booking_id: booking._id }, { limit: 500, sort: { version: -1, createdAt: -1 } }),
    travellersByIds(sdk, booking.traveller_ids),
    sdk.models.Itinerary.find({ quotation_id: booking.quotation_id }, { limit: 20, sort: { version: -1 } }),
    sdk.settings.get('confirmation_evidence'),
    store.timeZoneOf(sdk)
  ]);
  const ref = referenceDateOf(booking, timeZone);
  const voucherRule = (await sdk.settings.get('voucher_requires_full_payment')) !== false;
  const gate = await store.paymentGate(sdk, booking.quotation_id);
  const paidInFull = voucherRule ? gate.fullyPaid : true;
  // The quotation's tax invoice (Open Invoice), for users who may see finance.
  const invoice = can.finance && gate.payment && store.ID_RE.test(str(gate.payment.invoiceId))
    ? { id: str(gate.payment.invoiceId), number: str(gate.payment.invoiceNo), status: str(gate.payment.invoiceStatus) }
    : null;
  return {
    invoice,
    // Vouchers need the full payment verified (setting voucher_requires_full_payment).
    voucher_gate: { requires_full_payment: voucherRule, paid_in_full: paidInFull },
    // The Confirm Service dialog checks the evidence rule before sending (the server checks it again).
    rules: { confirmation_evidence: ['reference_or_file', 'reference', 'file', 'none'].includes(evidenceRule) ? evidenceRule : 'reference_or_file' },
    booking: store.presentBooking(booking, { finance: can.finance }),
    travellers: travellers.map((t) => presentTraveller(t, ref, timeZone)),
    services: services.map((s) => ({
      ...store.presentService(s, { finance: can.finance }),
      confirmations: history.filter((h) => str(h.booking_service_id) === s._id).map(store.presentConfirmation),
      vouchers: vouchers.filter((v) => str(v.booking_service_id) === s._id && v.status !== 'Draft').map(store.presentVoucher)
    })),
    itineraries: itineraries.map(itinerarySummary),
    can
  };
};

/** The lead's own lead id first, then the contact's other leads. */
async function contactLeadIds(sdk, booking) {
  const ids = [str(booking.lead_id)];
  const contactId = str(booking.contact_id);
  if (ID_RE.test(contactId)) {
    try {
      const contact = await sdk.crm.contacts.findById(contactId);
      for (const id of (contact && contact.leadIds) || []) if (!ids.includes(String(id))) ids.push(String(id));
    } catch {
      /* no contacts permission: leads of the contact below */
    }
    try {
      const leads = await sdk.crm.leads.find({ contactId }, { limit: 50 });
      for (const l of leads) if (!ids.includes(str(l._id))) ids.push(str(l._id));
    } catch {
      /* ignore */
    }
  }
  return ids.filter((id) => ID_RE.test(id)).slice(0, 50);
}

async function travellerOptions(sdk, booking) {
  const leadIds = await contactLeadIds(sdk, booking);
  const [rows, leads] = await Promise.all([
    sdk.models.Traveller.find({ lead_id: { $in: leadIds } }, { limit: 300, sort: { createdAt: 1 } }),
    sdk.crm.leads.findByIds(leadIds).catch(() => [])
  ]);
  const leadById = new Map((leads || []).map((l) => [str(l._id), l]));
  const current = str(booking.lead_id);
  const ordered = [...rows.filter((r) => str(r.lead_id) === current), ...rows.filter((r) => str(r.lead_id) !== current && leadById.has(str(r.lead_id)))];
  // One person (traveller profile) once: the copy on this lead wins.
  const seen = new Set();
  const out = [];
  for (const r of ordered) {
    const profile = str(r.profile_id) || str(r._id);
    if (seen.has(profile) || seen.has(str(r._id))) continue;
    seen.add(profile);
    seen.add(str(r._id));
    out.push(r);
  }
  return { rows: out, leadById };
}

exports.travellerOptions = async (req, sdk) => {
  const booking = await store.loadBooking(sdk, store.idParam(req));
  const [{ rows, leadById }, timeZone] = await Promise.all([travellerOptions(sdk, booking), store.timeZoneOf(sdk)]);
  const ref = referenceDateOf(booking, timeZone);
  const selected = new Set(Array.isArray(booking.traveller_ids) ? booking.traveller_ids.map(String) : []);
  return {
    lead_id: str(booking.lead_id),
    travellers: rows.map((r) => {
      const lead = leadById.get(str(r.lead_id)) || {};
      return {
        ...presentTraveller(r, ref, timeZone),
        current: str(r.lead_id) === str(booking.lead_id),
        lead_title: str(lead.title) || str(lead.name),
        selected: selected.has(str(r._id))
      };
    })
  };
};

/* --------------------------------------------------------------- change */

exports.update = async (req, sdk) => {
  const booking = await store.loadBooking(sdk, store.idParam(req));
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (has('notes')) {
    const notes = str(body.notes);
    if (notes.length > 3000) throw sdk.error(400, 'Notes must be 3000 characters or fewer', 'INVALID_INPUT');
    patch.notes = notes;
  }
  if (has('traveller_ids') || has('travel_start_date') || has('travel_end_date')) store.assertOpen(sdk, booking);
  // 2.27.1: a booking's travellers are copied from the paid quotation's trip when it is created and stay
  // fixed (price per person, vouchers and itineraries follow them); they are not chosen on the booking.
  if (has('traveller_ids')) {
    throw sdk.error(409, 'The travellers of a booking come from its quotation and cannot be changed on the booking.', 'BOOKING_TRAVELLERS_FIXED');
  }
  for (const key of ['travel_start_date', 'travel_end_date']) {
    if (!has(key)) continue;
    const v = str(body[key]).slice(0, 10);
    if (v && !store.isDay(v)) throw sdk.error(400, `${key === 'travel_start_date' ? 'Travel start' : 'Travel end'} must be a date (YYYY-MM-DD)`, 'INVALID_INPUT');
    patch[key] = v;
  }
  const start = has('travel_start_date') ? patch.travel_start_date : str(booking.travel_start_date).slice(0, 10);
  const end = has('travel_end_date') ? patch.travel_end_date : str(booking.travel_end_date).slice(0, 10);
  if (start && end && end < start) throw sdk.error(400, 'Travel end cannot be before travel start', 'INVALID_INPUT');
  if (!Object.keys(patch).length) throw sdk.error(400, 'Nothing to change', 'INVALID_INPUT');
  const updated = await sdk.models.Booking.updateById(booking._id, patch);
  await sdk.audit('updated', `Booking ${booking.number} changed`, { bookingId: booking._id, fields: Object.keys(patch) });
  return { booking: store.presentBooking(updated, { finance: store.permissionsOf(sdk).finance }) };
};

exports.cancel = async (req, sdk) => {
  const booking = await store.loadBooking(sdk, store.idParam(req));
  store.assertOpen(sdk, booking);
  const reason = str(req.body && req.body.reason);
  if (!reason) throw sdk.error(400, 'A reason is required to cancel the booking', 'REASON_REQUIRED');
  if (reason.length > 1000) throw sdk.error(400, 'The reason must be 1000 characters or fewer', 'INVALID_INPUT');
  // The booking is closed first, so a confirmation running at the same moment is refused.
  const updated = await sdk.models.Booking.updateById(booking._id, { status: 'Cancelled', cancel_reason: reason, cancelled_at: store.nowIso() });
  const services = await sdk.models.BookingService.find({ booking_id: booking._id }, { limit: 200 });
  let vouchers = 0;
  for (const s of services) {
    if (s.status !== 'Cancelled') {
      await sdk.models.BookingService.updateById(s._id, { status: 'Cancelled', cancel_reason: `Booking cancelled: ${reason}`.slice(0, 1000) });
      await store.addHistory(sdk, s, { action: 'cancel', status: 'Cancelled', notes: `Booking cancelled: ${reason}`.slice(0, 2000) });
    }
    vouchers += await voucherDoc.cancelLiveVouchers(sdk, s._id, 'Booking cancelled');
  }
  await sdk.audit('updated', `Booking ${booking.number} cancelled`, { bookingId: booking._id, services: services.length, vouchers });
  return { booking: store.presentBooking(updated, { finance: store.permissionsOf(sdk).finance }), vouchersCancelled: vouchers };
};

exports.complete = async (req, sdk) => {
  const booking = await store.loadBooking(sdk, store.idParam(req));
  store.assertOpen(sdk, booking);
  if (booking.status !== 'Confirmed') {
    throw sdk.error(409, 'Only a Confirmed booking can be completed — confirm or cancel every service first', 'BOOKING_NOT_CONFIRMED');
  }
  const [early, timeZone] = await Promise.all([sdk.settings.get('allow_early_completion'), store.timeZoneOf(sdk)]);
  if (early !== true) {
    const end = str(booking.travel_end_date).slice(0, 10);
    if (!store.isDay(end)) throw sdk.error(400, 'Set the travel end date before completing the booking', 'TRIP_NOT_ENDED');
    const today = todayIn(timeZone);
    if (end > today) {
      throw sdk.error(400, `The trip ends on ${store.prettyDay(end)} — complete the booking after that (or allow early completion in Settings → Travel)`, 'TRIP_NOT_ENDED');
    }
  }
  const updated = await sdk.models.Booking.updateById(booking._id, { status: 'Completed', completed_at: store.nowIso() });
  await sdk.audit('updated', `Booking ${booking.number} completed`, { bookingId: booking._id });
  return { booking: store.presentBooking(updated, { finance: store.permissionsOf(sdk).finance }) };
};

/* -------------------------------------------------------------- lead tab */

/**
 * GET /clients/:client_id/bookings — Client → Bookings tab: every booking of the client, also the ones made
 * while it was still a lead or an opportunity (its converted leads and its / their opportunities), with the
 * lead each came from. A sales agent sees the bookings of their own leads only.
 */
exports.forClient = async (req, sdk) => {
  const clientId = store.idParam(req, 'client_id');
  if (!ID_RE.test(clientId)) throw sdk.error(400, 'client_id is not valid', 'INVALID_INPUT');
  const leads = await sdk.crm.leads.find({ convertedClientId: clientId }, { limit: 100 });
  const leadIds = leads.map((l) => str(l._id)).filter((id) => ID_RE.test(id));
  let opportunities = [];
  try {
    const or = [{ clientId }];
    if (leadIds.length) or.push({ leadId: { $in: leadIds } });
    opportunities = await sdk.crm.opportunities.find({ $or: or }, { limit: 100 });
  } catch {
    opportunities = []; // no opportunity read permission: the leads' bookings only
  }
  const oppIds = opportunities.map((o) => str(o._id)).filter((id) => ID_RE.test(id));
  for (const o of opportunities) if (ID_RE.test(str(o.leadId)) && !leadIds.includes(str(o.leadId))) leadIds.push(str(o.leadId));
  // 2.28.0: and the client's own trips (bookings without a lead).
  const or = [{ client_id: clientId }];
  if (leadIds.length) or.push({ lead_id: { $in: leadIds } });
  if (oppIds.length) or.push({ opportunity_id: { $in: oppIds } });
  const where = await leadAccess.withVisibleBookings(sdk, { $or: or });
  const rows = await sdk.models.Booking.find(where, { limit: 100, sort: { createdAt: -1 } });
  const leadTitle = new Map(leads.map((l) => [str(l._id), str(l.title) || str(l.name)]));
  const missing = [...new Set(rows.map((r) => str(r.lead_id)))].filter((id) => ID_RE.test(id) && !leadTitle.has(id));
  if (missing.length && typeof sdk.crm.leads.findByIds === 'function') {
    for (const l of await sdk.crm.leads.findByIds(missing)) leadTitle.set(str(l._id), str(l.title) || str(l.name));
  }
  const oppTitle = new Map(opportunities.map((o) => [str(o._id), str(o.title) || str(o.opportunityNumber)]));
  return {
    bookings: rows.map((b) => ({
      ...store.presentBooking(b),
      lead_title: leadTitle.get(str(b.lead_id)) || '',
      opportunity_title: oppTitle.get(str(b.opportunity_id)) || ''
    })),
    itineraries: [],
    can: store.permissionsOf(sdk)
  };
};

exports.forLead = async (req, sdk) => {
  const leadId = store.idParam(req, 'lead_id');
  const lead = ID_RE.test(leadId) ? await sdk.crm.leads.findById(leadId) : null;
  if (!lead) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  const [bookings, itineraries] = await Promise.all([
    sdk.models.Booking.find({ lead_id: leadId }, { limit: 50, sort: { createdAt: -1 } }),
    sdk.models.Itinerary.find({ lead_id: leadId }, { limit: 50, sort: { createdAt: -1 } })
  ]);
  return {
    bookings: bookings.map((b) => store.presentBooking(b)),
    itineraries: itineraries.map(itinerarySummary),
    can: store.permissionsOf(sdk)
  };
};

exports._itinerarySummary = itinerarySummary;
exports._presentTraveller = presentTraveller;
