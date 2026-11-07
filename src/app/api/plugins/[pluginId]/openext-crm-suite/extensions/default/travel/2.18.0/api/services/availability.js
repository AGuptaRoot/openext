'use strict';

/**
 * Check Availability (spec §6.3): a manual record of what a provider said about one requirement,
 * before quoting. Every check is a new row (history); the newest one is the requirement's current
 * availability. "Available" is not a booking; a check past its "valid until" is Expired.
 *
 * Dates: "valid until" given as a day means the end of that day in the workspace time zone
 * (ctx.timeZone, IANA name; default Asia/Kolkata).
 */

const STATUSES = ['Available', 'Held', 'On Request', 'Unavailable'];
const CHANNELS = ['Phone', 'WhatsApp', 'Email', 'Website', 'Other'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TZ = 'Asia/Kolkata';

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

function badInput(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'INVALID_INPUT';
  return error;
}

function parseMoment(v) {
  const text = str(v);
  if (!text) return null;
  const t = Date.parse(ISO_DAY.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Minutes the time zone is ahead of UTC at a moment (e.g. +330 for Asia/Kolkata). */
function zoneOffsetMinutes(timeZone, at) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(at);
    const get = (type) => Number((parts.find((p) => p.type === type) || {}).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** 23:59:59.999 of a calendar day in the time zone, as a Date. */
function endOfDay(isoDay, timeZone = DEFAULT_TZ) {
  const utcEnd = Date.parse(`${isoDay}T23:59:59.999Z`);
  const offset = zoneOffsetMinutes(timeZone, new Date(utcEnd));
  return new Date(utcEnd - offset * 60000);
}

/** Today's date (YYYY-MM-DD) in the time zone. */
function todayIn(timeZone = DEFAULT_TZ, now = new Date()) {
  return new Date(now.getTime() + zoneOffsetMinutes(timeZone, now) * 60000).toISOString().slice(0, 10);
}

/** Price inputs the dialog shows for a service's pricing. */
function priceKeys(pricing) {
  return pricing === 'per_person' ? ['adult', 'child', 'infant'] : ['unit'];
}

/**
 * Checks a new availability check and returns the row to store.
 * @param {object} body  { provider, status, prices, currency, checked_at, valid_until, channel, contact_person, notes }
 * @param {{ pricing: string, now?: Date, currency?: string, timeZone?: string }} ctx
 */
function cleanCheck(body = {}, ctx = {}) {
  const now = ctx.now || new Date();
  const timeZone = ctx.timeZone || DEFAULT_TZ;
  const provider = str(body.provider).slice(0, 121);
  if (!provider) throw badInput('Provider / property name is required');
  if (provider.length > 120) throw badInput('Provider must be 120 characters or fewer');
  const status = str(body.status);
  if (!STATUSES.includes(status)) throw badInput(`Response status must be one of ${STATUSES.join(', ')}`);

  const checkedAt = body.checked_at ? parseMoment(body.checked_at) : now;
  if (!checkedAt) throw badInput('Checked at must be a date and time');
  if (checkedAt.getTime() > now.getTime() + 5 * 60 * 1000) throw badInput('Checked at cannot be in the future');

  let validUntil = null;
  if (str(body.valid_until)) {
    const raw = str(body.valid_until);
    validUntil = ISO_DAY.test(raw) ? endOfDay(raw, timeZone) : parseMoment(raw);
    if (!validUntil || Number.isNaN(validUntil.getTime())) throw badInput('Valid until must be a date');
    if (validUntil.getTime() < checkedAt.getTime()) throw badInput('Valid until cannot be before the check');
  }
  if (status === 'Held' && !validUntil) throw badInput('A hold needs a "valid until" date');

  const prices = {};
  const rawPrices = body.prices && typeof body.prices === 'object' ? body.prices : {};
  for (const key of priceKeys(ctx.pricing)) {
    if (rawPrices[key] === undefined || rawPrices[key] === null || rawPrices[key] === '') continue;
    const n = Number(rawPrices[key]);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) {
      throw badInput(`${key === 'unit' ? 'Price' : `${key[0].toUpperCase()}${key.slice(1)} price`} must be a number of 0 or more`);
    }
    prices[key] = Math.round(n * 100) / 100;
  }
  const currency = str(body.currency || ctx.currency || 'INR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw badInput('Currency must be a 3-letter code');
  const channel = str(body.channel);
  if (channel && !CHANNELS.includes(channel)) throw badInput(`Contact channel must be one of ${CHANNELS.join(', ')}`);
  const contactPerson = str(body.contact_person);
  if (contactPerson.length > 80) throw badInput('Contact person must be 80 characters or fewer');
  const notes = str(body.notes);
  if (notes.length > 2000) throw badInput('Notes must be 2000 characters or fewer');
  return {
    provider,
    status,
    prices,
    currency,
    checked_at: checkedAt.toISOString(),
    valid_until: validUntil ? validUntil.toISOString() : '',
    channel,
    contact_person: contactPerson,
    notes
  };
}

/**
 * The latest check of a requirement, as shown on its card and used by the quotation.
 * Prices are left out unless `withPrices` (callers pass the user's finance-read permission).
 */
function summarize(check, now = new Date(), { withPrices = true } = {}) {
  if (!check) return null;
  const until = parseMoment(check.valid_until);
  const expired = Boolean(until && until.getTime() < now.getTime() && check.status !== 'Unavailable');
  return {
    id: String(check._id || ''),
    status: check.status,
    effective: expired ? 'Expired' : check.status,
    expired,
    provider: str(check.provider),
    prices: withPrices && check.prices && typeof check.prices === 'object' ? check.prices : {},
    currency: str(check.currency) || 'INR',
    checked_at: str(check.checked_at),
    valid_until: str(check.valid_until),
    has_evidence: Boolean(check.evidence_file_id)
  };
}

/** Newest check per requirement id, from a list sorted newest first. */
function latestByRequirement(checks) {
  const out = new Map();
  for (const c of checks || []) {
    const id = str(c.requirement_id);
    if (id && !out.has(id)) out.set(id, c);
  }
  return out;
}

module.exports = { STATUSES, CHANNELS, DEFAULT_TZ, cleanCheck, summarize, latestByRequirement, priceKeys, endOfDay, todayIn, zoneOffsetMinutes };
