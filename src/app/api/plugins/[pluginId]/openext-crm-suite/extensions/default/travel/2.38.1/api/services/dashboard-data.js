'use strict';

/**
 * Travel Dashboard data (2.38.0) — the database counts and filters; only the records a box shows are read.
 *
 * Before: every lead, quotation, booking, traveller and voucher of the workspace was read (report-data.js) to
 * show a few numbers and lists. Now:
 *   Open Enquiries, "need attention", Qualified   3 counts done by MongoDB (no lead is read)
 *   Active bookings                               the bookings with an active status only
 *   their services / vouchers / travellers        only of those bookings (and their leads)
 *   Quotations awaiting an answer                 the "Sent" quotations and the other revisions of the same quotation
 *   Money (finance.summary)                       the accepted quotations only
 *   Recent activity                               the newest 5 of each kind (bookings, confirmations, vouchers)
 *   Passport alerts                               travellers whose passport expires within 6 months only
 * A user who sees few leads (a sales rep, or "mine": at most 500) reads those leads first, and every
 * search above is limited to them. The same rules as before: the leads this user may see (sdk.crm scope; "mine" = assigned to me), merged
 * leads left out, cancelled services left out, quotation revisions once, money only with crm.finance.read.
 */

const data = require('./report-data.js');
const store = require('./booking-store.js');
const passportAlerts = require('./passport-alerts.js');
const { todayIn } = require('./availability.js');

const { str, ID_RE } = store;
const { SENT, ACCEPTED, ROOT } = data;

const ACTIVE = ['Pending', 'Partially Confirmed', 'Confirmed'];
const EMPTY = { $in: [null, ''] };
const FILLED = { $nin: [null, ''] };
// The same test as the Dashboard's isOpenLead (a stage word "won" / "lost"), done by MongoDB.
const WON_LOST = { $regex: '(^|\\b)(won|lost)(\\b|$)', $options: 'i' };
const RECENT = 5;
const RECENT_PAGE = 50;
const RECENT_MAX_PAGES = 100;
const SMALL = 500; // up to this many leads in scope: read them and search only their records

/** Every row of an extension model matching a filter, by id (500 per read), oldest first. */
async function scanModel(Model, filter) {
  if (!Model) return [];
  const rows = [];
  let after = '';
  for (let n = 0; n < 200; n += 1) {
    const page = await Model.find({ ...filter, ...(after ? { _id: { $gt: after } } : {}) }, { limit: 500, sort: { _id: 1 } });
    rows.push(...page);
    if (page.length < 500) break;
    after = str(page[page.length - 1]._id);
    if (!after) break;
  }
  return data.oldestFirst(rows);
}

/** The leads this user may see (and "mine"), looked up by id once each. */
function leadScope(sdk, owner) {
  const known = new Map();
  return {
    /** Leads already read (the small scope): no look-up needed for them. */
    seed(rows) {
      for (const lead of rows || []) {
        if (lead.mergedIntoId || (owner && str(lead.assignedTo) !== owner)) continue;
        known.set(str(lead._id), lead);
      }
    },
    async load(ids) {
      const todo = [...new Set(ids.map(str))].filter((id) => ID_RE.test(id) && !known.has(id));
      await data.eachLimited(data.chunks(todo, 100), 4, async (part) => {
        const rows = await sdk.crm.leads.findByIds(part);
        for (const id of part) known.set(id, null);
        for (const lead of rows || []) {
          if (lead.mergedIntoId) continue;
          if (owner && str(lead.assignedTo) !== owner) continue;
          known.set(str(lead._id), lead);
        }
      });
    },
    has: (id) => Boolean(known.get(str(id))),
    get: (id) => known.get(str(id)) || null
  };
}

/** Core records matching a filter (pages of 100). */
const scanCore = (reader, filter) => data.scanCore(reader, filter, 20000);

/**
 * The newest rows of a model (sorted by `field`, newest first) that pass `keep`, up to RECENT.
 * `prepare(rows)` loads what `keep` needs for a page.
 */
