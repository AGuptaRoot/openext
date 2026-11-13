'use strict';

/**
 * Travellers page and contact page features.
 *
 * GET  /travellers?q=&category=&after=          traveller directory (numbers masked): one row per person,
 *                                               50 per page, cursor paging (after = nextCursor)
 * GET  /travellers/summary                      metrics: people, age categories, photos, passport status
 * GET  /travellers/export?q=&category=          CSV (no document numbers; masked only) — logged
 * GET  /travellers/search?q=&leadId=            "Add existing traveller": people matching a name / phone (≤ 20)
 * GET  /lead-options?q=                         leads to add a traveller to: only leads whose
 *                                               Travel Requirement has a Complete service
 * GET  /leads/:lead_id/contacts                 contact people of a lead (to pick the traveller's contact)
 * GET  /travellers/:traveller_id/detail         one traveller with its lead, contact person and trips (logged)
 * GET  /travellers/:traveller_id/trips          the person's travel history (every lead / booking of the profile)
 * GET  /contacts/:contact_id/travellers         travellers whose contact person is this contact
 * GET  /admin/orphaned-travellers               travellers of deleted leads (admins)
 * POST /admin/orphaned-travellers/cleanup       delete them and their photos (admins, audited)
 *
 * Travellers of deleted leads (orphans) never show in lists, totals or metrics. Age categories are
 * worked out on read (services/traveller-directory.js); leads are read in batches.
 */

const rules = require('../services/traveller-rules.js');
const store = require('../services/traveller-store.js');
const directory = require('../services/traveller-directory.js');

const { ID_RE, str } = store;
const PAGE = 50;
const EXPORT_MAX = 5000;
const SEARCH_MAX = 20;
const CLEANUP_MAX = 500;

/* ----------------------------------------------------------------- helpers */

const escapeRe = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const queryOf = (req) => (req && req.query && typeof req.query === 'object' ? req.query : {});
const categoryOf = (query) => (['Adult', 'Child', 'Infant'].includes(String(query.category || '')) ? String(query.category) : '');

/** Contact names by id: sdk.crm.contacts.findByIds in chunks of 100 (CRM 3.17); one by one on older CRMs. */
async function contactNames(sdk, ids) {
  const out = new Map();
  const list = [...new Set(ids.map((id) => str(id)).filter((id) => ID_RE.test(id)))];
  if (!list.length) return out;
  const reader = sdk.crm && sdk.crm.contacts;
  if (reader && typeof reader.findByIds === 'function') {
    try {
      for (let i = 0; i < list.length; i += 100) {
        const rows = await reader.findByIds(list.slice(i, i + 100));
        for (const c of Array.isArray(rows) ? rows : []) if (c && c._id) out.set(str(c._id), str(c.name));
      }
      return out;
    } catch (error) {
      if (error && error.status === 403) return out; // no permission to read contacts: export without names
      out.clear(); // fall back to one by one below
    }
  }
  await Promise.all(list.map(async (id) => {
    const c = await store.contactSummary(sdk, id);
    if (c) out.set(id, c.name);
  }));
  return out;
}

/**
 * One CSV cell. Text a spreadsheet would run as a formula (=…, @…, or +/- not
 * followed by a digit) gets a leading apostrophe; phone numbers like +91… stay as they are.
 */
