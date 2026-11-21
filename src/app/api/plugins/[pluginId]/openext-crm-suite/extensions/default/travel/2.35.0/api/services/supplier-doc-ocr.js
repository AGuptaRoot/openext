'use strict';

/**
 * 2.33.0 — reading a supplier document for "Confirm service" on a booking: an airline e-ticket, a hotel
 * confirmation, a transfer / activity voucher or a supplier (DMC) bill.
 *
 * The pages are read by the CRM's OCR engine (sdk.ai.readImage, up to 5 pages). This file says WHAT to
 * read and checks the answer against the booking:
 *   - provider, confirmation reference (PNR / booking / confirmation number) and the final details text;
 *   - passenger / guest names against the booking's travellers;
 *   - the travel / stay dates against the service dates.
 * Nothing is saved here; the user reviews the values in the Confirm service dialog and saves them there.
 * Prices are never read: the final details are printed on vouchers, which never show prices.
 */

const { cleanDate } = require('./document-ocr.js');

const MIN_CONFIDENCE = 0.75;
const KINDS = ['flight_ticket', 'hotel_confirmation', 'transfer', 'activity', 'visa', 'insurance', 'supplier_bill', 'other'];
const KIND_LABEL = {
  flight_ticket: 'Air ticket',
  hotel_confirmation: 'Hotel confirmation',
  transfer: 'Transfer voucher',
  activity: 'Activity voucher',
  visa: 'Visa document',
  insurance: 'Insurance document',
  supplier_bill: 'Supplier bill',
  other: 'Supplier document'
};
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'MASTER', 'DR', 'CHD', 'CHILD', 'INF', 'INFANT', 'ADT', 'PROF', 'SHRI', 'SMT']);

const INSTRUCTIONS = `You read the pages (in order) of a travel supplier document: an airline e-ticket / itinerary receipt,
a hotel booking confirmation, a transfer or activity voucher, a visa or insurance document, or a supplier bill.
Return this JSON object:
{
  "document_kind": "flight_ticket | hotel_confirmation | transfer | activity | visa | insurance | supplier_bill | other",
  "provider": "",
  "confirmation_ref": "",
  "ticket_numbers": [""],
  "passengers": [""],
  "segments": [{ "from": "", "to": "", "flight": "", "date": "", "departure_time": "", "arrival_time": "" }],
  "hotel": { "name": "", "check_in": "", "check_out": "", "rooms": "", "room_type": "", "meal_plan": "" },
  "start_date": "",
  "end_date": "",
  "other_details": "",
  "confidence": { "provider": 0, "confirmation_ref": 0, "passengers": 0, "dates": 0 }
}
Rules:
- provider = the airline, hotel, transport company or supplier that gives the service.
- confirmation_ref = the PNR / booking reference / confirmation number (for a bill: the bill number).
- ticket_numbers = e-ticket numbers (usually 13 digits); [] when none.
- passengers = every passenger / guest name exactly as printed (e.g. "SHARMA/RAHUL MR").
- segments = one per flight leg (airport or city codes, flight number like 6E-213); [] when not a flight.
- hotel = only for a hotel stay; empty strings otherwise.
- Dates as YYYY-MM-DD when sure, else as printed (day first). start_date / end_date = first and last travel or stay day.
- other_details = short service details for a transfer / activity / visa / insurance (pick-up time, place, cover).
- NEVER include prices, fares, taxes, amounts or card / payment details anywhere.
- Never invent a value: use "" or [] when it is not printed or cannot be read.
- confidence = how sure you are (0 to 1) of each value.`;

const PROMPT = 'Read this travel supplier document.';

