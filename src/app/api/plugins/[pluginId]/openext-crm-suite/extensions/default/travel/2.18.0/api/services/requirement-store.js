'use strict';

/**
 * Requirement instances (T2, requirements v2): a lead can have several requirements of one service
 * ("Hotel – Goa", "Hotel – Mumbai"). Each is its own TravelRequirement row with
 *   instance  1, 2, 3 … per lead and service (numbers are never reused, removed rows keep theirs)
 *   label     ≤ 80 characters; default "<Service>" for 1, "<Service> <n>" after that
 *   removed   soft remove (Remove on the tab); removed rows are kept, never shown or counted
 *
 * Lazy, idempotent migration: rows saved before 2.0.0 (no instance / label) get the next free
 * instance and the service name as label when they are read (a failed write never fails the read).
 *
 * Reading everything: a model find returns at most 500 rows, so every list here is read page by
 * page (by _id) and leads are queried in chunks of ≤ 50 — readiness and the latest-check lookups
 * never silently miss rows.
 */

const ID_RE = /^[a-f0-9]{24}$/i;
// A record id as sent in a URL (the CRM's ids are 24-hex; the model answers null for anything else).
const REC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_INSTANCES = 20;
const LABEL_MAX = 80;
const PAGE = 500;
const LEAD_CHUNK = 50;
const ID_CHUNK = 50;

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Every row matching `filter`, page by page (sorted by _id, `_id > last` for the next page).
 * @param {number} [max] safety cap on rows read (default 50 000)
 */
async function findAll(model, filter, { max = 50000 } = {}) {
  const out = [];
  let last = '';
  for (;;) {
    const where = last ? { $and: [filter, { _id: { $gt: last } }] } : filter;
    const page = await model.find(where, { limit: PAGE, sort: { _id: 1 } });
    const rows = Array.isArray(page) ? page : [];
    out.push(...rows);
    if (rows.length < PAGE || out.length >= max) break;
    const next = str(rows[rows.length - 1]._id);
    if (!next || next === last) break;
    last = next;
  }
  return out;
}

/** Every TravelRequirement row (removed included) of these leads: ≤ 50 leads per query, paged. */
async function rowsForLeads(sdk, leadIds) {
  const ids = [...new Set((leadIds || []).map(str).filter((id) => ID_RE.test(id)))];
  const out = [];
  for (const part of chunks(ids, LEAD_CHUNK)) {
    out.push(...(await findAll(sdk.models.TravelRequirement, part.length === 1 ? { lead_id: part[0] } : { lead_id: { $in: part } })));
  }
  return out;
}

const live = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.removed !== true);

const byAge = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a._id || '').localeCompare(String(b._id || ''));

function instanceOf(row) {
  const n = Number(row && row.instance);
  return Number.isInteger(n) && n >= 1 ? n : 0;
}

function defaultLabel(name, n) {
  return n > 1 ? `${name} ${n}` : name;
}

/** Name of a service for labels: the catalog's, else the one saved on the row, else the key. */
function serviceName(services, row) {
  const s = (services || []).find((x) => x && x.key === str(row.service_key));
  return str(s && s.name) || str(row.service_name) || str(row.service_key) || 'Requirement';
}

/**
 * Lazy migration (idempotent): rows without an instance get the next free number of their lead and
 * service (oldest first), rows without a label get the service name. Rows are changed in place.
 */