const csvCell = (v) => {
  let s = str(v);
  if (/^[=@]/.test(s) || /^[+-](?!\d)/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
};

/* ------------------------------------------------------------------ routes */

exports.listAll = async (req, sdk) => {
  const query = queryOf(req);
  const { people, truncated } = await directory.directory(sdk, { q: query.q, category: categoryOf(query) });
  // Cursor: the id of the last person's newest record on the previous page.
  const after = str(query.after);
  let start = 0;
  if (ID_RE.test(after)) {
    const at = people.findIndex((p) => p.rows.some((r) => str(r._id) === after));
    start = at >= 0 ? at + 1 : 0;
  } else {
    start = Math.max(0, Math.min(Number.parseInt(query.skip, 10) || 0, people.length));
  }
  const page = people.slice(start, start + PAGE);
  // Lazy migration of the rows shown (profile_id = own id for older rows).
  await store.ensureProfiles(sdk, page.map((p) => p.row));
  const hasMore = start + PAGE < people.length;
  return {
    travellers: page.map(directory.presentPerson),
    total: people.length,
    totalApproximate: truncated,
    skip: start,
    hasMore,
    nextCursor: hasMore && page.length ? str(page[page.length - 1].row._id) : '',
    canEdit: sdk.permissions.has('crm.leads.write')
  };
};

exports.summary = async (req, sdk) => {
  const { people, truncated } = await directory.directory(sdk, {});
  const today = rules.todayIso(undefined, await store.timeZone(sdk));
  const [y, m, d] = today.split('-').map(Number);
  const in6Months = new Date(Date.UTC(y, m - 1 + 6, d)).toISOString().slice(0, 10);
  const out = {
    total: people.length,
    adults: 0,
    children: 0,
    infants: 0,
    unknownAge: 0,
    withPassportPhoto: 0,
    withAadhaarPhoto: 0,
    passportsExpired: 0,
    passportsExpiringSoon: 0,
    approximate: truncated
  };
  for (const p of people) {
    if (p.category === 'Adult') out.adults += 1;
    else if (p.category === 'Child') out.children += 1;
    else if (p.category === 'Infant') out.infants += 1;
    else out.unknownAge += 1;
    if (p.row.passport_file_id) out.withPassportPhoto += 1;
    if (p.row.aadhaar_file_id) out.withAadhaarPhoto += 1;
    const expiry = str(p.row.passport_expiry_date).slice(0, 10);
    if (rules.isValidDate(expiry)) {
      if (expiry < today) out.passportsExpired += 1;
      else if (expiry < in6Months) out.passportsExpiringSoon += 1;
    }
  }
  return out;
};

exports.exportCsv = async (req, sdk) => {
  const query = queryOf(req);
  const category = categoryOf(query);
  const { rows } = await directory.scanRows(sdk, directory.searchFilter(query.q), EXPORT_MAX);
  const cache = directory.newCache();
  const leads = await directory.leadFacts(sdk, rows.map((r) => r.lead_id), cache);
  const contacts = await contactNames(sdk, rows.map((r) => str(r.contact_id)));
  const header = [
    'First name', 'Last name', 'Phone', 'Email', 'Relation', 'Gender', 'Date of birth', 'Age', 'Age category', 'Nationality',
    'Lead', 'Contact person', 'Passport number (masked)', 'Passport issue date', 'Passport expiry date', 'Passport country',
    'Passport photo', 'Aadhaar number (masked)', 'Aadhaar photo', 'Added on'
  ];
  const lines = [header.map(csvCell).join(',')];
  let count = 0;
  for (const row of rows) {
    const lead = leads.get(str(row.lead_id));
    if (!lead) continue;
    const t = store.present(row, lead.ref.referenceDate, lead.rule, lead.ref.timeZone);
    if (category && t.ageCategory !== category) continue;
    lines.push([
      t.firstName, t.lastName, t.phone, t.email, t.relation, t.gender, t.dob || (t.yearOfBirth ? String(t.yearOfBirth) : ''),
      t.age === null ? '' : t.age, t.ageCategory, t.nationality, lead.name, contacts.get(t.contactId) || '',
      t.passport.numberMasked, t.passport.issueDate, t.passport.expiryDate, t.passport.country, t.passport.hasFile ? 'Yes' : 'No',
      t.aadhaar.numberMasked, t.aadhaar.hasFile ? 'Yes' : 'No', str(row.createdAt).slice(0, 10)
    ].map(csvCell).join(','));
    count += 1;
  }
  await sdk.audit('exported', `Travellers exported to CSV (${count} rows, document numbers masked)`, { count });
  const today = rules.todayIso(undefined, await store.timeZone(sdk));
  return { filename: `travellers-${today}.csv`, count, csv: lines.join('\r\n') };
};

exports.search = async (req, sdk) => {
  const query = queryOf(req);
  const q = str(query.q).trim();
  const leadId = ID_RE.test(str(query.leadId)) ? str(query.leadId) : '';
  if (q.replace(/\s+/g, '').length < 2) return { travellers: [] };
  const { people } = await directory.directory(sdk, { q });
  const top = people.slice(0, SEARCH_MAX);
  await store.ensureProfiles(sdk, top.map((p) => p.row));
  // Which of these people are on the lead already (any copy of the profile).
  let onLead = new Set();
  if (leadId && top.length) {
    const profiles = top.map((p) => store.profileOf(p.row));
    const here = await sdk.models.Traveller.find({ lead_id: leadId, profile_id: { $in: profiles } }, { limit: 500 });
    onLead = new Set(here.map((r) => store.profileOf(r)));
    for (const p of top) if (p.rows.some((r) => str(r.lead_id) === leadId)) onLead.add(store.profileOf(p.row));
  }
  return {
    travellers: top.map((p) => ({ ...directory.presentPerson(p), onLead: onLead.has(store.profileOf(p.row)) }))
  };
};

exports.trips = async (req, sdk) => {
  const { row } = await store.loadTraveller(req, sdk);
  await store.ensureProfiles(sdk, [row]);
  return { profileId: store.profileOf(row), trips: await directory.tripsFor(sdk, row) };
};

exports.leadOptions = async (req, sdk) => {
  const q = String((req.query && req.query.q) || '').trim().slice(0, 60);
  const filter = {};
  if (q) filter.$or = ['name', 'company', 'title'].map((field) => ({ [field]: { $regex: escapeRe(q), $options: 'i' } }));
  const leads = await sdk.crm.leads.find(filter, { limit: 100, sort: { createdAt: -1 } });
  const ids = leads.map((l) => str(l._id));
  const complete = ids.length
    ? await sdk.models.TravelRequirement.find({ lead_id: { $in: ids }, status: 'Complete', removed: { $ne: true } }, { limit: 500 })
    : [];
  const ready = new Set(complete.map((r) => str(r.lead_id)));
  const usable = leads.filter((l) => ready.has(str(l._id)));
  return {
    leads: usable.slice(0, 20).map((lead) => ({
      id: str(lead._id),
      name: str(lead.name),
      company: str(lead.company),
      title: str(lead.title),
      stage: str(lead.stage)
    })),
    hiddenWithoutRequirement: leads.length - usable.length
  };
};

exports.leadContacts = async (req, sdk) => {
  const leadId = String((req.params && req.params.lead_id) || '');
  const lead = await store.loadLead(sdk, leadId);
  const out = new Map();
  const add = (c, isLeadContact) => {
    if (!c || !c._id || out.has(str(c._id))) return;
    out.set(str(c._id), { id: str(c._id), name: str(c.name), phone: str(c.phone), email: str(c.email), isLeadContact });
  };
  try {
    if (ID_RE.test(str(lead.contactId))) add(await sdk.crm.contacts.findById(lead.contactId), true);
    for (const c of await sdk.crm.contacts.find({ leadIds: leadId }, { limit: 50 })) add(c, false);
  } catch (error) {
    if (error && error.status === 403) return { contacts: [], note: 'You do not have access to contacts.' };
    throw error;
  }
  return { contacts: [...out.values()] };
};

exports.detail = async (req, sdk) => {
  const { row, lead } = await store.loadTraveller(req, sdk);
  await store.ensureProfiles(sdk, [row]);
  const ref = await store.referenceFor(sdk, row.lead_id);
  const rule = await store.passportRule(sdk, ref.selected);
  const [contact, trips] = await Promise.all([store.contactSummary(sdk, row.contact_id), directory.tripsFor(sdk, row)]);
  await sdk.audit('viewed', `Traveller details viewed (lead ${row.lead_id})`, { travellerId: row._id, leadId: row.lead_id });
  return {
    traveller: store.present(row, ref.referenceDate, rule, ref.timeZone),
    lead: { id: str(lead._id), name: str(lead.name), company: str(lead.company), title: str(lead.title), stage: str(lead.stage) },
    contact,
    trips,
    referenceDate: ref.referenceDate,
    referenceSource: ref.referenceSource,
    passportRequired: rule.required,
    passportRequiredBy: rule.services,
    canEdit: sdk.permissions.has('crm.leads.write')
  };
};

exports.contactTravellers = async (req, sdk) => {
  const contactId = String((req.params && req.params.contact_id) || '');
  if (!ID_RE.test(contactId)) throw sdk.error(404, 'Contact not found', 'NOT_FOUND');
  const rows = await sdk.models.Traveller.find(
    await require('../services/lead-access.js').withVisibleLeads(sdk, { contact_id: contactId }),
    { limit: 200, sort: { createdAt: -1 } }
  );
  const leads = await directory.leadFacts(sdk, rows.map((r) => r.lead_id));
  const travellers = [];
  for (const row of rows) {
    const lead = leads.get(str(row.lead_id));
    if (!lead) continue;
    travellers.push({ ...store.present(row, lead.ref.referenceDate, lead.rule, lead.ref.timeZone), leadName: lead.name });
  }
  return { count: travellers.length, leadCount: new Set(travellers.map((t) => t.leadId)).size, travellers };
};

/* ------------------------------------------------- orphaned travellers (E9) */

/** Orphans not on a booking, and how many are skipped because a booking lists them. */
async function cleanable(sdk, orphans) {
  if (!orphans.length) return { free: [], onBooking: 0 };
  const listed = new Set();
  if (sdk.models && sdk.models.Booking) {
    const ids = orphans.map((r) => str(r._id));
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      // Errors are thrown: never delete a traveller whose bookings could not be checked. Every page is
      // read (no truncation): a traveller listed on booking 501+ must stay too.
      let lastId = '';
      for (;;) {
        const where = lastId ? { traveller_ids: { $in: part }, _id: { $gt: lastId } } : { traveller_ids: { $in: part } };
        const bookings = await sdk.models.Booking.find(where, { limit: 500, sort: { _id: 1 } });
        for (const b of bookings) for (const id of Array.isArray(b.traveller_ids) ? b.traveller_ids : []) listed.add(str(id));
        if (bookings.length < 500) break;
        lastId = str(bookings[bookings.length - 1]._id);
      }
    }
  }
  const free = orphans.filter((r) => !listed.has(str(r._id)));
  return { free, onBooking: orphans.length - free.length };
}

