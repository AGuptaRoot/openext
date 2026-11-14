'use strict';

/**
 * Shared helpers for bookings, booking services, confirmations and vouchers (spec §6.5–§6.7):
 * loading rows (404 / 409 BOOKING_CLOSED), the services list with the optional per-service keys
 * other screens add (voucherType, itinerary settings, per-field hideOnVoucher — read defensively),
 * what a customer may see (no prices, budgets or document numbers), the shapes the UI gets, the
 * status rollup and the confirmation history.
 */

const { readServices } = require('./catalog.js');
const { rollup } = require('./booking-status.js');
const { zoneOffsetMinutes, DEFAULT_TZ } = require('./availability.js');

const ID_RE = /^[a-f0-9]{24}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const VOUCHER_TYPES = ['hotel', 'transport', 'excursion', 'ticket', 'none'];
const ISSUABLE_TYPES = ['hotel', 'transport', 'excursion'];
const LIVE_VOUCHER = ['Draft', 'Issued', 'Sent'];
const BOOKINGS_PAGE = '/ext/travel/bookings';
const ITINERARY_PAGE = '/ext/travel/itinerary';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isOpen = (booking) => Boolean(booking) && booking.status !== 'Cancelled' && booking.status !== 'Completed';
const nowIso = () => new Date().toISOString();

function idParam(req, key = 'id') {
  return str(req && req.params && req.params[key]);
}

function bookingLink(id) {
  return `${BOOKINGS_PAGE}?id=${id}`;
}

async function loadBooking(sdk, id) {
  const key = str(id);
  const row = ID_RE.test(key) ? await sdk.models.Booking.findById(key) : null;
  if (!row) throw sdk.error(404, 'Booking not found', 'NOT_FOUND');
  // Every booking route (services, vouchers, cancel, complete) opens the booking here.
  await require('./lead-access.js').assertLeadVisible(sdk, row.lead_id, 'Booking');
  return row;
}

async function loadService(sdk, id) {
  const key = str(id);
  const row = ID_RE.test(key) ? await sdk.models.BookingService.findById(key) : null;
  if (!row) throw sdk.error(404, 'Booking service not found', 'NOT_FOUND');
  return row;
}

async function loadVoucher(sdk, id) {
  const key = str(id);
  const row = ID_RE.test(key) ? await sdk.models.Voucher.findById(key) : null;
  if (!row) throw sdk.error(404, 'Voucher not found', 'NOT_FOUND');
  return row;
}

/** Refuses changes on a Cancelled / Completed booking (409 BOOKING_CLOSED). */
function assertOpen(sdk, booking) {
  if (!isOpen(booking)) {
    throw sdk.error(409, `Booking ${booking.number || ''} is ${String(booking.status || '').toLowerCase()} — it can no longer be changed`.replace('  ', ' '), 'BOOKING_CLOSED');
  }
}

/* ------------------------------------------------------------- services */

/**
 * What the CRM's verified payments allow for a quotation (sdk.finance.quotationPayment — never the
 * request or the browser):
 *   booking  Settings → General "Allow Booking Creation After Advance Payment": Yes → the required advance,
 *            No → the whole amount (the CRM decides: bookingEligible)
 *   voucher  the whole amount (setting voucher_requires_full_payment, on by default)
 * @returns {Promise<{ bookingEligible: boolean, fullyPaid: boolean, bookingReason: string, payment: object|null }>}
 */
async function paymentGate(sdk, quotationId) {
  const id = str(quotationId);
  let payment = null;
  try {
    payment = ID_RE.test(id) && sdk.finance && typeof sdk.finance.quotationPayment === 'function' ? await sdk.finance.quotationPayment(id) : null;
  } catch {
    payment = null;
  }
  const fullyPaid = Boolean(
    payment && (payment.fullyPaid === true || payment.status === 'Paid' || (payment.invoiceId && payment.invoiceStatus === 'Paid'))
  );
  const bookingEligible = Boolean(payment && (payment.bookingEligible === true || (payment.bookingEligible === undefined && fullyPaid)));
  return {
    payment,
    fullyPaid,
    bookingEligible,
    bookingReason: bookingEligible ? '' : str(payment && payment.bookingReason) || 'The quotation must be paid in full first.'
  };
}

