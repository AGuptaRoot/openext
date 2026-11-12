'use strict';

/**
 * Voucher content (spec §6.7) — what the customer gets, so: no prices, budgets, rates or fares,
 * no document numbers, no internal provider notes, no quotation internals.
 *
 * buildSnapshot() freezes everything printed when the voucher is issued; toDocument() turns a
 * snapshot into the structured document the CRM draws as PDF (sdk.documents.pdf). A Superseded or
 * Cancelled voucher is redrawn from its own snapshot with a watermark, so it shows what was given.
 */

const store = require('./booking-store.js');

/**
 * "<qty> <unit>" for a quantity — once: a unit saved with its own number (before 2.19.4, e.g.
 * "2 Adults" for 2) is shown as "2 Adults", never "2 2 Adults" (which reads like "22").
 */
function qtyWithUnit(qty, unit) {
  const q = String(qty).trim();
  let u = String(unit || '').trim();
  const lead = u.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (lead && Number(lead[1]) === Number(q)) u = lead[2];
  return u ? `${q} ${u}` : q;
}

const { str } = store;
const TITLES = { hotel: 'Hotel Voucher', transport: 'Transport Voucher', excursion: 'Excursion Voucher' };
const DEFAULT_PREFIX = { hotel: 'HTV', transport: 'TPV', excursion: 'EXV' };

function prefixFor(type, value) {
  const p = str(value).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
  return p || DEFAULT_PREFIX[type] || 'VCH';
}

function voucherNumber(prefix, n) {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

/**
 * @param {object} p
 *   booking, service (rows), travellers [{ first_name, last_name }], currentService (Services & Forms
 *   definition, for the hideOnVoucher flags), number, version, terms, user, timeZone, now
 */
function buildSnapshot(p) {
  const { booking, service } = p;
  const now = p.now || new Date();
  const qty = service.quantity === null || service.quantity === undefined || service.quantity === '' ? '' : String(service.quantity);
  const details = store.customerRows(service.service_details, p.currentService).map((r) => ({ key: str(r.key).slice(0, 63), label: r.label, value: r.value })).slice(0, 40);
  // A line built from a requirement prints its structured, filtered rows (details) — never the
  // quotation line's free text, which may name hidden fields. A line added by hand has only its
  // text: printed scrubbed (no amounts, no price / hidden / document labels).
  const fromRequirement = Boolean(str(service.requirement_id)) || (Array.isArray(service.service_details) && service.service_details.length > 0);
  const description = fromRequirement ? '' : store.scrubText(service.description, store.hiddenLabels(p.currentService, service.service_details));
  return {
    type: service.voucher_type,
    title: TITLES[service.voucher_type] || 'Service Voucher',
    number: p.number,
    version: p.version,
    booking_number: str(booking.number),
    guest: str(booking.guest_name),
    travellers: (p.travellers || []).map((t) => [str(t.first_name), str(t.last_name)].filter(Boolean).join(' ')).filter(Boolean).slice(0, 60),
    // Printed in the booking details (snapshots stored before these fields print without them).
    client: str(booking.company_name).slice(0, 120),
    destination: str(booking.destination).slice(0, 120),
    trip_dates: store.dateRange(booking.travel_start_date, booking.travel_end_date),
    traveller_count: Array.isArray(booking.traveller_ids) ? booking.traveller_ids.length : 0,
    service: {
      name: str(service.name).slice(0, 200),
      description,
      quantity: qty ? qtyWithUnit(qty, str(service.unit)) : '',
      dates: store.dateRange(service.start_date, service.end_date),
      start: store.prettyDay(service.start_date),
      end: store.prettyDay(service.end_date),
      nights: nightsBetween(service.start_date, service.end_date),
      details
    },
    confirmation: {
      provider: str(service.provider).slice(0, 120),
      reference: str(service.confirmation_ref).slice(0, 80),
      confirmed_at: service.confirmed_at ? store.prettyMoment(service.confirmed_at, p.timeZone) : '',
      details: str(service.final_details).slice(0, 2000)
    },
    terms: str(p.terms).slice(0, 3000),
    issued_on: store.prettyMoment(now.toISOString(), p.timeZone),
    issued_by: str(p.user).slice(0, 120)
  };
}

const TYPE_LABEL = { hotel: 'Hotel', transport: 'Transport', excursion: 'Excursion' };

function nightsBetween(a, b) {
  const x = str(a).slice(0, 10);
  const y = str(b).slice(0, 10);
  if (!store.isDay(x) || !store.isDay(y)) return 0;
  const n = Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / 86400000);
  return n > 0 ? n : 0;
}