exports.orphans = async (req, sdk) => {
  let found;
  let split;
  try {
    found = await directory.findOrphans(sdk);
    split = await cleanable(sdk, found.orphans);
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('orphaned travellers: check failed:', error && error.message);
    throw sdk.error(503, 'Could not check for orphaned travellers right now; try again.', 'TRY_AGAIN');
  }
  const { orphans, scanned, complete } = found;
  return {
    count: split.free.length,
    onBooking: split.onBooking,
    leadCount: new Set(split.free.map((r) => str(r.lead_id))).size,
    withPhotos: split.free.filter((r) => r.passport_file_id || r.aadhaar_file_id).length,
    total: orphans.length,
    scanned,
    complete
  };
};

exports.cleanupOrphans = async (req, sdk) => {
  if (!(req.body && req.body.confirm === true)) {
    throw sdk.error(400, 'Send { confirm: true } to delete the orphaned travellers', 'CONFIRM_REQUIRED');
  }
  let free;
  let onBooking;
  try {
    const found = await directory.findOrphans(sdk);
    ({ free, onBooking } = await cleanable(sdk, found.orphans));
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('orphaned travellers: cleanup check failed:', error && error.message);
    throw sdk.error(503, 'Could not check the travellers right now. Nothing was deleted; try again.', 'TRY_AGAIN');
  }
  const batch = free.slice(0, CLEANUP_MAX);
  let deleted = 0;
  let photos = 0;
  for (const row of batch) {
    for (const column of ['passport_file_id', 'aadhaar_file_id']) {
      if (!row[column]) continue;
      try {
        // A photo shared with a record of the same person on a lead that still exists stays.
        if (await store.releaseFile(sdk, row[column], [row._id])) photos += 1;
      } catch (error) {
        if (sdk.logger) sdk.logger.warn('orphaned traveller photo not removed:', error && error.message);
      }
    }
    if (await sdk.models.Traveller.deleteById(row._id)) deleted += 1;
  }
  await sdk.audit('deleted', `Orphaned travellers deleted: ${deleted} (their leads no longer exist), ${photos} document photos removed, ${onBooking} kept because a booking lists them`, {
    deleted,
    photos,
    skipped: onBooking,
    leadIds: [...new Set(batch.map((r) => str(r.lead_id)))].slice(0, 50)
  });
  return { deleted, photos, skipped: onBooking, remaining: free.length - batch.length };
};