/** Why a voucher cannot be issued for this service now ('' = it can). */
async function voucherBlock(sdk, booking, service) {
  if (!ISSUABLE_TYPES.includes(service.voucher_type)) return 'This service has no voucher';
  if (str(service.status) !== 'Confirmed') return 'Confirm the service before issuing a voucher';
  if ((await sdk.settings.get('voucher_requires_full_payment')) === false) return '';
  const gate = await paymentGate(sdk, booking.quotation_id);
  return gate.fullyPaid ? '' : 'Vouchers are issued once the full payment is verified';
}

/** Voucher type of a service when Services & Forms has none: by its key. */
function defaultVoucherType(key) {
  const k = str(key).toLowerCase();
  if (/hotel/.test(k)) return 'hotel';
  if (k === 'transport' || k === 'rent_a_cab' || /transport|(^|_)cab(_|$)|transfer/.test(k)) return 'transport';
  if (/excursion/.test(k)) return 'excursion';
  if (/(^|_)(air|rail|railway|bus|flight|train)(_|$)/.test(k)) return 'ticket';
  return 'none';
}

function voucherTypeOf(service) {
  const v = str(service && service.voucherType).toLowerCase();
  return VOUCHER_TYPES.includes(v) ? v : defaultVoucherType(service && service.key);
}

/**
 * Services as catalog.js cleans them, plus the optional keys the cleaner may not keep yet
 * (voucherType, itineraryKind / StartField / EndField / TimeField, field hideOnVoucher).
 */
async function readServicesFull(sdk) {
  const [clean, raw] = await Promise.all([readServices(sdk), sdk.settings.get('services')]);
  const rawByKey = new Map();
  for (const s of Array.isArray(raw) ? raw : []) if (s && typeof s === 'object') rawByKey.set(str(s.key), s);
  return clean.map((service) => {
    const r = rawByKey.get(service.key) || {};
    const rawFields = new Map();
    for (const f of Array.isArray(r.fields) ? r.fields : []) if (f && typeof f === 'object') rawFields.set(str(f.key), f);
    const pick = (k) => (service[k] !== undefined && service[k] !== '' ? service[k] : r[k]);
    return {
      ...service,
      voucherType: pick('voucherType'),
      itineraryKind: pick('itineraryKind'),
      itineraryStartField: pick('itineraryStartField'),
      itineraryEndField: pick('itineraryEndField'),
      itineraryTimeField: pick('itineraryTimeField'),
      fields: (service.fields || []).map((f) => ({
        ...f,
        hideOnVoucher: f.hideOnVoucher === true || (rawFields.get(f.key) || {}).hideOnVoucher === true
      }))
    };
  });
}

/* ------------------------------------------------- customer-facing rules */

const PRICE_WORD = /^(budget|budgets|price|prices|pricing|cost|costs|amount|amounts|rate|rates|fare|fares|airfare|airfares|tariff|tariffs)$/;
const DOC_WORD = /^(passport|aadhaar|aadhar|pan)$/;
// Amounts: a currency symbol anywhere ("₹4,000", "4500 $"), "Rs." / "rupees" next to a number, and
// upper-case ISO currency codes before or after a number ("USD 120", "4500 INR"), "4500/-".
const MONEY_TEXT = /(₹|[$€£¥]\s*\d|\d\s*[$€£¥]|\brs\.?\s*\d|\d[\d,.]*\s*(rs\b|rs\.|rupees?\b|dollars?\b|euros?\b)|\brupees?\s*\d|\d\s*\/-)/i;
const CURRENCY_CODES = 'INR|USD|EUR|GBP|AED|SGD|THB|AUD|CAD|NZD|JPY|CNY|MYR|IDR|LKR|NPR|BDT|MVR|CHF|HKD|SAR|QAR|OMR|KWD|BHD|ZAR|VND|PHP|KRW|TRY|RUB|EGP|MUR|BTN';
const MONEY_CODE = new RegExp(`(\\b(${CURRENCY_CODES})\\s*\\d|\\d[\\d,.]*\\s*(${CURRENCY_CODES})\\b)`);

