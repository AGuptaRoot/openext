'use strict';

/**
 * Date-only business values ("YYYY-MM-DD": travel dates, issue date, valid till). They are compared as
 * text, never through a Date in another time zone, so 5 Nov never turns into 4 or 6 Nov.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" when the text is a real calendar day, else ''. */
function isDay(value) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Today's day on this server's clock (its local time zone, not UTC). */
function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * The day of a stored value: a "YYYY-MM-DD…" text as written, a Date by its UTC day (date-only values are
 * stored at UTC midnight). '' when there is none.
 */
function dayOf(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') {
    const head = value.trim().slice(0, 10);
    if (isDay(head)) return head;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** A day as a Date at UTC midnight, for storing a date-only value. */
function dayToDate(day) {
  return isDay(day) ? new Date(`${day}T00:00:00.000Z`) : null;
}

/** Day + n days ("YYYY-MM-DD"). */
function addDays(day, n) {
  if (!isDay(day)) return '';
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(n || 0));
  return date.toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-05" → "5 Nov 2026" (for messages). */
function prettyDay(day) {
  if (!isDay(day)) return String(day || '');
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

module.exports = { DAY_RE, isDay, localDay, dayOf, dayToDate, addDays, prettyDay };
