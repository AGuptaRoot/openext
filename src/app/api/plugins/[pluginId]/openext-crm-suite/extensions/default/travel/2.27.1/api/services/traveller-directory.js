'use strict';

/**
 * Traveller directory (Travellers page, contact section, search, trips, orphan cleanup).
 *
 * - Leads are read in batches: sdk.crm.leads.findByIds (≤ 100 ids) and sdk.values.getMany('lead', ≤ 100 ids),
 *   both CRM 3.17.0. On an older CRM (no such call, or it fails) it falls back to one read per lead.
 *   Everything read is kept in a per-request cache (`cache`), so a request never reads a lead twice.
 * - A traveller whose lead no longer exists is an orphan: left out of lists, totals and metrics, and
 *   cleaned up by an admin (Settings → Travel). A lead the user may not open is simply not shown.
 * - Copies of one person on several leads share profile_id: the directory shows one row per person.
 * - Age category is worked out on read (on the trip date of each row's lead), never taken from the
 *   stored age_category, which can be stale (it is kept for exports and refreshed on save).
 */

const rules = require('./traveller-rules.js');
const store = require('./traveller-store.js');
const { readServices } = require('./catalog.js');

const { ID_RE, str } = store;
const BATCH = 100;
const SCAN_BATCH = 500;
// Rows read for one directory answer (search / category filter / grouping are worked out on them).
const SCAN_MAX = 2000;

/** A per-request cache: leads, lead values, services, time zone. */
function newCache() {
  return { leads: new Map(), values: new Map(), services: null, zone: null };
}

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Leads by id: Map id → lead (only leads that exist and may be read; others are absent).
 * Errors are thrown (a failed read must never look like a deleted lead).
 */
async function loadLeads(sdk, ids, cache = newCache()) {
  const wanted = [...new Set((ids || []).map(str).filter((id) => ID_RE.test(id)))].filter((id) => !cache.leads.has(id));
  const leads = sdk.crm && sdk.crm.leads;
  for (const part of chunks(wanted, BATCH)) {
    let found = null;
    if (leads && typeof leads.findByIds === 'function') {
      try {
        found = await leads.findByIds(part);
      } catch (error) {
        found = null; // older CRM or a passing failure: read one by one below (errors there are thrown)
        if (sdk.logger) sdk.logger.warn('leads.findByIds failed, reading one by one:', error && error.message);
      }
    }
    if (Array.isArray(found)) {
      const byId = new Map(found.filter(Boolean).map((lead) => [str(lead._id), lead]));
      for (const id of part) cache.leads.set(id, byId.get(id) || null);
      continue;
    }
    const list = await Promise.all(part.map((id) => leads.findById(id)));
    part.forEach((id, i) => cache.leads.set(id, list[i] || null));
  }
  const out = new Map();
  for (const id of (ids || []).map(str)) if (cache.leads.get(id)) out.set(id, cache.leads.get(id));
  return out;
}

/** Travel values of leads: Map id → values ({} when none). Only call for leads that exist. */
async function loadValues(sdk, ids, cache = newCache()) {
  const wanted = [...new Set((ids || []).map(str).filter((id) => ID_RE.test(id)))].filter((id) => !cache.values.has(id));
  for (const part of chunks(wanted, BATCH)) {
    let found = null;
    if (sdk.values && typeof sdk.values.getMany === 'function') {
      try {
        found = await sdk.values.getMany('lead', part);
      } catch (error) {
        found = null;
        if (sdk.logger) sdk.logger.warn('values.getMany failed, reading one by one:', error && error.message);
      }
    }
    if (found && typeof found === 'object') {
      for (const id of part) cache.values.set(id, found[id] && typeof found[id] === 'object' ? found[id] : {});
      continue;
    }
    const list = await Promise.all(part.map((id) => sdk.values.get('lead', id).catch(() => ({}))));
    part.forEach((id, i) => cache.values.set(id, list[i] && typeof list[i] === 'object' ? list[i] : {}));
  }
  const out = new Map();
  for (const id of (ids || []).map(str)) if (cache.values.has(id)) out.set(id, cache.values.get(id));
  return out;
}

