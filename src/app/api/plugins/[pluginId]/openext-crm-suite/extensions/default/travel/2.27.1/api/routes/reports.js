'use strict';

/**
 * Travel Reports (2.9.0) — data for the CRM Reports page (json/reports.json, CRM 3.29.0). The CRM draws the
 * sections; every number here comes from real records (services/report-data.js) and follows the filters.
 *
 * GET /reports/options      filter options: destinations (Settings → Travel), travel services (Services & Forms)
 * GET /reports/sales        kpis, funnel, revenue, payment-status, service-performance, destinations,
 *                           sales-people, lead-sources, quotation-status, quotation-metrics
 * GET /reports/operations   booking-overview, bookings-over-time, upcoming-trips, service-confirmation,
 *                           unconfirmed-services, traveller-readiness
 *
 * Money only for users with crm.finance.read. Never passport / Aadhaar numbers, document files or private URLs.
 */

const data = require('../services/report-data.js');
const store = require('../services/booking-store.js');
const { BOOKING_STATUSES, SERVICE_STATUSES } = require('../services/booking-status.js');

const { str } = store;
const { ACCEPTED, SENT, sentDay, acceptedDay, day, keyOf } = data;

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const LIVE = (b) => str(b.status) !== 'Cancelled';
const BOOKINGS = '/ext/travel/bookings';
const bookingLink = (b) => `${BOOKINGS}?id=${b._id}`;

/* ------------------------------------------------------------------ options */

exports.options = async (req, sdk) => {
  const [{ readServices }, list] = [require('../services/catalog.js'), await sdk.settings.get('destinations')];
  const services = await readServices(sdk);
  return {
    destinations: (Array.isArray(list) ? list : []).map((d) => ({ value: keyOf(d), label: str(d) })).filter((o) => o.value),
    services: services.map((s) => ({ value: s.key, label: s.name })),
    booking_statuses: BOOKING_STATUSES.map((s) => ({ value: s, label: s }))
  };
};

/* ------------------------------------------------------------- per-lead stage */

/**
 * How far each lead got (revisions never count twice): 0 enquiry · 1 requirement ready · 2 opportunity ·
 * 3 quotation sent · 4 accepted · 5 booking · 6 fully paid · 7 trip complete. A later stage implies the
 * earlier ones (e.g. a booked lead counts as ready).
 */