async function migrateRows(sdk, rows, services) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = `${str(row.lead_id)}|${str(row.service_key)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const model = sdk.models && sdk.models.TravelRequirement;
  for (const list of groups.values()) {
    if (!list.some((r) => !instanceOf(r) || !str(r.label))) continue;
    let next = Math.max(0, ...list.map(instanceOf)) + 1;
    for (const row of list.slice().sort(byAge)) {
      const patch = {};
      if (!instanceOf(row)) {
        patch.instance = next;
        next += 1;
      }
      if (!str(row.label)) patch.label = serviceName(services, row).slice(0, LABEL_MAX);
      if (!Object.keys(patch).length) continue;
      Object.assign(row, patch);
      if (!model || !row._id) continue;
      try {
        await model.updateById(row._id, patch);
      } catch (error) {
        if (sdk.logger) sdk.logger.warn('requirement migration: save failed:', error && error.message);
      }
    }
  }
  return rows;
}

/** A label as typed: trimmed, ≤ 80 characters (400 otherwise); '' means "use the default". */
function cleanLabel(sdk, raw) {
  if (raw === undefined || raw === null) return '';
  const label = String(raw).replace(/\s+/g, ' ').trim();
  if (label.length > LABEL_MAX) throw sdk.error(400, `Label must be ${LABEL_MAX} characters or fewer`, 'INVALID_LABEL');
  return label;
}

/**
 * Creates the next instance of a service for a lead. Two "add another" at the same moment cannot
 * end with the same number: after the create the rows are read again and, if another row has the
 * same number, the newer of the two takes the next free number (retried a few times).
 */
async function createInstance(sdk, { leadId, service, label, values, status }) {
  const model = sdk.models.TravelRequirement;
  const filter = { lead_id: leadId, service_key: service.key };
  const before = await findAll(model, filter);
  await migrateRows(sdk, before, [service]);
  if (live(before).length >= MAX_INSTANCES) {
    throw sdk.error(409, `A lead can have at most ${MAX_INSTANCES} ${service.name} requirements`, 'TOO_MANY_REQUIREMENTS');
  }
  const n = Math.max(0, ...before.map(instanceOf)) + 1;
  let row = await model.create({
    lead_id: leadId,
    service_key: service.key,
    service_name: service.name,
    instance: n,
    label: (label || defaultLabel(service.name, n)).slice(0, LABEL_MAX),
    removed: false,
    values,
    status
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const all = await findAll(model, filter);
    const mine = all.find((r) => str(r._id) === str(row._id)) || row;
    const clash = all.filter((r) => str(r._id) !== str(row._id) && instanceOf(r) === instanceOf(mine));
    // Only the newer row of a clash moves (the older one keeps its number).
    if (!clash.length || clash.every((other) => byAge(other, mine) > 0)) break;
    const free = Math.max(0, ...all.map(instanceOf)) + 1;
    const patch = { instance: free };
    if (!label) patch.label = defaultLabel(service.name, free).slice(0, LABEL_MAX);
    row = (await model.updateById(row._id, patch)) || { ...row, ...patch };
  }
  return row;
}

/**
 * Booking guard: a requirement on a booking cannot be removed. Refuses (503) when the bookings
 * cannot be read — never lets a remove through unchecked.
 */
async function assertNotBooked(sdk, requirementId) {
  const services = sdk.models && sdk.models.BookingService;
  if (!services) return;
  let hit;
  try {
    hit = await services.findOne({ requirement_id: str(requirementId) });
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('requirement booking check failed:', error && error.message);
    throw sdk.error(503, 'Could not check the bookings of this requirement — try again', 'BOOKING_CHECK_FAILED');
  }
  if (!hit) return;
  let number = '';
  try {
    const booking = sdk.models.Booking && ID_RE.test(str(hit.booking_id)) ? await sdk.models.Booking.findById(str(hit.booking_id)) : null;
    number = str(booking && booking.number);
  } catch {
    number = '';
  }
  throw sdk.error(409, `On booking ${number || 'BK-…'}; remove it from the booking first`, 'REQUIREMENT_BOOKED');
}

/** Checks newest first: by checked_at, then by when they were entered. */
function sortChecks(checks) {
  const t = (v) => {
    const n = Date.parse(str(v));
    return Number.isNaN(n) ? 0 : n;
  };
  return (checks || []).slice().sort((a, b) => t(b.checked_at) - t(a.checked_at) || t(b.createdAt) - t(a.createdAt) || str(b._id).localeCompare(str(a._id)));
}

/** Every check of these requirements (≤ 50 ids per query, paged). */
async function checksFor(sdk, requirementIds) {
  const model = sdk.models && sdk.models.AvailabilityCheck;
  const ids = [...new Set((requirementIds || []).map(str).filter(Boolean))];
  if (!model || !ids.length) return [];
  const out = [];
  for (const part of chunks(ids, ID_CHUNK)) {
    out.push(...(await findAll(model, part.length === 1 ? { requirement_id: part[0] } : { requirement_id: { $in: part } })));
  }
  return out;
}

/** Latest check per requirement id (Map id → check row); every requirement is covered. */
async function latestChecks(sdk, requirementIds) {
  const out = new Map();
  for (const c of sortChecks(await checksFor(sdk, requirementIds))) {
    const id = str(c.requirement_id);
    if (id && !out.has(id)) out.set(id, c);
  }
  return out;
}

/** Lead values of many leads: sdk.values.getMany (≤ 100 per call), else one get per lead. */
async function leadValues(sdk, leadIds) {
  const ids = [...new Set((leadIds || []).map(str).filter((id) => ID_RE.test(id)))];
  const out = new Map();
  if (typeof sdk.values.getMany === 'function') {
    try {
      for (const part of chunks(ids, 100)) {
        const got = (await sdk.values.getMany('lead', part)) || {};
        for (const id of part) if (got[id]) out.set(id, got[id]);
      }
      return { values: out, checked: true };
    } catch (error) {
      if (sdk.logger) sdk.logger.warn('values.getMany failed, reading one by one:', error && error.message);
      out.clear();
    }
  }
  await Promise.all(ids.map(async (id) => {
    try {
      out.set(id, (await sdk.values.get('lead', id)) || {});
    } catch {
      /* not readable: left out */
    }
  }));
  return { values: out, checked: false };
}

module.exports = {
  MAX_INSTANCES,
  LABEL_MAX,
  PAGE,
  ID_RE,
  REC_RE,
  str,
  chunks,
  findAll,
  rowsForLeads,
  live,
  instanceOf,
  defaultLabel,
  migrateRows,
  cleanLabel,
  createInstance,
  assertNotBooked,
  sortChecks,
  checksFor,
  latestChecks,
  leadValues
};
