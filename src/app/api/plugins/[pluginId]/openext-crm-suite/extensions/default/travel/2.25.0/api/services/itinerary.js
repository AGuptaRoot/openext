'use strict';

/**
 * Itinerary / day plan generated from a proposal (quotation), then edited by the agent.
 *
 * generate() is a pure function: quotation lines → the requirements they came from (line sourceRef
 * "<requirementId>[:<checkId>]") → dated items by each service's itinerary settings (Services & Forms):
 *   stay      check-in day "Check-in", nights "Stay", check-out day "Check-out"
 *   travel    start date "From → To" (and the return date, when the form has one)
 *   transfer  start date; "both ways" without a date → arrival (first day) + departure (last day)
 *   activity  start date
 *   none      listed under "Included services"
 * Lines without a requirement (added by hand) and services without a usable date are "Included services".
 * Never includes prices, document numbers or internal columns.
 */

const MAX_DAYS = 60;
const MAX_ITEMS_PER_DAY = 30;
const MAX_JSON_BYTES = 60 * 1024;
const KINDS = ['stay', 'travel', 'transfer', 'activity', 'note'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isDate = (v) => ISO.test(str(v).slice(0, 10)) && !Number.isNaN(Date.parse(`${str(v).slice(0, 10)}T00:00:00Z`));
const day = (v) => str(v).slice(0, 10);

/** UTF-8 size of a string (the extension sandbox has no Buffer). */
function utf8Bytes(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function prettyDate(iso) {
  if (!isDate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.parse(`${iso}T00:00:00Z`)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/** Default itinerary kind of a service when the admin has not chosen one. */
function defaultKind(service) {
  const key = str(service.key).toLowerCase();
  if (/hotel|stay|resort|accommodation/.test(key)) return 'stay';
  if (/air|flight|rail|train|bus|ferry|cruise/.test(key)) return 'travel';
  if (/transport|transfer|cab|taxi|car/.test(key)) return 'transfer';
  if (/excursion|tour|activity|sightseeing/.test(key)) return 'activity';
  return 'none';
}

function dateFields(service) {
  return (service.fields || []).filter((f) => f && f.enabled !== false && f.type === 'date');
}

function pickField(fields, explicit, patterns) {
  if (explicit) {
    const found = fields.find((f) => f.key === explicit);
    if (found) return found.key;
  }
  for (const re of patterns) {
    const found = fields.find((f) => re.test(f.key));
    if (found) return found.key;
  }
  return '';
}

/** Which form fields give the start / end / time of a service's itinerary items. */
function itinerarySettings(service) {
  const kind = ['stay', 'travel', 'transfer', 'activity', 'none'].includes(service.itineraryKind) ? service.itineraryKind : defaultKind(service);
  const dates = dateFields(service);
  const start = pickField(dates, service.itineraryStartField, [/check_?in/, /depart/, /onward/, /travel_?date/, /journey/, /pick_?up/, /activity/, /start/, /date/]);
  const end = pickField(dates, service.itineraryEndField, kind === 'stay' ? [/check_?out/, /end/] : [/return/, /drop_?date/, /end/]);
  const time = pickField((service.fields || []).filter((f) => f && f.enabled !== false), service.itineraryTimeField, [/time/]);
  return { kind, start, end: end === start ? '' : end, time };
}

function valueByKey(values, re) {
  for (const [k, v] of Object.entries(values || {})) {
    if (re.test(k) && str(v) && typeof v !== 'object') return str(v);
  }
  return '';
}

function route(values) {
  const from = valueByKey(values, /(^|_)from(_|$)|origin|pick_?up_?(location|point|city)?$/);
  const to = valueByKey(values, /(^|_)to(_|$)|destination|drop_?(location|point|city)?$/);
  return from && to ? `${from} → ${to}` : from || to;
}

function cleanTime(v) {
  const m = str(v).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : '';
}

/**
 * @param {object} input
 *   quotation   { lineItems: [{ name, description, sourceRef }], title }
 *   leadValues  { travel_start_date, travel_end_date, destination, to }
 *   requirements Map<id, { _id, service_key, label, values }>
 *   services    [{ key, name, fields, itineraryKind?, itineraryStartField?, itineraryEndField?, itineraryTimeField? }]
 * @returns {{ start_date, end_date, days, unscheduled, title }}
 */
function generate({ quotation, leadValues = {}, requirements = new Map(), services = [] }) {
  const byService = new Map(services.map((s) => [s.key, s]));
  const destination = str(leadValues.destination) || str(leadValues.to);
  const planned = []; // { date, endDate?, kind, title, details, time, source_ref }
  const unscheduled = [];
  const seen = new Set();
  let n = 0;
  const nextId = () => `i${++n}`;

  for (const line of (quotation && quotation.lineItems) || []) {
    const ref = str(line.sourceRef);
    const requirementId = ref.split(':')[0];
    const requirement = requirementId ? requirements.get(requirementId) : null;
    if (requirementId && seen.has(requirementId)) continue; // Adult / Child rows of one requirement → one item
    if (requirementId) seen.add(requirementId);
    const service = requirement ? byService.get(str(requirement.service_key)) : null;
    const name = str((requirement && requirement.label) || line.name) || 'Service';
    if (!requirement || !service) {
      unscheduled.push({ id: nextId(), time: '', kind: 'note', title: str(line.name) || 'Service', details: str(line.description).slice(0, 300), source_ref: ref });
      continue;
    }
    const values = requirement.values || {};
    const cfg = itinerarySettings(service);
    const start = isDate(values[cfg.start]) ? day(values[cfg.start]) : '';
    const end = cfg.end && isDate(values[cfg.end]) ? day(values[cfg.end]) : '';
    const time = cleanTime(values[cfg.time]);
    const where = valueByKey(values, /hotel_?name|property|resort_?name/);
    const path = route(values);
    if (cfg.kind === 'none') {
      unscheduled.push({ id: nextId(), time: '', kind: 'note', title: name, details: str(line.description).slice(0, 300), source_ref: ref });
    } else if (cfg.kind === 'stay') {
      if (!start) unscheduled.push({ id: nextId(), time: '', kind: 'stay', title: `Stay: ${where || name}`, details: str(line.description).slice(0, 300), source_ref: ref });
      else planned.push({ kind: 'stay', date: start, endDate: end && end > start ? end : '', title: where || name, details: str(line.description).slice(0, 300), time, source_ref: ref });
    } else if (cfg.kind === 'travel') {
      if (!start) unscheduled.push({ id: nextId(), time: '', kind: 'travel', title: `${name}${path ? `: ${path}` : ''}`, details: '', source_ref: ref });
      else {
        planned.push({ kind: 'travel', date: start, title: `${name}${path ? `: ${path}` : ''}`, details: '', time, source_ref: ref });
        if (end && end > start) {
          const back = path.includes(' → ') ? path.split(' → ').reverse().join(' → ') : path;
          planned.push({ kind: 'travel', date: end, title: `${name} (return)${back ? `: ${back}` : ''}`, details: '', time: '', source_ref: ref });
        }
      }
    } else if (cfg.kind === 'transfer') {
      const bothWays = Object.values(values).some((v) => /both/i.test(str(v)));
      if (start) planned.push({ kind: 'transfer', date: start, title: `${name}${path ? `: ${path}` : ''}`, details: '', time, source_ref: ref });
      else if (bothWays) {
        planned.push({ kind: 'transfer', date: '@first', title: `Arrival transfer${path ? `: ${path}` : ''}`, details: name, time: '', source_ref: ref });
        planned.push({ kind: 'transfer', date: '@last', title: 'Departure transfer', details: name, time: '', source_ref: ref });
      } else unscheduled.push({ id: nextId(), time: '', kind: 'transfer', title: name, details: path, source_ref: ref });
    } else {
      // activity
      const summary = str(line.description).split(' · ').slice(0, 2).join(' · ').slice(0, 300);
      if (start) planned.push({ kind: 'activity', date: start, title: name, details: summary, time, source_ref: ref });
      else unscheduled.push({ id: nextId(), time: '', kind: 'activity', title: name, details: summary, source_ref: ref });
    }
  }

  // Trip range: the lead's dates, widened to cover the requirements' own dates.
  const dated = planned.flatMap((p) => [p.date, p.endDate]).filter(isDate);
  let first = isDate(leadValues.travel_start_date) ? day(leadValues.travel_start_date) : '';
  let last = isDate(leadValues.travel_end_date) ? day(leadValues.travel_end_date) : '';
  for (const d of dated) {
    if (!first || d < first) first = d;
    if (!last || d > last) last = d;
  }
  if (first && (!last || last < first)) last = first;

  const days = [];
  if (!first) {
    days.push({ day: 1, date: '', title: destination ? `Trip to ${destination}` : 'Day 1', items: [] });
  } else {
    const count = Math.min(MAX_DAYS, diffDays(first, last) + 1);
    for (let i = 0; i < count; i++) {
      const date = addDays(first, i);
      const title =
        i === 0
          ? destination ? `Arrival in ${destination}` : 'Day 1'
          : i === count - 1 && count > 1
            ? destination ? `Departure from ${destination}` : `Day ${i + 1}`
            : destination ? `${destination} — Day ${i + 1}` : `Day ${i + 1}`;
      days.push({ day: i + 1, date, title, items: [] });
    }
  }
  const dayFor = (date) => {
    if (date === '@first') return days[0];
    if (date === '@last') return days[days.length - 1];
    return days.find((d) => d.date === date) || null;
  };
  for (const p of planned) {
    if (p.kind === 'stay') {
      const nights = p.endDate ? diffDays(p.date, p.endDate) : 0;
      const pushTo = (date, item) => {
        const d = dayFor(date);
        if (d) d.items.push({ id: nextId(), ...item });
      };
      pushTo(p.date, { time: p.time, kind: 'stay', title: `Check-in: ${p.title}`, details: p.details, source_ref: p.source_ref });
      for (let k = 1; k < nights; k++) pushTo(addDays(p.date, k), { time: '', kind: 'stay', title: `Stay: ${p.title}`, details: '', source_ref: p.source_ref });
      if (p.endDate) pushTo(p.endDate, { time: '', kind: 'stay', title: `Check-out: ${p.title}`, details: '', source_ref: p.source_ref });
    } else {
      const d = dayFor(p.date);
      if (d) d.items.push({ id: nextId(), time: p.time, kind: p.kind, title: p.title, details: p.details, source_ref: p.source_ref });
      else unscheduled.push({ id: nextId(), time: p.time, kind: p.kind, title: p.title, details: p.details, source_ref: p.source_ref });
    }
  }
  // The order of a travel day: arrive, transfer, check in, activities, stay; then check out, transfer, fly home.
  const rank = (it) => {
    if (/\(return\)/.test(it.title)) return 8;
    if (/^Departure/.test(it.title)) return 7;
    if (/^Check-out/.test(it.title)) return 6;
    if (it.kind === 'travel') return 0;
    if (/^Arrival/.test(it.title)) return 1;
    if (/^Check-in/.test(it.title)) return 2;
    if (it.kind === 'activity' || it.kind === 'transfer') return 3;
    if (/^Stay/.test(it.title)) return 4;
    return 5;
  };
  for (const d of days) {
    d.items.sort((a, b) => rank(a) - rank(b) || (a.time || '99').localeCompare(b.time || '99'));
    d.items = d.items.slice(0, MAX_ITEMS_PER_DAY);
    const activity = d.items.find((it) => it.kind === 'activity');
    if (activity && d.day !== 1 && d.day !== days.length) d.title = activity.title.slice(0, 120);
  }
  return {
    title: `${destination ? `${destination} ` : ''}Itinerary`.trim(),
    start_date: first,
    end_date: last,
    days,
    unscheduled: unscheduled.slice(0, 100)
  };
}

function badInput(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'INVALID_INPUT';
  return error;
}

/** Checks an edited itinerary (days, items, notes) and returns a clean copy; throws 400 with the reason. */
function cleanEdit(body, { start_date, end_date }) {
  const daysIn = Array.isArray(body.days) ? body.days : null;
  if (!daysIn || !daysIn.length) throw badInput('An itinerary needs at least one day');
  if (daysIn.length > MAX_DAYS) throw badInput(`An itinerary can have at most ${MAX_DAYS} days`);
  let n = 0;
  const cleanItem = (raw, where) => {
    if (!raw || typeof raw !== 'object') throw badInput(`${where}: invalid item`);
    const title = str(raw.title).slice(0, 160);
    if (!title) throw badInput(`${where}: every item needs a title`);
    const time = str(raw.time);
    if (time && !cleanTime(time)) throw badInput(`${where}: time must be HH:MM`);
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'note';
    return { id: str(raw.id).slice(0, 20) || `e${++n}`, time: cleanTime(time), kind, title, details: str(raw.details).slice(0, 600), source_ref: str(raw.source_ref).slice(0, 64) };
  };
  const days = daysIn.map((d, i) => {
    const where = `Day ${i + 1}`;
    const date = str(d && d.date);
    if (date && !isDate(date)) throw badInput(`${where}: date must be YYYY-MM-DD`);
    if (date && start_date && end_date && (date < start_date || date > end_date)) {
      throw badInput(`${where}: ${date} is outside the trip (${start_date} – ${end_date})`);
    }
    const items = Array.isArray(d && d.items) ? d.items : [];
    if (items.length > MAX_ITEMS_PER_DAY) throw badInput(`${where}: at most ${MAX_ITEMS_PER_DAY} items`);
    return { day: i + 1, date, title: str(d && d.title).slice(0, 120) || `Day ${i + 1}`, items: items.map((it, j) => cleanItem(it, `${where}, item ${j + 1}`)) };
  });
  const unscheduled = (Array.isArray(body.unscheduled) ? body.unscheduled : []).slice(0, 100).map((it, j) => cleanItem(it, `Included services, item ${j + 1}`));
  if (utf8Bytes(JSON.stringify({ days, unscheduled })) > MAX_JSON_BYTES) throw badInput('This itinerary is too long — shorten some details');
  return { title: str(body.title).slice(0, 120), days, unscheduled, notes: str(body.notes).slice(0, 3000) };
}

const TAGS = { stay: 'Hotel', transfer: 'Transport', activity: 'Activity' };

/** Small label printed beside an item: Flight / Train / Travel, Hotel, Transport, Activity. */
function tagOf(item) {
  if (item.kind === 'travel') return /\b(air|flight|plane)/i.test(item.title) ? 'Flight' : /\b(rail|train)/i.test(item.title) ? 'Train' : 'Travel';
  return TAGS[item.kind] || '';
}

/** "Sea View Resort - Sat, 12 Jun 2027 to Tue, 15 Jun 2027": stays, journeys and transfers at a glance. */
function glanceRows(days) {
  const items = days.flatMap((d) => (Array.isArray(d.items) ? d.items : []).map((it) => ({ ...it, date: str(d.date) })));
  const rows = [];
  for (const it of items) {
    const title = str(it.title);
    const when = [prettyDate(it.date), cleanTime(it.time)].filter(Boolean).join(', ');
    if (it.kind === 'stay' && title.startsWith('Check-in: ')) {
      const name = title.slice('Check-in: '.length);
      const out = items.find((o) => o.kind === 'stay' && str(o.title) === `Check-out: ${name}`);
      const range = [prettyDate(it.date), out ? prettyDate(out.date) : ''].filter(Boolean).join(' to ');
      rows.push({ label: 'Hotel', value: `${name}${range ? ` - ${range}` : ''}` });
    } else if (it.kind === 'travel' || it.kind === 'transfer') {
      rows.push({ label: tagOf(it), value: `${title}${when ? ` - ${when}` : ''}` });
    }
  }
  return rows.slice(0, 20);
}

/**
 * The structured document drawn by the CRM as PDF (sdk.documents.pdf, branded layout): trip summary,
 * hotels / flights / transport at a glance, the day-wise plan, inclusions and notes.
 * `snapshot` ({ guest, travellers, booking_number?, from?, to? }) is stored on the itinerary when it is
 * finalized, so a later redraw (e.g. watermark SUPERSEDED) shows what the customer was given; snapshots
 * stored before the branded PDF have guest / travellers only and print without the newer facts.
 */
function toDocument(itinerary, snapshot) {
  // Agent-typed text may name a passport / Aadhaar number: masked before printing.
  const safe = (v) => require('./booking-store.js').maskIdNumbers(str(v));
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const days = Array.isArray(itinerary.days) ? itinerary.days : [];
  const unscheduled = Array.isArray(itinerary.unscheduled) ? itinerary.unscheduled : [];
  const start = isDate(itinerary.start_date) ? day(itinerary.start_date) : '';
  const end = isDate(itinerary.end_date) ? day(itinerary.end_date) : '';
  const span = start && end && end >= start ? diffDays(start, end) : null;
  const duration =
    span !== null ? `${span + 1} day${span ? 's' : ''}${span ? ` / ${span} night${span === 1 ? '' : 's'}` : ''}` : days.length > 1 ? `${days.length} days` : '';
  const dates = start ? (end && end !== start ? `${prettyDate(start)} - ${prettyDate(end)}` : prettyDate(start)) : '';
  const from = str(snap.from);
  const to = str(snap.to);
  const superseded = itinerary.status === 'Superseded';
  const blocks = [
    {
      type: 'hero',
      eyebrow: str(snap.guest) ? `Prepared for ${str(snap.guest)}` : 'Your trip plan',
      title: str(itinerary.title) || 'Your trip',
      subtitle: [dates, duration].filter(Boolean).join('  |  '),
      badge: superseded ? { text: 'Superseded', tone: 'neutral' } : null
    },
    {
      type: 'facts',
      heading: 'Trip summary',
      columns: 3,
      items: [
        { label: 'Guest', value: str(snap.guest) },
        { label: 'Travellers', value: str(snap.travellers) },
        { label: 'From - To', value: from && to ? `${from} → ${to}` : from || to },
        { label: 'Travel dates', value: dates },
        { label: 'Duration', value: duration },
        { label: 'Booking reference', value: str(snap.booking_number) }
      ]
    },
    { type: 'rows', heading: 'Hotels, flights & transport', rows: glanceRows(days).map((r) => ({ ...r, value: safe(r.value) })) },
    {
      type: 'days',
      heading: 'Day-wise plan',
      days: days.map((d, i) => ({
        label: `Day ${Number(d.day) || i + 1}`,
        date: prettyDate(str(d.date)),
        // "Goa — Day 3" repeats the day label: keep the place.
        title: str(d.title).replace(/\s*[—-]\s*Day \d+$/, '') || '',
        empty: 'Free day at leisure',
        items: (Array.isArray(d.items) ? d.items : []).map((it) => ({ time: cleanTime(it.time), title: safe(it.title), detail: safe(it.details), tag: tagOf(it) }))
      }))
    },
    { type: 'list', heading: 'Inclusions', items: unscheduled.map((it) => safe(`${str(it.title)}${str(it.details) ? ` - ${str(it.details)}` : ''}`)) },
    { type: 'note', heading: 'Important notes', text: safe(itinerary.notes), tone: 'info' }
  ];
  return {
    title: 'Travel Itinerary',
    reference: `ITN-${itinerary.quotation_no || ''}-v${itinerary.version || 1}`.replace('ITN--', 'ITN-'),
    layout: 'branded',
    meta: [],
    blocks,
    footer: 'Times and services are subject to the confirmations in your vouchers.',
    watermark: superseded ? 'SUPERSEDED' : ''
  };
}

module.exports = { generate, cleanEdit, toDocument, itinerarySettings, defaultKind, prettyDate, utf8Bytes, MAX_DAYS };