async function leadStages(sdk, ctx) {
  const { readinessFor } = require('../services/readiness.js');
  let ready = new Map();
  try {
    ready = await readinessFor(sdk, ctx.leadIds);
  } catch {
    ready = new Map();
  }
  const by = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = str(r[key]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const opps = by(ctx.opportunities, 'leadId');
  const quotes = new Map();
  for (const q of ctx.quotations) {
    const l = ctx.leadOfQuotation(q);
    if (!quotes.has(l)) quotes.set(l, []);
    quotes.get(l).push(q);
  }
  const books = by(ctx.bookings.filter(LIVE), 'lead_id');
  const stage = new Map();
  for (const id of ctx.leadIds) {
    const o = opps.get(id) || [];
    const q = quotes.get(id) || [];
    const b = books.get(id) || [];
    const accepted = ctx.canFinance ? q.filter(ACCEPTED) : [];
    const sent = ctx.canFinance ? q.some(SENT) : o.some((x) => ['QUOTATION_SENT', 'NEGOTIATION', 'WON'].includes(str(x.stageType).toUpperCase()) || x.generatedQuotationId);
    const isAccepted = ctx.canFinance ? accepted.length > 0 : o.some((x) => x.acceptedQuotationId);
    const paid = Boolean(ctx.finance) && accepted.some((x) => ctx.finance.quotations[str(x._id)] && ctx.finance.quotations[str(x._id)].status === 'Paid');
    let s = 0;
    const info = ready.get ? ready.get(id) : null;
    if (info && info.ready) s = 1;
    if (o.length) s = 2;
    if (sent) s = 3;
    if (isAccepted) s = 4;
    if (b.length) s = 5;
    if (b.length && paid) s = 6;
    if (b.some((x) => str(x.status) === 'Completed') && (paid || !ctx.finance)) s = 7;
    stage.set(id, s);
  }
  return stage;
}

/* -------------------------------------------------------------------- sales */

function groupRows(ctx, keyFn, stageOf) {
  const rows = new Map();
  const row = (key) => {
    if (!rows.has(key)) rows.set(key, { key, enquiries: 0, opportunities: 0, sent: 0, accepted: 0, bookings: 0, value: 0, collected: 0 });
    return rows.get(key);
  };
  const leadKey = new Map(ctx.leads.map((l) => [str(l._id), keyFn(l)]));
  for (const l of ctx.leads) if (ctx.inRange(day(l.createdAt))) row(keyFn(l)).enquiries += 1;
  for (const o of ctx.opportunities) if (ctx.inRange(day(o.createdAt))) row(leadKey.get(str(o.leadId)) ?? '').opportunities += 1;
  const roots = data.latestByRoot(ctx.quotations.filter(SENT));
  for (const q of roots.values()) if (ctx.inRange(sentDay(q))) row(leadKey.get(ctx.leadOfQuotation(q)) ?? '').sent += 1;
  for (const q of data.conversions(ctx.quotations)) {
    if (!ctx.inRange(acceptedDay(q))) continue;
    const r = row(leadKey.get(ctx.leadOfQuotation(q)) ?? '');
    r.accepted += 1;
    if (ctx.finance && ctx.finance.quotations[str(q._id)]) r.collected = money(r.collected + ctx.finance.quotations[str(q._id)].paid);
  }
  for (const b of ctx.bookings.filter(LIVE)) {
    if (!ctx.inRange(day(b.createdAt))) continue;
    const r = row(leadKey.get(str(b.lead_id)) ?? '');
    r.bookings += 1;
    r.value = money(r.value + (Number(b.total) || 0));
  }
  void stageOf;
  return [...rows.values()].map((r) => ({ ...r, conversion: pct(r.bookings, r.enquiries) }));
}

exports.sales = async (req, sdk) => {
  const ctx = await data.load(sdk, req.query);
  const { inRange, canFinance, finance } = ctx;
  const currency = 'INR';
  const live = ctx.bookings.filter(LIVE);
  const periodBookings = live.filter((b) => inRange(day(b.createdAt)));
  const conversionsInRange = data.conversions(ctx.quotations).filter((q) => inRange(acceptedDay(q)));
  const enquiries = ctx.leads.filter((l) => inRange(day(l.createdAt)));
  const stages = await leadStages(sdk, ctx);
  const cohort = enquiries.map((l) => stages.get(str(l._id)) || 0);
  const reached = (n) => cohort.filter((s) => s >= n).length;
  const acceptedCount = canFinance ? conversionsInRange.length : ctx.opportunities.filter((o) => o.acceptedQuotationId && inRange(day(o.updatedAt))).length;

  const kpis = {
    items: [
      { key: 'enquiries', label: 'Travel Enquiries', value: enquiries.length, link: '/leads' },
      { key: 'opportunities', label: 'Opportunities', value: ctx.opportunities.filter((o) => inRange(day(o.createdAt))).length, link: '/opportunities' },
      { key: 'accepted', label: 'Accepted Quotations', value: acceptedCount, link: '/quotations?status=Accepted' },
      { key: 'bookings', label: 'Bookings', value: periodBookings.length, link: BOOKINGS, hint: 'Cancelled bookings are not counted' },
      ...(canFinance
        ? [
            { key: 'booking_value', label: 'Booking Value', value: money(periodBookings.reduce((s, b) => s + (Number(b.total) || 0), 0)), format: 'money', currency },
            { key: 'received', label: 'Amount Received', value: finance.totals.received, format: 'money', currency, hint: 'Verified payments only', tone: 'success' },
            { key: 'outstanding', label: 'Outstanding Amount', value: finance.totals.outstanding, format: 'money', currency, hint: `${finance.totals.outstandingCount} invoices with a balance`, tone: finance.totals.outstanding > 0 ? 'warning' : 'neutral', link: '/invoices' }
          ]
        : []),
      { key: 'conversion', label: 'Conversion Rate', value: pct(reached(5), enquiries.length), format: 'percent', hint: 'Enquiry → booking' }
    ]
  };

  const funnelStages = [
    ['enquiries', 'Travel Enquiry', '/leads'],
    ['ready', 'Requirement Ready', ''],
    ['opportunity', 'Opportunity', '/opportunities'],
    ['sent', 'Quotation Sent', '/quotations'],
    ['accepted', 'Quotation Accepted', '/quotations?status=Accepted'],
    ['booked', 'Booking Created', BOOKINGS],
    ...(canFinance ? [['paid', 'Fully Paid', '']] : []),
    ['complete', 'Trip Complete', `${BOOKINGS}?status=Completed`]
  ];
  const stageIndex = { enquiries: 0, ready: 1, opportunity: 2, sent: 3, accepted: 4, booked: 5, paid: 6, complete: 7 };
  const funnel = { stages: funnelStages.map(([key, label, link]) => ({ key, label, count: reached(stageIndex[key]), ...(link ? { link } : {}) })) };

  const out = { kpis, funnel };
  const roots = data.latestByRoot(ctx.quotations.filter(SENT));

  if (canFinance) {
    const quotationValue = money([...roots.values()].filter((q) => inRange(sentDay(q))).reduce((s, q) => s + (Number(q.grandTotal) || 0), 0));
    const acceptedValue = money(conversionsInRange.reduce((s, q) => s + (Number(q.grandTotal) || 0), 0));
    out.revenue = {
      currency,
      items: [
        { key: 'quoted', label: 'Quotation Value', value: quotationValue, format: 'money', currency },
        { key: 'accepted', label: 'Accepted Value', value: acceptedValue, format: 'money', currency },
        { key: 'invoiced', label: 'Invoiced Amount', value: finance.totals.invoiced, format: 'money', currency, link: '/invoices' },
        { key: 'advance', label: 'Advance Received', value: finance.totals.advanceReceived, format: 'money', currency },
        { key: 'received', label: 'Total Amount Received', value: finance.totals.received, format: 'money', currency, tone: 'success' },
        { key: 'outstanding', label: 'Outstanding Balance', value: finance.totals.outstanding, format: 'money', currency, tone: finance.totals.outstanding > 0 ? 'warning' : 'neutral', link: '/invoices' }
      ],
      // A row per period (by invoice date / payment date), with its graph.
      columns: [
        { key: 'period', label: 'Period', type: 'text' },
        { key: 'invoiced', label: 'Invoiced', type: 'money' },
        { key: 'received', label: 'Paid', type: 'money' },
        { key: 'outstanding', label: 'Outstanding', type: 'money' }
      ],
      rows: finance.series.map((p) => ({ period: p.bucket, invoiced: p.invoiced, received: p.received, outstanding: p.outstanding })),
      chart: {
        type: 'bar',
        labelKey: 'period',
        series: [
          { key: 'invoiced', label: 'Invoiced', format: 'money' },
          { key: 'received', label: 'Paid', format: 'money' },
          { key: 'outstanding', label: 'Outstanding', format: 'money' }
        ]
      }
    };

    const groups = ['Unpaid', 'Advance Paid', 'Partially Paid', 'Paid', 'Overdue'];
    const tally = new Map(groups.map((g) => [g, { count: 0, value: 0, due: 0 }]));
    for (const q of conversionsInRange) {
      const st = finance.quotations[str(q._id)];
      if (!st || !tally.has(st.paymentGroup)) continue;
      const t = tally.get(st.paymentGroup);
      t.count += 1;
      t.value = money(t.value + st.total);
      t.due = money(t.due + Math.max(0, st.total - st.paid));
    }
    const tone = { Unpaid: 'danger', 'Advance Paid': 'info', 'Partially Paid': 'warning', Paid: 'success', Overdue: 'danger' };
    out['payment-status'] = {
      currency,
      columns: [
        { key: 'status', label: 'Payment Status', type: 'status' },
        { key: 'count', label: 'Quotations', type: 'number' },
        { key: 'value', label: 'Value', type: 'money' },
        { key: 'due', label: 'Due', type: 'money' }
      ],
      rows: groups.map((g) => ({
        status: g,
        count: tally.get(g).count,
        value: tally.get(g).value,
        due: g === 'Paid' ? 0 : tally.get(g).due,
        _tone: tally.get(g).count && ['Unpaid', 'Overdue'].includes(g) ? 'warning' : undefined
      })),
      chart: { type: 'pie', labelKey: 'status', series: [{ key: 'count', label: 'Quotations', format: 'number' }] }
    };
    void tone;
  }

  // Travel services: every service of Services & Forms (new ones appear by themselves).
  const reqById = new Map(ctx.requirements.map((r) => [str(r._id), r]));
  const quotedReq = new Set();
  for (const q of roots.values()) {
    if (!inRange(sentDay(q))) continue;
    for (const line of Array.isArray(q.lineItems) ? q.lineItems : []) {
      const reqId = str(line && line.sourceRef).split(':')[0];
      if (reqById.has(reqId)) quotedReq.add(reqId);
    }
  }
  const liveBookingIds = new Set(periodBookings.map((b) => str(b._id)));
  out['service-performance'] = {
    columns: [
      { key: 'service', label: 'Travel Service', type: 'text' },
      { key: 'requirements', label: 'Requirements', type: 'number' },
      { key: 'quoted', label: 'Quoted', type: 'number' },
      { key: 'booked', label: 'Booked', type: 'number' },
      { key: 'confirmed', label: 'Confirmed', type: 'number' },
      ...(canFinance ? [{ key: 'value', label: 'Booking Value', type: 'money' }] : [])
    ],
    rows: ctx.services.map((s) => {
      const reqs = ctx.requirements.filter((r) => str(r.service_key) === s.key && inRange(day(r.createdAt)));
      const booked = ctx.bookingServices.filter((x) => str(x.service_key) === s.key && liveBookingIds.has(str(x.booking_id)) && str(x.status) !== 'Cancelled');
      return {
        service: s.name,
        requirements: reqs.length,
        quoted: [...quotedReq].filter((id) => str(reqById.get(id).service_key) === s.key).length,
        booked: booked.length,
        confirmed: booked.filter((x) => str(x.status) === 'Confirmed').length,
        ...(canFinance ? { value: money(booked.reduce((sum, x) => sum + (Number(x.amount) || 0), 0)) } : {})
      };
    }),
    chart: {
      type: 'bar',
      labelKey: 'service',
      series: [
        { key: 'requirements', label: 'Requirements', format: 'number' },
        { key: 'quoted', label: 'Quoted', format: 'number' },
        { key: 'booked', label: 'Booked', format: 'number' },
        { key: 'confirmed', label: 'Confirmed', format: 'number' }
      ]
    }
  };

  // Destinations: by the configured label (Settings → Travel), keyed case-insensitively.
  const dest = new Map();
  const drow = (label) => {
    const key = keyOf(label) || '—';
    if (!dest.has(key)) dest.set(key, { destination: ctx.destinationLabel.get(key) || str(label) || 'Not set', enquiries: 0, bookings: 0, travellers: 0, value: 0 });
    return dest.get(key);
  };
  for (const l of enquiries) drow(ctx.destOf(str(l._id))).enquiries += 1;
  for (const b of periodBookings) {
    const r = drow(str(b.destination) || ctx.destOf(str(b.lead_id)));
    r.bookings += 1;
    r.travellers += Array.isArray(b.traveller_ids) ? b.traveller_ids.length : 0;
    r.value = money(r.value + (Number(b.total) || 0));
  }
  out.destinations = {
    columns: [
      { key: 'destination', label: 'Destination', type: 'text' },
      { key: 'enquiries', label: 'Enquiries', type: 'number' },
      { key: 'bookings', label: 'Bookings', type: 'number' },
      { key: 'travellers', label: 'Travellers', type: 'number' },
      ...(canFinance ? [{ key: 'value', label: 'Booking Value', type: 'money' }] : []),
      { key: 'conversion', label: 'Conversion %', type: 'percent' }
    ],
    rows: [...dest.values()]
      .map((r) => ({ ...r, conversion: pct(r.bookings, r.enquiries) }))
      .sort((a, b) => b.bookings - a.bookings || b.enquiries - a.enquiries)
      .slice(0, 50)
  };

  const people = groupRows(ctx, (l) => str(l.assignedTo));
  out['sales-people'] = {
    columns: [
      { key: 'owner', label: 'Sales Person', type: 'user' },
      { key: 'enquiries', label: 'Enquiries', type: 'number' },
      { key: 'opportunities', label: 'Opportunities', type: 'number' },
      { key: 'sent', label: 'Quotations Sent', type: 'number' },
      { key: 'accepted', label: 'Accepted', type: 'number' },
      { key: 'bookings', label: 'Bookings', type: 'number' },
      ...(canFinance ? [{ key: 'value', label: 'Booking Value', type: 'money' }, { key: 'collected', label: 'Collected', type: 'money' }] : []),
      { key: 'conversion', label: 'Conversion %', type: 'percent' }
    ],
    rows: people
      .map((r) => ({
        ...r,
        owner: r.key || 'Unassigned',
        ...(/^[\w.-]{1,80}$/.test(r.key) ? { _link: `/reports?tab=activity-location&rep=${encodeURIComponent(r.key)}` } : {})
      }))
      .sort((a, b) => b.bookings - a.bookings || b.enquiries - a.enquiries)
  };

  const sources = groupRows(ctx, (l) => str(l.source));
  out['lead-sources'] = {
    columns: [
      { key: 'source', label: 'Lead Source', type: 'text' },
      { key: 'enquiries', label: 'Enquiries', type: 'number' },
      { key: 'opportunities', label: 'Opportunities', type: 'number' },
      { key: 'accepted', label: 'Accepted', type: 'number' },
      { key: 'bookings', label: 'Bookings', type: 'number' },
      ...(canFinance ? [{ key: 'value', label: 'Booking Value', type: 'money' }] : []),
      { key: 'conversion', label: 'Conversion %', type: 'percent' }
    ],
    rows: sources.map((r) => ({ ...r, source: r.key || 'Not set' })).sort((a, b) => b.enquiries - a.enquiries),
    chart: {
      type: 'bar',
      labelKey: 'source',
      series: [
        { key: 'enquiries', label: 'Enquiries', format: 'number' },
        { key: 'opportunities', label: 'Opportunities', format: 'number' },
        { key: 'bookings', label: 'Bookings', format: 'number' }
      ]
    }
  };

  if (canFinance) {
    // Latest revision of every root quotation made in the period (a revision never counts twice).
    const all = data.latestByRoot(ctx.quotations);
    const inPeriod = [...all.values()].filter((q) => inRange(day(q.createdAt)) || inRange(sentDay(q)));
    const count = (status) => inPeriod.filter((q) => (status === 'Accepted' ? ACCEPTED(q) : str(q.status) === status)).length;
    out['quotation-status'] = {
      items: [
        { key: 'draft', label: 'Draft', count: count('Draft'), value: count('Draft'), link: '/quotations?status=Draft' },
        { key: 'sent', label: 'Sent', count: count('Sent'), value: count('Sent'), tone: 'info', link: '/quotations?status=Sent' },
        { key: 'accepted', label: 'Accepted', count: count('Accepted'), value: count('Accepted'), tone: 'success', link: '/quotations?status=Accepted' },
        { key: 'rejected', label: 'Rejected', count: count('Rejected'), value: count('Rejected'), tone: 'danger', link: '/quotations?status=Rejected' },
        { key: 'expired', label: 'Expired', count: count('Expired'), value: count('Expired'), tone: 'warning', link: '/quotations?status=Expired' },
        { key: 'closed', label: 'Closed / Superseded', count: count('Closed'), value: count('Closed'), hint: 'Another quotation of the opportunity was accepted' }
      ]
    };
    const sentRoots = [...roots.values()].filter((q) => inRange(sentDay(q)));
    const accepted = data.conversions(ctx.quotations).filter((q) => inRange(acceptedDay(q)));
    const leadCreated = new Map(ctx.leads.map((l) => [str(l._id), day(l.createdAt)]));
    const days = (a, b) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 86400000) : null);
    const avg = (list) => (list.length ? Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 10) / 10 : 0);
    // First sent quotation of each root (the original send), for the timings.
    const firstSent = new Map();
    for (const q of ctx.quotations.filter(SENT)) {
      const root = data.ROOT(q);
      const d = sentDay(q);
      if (d && (!firstSent.has(root) || d < firstSent.get(root))) firstSent.set(root, d);
    }
    const toQuote = sentRoots.map((q) => days(leadCreated.get(ctx.leadOfQuotation(q)), firstSent.get(data.ROOT(q)))).filter((v) => v !== null);
    const toAccept = accepted.map((q) => days(firstSent.get(data.ROOT(q)), acceptedDay(q))).filter((v) => v !== null);
    out['quotation-metrics'] = {
      items: [
        { key: 'acceptance', label: 'Acceptance Rate', value: pct(accepted.length, sentRoots.length), format: 'percent', hint: 'Accepted ÷ quotations sent (revisions once)' },
        { key: 'average', label: 'Average Quotation Value', value: money(sentRoots.length ? sentRoots.reduce((s, q) => s + (Number(q.grandTotal) || 0), 0) / sentRoots.length : 0), format: 'money', currency },
        { key: 'to_quote', label: 'Enquiry → Quotation', value: avg(toQuote), format: 'days', hint: 'Average days' },
        { key: 'to_accept', label: 'Quotation → Acceptance', value: avg(toAccept), format: 'days', hint: 'Average days' }
      ]
    };
  }
  return out;
};

