'use strict';

/**
 * Location (state / district / city) helpers shared by the Location Wise report and the
 * Leads / Clients list drill-down filters. Generic: works on any record with three location fields.
 *
 * Matching ignores case and extra spaces: "Surat" = "surat " = "SURAT" = "  surat ".
 */

const LOCATION_PARTS = ['state', 'district', 'city'];

/** Trim and collapse inner whitespace ("  New   Delhi " → "New Delhi"). */
function cleanLocation(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

/** Grouping key: cleaned and lower-cased. */
function locationKey(value) {
  return cleanLocation(value).toLowerCase();
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive exact match that tolerates surrounding / repeated spaces. Null when empty. */
function locationRegex(value) {
  const words = cleanLocation(value).split(' ').filter(Boolean);
  if (!words.length) return null;
  return new RegExp(`^\\s*${words.map(escapeRegex).join('\\s+')}\\s*$`, 'i');
}

function isTruthyFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Read the location filter from a query object.
 * Params: state, district, city (exact, case-insensitive), stateNotSet / districtNotSet / cityNotSet
 * (that part is empty) and locationNotSet=1 (all three empty).
 * @returns {{ state: string, district: string, city: string, stateNotSet: boolean, districtNotSet: boolean, cityNotSet: boolean, active: boolean }}
 */
function parseLocationQuery(query = {}) {
  const q = query || {};
  const all = isTruthyFlag(q.locationNotSet);
  const out = { active: false };
  for (const part of LOCATION_PARTS) {
    const notSet = all || isTruthyFlag(q[`${part}NotSet`]);
    out[`${part}NotSet`] = notSet;
    out[part] = notSet ? '' : cleanLocation(q[part]);
    if (notSet || out[part]) out.active = true;
  }
  return out;
}

const EMPTY_VALUE = { $in: ['', null] };

/**
 * Mongo clauses for a parsed location filter.
 * @param {object} loc — from parseLocationQuery
 * @param {{ state: string, district: string, city: string }} paths — document paths of the three fields
 * @returns {object[]} clauses to AND into a filter
 */
function buildLocationClauses(loc, paths) {
  const clauses = [];
  if (!loc || !loc.active) return clauses;
  for (const part of LOCATION_PARTS) {
    const path = paths[part];
    if (!path) continue;
    if (loc[`${part}NotSet`]) {
      clauses.push({ [path]: EMPTY_VALUE });
    } else if (loc[part]) {
      clauses.push({ [path]: locationRegex(loc[part]) });
    }
  }
  return clauses;
}

/** AND extra clauses into a filter without disturbing an existing $or. */
function andInto(filter, clauses) {
  if (!clauses || !clauses.length) return filter;
  filter.$and = [...(Array.isArray(filter.$and) ? filter.$and : []), ...clauses];
  return filter;
}

/** Does a set of grouping keys pass the parsed location filter? (keys already lower-cased) */
function keysMatchLocation(keys, loc) {
  if (!loc || !loc.active) return true;
  return LOCATION_PARTS.every((part) => {
    const k = keys[part] || '';
    if (loc[`${part}NotSet`]) return k === '';
    if (loc[part]) return k === locationKey(loc[part]);
    return true;
  });
}

module.exports = {
  LOCATION_PARTS,
  cleanLocation,
  locationKey,
  locationRegex,
  parseLocationQuery,
  buildLocationClauses,
  andInto,
  keysMatchLocation,
  isTruthyFlag
};