async function servicesOf(sdk, cache) {
  if (!cache.services) cache.services = await readServices(sdk);
  return cache.services;
}

async function zoneOf(sdk, cache) {
  if (!cache.zone) cache.zone = await store.timeZone(sdk);
  return cache.zone;
}

/** The passport rule of a lead from its selected services (same as store.passportRule, no extra read). */
function ruleFor(services, selected) {
  const names = services
    .filter((s) => s.enabled !== false && s.requiresPassport === true && selected.includes(s.key))
    .map((s) => s.name);
  return { required: names.length > 0, services: names };
}

/**
 * Lead facts for many traveller rows: Map leadId → { id, name, company, title, stage, values, ref, rule }.
 * Leads that do not exist (orphans) or may not be read are absent.
 */
async function leadFacts(sdk, leadIds, cache = newCache()) {
  const leads = await loadLeads(sdk, leadIds, cache);
  const ids = [...leads.keys()];
  const [values, services, zone] = await Promise.all([loadValues(sdk, ids, cache), servicesOf(sdk, cache), zoneOf(sdk, cache)]);
  const out = new Map();
  for (const id of ids) {
    const lead = leads.get(id);
    const v = values.get(id) || {};
    const ref = store.referenceFromValues(v, zone);
    out.set(id, {
      id,
      name: str(lead.name || lead.title),
      company: str(lead.company),
      title: str(lead.title),
      stage: str(lead.stage || lead.status),
      values: v,
      ref,
      rule: ruleFor(services, ref.selected)
    });
  }
  return out;
}

/** Age category of a row on its lead's trip date ('' when unknown). */
function categoryOf(row, facts) {
  return rules.ageInfo({ dob: str(row.dob).slice(0, 10), yearOfBirth: row.year_of_birth }, facts.ref.referenceDate).ageCategory;
}

const escapeRe = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Search filter (E7): every word must match the first or the last name ("Priya Sharma" finds Priya
 * Sharma); a phone number may be typed with spaces; 4 letters / digits also match the last 4 of a
 * passport / Aadhaar number.
 */
function searchFilter(q) {
  const text = String(q || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!text) return {};
  const words = text.split(' ').filter(Boolean).slice(0, 5);
  const nameOf = (w) => ({ $or: [{ first_name: { $regex: escapeRe(w), $options: 'i' } }, { last_name: { $regex: escapeRe(w), $options: 'i' } }] });
  const or = words.length === 1 ? [...nameOf(words[0]).$or] : [{ $and: words.map(nameOf) }];
  const digits = text.replace(/[\s()+-]/g, '');
  if (/^\d{3,}$/.test(digits)) or.push({ phone: { $regex: escapeRe(digits), $options: 'i' } });
  else if (words.length === 1) or.push({ phone: { $regex: escapeRe(text), $options: 'i' } });
  if (/^[A-Za-z0-9]{4}$/.test(text)) or.push({ passport_last4: text.toUpperCase() }, { aadhaar_last4: text });
  return { $or: or };
}

/**
 * Rows matching `filter`, newest first, up to SCAN_MAX (read in batches).
 * @returns {{ rows: object[], truncated: boolean }}
 */
async function scanRows(sdk, filter, max = SCAN_MAX) {
  const rows = [];
  // A sales agent's directory, search, export and metrics hold the travellers of their own leads only.
  const where = await require('./lead-access.js').withVisibleLeads(sdk, filter);
  for (let skip = 0; skip < max; skip += SCAN_BATCH) {
    const batch = await sdk.models.Traveller.find(where, { limit: SCAN_BATCH, skip, sort: { createdAt: -1 } });
    rows.push(...batch);
    if (batch.length < SCAN_BATCH) return { rows, truncated: false };
  }
  return { rows: rows.slice(0, max), truncated: rows.length >= max };
}

/**
 * The directory: rows of existing leads (orphans and unreadable leads left out), category worked out
 * on read and filtered, grouped one entry per person (newest record first).
 * @returns {{ people: Array<{ row, facts, category, rows }>, truncated: boolean, cache }}
 */