/* --------------------------------------------------------------- operations */

const passportServices = (ctx) => new Set(ctx.services.filter((s) => s.requiresPassport).map((s) => s.key));

function travellerFacts(ctx) {
  const needsPassport = passportServices(ctx);
  const leadNeedsPassport = new Set(
    ctx.requirements.filter((r) => needsPassport.has(str(r.service_key))).map((r) => str(r.lead_id))
  );
  const byLead = new Map();
  for (const t of ctx.travellers) {
    const k = str(t.lead_id);
    if (!byLead.has(k)) byLead.set(k, []);
    byLead.get(k).push(t);
  }
  const in6 = new Date(Date.parse(`${ctx.today}T00:00:00Z`) + 183 * 86400000).toISOString().slice(0, 10);
  const facts = { total: 0, complete: 0, missingProfiles: 0, passportMissing: 0, expiringSoon: 0, expired: 0, incompleteLeads: new Set() };
  for (const id of ctx.leadIds) {
    const list = byLead.get(id) || [];
    const expected = data.expectedTravellers(ctx.values[id]);
    facts.total += list.length;
    if (expected > list.length) {
      facts.missingProfiles += expected - list.length;
      facts.incompleteLeads.add(id);
    }
    for (const t of list) {
      const named = str(t.first_name) && str(t.last_name) && (str(t.dob) || t.year_of_birth);
      const hasPassport = Boolean(str(t.passport_last4) && str(t.passport_expiry_date));
      const exp = str(t.passport_expiry_date).slice(0, 10);
      if (leadNeedsPassport.has(id) && !hasPassport) facts.passportMissing += 1;
      if (exp && exp < ctx.today) facts.expired += 1;
      else if (exp && exp < in6) facts.expiringSoon += 1;
      if (named && (!leadNeedsPassport.has(id) || (hasPassport && exp >= ctx.today))) facts.complete += 1;
      else facts.incompleteLeads.add(id);
    }
  }
  return facts;
}