async function newest(Model, filter, field, prepare, keep) {
  if (!Model) return [];
  const out = [];
  for (let page = 0; page < RECENT_MAX_PAGES && out.length < RECENT; page += 1) {
    const rows = await Model.find(filter, { limit: RECENT_PAGE, skip: page * RECENT_PAGE, sort: { [field]: -1 } });
    await prepare(rows);
    for (const row of rows) if (out.length < RECENT && keep(row)) out.push(row);
    if (rows.length < RECENT_PAGE) break;
  }
  return out;
}

/**
 * Everything the Dashboard shows → { today, canFinance, finance, counts, active, bookingServices, travellers,
 * vouchers, values, awaiting, recent: { bookings, services, vouchers, conversions }, passportTravellers, lead }.
 */
async function overviewData(sdk, { owner = '' } = {}) {
  const canFinance = Boolean(sdk.permissions && sdk.permissions.has('crm.finance.read'));
  const timeZone = await store.timeZoneOf(sdk);
  const today = todayIn(timeZone);
  const scope = leadScope(sdk, owner);
  const models = sdk.models || {};

  /* Counts: MongoDB counts the leads; none is read. */
  const base = { mergedIntoId: EMPTY, ...(owner ? { assignedTo: owner } : {}) };
  const open = { ...base, convertedClientId: EMPTY, $nor: [{ stage: WON_LOST }] };
  // "Need attention": last updated (else created) 3 days ago or more — before the start of the day 2 days ago.
  const stale = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86400000).toISOString();
  const attention = { ...open, $or: [{ updatedAt: { $lt: stale } }, { updatedAt: null, createdAt: { $lt: stale } }, { updatedAt: null, createdAt: null }] };
  const qualified = { ...open, stage: { $regex: 'qualif', $options: 'i' } };

  // Passports expired, or ending within 6 months (the dates are "YYYY-MM-DD", maybe with a time).
  const sixMonths = passportAlerts.addMonths(today, 6);

  // Few leads in scope: read them and limit every search to them (a lead outside them is never in scope).
  let mine = null;
  if ((await sdk.crm.leads.count(base)) <= SMALL) {
    const rows = (await scanCore(sdk.crm.leads, base)).filter((l) => !l.mergedIntoId);
    scope.seed(rows);
    mine = rows.map((l) => str(l._id));
  }
  const onLeads = (field) => (mine ? { [field]: { $in: mine } } : {});

  const [openCount, attentionCount, qualifiedCount, activeRows, passportRows, acceptedRows, sentRows] = await Promise.all([
    sdk.crm.leads.count(open),
    sdk.crm.leads.count(attention),
    sdk.crm.leads.count(qualified),
    scanModel(models.Booking, { status: { $in: ACTIVE }, ...onLeads('lead_id') }),
    sixMonths ? scanModel(models.Traveller, { passport_expiry_date: { ...FILLED, $lt: `${sixMonths}~` }, ...onLeads('lead_id') }) : Promise.resolve([]),
    canFinance ? scanCore(sdk.crm.quotations, { status: { $in: ['Accepted', 'Converted'] }, ...onLeads('leadId') }) : Promise.resolve([]),
    canFinance ? scanCore(sdk.crm.quotations, { status: 'Sent', ...onLeads('leadId') }) : Promise.resolve([])
  ]);

  await scope.load([
    ...activeRows.map((b) => b.lead_id),
    ...passportRows.map((t) => t.lead_id),
    ...acceptedRows.map((q) => q.leadId),
    ...sentRows.map((q) => q.leadId)
  ]);
  const active = activeRows.filter((b) => scope.has(b.lead_id));
  const passportTravellers = passportRows.filter((t) => scope.has(t.lead_id));
  const quoteKept = (q) => !q.isArchived && scope.has(q.leadId);
  const accepted = acceptedRows.filter(quoteKept);

  /* The active bookings' services, vouchers, travellers and trip details. */
  const activeIds = active.map((b) => str(b._id));
  const activeLeads = [...new Set(active.map((b) => str(b.lead_id)))];
  const [bookingServices, vouchers, travellers, values] = await Promise.all([
    data.modelIn(models.BookingService, 'booking_id', activeIds),
    data.modelIn(models.Voucher, 'booking_id', activeIds),
    data.modelIn(models.Traveller, 'lead_id', activeLeads),
    data.valuesOf(sdk, activeLeads)
  ]);

  /* Quotations sent and waiting: the latest sent revision of each quotation that has a "Sent" one. */
  let awaiting = [];
  if (canFinance) {
    const roots = [...new Set(sentRows.filter(quoteKept).map(ROOT))].filter(Boolean);
    const family = new Map();
    const [rootRows, revisionRows] = await Promise.all([
      data.eachLimited(data.chunks(roots.filter((id) => ID_RE.test(id)), 100), 4, (part) => sdk.crm.quotations.findByIds(part)),
      data.eachLimited(data.chunks(roots, 500), 4, (part) => scanCore(sdk.crm.quotations, { revisionOf: { $in: part } }))
    ]);
    for (const q of [...rootRows.flat(), ...revisionRows.flat()]) family.set(str(q._id), q);
    const rootSet = new Set(roots);
    const members = data.oldestFirst([...family.values()]).filter((q) => rootSet.has(ROOT(q)));
    await scope.load(members.map((q) => q.leadId));
    awaiting = [...data.latestByRoot(members.filter(quoteKept).filter(SENT)).values()].filter((q) => str(q.status) === 'Sent');
  }

  /* Money: the CRM's rules over the accepted quotations (as before: no date range on the Dashboard). */
  const finance = canFinance ? await sdk.finance.summary({ quotationIds: accepted.filter(ACCEPTED).map((q) => str(q._id)), from: '', to: '' }) : null;

  /* Recent activity: the newest few of each kind, of the bookings this user may see. */
  const bookingLead = new Map(active.map((b) => [str(b._id), str(b.lead_id)]));
  const knowBookings = async (ids) => {
    const todo = [...new Set(ids.map(str))].filter((id) => ID_RE.test(id) && !bookingLead.has(id));
    if (todo.length) {
      const rows = await data.modelIn(models.Booking, '_id', todo);
      for (const id of todo) bookingLead.set(id, '');
      for (const b of rows) bookingLead.set(str(b._id), str(b.lead_id));
    }
    await scope.load([...bookingLead.values()].filter(Boolean));
  };
  const bookingKept = (id) => scope.has(bookingLead.get(str(id)) || '');
  const [recentBookings, recentServices, recentVouchers] = await Promise.all([
    newest(models.Booking, onLeads('lead_id'), 'createdAt', (rows) => scope.load(rows.map((b) => b.lead_id)), (b) => Boolean(b.createdAt) && scope.has(b.lead_id)),
    newest(models.BookingService, { status: 'Confirmed', confirmed_at: FILLED }, 'confirmed_at', (rows) => knowBookings(rows.map((s) => s.booking_id)), (s) => bookingKept(s.booking_id)),
    newest(models.Voucher, { status: { $ne: 'Draft' }, issued_at: FILLED }, 'issued_at', (rows) => knowBookings(rows.map((v) => v.booking_id)), (v) => bookingKept(v.booking_id))
  ]);

  return {
    today,
    timeZone,
    canFinance,
    finance,
    counts: { open: openCount, attention: attentionCount, qualified: qualifiedCount },
    active,
    bookingServices,
    vouchers,
    travellers,
    values,
    awaiting,
    recent: { bookings: recentBookings, services: recentServices, vouchers: recentVouchers, conversions: canFinance ? data.conversions(accepted) : [] },
    passportTravellers,
    lead: (id) => scope.get(id)
  };
}

module.exports = { overviewData, ACTIVE };