/** Customer-safe detail rows of a snapshot (never price, internal or identity-document rows). */
function safeDetails(list) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && str(d.value) && typeof d.value !== 'object')
    .map((d) => ({ key: str(d.key), label: str(d.label).slice(0, 60), value: store.maskIdNumbers(str(d.value)).slice(0, 600) }))
    .filter((d) => d.value && !store.isInternalField({ key: d.key, label: d.label }) && !store.hasMoney(d.value));
}

const normKey = (d) => str(d.key || d.label).toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** Takes the first detail whose key (or label) matches; it is then not printed again under "Service details". */
function take(details, used, re) {
  const i = details.findIndex((d, n) => !used.has(n) && re.test(normKey(d)));
  if (i < 0) return '';
  used.add(i);
  return details[i].value;
}

/**
 * Snapshot → sdk.documents.pdf document (branded layout, header "TRAVEL VOUCHER"). A hotel voucher
 * leads with the hotel (name, CONFIRMED, stay details); other services with the service. Never prints
 * prices, document numbers or internal notes; works for snapshots stored before the branded layout.
 */
function toDocument(snapshot, { recordId, watermark = '' } = {}) {
  const s = snapshot || {};
  const svc = s.service || {};
  const conf = s.confirmation || {};
  const mark = watermark === 'CANCELLED' || watermark === 'SUPERSEDED' ? watermark : '';
  const hotel = s.type === 'hotel';
  const typeLabel = TYPE_LABEL[s.type] || 'Service';
  const travellers = (Array.isArray(s.travellers) ? s.travellers : []).map((n) => str(n)).filter(Boolean).slice(0, 60);
  const details = safeDetails(svc.details);
  const used = new Set();
  const badge = mark === 'CANCELLED' ? { text: 'Cancelled', tone: 'danger' } : mark === 'SUPERSEDED' ? { text: 'Superseded', tone: 'neutral' } : { text: 'Confirmed', tone: 'success' };
  const voucherNo = `${str(s.number)}${s.version ? ` (version ${s.version})` : ''}`;
  const travellerCount = Number(s.traveller_count) || travellers.length;
  const blocks = [];

  if (hotel) {
    const hotelName = take(details, used, /^(hotel_?name|hotel|preferred_hotel|property(_name)?|resort(_name)?)$/) || str(conf.provider) || str(svc.name) || 'Hotel';
    const address = take(details, used, /address/);
    const city = take(details, used, /^(city|city_destination|destination|location)$/);
    const checkIn = take(details, used, /check_?in/) || str(svc.start);
    const checkOut = take(details, used, /check_?out/) || str(svc.end);
    const nightsRow = take(details, used, /nights?$/);
    const nights = nightsRow || (Number(svc.nights) > 0 ? `${svc.nights} night${Number(svc.nights) === 1 ? '' : 's'}` : '');
    blocks.push({ type: 'hero', eyebrow: 'Hotel voucher', title: hotelName, subtitle: [address, city].filter(Boolean).join(', '), badge });
    blocks.push({
      type: 'facts',
      heading: 'Hotel details',
      columns: 4,
      items: [
        { label: 'Check-in', value: checkIn },
        { label: 'Check-out', value: checkOut },
        { label: 'Number of nights', value: nights },
        { label: 'Room type', value: take(details, used, /room_?type|room_?category/) },
        { label: 'Meal plan', value: take(details, used, /meal/) },
        { label: 'Rooms', value: take(details, used, /^(number_of_)?rooms?$|no_of_rooms/) },
        { label: 'Confirmation reference', value: str(conf.reference) },
        { label: 'Provider', value: str(conf.provider) && str(conf.provider) !== hotelName ? str(conf.provider) : '' },
        { label: 'Confirmed on', value: str(conf.confirmed_at) }
      ]
    });
  } else {
    blocks.push({ type: 'hero', eyebrow: `${typeLabel} voucher`, title: str(svc.name) || typeLabel, subtitle: str(svc.dates), badge });
    blocks.push({
      type: 'facts',
      heading: 'Service details',
      columns: 3,
      items: [
        { label: 'Service type', value: typeLabel },
        { label: 'Provider', value: str(conf.provider) },
        { label: 'Confirmation number', value: str(conf.reference) },
        { label: 'Travel dates', value: str(svc.dates) },
        { label: 'Quantity', value: str(svc.quantity) },
        { label: 'Confirmed on', value: str(conf.confirmed_at) }
      ]
    });
  }

  blocks.push({
    type: 'facts',
    heading: 'Booking details',
    columns: 3,
    items: [
      { label: 'Voucher number', value: voucherNo },
      { label: 'Booking reference', value: str(s.booking_number) },
      { label: 'Client / Lead', value: [str(s.guest), str(s.client) && str(s.client) !== str(s.guest) ? str(s.client) : ''].filter(Boolean).join(', ') },
      { label: 'Destination', value: str(s.destination) },
      { label: 'Number of travellers', value: travellerCount ? String(travellerCount) : '' },
      { label: 'Trip dates', value: str(s.trip_dates) }
    ]
  });
  blocks.push({
    type: 'text',
    heading: `${hotel ? 'Guest names' : 'Travellers'}${travellers.length ? ` (${travellers.length})` : ''}`,
    text: travellers.length ? travellers.join(', ') : 'As listed on the booking.'
  });
  const rest = details.filter((_, n) => !used.has(n)).map((d) => ({ label: d.label, value: d.value }));
  const description = store.maskIdNumbers(store.scrubText(svc.description));
  if (description) rest.unshift({ label: 'Description', value: description });
  if (hotel && str(svc.quantity)) rest.push({ label: 'Quantity', value: str(svc.quantity) });
  const confirmed = store.maskIdNumbers(str(conf.details));
  if (confirmed) rest.push({ label: 'Confirmed details', value: confirmed });
  blocks.push({ type: 'rows', heading: hotel ? 'Stay information' : 'More about this service', rows: rest.slice(0, 40) });
  const terms = store.maskIdNumbers(str(s.terms));
  const notes = [
    ...terms.split(/\n+/).map((l) => l.trim()).filter(Boolean),
    hotel ? 'Please present this voucher (printed or on your phone) at hotel check-in, with a photo ID for each guest.' : 'Please present this voucher (printed or on your phone) at pick-up or entry.'
  ];
  blocks.push({ type: 'list', heading: 'Important information', items: notes.slice(0, 40) });
  blocks.push({ type: 'contact', heading: 'Help & support', text: 'For any change or assistance during your trip, contact us:' });

  return {
    title: 'Travel Voucher',
    reference: `${s.number} v${s.version}`,
    date: s.issued_on ? `Issued ${s.issued_on}` : '',
    layout: 'branded',
    recordType: 'voucher',
    recordId: str(recordId),
    name: `${s.number}-v${s.version}`,
    meta: [],
    blocks,
    footer: `Issued ${s.issued_on || ''}${s.issued_by ? ` by ${s.issued_by}` : ''}. Please show this voucher at check-in / pick-up.`.slice(0, 300),
    watermark: mark
  };
}