exports.operations = async (req, sdk) => {
  const ctx = await data.load(sdk, req.query);
  const { inRange, today } = ctx;
  const inPeriod = ctx.bookings.filter((b) => inRange(day(b.createdAt)));
  const count = (status) => inPeriod.filter((b) => str(b.status) === status).length;
  const out = {};

  out['booking-overview'] = {
    items: [
      { key: 'total', label: 'Total Bookings', count: inPeriod.filter(LIVE).length, value: inPeriod.filter(LIVE).length, link: BOOKINGS },
      { key: 'upcoming', label: 'Upcoming', count: inPeriod.filter((b) => LIVE(b) && str(b.status) !== 'Completed' && str(b.travel_start_date) >= today).length, value: 0, tone: 'info' },
      { key: 'confirmed', label: 'Confirmed', count: count('Confirmed'), value: 0, tone: 'success', link: `${BOOKINGS}?status=Confirmed` },
      { key: 'partial', label: 'Partially Confirmed', count: count('Partially Confirmed'), value: 0, tone: 'warning', link: `${BOOKINGS}?status=Partially%20Confirmed` },
      { key: 'completed', label: 'Completed Trips', count: count('Completed'), value: 0, link: `${BOOKINGS}?status=Completed` },
      { key: 'cancelled', label: 'Cancelled', count: count('Cancelled'), value: 0, tone: 'danger', link: `${BOOKINGS}?status=Cancelled` }
    ].map((i) => ({ ...i, value: i.count }))
  };

  // Bookings over time: by day / week / month for the range (the CRM's bucket rule).
  const dates = inPeriod.map((b) => day(b.createdAt)).filter(Boolean).sort();
  const from = ctx.f.from || dates[0] || today;
  const to = ctx.f.to || today;
  const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
  const bucket = spanDays <= 31 ? 'day' : spanDays <= 186 ? 'week' : 'month';
  const keyFor = (d) => {
    if (bucket === 'month') return d.slice(0, 7);
    if (bucket === 'week') {
      const x = new Date(`${d}T00:00:00Z`);
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x.toISOString().slice(0, 10);
    }
    return d;
  };
  const points = new Map();
  for (const b of inPeriod.filter(LIVE)) {
    const k = keyFor(day(b.createdAt));
    if (!points.has(k)) points.set(k, { bookings: 0, value: 0 });
    const p = points.get(k);
    p.bookings += 1;
    p.value = money(p.value + (Number(b.total) || 0));
  }
  out['bookings-over-time'] = {
    type: 'bar',
    series: [{ key: 'bookings', label: 'Bookings', format: 'number' }, ...(ctx.canFinance ? [{ key: 'value', label: 'Booking Value', format: 'money' }] : [])],
    points: [...points.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, v]) => ({ label, values: v })),
    note: `Grouped by ${bucket}`
  };

  // Upcoming trips (date filter not applied: the next 7 / 15 / 30 days).
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + ctx.f.upcomingDays * 86400000).toISOString().slice(0, 10);
  const upcoming = ctx.bookings
    .filter((b) => LIVE(b) && str(b.status) !== 'Completed' && str(b.travel_start_date) >= today && str(b.travel_start_date) <= until)
    .sort((a, b) => (str(a.travel_start_date) < str(b.travel_start_date) ? -1 : 1));
  const servicesByBooking = new Map();
  for (const s of ctx.bookingServices) {
    if (str(s.status) === 'Cancelled') continue;
    const k = str(s.booking_id);
    if (!servicesByBooking.has(k)) servicesByBooking.set(k, []);
    servicesByBooking.get(k).push(s);
  }
  const servicesOf = (b) => servicesByBooking.get(str(b._id)) || [];
  const facts = travellerFacts(ctx);
  const quotationGroup = (b) => {
    if (!ctx.finance) return '';
    const st = ctx.finance.quotations[str(b.quotation_id)];
    return st ? st.paymentGroup : 'Unpaid';
  };
  const liveVoucher = (s) => ctx.vouchers.some((v) => str(v.booking_service_id) === str(s._id) && ['Issued', 'Sent', 'Used'].includes(str(v.status)));
  const docsReady = (s) => (store.ISSUABLE_TYPES.includes(str(s.voucher_type)) ? liveVoucher(s) : str(s.voucher_type) === 'ticket' ? (Array.isArray(s.documents) && s.documents.length > 0) : true);
  out['upcoming-trips'] = {
    columns: [
      { key: 'date', label: 'Travel Date', type: 'date' },
      { key: 'client', label: 'Client', type: 'text' },
      { key: 'destination', label: 'Destination', type: 'text' },
      { key: 'travellers', label: 'Travellers', type: 'text' },
      { key: 'status', label: 'Booking Status', type: 'status' },
      ...(ctx.canFinance ? [{ key: 'payment', label: 'Payment', type: 'status' }] : []),
      { key: 'services', label: 'Services Confirmed', type: 'text' },
      { key: 'documents', label: 'Vouchers / Tickets', type: 'text' },
      { key: 'issues', label: 'Needs Attention', type: 'flags' }
    ],
    rows: upcoming.slice(0, 200).map((b) => {
      const list = servicesOf(b);
      const confirmed = list.filter((s) => str(s.status) === 'Confirmed').length;
      const docTargets = list.filter((s) => str(s.status) === 'Confirmed' && str(s.voucher_type) !== 'none');
      const ready = docTargets.filter(docsReady).length;
      const expected = data.expectedTravellers(ctx.values[str(b.lead_id)]);
      const have = Array.isArray(b.traveller_ids) ? b.traveller_ids.length : 0;
      const pay = quotationGroup(b);
      const issues = [];
      if (ctx.finance && pay !== 'Paid') issues.push('Payment pending');
      if (confirmed < list.length) issues.push('Service not confirmed');
      if (facts.incompleteLeads.has(str(b.lead_id)) || (expected && have < expected)) issues.push('Traveller details incomplete');
      if (ready < docTargets.length) issues.push('Voucher / ticket not ready');
      return {
        date: str(b.travel_start_date),
        client: str(b.guest_name),
        destination: str(b.destination),
        travellers: expected ? `${have} of ${expected}` : String(have),
        status: str(b.status),
        ...(ctx.canFinance ? { payment: pay } : {}),
        services: `${confirmed} of ${list.length}`,
        documents: docTargets.length ? `${ready} of ${docTargets.length}` : '—',
        issues,
        _link: bookingLink(b),
        _tone: issues.length ? 'warning' : 'neutral'
      };
    }),
    total: upcoming.length
  };

  const bookingById = new Map(ctx.bookings.map((x) => [str(x._id), x]));
  const scopeServices = ctx.bookingServices.filter((s) => {
    const b = bookingById.get(str(s.booking_id));
    return b && LIVE(b) && inRange(day(b.createdAt));
  });
  const tone = { Confirmed: 'success', Requested: 'info', 'Not Requested': 'warning', Unavailable: 'danger', Cancelled: 'neutral' };
  out['service-confirmation'] = {
    items: SERVICE_STATUSES.map((s) => {
      const n = scopeServices.filter((x) => str(x.status) === s).length;
      return { key: keyOf(s).replace(/ /g, '_'), label: s, count: n, value: n, tone: tone[s] || 'neutral' };
    })
  };

  const nameOf = new Map(ctx.services.map((s) => [s.key, s.name]));
  out['unconfirmed-services'] = {
    columns: [
      { key: 'trip', label: 'Trip', type: 'text' },
      { key: 'date', label: 'Travel Date', type: 'date' },
      { key: 'services', label: 'Services', type: 'text' }
    ],
    rows: upcoming
      .filter((b) => servicesOf(b).some((s) => str(s.status) !== 'Confirmed'))
      .slice(0, 100)
      .map((b) => ({
        trip: `${str(b.destination) || str(b.title) || 'Trip'} — ${str(b.number)}`,
        date: str(b.travel_start_date),
        services: servicesOf(b).map((s) => `${str(s.name) || nameOf.get(str(s.service_key)) || 'Service'}: ${str(s.status)}`).join(' · '),
        _link: bookingLink(b),
        _tone: 'warning'
      }))
  };

  out['traveller-readiness'] = {
    items: [
      { key: 'total', label: 'Total Travellers', value: facts.total },
      { key: 'complete', label: 'Complete Profiles', value: facts.complete, tone: 'success' },
      { key: 'missing', label: 'Missing Traveller Profiles', value: facts.missingProfiles, tone: facts.missingProfiles ? 'warning' : 'neutral', hint: 'Expected on the lead but not added' },
      { key: 'passport_missing', label: 'Passport Missing', value: facts.passportMissing, tone: facts.passportMissing ? 'danger' : 'neutral', hint: 'For services that need a passport' },
      { key: 'expiring', label: 'Passport Expiring Soon', value: facts.expiringSoon, tone: facts.expiringSoon ? 'warning' : 'neutral', hint: 'Within 6 months' },
      { key: 'expired', label: 'Passport Expired', value: facts.expired, tone: facts.expired ? 'danger' : 'neutral' }
    ]
  };
  return out;
};
