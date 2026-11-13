'use strict';

/**
 * Trip dates (2.12.0). A lead's Travel Start / End Date bound the dates of its Travel Requirements, and a
 * travel quotation is not valid after the trip starts. Every date here is a date-only day "YYYY-MM-DD",
 * compared as text: no Date in another time zone, so 5 Nov never becomes 4 or 6 Nov.
 *
 * Requirement rules come from each Services & Forms field (api/services/catalog.js), never from a fixed
 * list of services:
 *   date    dateConstraint 'lead_travel_range' → inside the trip's allowed range (2.23.0, Date Flexibility):
 *             Fixed (or empty)       travelStart ≤ date ≤ travelEnd
 *             ±1 Day / ±2 Days / ±…  travelStart − 7 days ≤ date ≤ travelEnd + 7 days (the stated ± is kept
 *                                    as the customer's flexibility; 7 days is the working limit)
 *             Flexible               travelStart ≤ date, no Travel End Date maximum
 *           The browser uses the same rule (ui/shared/trip-range.js; tests keep the two equal).
 *           after / afterStrict                → not before (afterStrict: strictly after) another date
 *   number  nightsFrom / nightsTo              → the nights between two dates of the form (calculated)
 *           tripLimit 'nights' | 'days'        → at most the trip's nights / days
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

/** A real calendar day "YYYY-MM-DD". */
function isDay(value) {
  const v = str(value);
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const day = (value) => (isDay(str(value).slice(0, 10)) ? str(value).slice(0, 10) : '');

/** Whole days from a to b (b − a); null when either is missing. */
function daysBetween(a, b) {
  if (!isDay(a) || !isDay(b)) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** "2026-11-10" → "10 Nov 2026". */
function prettyDay(value) {
  if (!isDay(value)) return str(value);
  const [y, m, d] = value.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * The trip of a lead's values: { start, end, nights, days } (nights / days null when unknown) and the
 * allowed requirement-date range from its Date Flexibility (flexibility, rangeStart, rangeEnd).
 */
function tripOf(values) {
  const v = values && typeof values === 'object' ? values : {};
  const start = day(v.travel_start_date);
  const end = day(v.travel_end_date);
  const nights = start && end && end >= start ? daysBetween(start, end) : null;
  return { start, end, nights, days: nights === null ? null : nights + 1, ...rangeOf(start, end, v.date_flexibility) };
}

/** The allowed range of a trip object (older callers pass only start / end: the exact trip). */
function allowedRange(trip = {}) {
  if (Object.prototype.hasOwnProperty.call(trip, 'rangeStart')) {
    return { lo: trip.rangeStart || '', hi: trip.rangeEnd || '', kind: trip.flexibility || 'fixed' };
  }
  return { lo: trip.start || '', hi: trip.end || '', kind: 'fixed' };
}

const isEmpty = (v) => v === undefined || v === null || v === '';

/** Days of working buffer on both sides of the trip for a "±" Date Flexibility. */
const FLEX_BUFFER_DAYS = 7;

/** Day + n ("YYYY-MM-DD"), '' when not a day. */
function addDays(value, n) {
  if (!isDay(value)) return '';
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 'fixed' | 'buffer' | 'flexible' for a Date Flexibility value (unknown values count as fixed). */
function flexibilityKind(value) {
  const v = str(value).toLowerCase();
  if (v === 'flexible') return 'flexible';
  if (v.includes('±') || v.includes('+/-') || v.includes('+-')) return 'buffer';
  return 'fixed';
}

/** The allowed requirement-date range of a trip: { flexibility, rangeStart, rangeEnd } ('' = no bound). */
function rangeOf(start, end, flexibility) {
  const kind = flexibilityKind(flexibility);
  const rangeStart = kind === 'buffer' ? addDays(start, -FLEX_BUFFER_DAYS) : start;
  const rangeEnd = kind === 'flexible' ? '' : kind === 'buffer' ? addDays(end, FLEX_BUFFER_DAYS) : end;
  return { flexibility: kind, rangeStart, rangeEnd };
}

/**
 * Trip rules of one requirement form for its values: errors [{ key, message }] and calculated
 * values ({ <nights field>: n } when its two dates are set and nothing was entered).
 * @param {object[]} fields  enabled fields of the service (cleaned by catalog.normalizeServices)
 * @param {object}   values  checked values of the form
 * @param {{ start, end, nights, days }} trip
 */
function requirementTripCheck(fields, values, tripIn = {}) {
  const trip = tripIn || {};
  const errors = [];
  const auto = {};
  const list = Array.isArray(fields) ? fields : [];
  const byKey = new Map(list.map((f) => [f.key, f]));
  const labelOf = (key) => {
    const f = byKey.get(key);
    return (f && f.label) || key;
  };
  const range = allowedRange(trip);
  const why = range.kind === 'buffer' ? ` (travel dates ± ${FLEX_BUFFER_DAYS} days)` : '';
  for (const field of list) {
    const label = field.label || field.key;
    if (field.type === 'date' && field.dateConstraint === 'lead_travel_range') {
      const v = day(values[field.key]);
      if (!v) continue;
      const { lo, hi } = range;
      if (lo && hi && (v < lo || v > hi)) {
        errors.push({ key: field.key, message: `${label} must be between ${prettyDay(lo)} and ${prettyDay(hi)}${why}.` });
      } else if (lo && !hi && v < lo) {
        errors.push({ key: field.key, message: `${label} cannot be before ${range.kind === 'buffer' ? prettyDay(lo) + why : `the Travel Start Date (${prettyDay(lo)})`}.` });
      } else if (hi && !lo && v > hi) {
        errors.push({ key: field.key, message: `${label} cannot be after ${range.kind === 'buffer' ? prettyDay(hi) + why : `the Travel End Date (${prettyDay(hi)})`}.` });
      }
      continue;
    }
    if (field.type !== 'number') continue;
    const raw = values[field.key];
    const n = isEmpty(raw) ? null : Number(raw);
    if (n !== null && !Number.isFinite(n)) continue; // reported as "must be a number" already
    // Nights between two dates of the form (e.g. Check-In → Check-Out): calculated, never more or less.
    const stay = field.nightsFrom && field.nightsTo ? daysBetween(day(values[field.nightsFrom]), day(values[field.nightsTo])) : null;
    if (stay !== null && stay > 0) {
      if (n === null) auto[field.key] = stay;
      else if (n > stay) errors.push({ key: field.key, message: `${label} cannot exceed ${stay}.` });
      else if (n !== stay) errors.push({ key: field.key, message: `${label} must be ${stay} (${labelOf(field.nightsFrom)} to ${labelOf(field.nightsTo)}).` });
      continue;
    }
    // The trip's own nights / days (± moves the trip, not its length); Flexible has no end, so no limit.
    const limit = range.kind === 'flexible' ? null : field.tripLimit === 'nights' ? trip.nights : field.tripLimit === 'days' ? trip.days : null;
    if (n !== null && limit !== null && limit !== undefined && n > limit) {
      errors.push({ key: field.key, message: `${label} cannot exceed ${limit}.` });
    }
  }
  return { errors, auto };
}

module.exports = { FLEX_BUFFER_DAYS, isDay, day, daysBetween, addDays, prettyDay, flexibilityKind, rangeOf, tripOf, requirementTripCheck };