/**
 * Redraws a voucher's PDF from its snapshot with a watermark and stores the patch; the old file is
 * removed. The status change is written first, so a drawing failure never leaves a live voucher.
 */
async function redraw(sdk, voucher, watermark, patch) {
  let row = await sdk.models.Voucher.updateById(voucher._id, patch);
  try {
    if (voucher.snapshot && typeof voucher.snapshot === 'object') {
      const file = await sdk.documents.pdf(toDocument(voucher.snapshot, { recordId: voucher._id, watermark }));
      row = await sdk.models.Voucher.updateById(voucher._id, { file_id: file.id });
      if (voucher.file_id && voucher.file_id !== file.id) await sdk.files.remove(voucher.file_id);
    }
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('voucher redraw failed:', error && error.message);
  }
  return row;
}

/** Cancels every Draft / Issued / Sent voucher of a booking service (PDF redrawn "CANCELLED"). */
async function cancelLiveVouchers(sdk, serviceId, reason) {
  const live = await sdk.models.Voucher.find({ booking_service_id: serviceId, status: { $in: store.LIVE_VOUCHER } }, { limit: 100 });
  for (const v of live) {
    await redraw(sdk, v, 'CANCELLED', { status: 'Cancelled', cancel_reason: str(reason).slice(0, 500) });
  }
  return live.length;
}

module.exports = { TITLES, DEFAULT_PREFIX, prefixFor, voucherNumber, buildSnapshot, toDocument, redraw, cancelLiveVouchers };