function text(value, max = 200) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function confidenceOf(raw, key) {
  const n = Number(raw && raw.confidence && raw.confidence[key]);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

/** A PNR / reference: letters, digits, "-" and "/" only. */
function cleanRef(value) {
  return text(value, 80).toUpperCase().replace(/[^A-Z0-9\-/ ]/g, '').replace(/\s+/g, ' ').trim();
}

function list(value, max, size = 80) {
  return (Array.isArray(value) ? value : []).map((v) => text(v, size)).filter(Boolean).slice(0, max);
}

/** Name tokens without titles: "SHARMA/RAHUL MR" → ['sharma', 'rahul']. */
function nameTokens(value) {
  return text(value, 120)
    .toUpperCase()
    .replace(/[^A-Z\s/.-]/g, ' ')
    .split(/[\s/.-]+/)
    .filter((t) => t && !TITLES.has(t))
    .map((t) => t.toLowerCase());
}

/** A traveller is on the document when their first and last name are both in one printed name. */
function sameTraveller(printed, traveller) {
  const tokens = new Set(nameTokens(printed));
  const first = nameTokens(traveller.first_name || traveller.firstName)[0];
  const last = nameTokens(traveller.last_name || traveller.lastName).slice(-1)[0];
  if (!first) return false;
  return tokens.has(first) && (!last || tokens.has(last));
}

function prettyDay(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function segmentLine(s) {
  const route = [s.from, s.to].filter(Boolean).join(' → ');
  const times = [s.departure_time, s.arrival_time].filter(Boolean).join('–');
  return [s.flight, route, prettyDay(s.date) || s.dateText, times].filter(Boolean).join(' · ');
}

/** The text for "Final confirmed details" (no prices, max 2000 characters). */
function finalDetails(read) {
  const lines = [];
  if (read.segments.length) lines.push(...read.segments.map(segmentLine).filter(Boolean));
  const hotel = read.hotel;
  if (hotel.name || hotel.check_in) {
    const stay = [hotel.check_in ? `Check-in ${prettyDay(hotel.check_in)}` : '', hotel.check_out ? `Check-out ${prettyDay(hotel.check_out)}` : ''].filter(Boolean).join(' – ');
    lines.push([hotel.name, stay, [hotel.rooms, hotel.room_type].filter(Boolean).join(' '), hotel.meal_plan].filter(Boolean).join(' · '));
  }
  if (read.other_details) lines.push(read.other_details);
  if (read.ticket_numbers.length) lines.push(`Ticket no.: ${read.ticket_numbers.join(', ')}`);
  if (read.passengers.length) lines.push(`${read.kind === 'hotel_confirmation' ? 'Guests' : 'Passengers'}: ${read.passengers.join(', ')}`);
  return lines.filter(Boolean).join('\n').slice(0, 2000);
}

/**
 * The model's answer → the dialog's values and the checks against the booking.
 * @param raw        sdk.ai.readImage data
 * @param context    { service: { start_date, end_date }, booking: { travel_start_date, travel_end_date }, travellers: [{ first_name, last_name }] }
 * @returns {{ kind, kindLabel, fields: { provider, confirmation_ref, final_details }, review: string[], warnings: string[], counts }}
 */
function supplierResult(raw, context = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const kind = KINDS.includes(text(src.document_kind, 40)) ? text(src.document_kind, 40) : 'other';
  const segments = (Array.isArray(src.segments) ? src.segments : []).slice(0, 12).map((s) => {
    const r = s && typeof s === 'object' ? s : {};
    const dateText = text(r.date, 30);
    return {
      from: text(r.from, 40).toUpperCase(),
      to: text(r.to, 40).toUpperCase(),
      flight: text(r.flight, 20).toUpperCase(),
      date: cleanDate(dateText),
      dateText,
      departure_time: text(r.departure_time, 10),
      arrival_time: text(r.arrival_time, 10)
    };
  }).filter((s) => s.from || s.to || s.flight);
  const h = src.hotel && typeof src.hotel === 'object' ? src.hotel : {};
  const hotel = {
    name: text(h.name, 120),
    check_in: cleanDate(h.check_in),
    check_out: cleanDate(h.check_out),
    rooms: text(h.rooms, 40),
    room_type: text(h.room_type, 80),
    meal_plan: text(h.meal_plan, 60)
  };
  const read = {
    kind,
    provider: text(src.provider, 120),
    confirmation_ref: cleanRef(src.confirmation_ref),
    ticket_numbers: list(src.ticket_numbers, 20, 20).map((t) => t.replace(/[^0-9A-Z-]/gi, '')).filter(Boolean),
    passengers: list(src.passengers, 30, 80),
    segments,
    hotel,
    other_details: text(src.other_details, 600)
  };
  const startDate = cleanDate(src.start_date) || (segments[0] && segments[0].date) || hotel.check_in || '';
  const endDate = cleanDate(src.end_date) || (segments.length ? segments[segments.length - 1].date : '') || hotel.check_out || '';

  const review = [];
  const warnings = [];
  if (read.provider && confidenceOf(src, 'provider') < MIN_CONFIDENCE) review.push('provider');
  if (read.confirmation_ref && confidenceOf(src, 'confirmation_ref') < MIN_CONFIDENCE) review.push('confirmation_ref');
  if (!read.confirmation_ref) warnings.push('No PNR / confirmation number was found — type it yourself.');

  // Names against the booking's travellers.
  const travellers = Array.isArray(context.travellers) ? context.travellers : [];
  if (read.passengers.length && travellers.length) {
    const strangers = read.passengers.filter((p) => !travellers.some((t) => sameTraveller(p, t)));
    const missing = travellers.filter((t) => !read.passengers.some((p) => sameTraveller(p, t)));
    if (strangers.length) warnings.push(`Not a traveller on this booking: ${strangers.join(', ')}.`);
    if (missing.length && (kind === 'flight_ticket' || kind === 'hotel_confirmation')) {
      warnings.push(`Not on the document: ${missing.map((t) => [t.first_name, t.last_name].filter(Boolean).join(' ')).join(', ')}.`);
    }
  }
  if (read.passengers.length && confidenceOf(src, 'passengers') < MIN_CONFIDENCE) review.push('passengers');

  // Dates against the service (else the booking) dates.
  const service = context.service || {};
  const booking = context.booking || {};
  const wantStart = text(service.start_date, 10) || text(booking.travel_start_date, 10);
  const wantEnd = text(service.end_date, 10) || text(booking.travel_end_date, 10);
  if (startDate && wantStart && startDate !== wantStart) {
    warnings.push(`The document starts on ${prettyDay(startDate)}, but this service starts on ${prettyDay(wantStart)}.`);
  }
  if (endDate && wantEnd && endDate !== wantEnd && kind === 'hotel_confirmation') {
    warnings.push(`The stay ends on ${prettyDay(endDate)}, but this service ends on ${prettyDay(wantEnd)}.`);
  }
  if ((startDate || endDate) && confidenceOf(src, 'dates') < MIN_CONFIDENCE) review.push('dates');

  return {
    kind,
    kindLabel: KIND_LABEL[kind],
    fields: { provider: read.provider, confirmation_ref: read.confirmation_ref, final_details: finalDetails(read) },
    dates: { start: startDate, end: endDate },
    review,
    warnings,
    counts: { passengers: read.passengers.length, segments: segments.length, tickets: read.ticket_numbers.length }
  };
}

module.exports = { INSTRUCTIONS, PROMPT, KINDS, supplierResult, sameTraveller, nameTokens, cleanRef };