function words(text) {
  return str(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** A price-like key or label ("Budget per night", "package_budget", "Fare"). */
function isPriceLike(text) {
  return words(text).some((w) => PRICE_WORD.test(w) || /budget|price/.test(w));
}

/** Form fields never printed for a customer: money (currency type or a price-like key / label),
 *  document numbers, and fields the admin marked "hide on voucher". */
function isInternalField(field) {
  if (!field) return false;
  if (field.hideOnVoucher === true) return true;
  if (field.type === 'currency') return true;
  if (isPriceLike(field.key) || isPriceLike(field.label)) return true;
  return words(field.key).some((w) => DOC_WORD.test(w)) || words(field.label).some((w) => DOC_WORD.test(w));
}

/** True when a text carries a money amount ("₹4,000", "4500 USD", "Rs. 300", "$ 20", "4500/-"). */
function hasMoney(text) {
  const t = str(text);
  return MONEY_TEXT.test(t) || MONEY_CODE.test(t);
}

// "Passport no. K1234567", "Aadhaar 1234 5678 9012": identity-document numbers in free text.
const ID_DOC_TEXT = /\b(passport|aadhaar|aadhar|pan)\b/i;
const ID_TOKENS = /\b(?=[a-z0-9-]*\d)[a-z0-9-]{5,}\b/gi;
const AADHAAR_LIKE = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

/**
 * Free text for a customer document without identity-document numbers: 12-digit Aadhaar-like numbers
 * are masked everywhere, and on a line that names a passport / Aadhaar / PAN every number-like token
 * (5+ characters with a digit) is masked too. "Carry your passport" stays as it is.
 */
function maskIdNumbers(text) {
  return str(text)
    .split('\n')
    .map((line) => {
      const out = line.replace(AADHAAR_LIKE, '[hidden]');
      return ID_DOC_TEXT.test(out) ? out.replace(ID_TOKENS, '[hidden]') : out;
    })
    .join('\n')
    .trim();
}

/**
 * Lower-case labels a customer must not see for a service: the form's internal fields (hide on voucher,
 * money, document numbers — `currentService` from readServicesFull) and the price / internal rows kept
 * on the booking service (`rows`, detailRows()).
 */
function hiddenLabels(currentService, rows) {
  const out = new Set();
  for (const f of (currentService && currentService.fields) || []) {
    if (f && isInternalField(f)) for (const l of [f.label, f.key]) if (str(l)) out.add(str(l).toLowerCase());
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && (r.price || r.internal) && str(r.label)) out.add(str(r.label).toLowerCase());
  }
  return out;
}

/**
 * Drops "Budget per night: 4000", "Adult fare", money amounts and — given `hidden` (a Set / list of
 * labels, hiddenLabels()) — "<label>: <value>" parts of internal fields from a free-text description.
 */
function scrubText(text, hidden) {
  const hide = hidden instanceof Set ? hidden : new Set((Array.isArray(hidden) ? hidden : []).map((l) => str(l).toLowerCase()));
  const parts = str(text).split(/\s+·\s+|\n+/).map((p) => p.trim()).filter(Boolean);
  return parts
    .filter((part) => {
      if (hasMoney(part)) return false;
      const colon = part.indexOf(':');
      const label = colon > 0 ? part.slice(0, colon) : part;
      if (colon > 0 && hide.has(label.trim().toLowerCase())) return false;
      return !isPriceLike(label) && !words(label).some((w) => DOC_WORD.test(w));
    })
    .join(' · ')
    .slice(0, 600);
}

function displayValue(v) {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v && typeof v === 'object') return '';
  return str(v);
}

/** Filled requirement fields as rows, each marked price / internal (snapshot kept on the booking service). */
function detailRows(service, values) {
  const out = [];
  if (!service || !values || typeof values !== 'object') return out;
  for (const field of service.fields || []) {
    if (field.enabled === false) continue;
    const raw = displayValue(values[field.key]);
    if (!raw) continue;
    const value = field.type === 'date' && isDay(raw.slice(0, 10)) ? prettyDay(raw) : raw;
    out.push({
      key: str(field.key).slice(0, 63),
      label: str(field.label || field.key).slice(0, 120),
      type: str(field.type),
      value: value.slice(0, 500),
      price: field.type === 'currency' || isPriceLike(field.key) || isPriceLike(field.label),
      internal: isInternalField(field)
    });
    if (out.length >= 40) break;
  }
  return out;
}

/** Rows a customer may see: never price / internal rows, and honours the form's current flags. */
function customerRows(rows, currentService) {
  const fields = new Map(((currentService && currentService.fields) || []).map((f) => [f.key, f]));
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || r.price || r.internal) return false;
    const now = fields.get(r.key);
    if (now && isInternalField(now)) return false;
    if (hasMoney(r.value)) return false;
    return !isPriceLike(r.label) && !isPriceLike(r.key);
  });
}