async function directory(sdk, { q = '', category = '' } = {}, cache = newCache()) {
  const { rows, truncated } = await scanRows(sdk, searchFilter(q));
  const facts = await leadFacts(sdk, rows.map((r) => r.lead_id), cache);
  const people = new Map();
  for (const row of rows) {
    const f = facts.get(str(row.lead_id));
    if (!f) continue;
    const key = store.profileOf(row);
    const entry = people.get(key);
    if (entry) {
      entry.rows.push(row);
      continue;
    }
    people.set(key, { row, facts: f, category: categoryOf(row, f), rows: [row] });
  }
  let list = [...people.values()];
  if (['Adult', 'Child', 'Infant'].includes(category)) list = list.filter((p) => p.category === category);
  return { people: list, truncated, cache };
}

/** A directory entry → the list shape (numbers masked) with lead name and trips. */
function presentPerson(p) {
  const t = store.present(p.row, p.facts.ref.referenceDate, p.facts.rule, p.facts.ref.timeZone);
  t.ageCategory = p.category;
  return {
    ...t,
    leadName: p.facts.name,
    referenceDate: p.facts.ref.referenceDate,
    trips: new Set(p.rows.map((r) => str(r.lead_id))).size
  };
}

/**
 * Travel history of the person behind a traveller row: every lead (and booking, when bookings exist)
 * of the same profile, newest first.
 */
async function tripsFor(sdk, row, cache = newCache()) {
  const profileId = store.profileOf(row);
  const copies = await sdk.models.Traveller.find(
    await require('./lead-access.js').withVisibleLeads(sdk, { $or: [{ profile_id: profileId }, { _id: profileId }] }),
    { limit: 200, sort: { createdAt: -1 } }
  );
  if (!copies.some((c) => str(c._id) === str(row._id))) copies.push(row);
  const facts = await leadFacts(sdk, copies.map((c) => c.lead_id), cache);
  const trips = [];
  const seen = new Set();
  for (const copy of copies) {
    const f = facts.get(str(copy.lead_id));
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    trips.push({
      kind: 'lead',
      leadId: f.id,
      travellerId: str(copy._id),
      title: f.title || f.name || 'Lead',
      destination: str(f.values.destination || f.values.to),
      startDate: str(f.values.travel_start_date).slice(0, 10),
      endDate: str(f.values.travel_end_date).slice(0, 10),
      status: f.stage,
      current: f.id === str(row.lead_id)
    });
  }
  try {
    const bookings = await store.bookingsFor(sdk, copies.map((c) => str(c._id)), 100);
    for (const b of bookings) {
      trips.push({
        kind: 'booking',
        bookingId: str(b._id),
        leadId: str(b.lead_id),
        title: str(b.number || b.booking_number || b.title) || 'Booking',
        destination: str(b.destination),
        startDate: str(b.travel_start_date || b.start_date).slice(0, 10),
        endDate: str(b.travel_end_date || b.end_date).slice(0, 10),
        status: str(b.status),
        current: false
      });
    }
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('traveller trips: bookings not read:', error && error.message);
  }
  const at = (t) => t.startDate || '';
  trips.sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? 1 : -1));
  return trips;
}

/**
 * Travellers whose lead no longer exists. Leads are checked in batches; a read error is thrown
 * (never treated as "deleted"). Needs a user who can read every lead (admin route).
 * @returns {{ orphans: object[], scanned: number, complete: boolean }}
 */
async function findOrphans(sdk, { max = 5000 } = {}) {
  const { rows, truncated } = await scanRows(sdk, {}, max);
  const cache = newCache();
  const leads = await loadLeads(sdk, rows.map((r) => r.lead_id), cache);
  const orphans = rows.filter((r) => !leads.has(str(r.lead_id)));
  return { orphans, scanned: rows.length, complete: !truncated };
}

module.exports = {
  SCAN_MAX,
  newCache,
  loadLeads,
  loadValues,
  leadFacts,
  categoryOf,
  searchFilter,
  scanRows,
  directory,
  presentPerson,
  tripsFor,
  findOrphans
};
