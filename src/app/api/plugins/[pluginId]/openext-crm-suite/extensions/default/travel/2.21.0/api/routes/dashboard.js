'use strict';

/**
 * Travel Dashboard (2.11.0, CRM 3.31.0 json/dashboard.json) — a quick overview, not a report:
 * 4 KPI cards, up to 5 actions, the next 5 trips, a 4-step pipeline, payments, booking problems and
 * the last 5 business events. The same records and rules as Travel Reports (services/report-data.js).
 *
 * GET /dashboard/overview?scope=mine|team   (mine = the current user's leads)
 *
 * Money only with crm.finance.read (verified payments; an advance moved onto the tax invoice counted once).
 * No passport / Aadhaar numbers or document files.
 */

const data = require('../services/report-data.js');
const passportAlerts = require('../services/passport-alerts.js');
const store = require('../services/booking-store.js');

const { str } = store;
const { ACCEPTED, SENT, sentDay, acceptedDay, day } = data;

const ACTIVE = ['Pending', 'Partially Confirmed', 'Confirmed'];
const BOOKINGS = '/ext/travel/bookings';
const bookingLink = (b) => `${BOOKINGS}?id=${b._id}`;
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** ₹8.4L / ₹3,450 — short Indian money for cards. */
function short(v) {
  const n = Number(v) || 0;
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2).replace(/\.?0+$/, '')}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2).replace(/\.?0+$/, '')}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : '');
function fmtRange(a, b) {
  if (!a) return '';
  if (!b || b === a) return fmtDay(a);
  return a.slice(0, 7) === b.slice(0, 7) ? `${Number(a.slice(8, 10))}–${fmtDay(b)}` : `${fmtDay(a)} – ${fmtDay(b)}`;
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

exports.overview = async (req, sdk) => {
  const scope = str(req.query && req.query.scope) === 'mine' ? 'mine' : 'team';
  const me = str(sdk.user && sdk.user.id);
  const ctx = await data.load(sdk, scope === 'mine' && me && me !== 'system' ? { owner: me } : {});
  const { today, canFinance, finance } = ctx;
  const trip = (b) => str(b.destination) || str(b.title) || 'Trip';

  /* ---------------------------------------------------------------- records */
  const isOpenLead = (l) => !l.convertedClientId && !/(^|\b)(won|lost)(\b|$)/i.test(str(l.stage));
  const openLeads = ctx.leads.filter(isOpenLead);
  const openOpps = ctx.opportunities.filter((o) => !['WON', 'LOST'].includes(str(o.stageType).toUpperCase()) && !o.acceptedQuotationId);
  const active = ctx.bookings.filter((b) => ACTIVE.includes(str(b.status)));
  const upcoming = active.filter((b) => str(b.travel_start_date) >= today).sort((a, b) => (str(a.travel_start_date) < str(b.travel_start_date) ? -1 : 1));
  const monthEnd = `${today.slice(0, 7)}-31`;

  const servicesBy = new Map();
  for (const s of ctx.bookingServices) {
    if (str(s.status) === 'Cancelled') continue;
    if (!servicesBy.has(str(s.booking_id))) servicesBy.set(str(s.booking_id), []);
    servicesBy.get(str(s.booking_id)).push(s);
  }
  const travellersBy = new Map();
  for (const t of ctx.travellers) travellersBy.set(str(t.lead_id), (travellersBy.get(str(t.lead_id)) || 0) + 1);
  const liveVoucher = new Set(ctx.vouchers.filter((v) => ['Issued', 'Sent', 'Used'].includes(str(v.status))).map((v) => str(v.booking_service_id)));

  const facts = (b) => {
    const list = servicesBy.get(str(b._id)) || [];
    const pending = list.filter((s) => str(s.status) !== 'Confirmed');
    const expected = data.expectedTravellers(ctx.values[str(b.lead_id)]);
    const added = travellersBy.get(str(b.lead_id)) || 0;
    const pay = finance ? finance.quotations[str(b.quotation_id)] : null;
    const due = pay ? money(Math.max(0, pay.total - pay.paid)) : 0;
    const docsMissing = list.filter((s) => str(s.status) === 'Confirmed' && store.ISSUABLE_TYPES.includes(str(s.voucher_type)) && !liveVoucher.has(str(s._id))).length;
    return {
      pending,
      expected,
      added,
      travellersMissing: expected > added,
      paymentPending: Boolean(finance) && (!pay || pay.status !== 'Paid'),
      due,
      docsMissing
    };
  };

  /* ------------------------------------------------------------------ KPIs */
  const needAttention = openLeads.filter((l) => {
    const updated = day(l.updatedAt || l.createdAt);
    return !updated || daysBetween(updated, today) >= 3;
  }).length;
  const pipelineValue = money(openOpps.reduce((s, o) => s + (Number(o.expectedRevenue || o.estimatedDealValue || o.value) || 0), 0));
  const kpis = {
    items: [
      { key: 'enquiries', label: 'Open Enquiries', value: openLeads.length, hint: needAttention ? `${needAttention} need attention` : 'All followed up', tone: needAttention ? 'warning' : 'neutral', link: '/leads' },
      { key: 'opportunities', label: 'Open Opportunities', value: openOpps.length, hint: canFinance ? `${short(pipelineValue)} pipeline` : 'In progress', link: '/opportunities' },
      { key: 'bookings', label: 'Active Bookings', value: active.length, hint: `${upcoming.filter((b) => str(b.travel_start_date) <= monthEnd).length} upcoming this month`, link: BOOKINGS },
      ...(canFinance
        ? [{ key: 'outstanding', label: 'Outstanding Payment', value: finance.totals.outstanding, format: 'money', currency: 'INR', hint: `${finance.totals.outstandingCount} invoices`, tone: finance.totals.outstanding > 0 ? 'warning' : 'neutral', link: '/invoices' }]
        : [])
    ]
  };

  /* ------------------------------------------------------- Action Required */
  // Urgency: lower first (trips soonest, then follow-ups).
  const actions = [];
  for (const b of upcoming) {
    const f = facts(b);
    const inDays = daysBetween(today, str(b.travel_start_date));
    if (f.paymentPending && f.due > 0) actions.push({ u: inDays, key: `pay-${b._id}`, title: 'Payment Pending', detail: `${trip(b)} · ${short(f.due)} due`, tone: 'danger', actionLabel: 'View', link: bookingLink(b) });
    for (const s of f.pending.slice(0, 2)) {
      actions.push({ u: inDays + 0.1, key: `svc-${s._id}`, title: `${str(s.name) || 'Service'} Confirmation Pending`, detail: `${trip(b)} · Travel on ${fmtDay(str(b.travel_start_date))}`, tone: 'warning', actionLabel: 'Open', link: bookingLink(b) });
    }
    if (f.travellersMissing) {
      actions.push({ u: inDays + 0.2, key: `trv-${b._id}`, title: 'Traveller details incomplete', detail: `${trip(b)} · ${f.added} of ${f.expected} added`, tone: 'warning', actionLabel: 'Manage', link: `/leads/${b.lead_id}?tab=decl_travellers` });
    }
  }
  // Quotations sent 3+ days ago and still waiting (latest revision only).
  if (canFinance) {
    for (const q of data.latestByRoot(ctx.quotations.filter(SENT)).values()) {
      if (str(q.status) !== 'Sent') continue;
      const age = daysBetween(sentDay(q), today);
      if (age < 3) continue;
      actions.push({ u: 30 + Math.max(0, 14 - age), key: `qt-${q._id}`, title: 'Quotation Follow-up', detail: `${str(q.quotationNo) || 'Quotation'} · Sent ${age} days ago`, tone: 'info', actionLabel: 'View', link: `/quotations/${q._id}` });
    }
  }
  // Passports expiring within 6 months, travellers of active bookings.
  const activeLeads = new Set(active.map((b) => str(b.lead_id)));
  const in6 = new Date(Date.parse(`${today}T00:00:00Z`) + 183 * 86400000).toISOString().slice(0, 10);
  const expiring = ctx.travellers.filter((t) => activeLeads.has(str(t.lead_id)) && str(t.passport_expiry_date) && str(t.passport_expiry_date).slice(0, 10) < in6);
  if (expiring.length) {
    actions.push({ u: 20, key: 'passport', title: 'Passport Expiring Soon', detail: `${expiring.length} traveller${expiring.length === 1 ? '' : 's'} affected`, tone: 'warning', actionLabel: 'Review', link: '/ext/travel/travellers' });
  }
  actions.sort((a, b) => a.u - b.u);

  /* --------------------------------------------------------- Upcoming Trips */
  const badge = (b) => {
    const f = facts(b);
    if (f.paymentPending) return ['Payment Pending', 'danger'];
    if (f.pending.length) return ['Confirmation Pending', 'warning'];
    if (f.travellersMissing || f.docsMissing) return ['Action Required', 'warning'];
    return ['Ready', 'success'];
  };
  const trips = upcoming.slice(0, 5).map((b) => {
    const [label, tone] = badge(b);
    const count = Array.isArray(b.traveller_ids) && b.traveller_ids.length ? b.traveller_ids.length : data.expectedTravellers(ctx.values[str(b.lead_id)]);
    return {
      key: str(b._id),
      title: trip(b),
      detail: fmtRange(str(b.travel_start_date), str(b.travel_end_date)),
      meta: [str(b.guest_name), count ? `${count} Traveller${count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
      badge: label,
      tone,
      link: bookingLink(b)
    };
  });

  /* --------------------------------------------------------------- Pipeline */
  const openQuotes = canFinance
    ? [...data.latestByRoot(ctx.quotations.filter(SENT)).values()].filter((q) => str(q.status) === 'Sent').length
    : ctx.opportunities.filter((o) => str(o.stageType).toUpperCase() === 'QUOTATION_SENT').length;

  /* ----------------------------------------------------------- Attention */
  const all = active.map(facts);
  const attention = [
    { key: 'services', label: 'Services Pending Confirmation', count: all.reduce((s, f) => s + f.pending.length, 0), tone: 'warning', link: `${BOOKINGS}?status=Partially%20Confirmed` },
    { key: 'travellers', label: 'Traveller Details Missing', count: all.filter((f) => f.travellersMissing).length, tone: 'warning', link: BOOKINGS },
    ...(canFinance ? [{ key: 'payments', label: 'Payment Pending', count: all.filter((f) => f.paymentPending).length, tone: 'danger', link: BOOKINGS }] : []),
    { key: 'documents', label: 'Documents Not Ready', count: all.reduce((s, f) => s + f.docsMissing, 0), tone: 'info', link: BOOKINGS }
  ].filter((i) => i.count > 0).map((i) => ({ ...i, value: i.count }));

  /* --------------------------------------------------------- Recent activity */
  const events = [];
  for (const b of ctx.bookings) events.push({ at: str(b.createdAt), title: `Booking ${str(b.number)} created`, detail: trip(b), link: bookingLink(b) });
  for (const s of ctx.bookingServices) {
    if (str(s.status) === 'Confirmed' && s.confirmed_at) events.push({ at: str(s.confirmed_at), title: `${str(s.name) || 'Service'} confirmed`, detail: '', link: `${BOOKINGS}?id=${s.booking_id}` });
  }
  for (const v of ctx.vouchers) {
    if (v.issued_at && str(v.status) !== 'Draft') events.push({ at: str(v.issued_at), title: `Voucher ${str(v.number)} issued`, detail: '', link: `${BOOKINGS}?id=${v.booking_id}` });
  }
  if (canFinance) {
    for (const q of data.conversions(ctx.quotations)) events.push({ at: acceptedDay(q), title: `Quotation ${str(q.quotationNo)} accepted`, detail: '', link: `/quotations/${q._id}` });
  }
  const recent = events
    .filter((e) => e.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 5)
    .map((e, i) => ({ key: `ev-${i}`, title: e.title, detail: [e.detail, fmtDay(e.at.slice(0, 10))].filter(Boolean).join(' · '), link: e.link }));

  /* --------------------------------------------------------- Passport alerts */
  // Travellers of the leads in scope: expired passports and those expiring within 6 months (one per
  // person), most urgent first. Never a passport number.
  const { expired: ppExpired, expiring: ppExpiring } = passportAlerts.alertsOf(ctx.travellers, today);
  const leadById = new Map(ctx.leads.map((l) => [str(l._id), l]));
  const alertRow = ({ row, status }) => {
    const lead = leadById.get(str(row.lead_id));
    const v = ctx.values[str(row.lead_id)] || {};
    const expiry = str(row.passport_expiry_date).slice(0, 10);
    return {
      key: `pp-${row._id}`,
      title: passportAlerts.fullName(row),
      detail: `Passport ${status === 'Expired' ? 'expired' : 'expires'} ${passportAlerts.prettyDay(expiry)}`,
      meta: [str(v.destination) || str(v.to), lead ? str(lead.title) || str(lead.name) : ''].filter(Boolean).join(' · '),
      badge: status,
      tone: status === 'Expired' ? 'danger' : 'warning',
      actionLabel: 'View Traveller',
      link: passportAlerts.travellerLink(row)
    };
  };
  const passportRows = [...ppExpired, ...ppExpiring];

  const out = {
    kpis,
    'passport-alerts': {
      items: passportRows.slice(0, 5).map(alertRow),
      ...(passportRows.length
        ? { more: { label: `${ppExpired.length} expired · ${ppExpiring.length} expiring · View all`.slice(0, 40), link: '/ext/travel/travellers' } }
        : {}),
      empty: 'No passports expired or expiring within 6 months.'
    },
    'action-required': {
      items: actions.slice(0, 5).map(({ u, ...item }) => item),
      ...(actions.length > 5 ? { more: { label: `View All (${actions.length})`, link: BOOKINGS } } : {}),
      empty: 'Nothing needs attention right now.'
    },
    'upcoming-trips': { items: trips, more: { label: 'View All Bookings', link: BOOKINGS }, empty: 'No upcoming trips.' },
    pipeline: {
      stages: [
        { key: 'enquiries', label: 'Enquiries', count: openLeads.length, link: '/leads' },
        { key: 'opportunities', label: 'Opportunities', count: openOpps.length, link: '/opportunities' },
        { key: 'quotations', label: 'Quotations', count: openQuotes, link: '/quotations?status=Sent' },
        { key: 'bookings', label: 'Bookings', count: active.length, link: BOOKINGS }
      ]
    },
    'booking-attention': { items: attention, empty: 'All bookings are on track.' },
    'recent-activity': { items: recent, empty: 'No recent activity.' }
  };
  if (canFinance) {
    const received = finance.totals.received;
    const outstanding = finance.totals.outstanding;
    out.payments = {
      items: [
        { key: 'received', label: 'Received', value: received, format: 'money', currency: 'INR', tone: 'success' },
        { key: 'outstanding', label: 'Outstanding', value: outstanding, format: 'money', currency: 'INR', tone: outstanding > 0 ? 'warning' : 'neutral' }
      ],
      current: received,
      total: money(received + outstanding),
      format: 'money',
      label: `${short(received)} received of ${short(received + outstanding)}`,
      more: { label: 'View Invoices', link: '/invoices' }
    };
  }
  return out;
};
