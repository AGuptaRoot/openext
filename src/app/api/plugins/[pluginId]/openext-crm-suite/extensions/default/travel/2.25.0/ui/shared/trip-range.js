/**
 * The trip of a lead's values and the allowed requirement-date range from its Date Flexibility (2.23.0).
 * The same rule as the server (api/services/trip-dates.js tripOf); tests/trip-dates.test.js keeps them equal.
 *
 *   Fixed (or empty)        travel start → travel end
 *   ±1 Day / ±2 Days / ±…   travel start − 7 days → travel end + 7 days
 *   Flexible                travel start → no end
 */

export const FLEX_BUFFER_DAYS = 7;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

function isDay(value) {
  const v = str(value);
  if (!DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const day = (value) => (isDay(str(value).slice(0, 10)) ? str(value).slice(0, 10) : '');

function daysBetween(a, b) {
  if (!isDay(a) || !isDay(b)) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function addDays(value, n) {
  if (!isDay(value)) return '';
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 'fixed' | 'buffer' | 'flexible' (unknown values count as fixed). */
export function flexibilityKind(value) {
  const v = str(value).toLowerCase();
  if (v === 'flexible') return 'flexible';
  if (v.includes('±') || v.includes('+/-') || v.includes('+-')) return 'buffer';
  return 'fixed';
}

export function rangeOf(start, end, flexibility) {
  const kind = flexibilityKind(flexibility);
  const rangeStart = kind === 'buffer' ? addDays(start, -FLEX_BUFFER_DAYS) : start;
  const rangeEnd = kind === 'flexible' ? '' : kind === 'buffer' ? addDays(end, FLEX_BUFFER_DAYS) : end;
  return { flexibility: kind, rangeStart, rangeEnd };
}

/** { start, end, nights, days, flexibility, rangeStart, rangeEnd } of a lead's values. */
export function tripOf(values) {
  const v = values && typeof values === 'object' ? values : {};
  const start = day(v.travel_start_date);
  const end = day(v.travel_end_date);
  const nights = start && end && end >= start ? daysBetween(start, end) : null;
  return { start, end, nights, days: nights === null ? null : nights + 1, ...rangeOf(start, end, v.date_flexibility) };
}

/** The bounds a requirement date picker uses: { min, max, kind } ('' = no bound). */
export function allowedRange(trip) {
  const t = trip || {};
  if (Object.prototype.hasOwnProperty.call(t, 'rangeStart')) return { min: t.rangeStart || '', max: t.rangeEnd || '', kind: t.flexibility || 'fixed' };
  return { min: t.start || '', max: t.end || '', kind: 'fixed' };
}
