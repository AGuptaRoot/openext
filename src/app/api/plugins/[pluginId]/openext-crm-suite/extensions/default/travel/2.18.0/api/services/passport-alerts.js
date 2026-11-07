'use strict';

/**
 * Passport alerts (2.14.0): which passports are expired or expire within 6 months, for the dashboard,
 * the client's Travellers tab and the "Passport Expiry Alert" notification.
 *
 *   Expired        expiryDate < today
 *   Expiring Soon  today ≤ expiryDate ≤ today + 6 months   (a passport that ends today is still valid today)
 *
 * Days are "YYYY-MM-DD" in the workspace time zone (Settings → Travel → Time zone). Nothing here reads
 * or shows a passport number.
 *
 * The notification goes to the lead's assigned user (else its creator), once per traveller and expiry
 * date (CRM sdk.notify keeps it to one), from the daily job (manifest `schedules`) and when a traveller
 * is saved with a passport already inside the window.
 */

const rules = require('./traveller-rules.js');
const store = require('./traveller-store.js');

const { str, ID_RE } = store;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SWEEP_MAX = 5000;
const BATCH = 500;

/** "2026-11-05" + 6 months → "2027-05-05" (calendar months). */
function addMonths(day, n) {
  if (!rules.isValidDate(day)) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
}

function prettyDay(day) {
  if (!rules.isValidDate(day)) return '';
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** 'Expired' | 'Expiring Soon' | 'Valid' | 'Missing' for a passport expiry date. */
function passportStatus(expiry, today) {
  const e = str(expiry).slice(0, 10);
  if (!rules.isValidDate(e)) return 'Missing';
  if (e < today) return 'Expired';
  if (e <= addMonths(today, 6)) return 'Expiring Soon';
  return 'Valid';
}

const fullName = (row) => [str(row.first_name), str(row.last_name)].filter(Boolean).join(' ') || 'Traveller';
const travellerLink = (row) => `/ext/travel/travellers?traveller=${encodeURIComponent(str(row._id))}`;

/**
 * Expired and expiring travellers among `rows`, one per person (profile), most urgent first:
 * expired (latest expiry first), then expiring (soonest first).
 */
function alertsOf(rows, today) {
  const people = new Map();
  for (const row of rows || []) {
    const status = passportStatus(row.passport_expiry_date, today);
    if (status !== 'Expired' && status !== 'Expiring Soon') continue;
    const key = store.profileOf(row) || str(row._id);
    const prev = people.get(key);
    if (!prev || str(row.passport_expiry_date) > str(prev.row.passport_expiry_date)) people.set(key, { row, status });
  }
  const list = [...people.values()];
  const expired = list.filter((x) => x.status === 'Expired').sort((a, b) => (str(a.row.passport_expiry_date) > str(b.row.passport_expiry_date) ? -1 : 1));
  const expiring = list.filter((x) => x.status === 'Expiring Soon').sort((a, b) => (str(a.row.passport_expiry_date) < str(b.row.passport_expiry_date) ? -1 : 1));
  return { expired, expiring };
}

/** The CRM user responsible for a lead: its assigned user, else its creator ('' when unknown). */
const ownerOf = (lead) => [lead && lead.assignedTo, lead && lead.createdBy].map((v) => str(v && typeof v === 'object' ? v._id : v)).find((v) => ID_RE.test(v)) || '';

async function leadsById(sdk, ids) {
  const out = new Map();
  const list = [...new Set(ids.map(str).filter((id) => ID_RE.test(id)))];
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    let rows = [];
    try {
      rows = typeof sdk.crm.leads.findByIds === 'function' ? await sdk.crm.leads.findByIds(part) : await Promise.all(part.map((id) => sdk.crm.leads.findById(id).catch(() => null)));
    } catch {
      rows = [];
    }
    for (const lead of rows) if (lead) out.set(str(lead._id), lead);
  }
  return out;
}

/** Sends the alert for travellers whose passport is in the 6-month window. Returns { sent, checked }. */
async function notifyFor(sdk, rows, today) {
  if (!sdk || typeof sdk.notify !== 'function') return { sent: 0, checked: 0 }; // CRM older than 3.33.0
  const { expiring } = alertsOf(rows, today);
  if (!expiring.length) return { sent: 0, checked: 0 };
  const leads = await leadsById(sdk, expiring.map((x) => x.row.lead_id));
  let sent = 0;
  for (const { row } of expiring) {
    const owner = ownerOf(leads.get(str(row.lead_id)));
    if (!owner) continue;
    const expiry = str(row.passport_expiry_date).slice(0, 10);
    try {
      const res = await sdk.notify({
        userIds: [owner],
        title: 'Passport Expiry Alert',
        message: `${fullName(row)}'s passport expires on ${prettyDay(expiry)}.`,
        link: travellerLink(row),
        linkLabel: 'View Traveller',
        // Once per person and expiry date: a renewed passport (new date) alerts again when its time comes.
        key: `passport-expiry:${store.profileOf(row) || str(row._id)}:${expiry}`
      });
      sent += Number(res && res.sent) || 0;
    } catch (error) {
      if (sdk.logger) sdk.logger.warn('passport alert not sent:', error && error.message);
    }
  }
  return { sent, checked: expiring.length };
}

async function todayFor(sdk) {
  return rules.todayIso(undefined, await store.timeZone(sdk));
}

/** POST /passport-alerts/sweep — the daily job (run by the CRM as the system). */
async function sweep(sdk) {
  const today = await todayFor(sdk);
  const until = addMonths(today, 6);
  const rows = [];
  for (let skip = 0; skip < SWEEP_MAX; skip += BATCH) {
    const batch = await sdk.models.Traveller.find({ passport_expiry_date: { $exists: true, $ne: '' } }, { limit: BATCH, skip, sort: { createdAt: 1 } });
    rows.push(...batch.filter((r) => {
      const e = str(r.passport_expiry_date).slice(0, 10);
      return rules.isValidDate(e) && e >= today && e <= until;
    }));
    if (batch.length < BATCH) break;
  }
  return notifyFor(sdk, rows, today);
}

/** After a traveller is saved: alert at once when its passport is already in the window. Never throws. */
async function afterSave(sdk, row) {
  try {
    if (!row || !rules.isValidDate(str(row.passport_expiry_date).slice(0, 10))) return;
    await notifyFor(sdk, [row], await todayFor(sdk));
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('passport alert check failed:', error && error.message);
  }
}

module.exports = { addMonths, prettyDay, passportStatus, alertsOf, ownerOf, notifyFor, sweep, afterSave, travellerLink, fullName };