/**
 * Customer-safe one-line summary of a requirement ("Hotel name: Sea View · Rooms: 2"), built from the
 * structured rows (customerRows of detailRows) — never from a quotation line's free text.
 * @param {object} service  Services & Forms definition (readServicesFull, for hideOnVoucher)
 * @param {object} values   the requirement's values
 * @param {{ max?: number, skipTypes?: string[] }} [opts]
 */
function customerSummary(service, values, { max = 4, skipTypes = ['textarea'] } = {}) {
  return customerRows(detailRows(service, values), service)
    .filter((r) => !skipTypes.includes(r.type))
    .slice(0, max)
    .map((r) => `${r.label}: ${r.value}`)
    .join(' · ')
    .slice(0, 600);
}

/* --------------------------------------------------------------- dates */

function isDay(v) {
  return ISO_DAY.test(str(v)) && !Number.isNaN(Date.parse(`${str(v)}T00:00:00Z`));
}

function prettyDay(iso) {
  const d = str(iso).slice(0, 10);
  if (!isDay(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

/** "12 Jun 2027, 14:30" in the workspace time zone. */
function prettyMoment(iso, timeZone = DEFAULT_TZ) {
  const t = Date.parse(str(iso));
  if (Number.isNaN(t)) return prettyDay(iso);
  const local = new Date(t + zoneOffsetMinutes(timeZone, new Date(t)) * 60000).toISOString();
  return `${prettyDay(local.slice(0, 10))}, ${local.slice(11, 16)}`;
}

function dateRange(a, b) {
  const x = prettyDay(a);
  const y = prettyDay(b);
  if (x && y && x !== y) return `${x} - ${y}`;
  return x || y;
}

async function timeZoneOf(sdk) {
  const tz = str(await sdk.settings.get('timezone'));
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/* --------------------------------------------------------------- shapes */

function presentBooking(row, { finance = false } = {}) {
  const out = {
    id: row._id,
    number: str(row.number),
    status: str(row.status) || 'Pending',
    title: str(row.title),
    guest_name: str(row.guest_name),
    company_name: str(row.company_name),
    destination: str(row.destination),
    travel_start_date: str(row.travel_start_date).slice(0, 10),
    travel_end_date: str(row.travel_end_date).slice(0, 10),
    lead_id: str(row.lead_id),
    contact_id: str(row.contact_id),
    opportunity_id: str(row.opportunity_id),
    quotation_id: str(row.quotation_id),
    quotation_no: str(row.quotation_no),
    quotation_version: Number(row.quotation_version) || 1,
    traveller_ids: Array.isArray(row.traveller_ids) ? row.traveller_ids.map(String) : [],
    notes: str(row.notes),
    cancel_reason: str(row.cancel_reason),
    cancelled_at: str(row.cancelled_at),
    completed_at: str(row.completed_at),
    createdAt: row.createdAt
  };
  if (finance) {
    out.currency = str(row.currency) || 'INR';
    out.total = Number(row.total) || 0;
  }
  return out;
}

function presentDocuments(list) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && d.id && !d.removed)
    .map((d) => ({ id: str(d.id), name: str(d.name), mimeType: str(d.mimeType), size: Number(d.size) || 0, added_at: str(d.added_at), added_by: str(d.added_by) }));
}

function presentService(row, { finance = false, details = true } = {}) {
  const snap = row.availability_snapshot && typeof row.availability_snapshot === 'object' ? row.availability_snapshot : {};
  const out = {
    id: row._id,
    booking_id: str(row.booking_id),
    line_index: Number(row.line_index) || 0,
    requirement_id: str(row.requirement_id),
    service_key: str(row.service_key),
    voucher_type: VOUCHER_TYPES.includes(row.voucher_type) ? row.voucher_type : 'none',
    name: str(row.name),
    description: finance ? str(row.description) : scrubText(row.description),
    unit: str(row.unit),
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    start_date: str(row.start_date).slice(0, 10),
    end_date: str(row.end_date).slice(0, 10),
    availability: { status: str(snap.status), provider: str(snap.provider), valid_until: str(snap.valid_until) },
    provider: str(row.provider),
    status: str(row.status) || 'Not Requested',
    requested_at: str(row.requested_at),
    confirmation_ref: str(row.confirmation_ref),
    confirmed_at: str(row.confirmed_at),
    final_details: str(row.final_details),
    has_evidence: Boolean(row.evidence_file_id),
    evidence_file_id: str(row.evidence_file_id),
    documents: presentDocuments(row.documents),
    cancel_reason: str(row.cancel_reason)
  };
  if (details) out.details = (Array.isArray(row.service_details) ? row.service_details : []).filter((r) => r && (finance || !r.price)).map((r) => ({ label: str(r.label), value: str(r.value) }));
  if (finance) {
    out.rate = Number(row.rate) || 0;
    out.amount = Number(row.amount) || 0;
  }
  return out;
}

function presentConfirmation(row) {
  return {
    id: row._id,
    action: str(row.action),
    status: str(row.status),
    provider: str(row.provider),
    confirmation_ref: str(row.confirmation_ref),
    confirmed_at: str(row.confirmed_at),
    final_details: str(row.final_details),
    has_evidence: Boolean(row.evidence_file_id),
    evidence_file_id: str(row.evidence_file_id),
    notes: str(row.notes),
    by: str(row.by),
    at: row.createdAt
  };
}

function presentVoucher(row) {
  return {
    id: row._id,
    number: str(row.number),
    version: Number(row.version) || 1,
    type: str(row.type),
    status: str(row.status),
    outdated: row.outdated === true,
    booking_id: str(row.booking_id),
    booking_service_id: str(row.booking_service_id),
    issued_at: str(row.issued_at),
    issued_by: str(row.issued_by),
    sent_at: str(row.sent_at),
    sent_channel: str(row.sent_channel),
    sent_to: str(row.sent_to),
    used_at: str(row.used_at),
    cancel_reason: str(row.cancel_reason),
    superseded_by: str(row.superseded_by),
    has_file: Boolean(row.file_id)
  };
}

/* ------------------------------------------------------- history, rollup */

function addHistory(sdk, service, fields) {
  const user = sdk.user || {};
  return sdk.models.ServiceConfirmation.create({
    booking_service_id: service._id,
    booking_id: str(service.booking_id),
    by: str(user.name || user.email).slice(0, 120),
    by_id: str(user.id).slice(0, 64),
    ...fields
  });
}

/**
 * Re-reads the booking and its services and stores the rolled-up status (Cancelled / Completed stay).
 * @returns {Promise<string>} the booking's status
 */
async function rollupBooking(sdk, bookingId) {
  const [booking, services] = await Promise.all([
    sdk.models.Booking.findById(bookingId),
    sdk.models.BookingService.find({ booking_id: bookingId }, { limit: 200 })
  ]);
  if (!booking) return '';
  const next = rollup(booking.status, services);
  if (next !== booking.status) {
    const patch = { status: next };
    if (next === 'Cancelled') {
      patch.cancelled_at = nowIso();
      patch.cancel_reason = str(booking.cancel_reason) || 'Every service was cancelled';
    }
    await sdk.models.Booking.updateById(booking._id, patch);
  }
  return next;
}

function permissionsOf(sdk) {
  const has = (k) => {
    try {
      return Boolean(sdk.permissions.has(k));
    } catch {
      return false;
    }
  };
  return {
    read: has('x.travel.bookings.read'),
    write: has('x.travel.bookings.write'),
    issue: has('x.travel.vouchers.issue'),
    finance: has('crm.finance.read'),
    itinerary: has('crm.leads.write')
  };
}

function escapeRegex(text) {
  return str(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80);
}

module.exports = {
  ID_RE,
  VOUCHER_TYPES,
  ISSUABLE_TYPES,
  paymentGate,
  voucherBlock,
  LIVE_VOUCHER,
  BOOKINGS_PAGE,
  ITINERARY_PAGE,
  str,
  isOpen,
  nowIso,
  idParam,
  bookingLink,
  loadBooking,
  loadService,
  loadVoucher,
  assertOpen,
  defaultVoucherType,
  voucherTypeOf,
  readServicesFull,
  isPriceLike,
  isInternalField,
  hasMoney,
  maskIdNumbers,
  hiddenLabels,
  scrubText,
  detailRows,
  customerRows,
  customerSummary,
  isDay,
  prettyDay,
  prettyMoment,
  dateRange,
  timeZoneOf,
  presentBooking,
  presentService,
  presentConfirmation,
  presentVoucher,
  presentDocuments,
  addHistory,
  rollupBooking,
  permissionsOf,
  escapeRegex
};
