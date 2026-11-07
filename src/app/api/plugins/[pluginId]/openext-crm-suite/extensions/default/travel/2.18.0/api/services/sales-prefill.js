'use strict';

/**
 * What a new opportunity / quotation starts with, from the lead's travel data
 * (CRM sales-flow contract: manifest salesFlow.opportunityPrefillRoute / quotationPrefillRoute).
 *
 * Opportunity: title "Goa — 2 Adults, 1 Child · 12–18 Jun 2026", close date before travel, the lead's
 *   Deal Value, trip fields (destination, dates, trip type, traveller counts), one line per Complete
 *   service (saved as the opportunity's products) and panels with the lead's travel services and travellers
 *   (shown in place of the product lines: manifest salesFlow.hideOpportunityLines).
 * Quotation (manifest salesFlow.lockQuotationLines): lines from the Complete services; the agent enters
 *   the rate, availability and provider. Quantity and unit by the service's Pricing (Services & Forms):
 *     per_person      one line per Adult / Child / Infant group ("2 Adults")
 *     per_room_night  rooms × nights ("Rooms × Nights"; number_of_rooms / number_of_nights or check-in/out)
 *     per_unit        number_of_vehicles / participants, else 1 ("2 Vehicles", "1 Service")
 *   Tax from the service's Quotation tax %. Also: title and description, the trip summary row, the
 *   travellers (names only), services the agent may add by hand, sections (inclusions, exclusions,
 *   cancellation policy from Settings → Travel; traveller names) and warnings.
 * Document numbers never appear.
 *
 * 2.1.0 (CRM 3.18.0 sales forms): the opportunity gets every Trip / Travellers field, the title
 * "<Destination> trip – <Customer> · <Mon YYYY>", a close date N days before the trip (Settings → Travel)
 * and right-column checks. Quotation lines carry their group (Services & Forms → Quotation: line group)
 * and the extra columns (date, route, cabin class, room type, meal plan); the quotation also gets its
 * declared values (travellers, special requests), a default "Valid till" (earliest supplier hold, or
 * today + N days), the latest valid till a hold allows (validTillMax), checks and a read-only Day plan.
 */

const { readServices, quotationGroupOf } = require('./catalog.js');
const rules = require('./traveller-rules.js');
const { readinessFor } = require('./readiness.js');
const { refreshStatuses } = require('./requirement-status.js');
const { migrateRows, live, latestChecks, rowsForLeads } = require('./requirement-store.js');
const { summarize, todayIn } = require('./availability.js');
const itinerary = require('./itinerary.js');

const ID_RE = /^[a-f0-9]{24}$/i;
const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso, withYear) {
  if (!rules.isValidDate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

function dateRange(start, end) {
  if (!rules.isValidDate(start)) return '';
  // An end before the start is a typing mistake: show the start only (warningsFor flags it).
  if (!rules.isValidDate(end) || end <= start) return shortDate(start, true);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${Number(start.slice(8, 10))}–${shortDate(end, true)}`; // 12–18 Jun 2027
  return start.slice(0, 4) === end.slice(0, 4) ? `${shortDate(start, false)}–${shortDate(end, true)}` : `${shortDate(start, true)} – ${shortDate(end, true)}`;
}

/** Whole days from a to b; null when either is missing or b is not after a (reversed dates). */
function daysBetween(a, b) {
  if (!rules.isValidDate(a) || !rules.isValidDate(b)) return null;
  const days = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  return days > 0 ? days : null;
}

function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** A whole-number setting within [min, max]; the fallback when it is unset or not a number. */
async function numberSetting(sdk, key, fallback, min, max) {
  let raw;
  try {
    raw = await sdk.settings.get(key);
  } catch {
    raw = undefined;
  }
  const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** A checkbox setting; the fallback when it was never saved. */
async function flagSetting(sdk, key, fallback) {
  try {
    const v = await sdk.settings.get(key);
    return v === undefined || v === null ? fallback : v === true;
  } catch {
    return fallback;
  }
}

/** Lead "Date Flexibility" (±1 Day …) → opportunity options (Fixed, ± 1–2 days, ± 1 week, Flexible). */
function flexibilityFor(value) {
  const v = str(value);
  if (!v) return '';
  if (/^fixed$/i.test(v)) return 'Fixed';
  if (/flexible/i.test(v)) return 'Flexible';
  if (/(^|\D)[12]\s*days?/i.test(v) || /1\s*[–-]\s*2/.test(v)) return '± 1–2 days';
  if (/(^|\D)[3-7]\s*days?|week/i.test(v)) return '± 1 week';
  return '';
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Everything both prefills need about one lead. */
async function loadTrip(sdk, leadId) {
  const id = str(leadId);
  if (!ID_RE.test(id)) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  const lead = await sdk.crm.leads.findById(id);
  if (!lead) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  const [values, services, requirements, travellers, readiness] = await Promise.all([
    sdk.values.get('lead', id),
    readServices(sdk),
    rowsForLeads(sdk, [id]),
    sdk.models.Traveller.find({ lead_id: id }, { limit: 200, sort: { createdAt: 1 } }),
    readinessFor(sdk, [id])
  ]);
  // Requirement instances (several per service, v2), without removed ones.
  await migrateRows(sdk, requirements, services);
  const rows = live(requirements).sort((a, b) => Number(a.instance || 1) - Number(b.instance || 1));
  await refreshStatuses(sdk, rows, services);
  const checks = await latestChecks(sdk, rows.filter((r) => r._id && r.status === 'Complete').map((r) => r._id));
  const now = new Date();
  let withPrices = false;
  try {
    withPrices = Boolean(sdk.permissions && sdk.permissions.has('crm.finance.read'));
  } catch {
    withPrices = false;
  }
  const start = str(values.travel_start_date).slice(0, 10);
  const end = str(values.travel_end_date).slice(0, 10);
  // "Today" in the workspace time zone (Settings → Travel → Time zone).
  let timeZone = rules.DEFAULT_TZ;
  try {
    timeZone = rules.cleanTimeZone(await sdk.settings.get('timezone'));
  } catch {
    timeZone = rules.DEFAULT_TZ;
  }
  const today = rules.todayIso(undefined, timeZone);
  const referenceDate = rules.isValidDate(start) ? start : today;

  // Traveller groups: the travellers added on the lead (no known age = Adult) win over the lead's
  // own counts, unless fewer travellers were added than the lead says travel (rules.travellerGroups).
  const expected = [values.adults, values.children, values.infants].some((v) => num(v) !== null)
    ? { adults: num(values.adults) || 0, children: num(values.children) || 0, infants: num(values.infants) || 0 }
    : null;
  const categories = travellers.map((t) => rules.ageInfo({ dob: str(t.dob).slice(0, 10), yearOfBirth: t.year_of_birth }, referenceDate).ageCategory);
  const { groups } = rules.travellerGroups(categories, expected);

  const selected = Array.isArray(values.required_services) ? values.required_services.map(String) : [];
  const byKey = new Map(services.filter((s) => s.enabled !== false).map((s) => [s.key, s]));
  // Selected services in the services' order; each with its live requirement instances.
  const chosen = services
    .filter((s) => selected.includes(s.key) && byKey.has(s.key))
    .map((s) => {
      const list = rows.filter((r) => str(r.service_key) === s.key);
      const instances = list.map((r) => ({
        requirement: r,
        label: str(r.label) || s.name,
        complete: r.status === 'Complete',
        status: str(r.status) || 'Draft',
        // Rates only for users who may see money (crm.finance.read); others get lines without a rate.
        check: r.status === 'Complete' && r._id ? summarize(checks.get(str(r._id)), now, { withPrices }) : null
      }));
      return { service: s, instances, complete: instances.filter((i) => i.complete) };
    });

  return { id, lead, values, start, end, referenceDate, timeZone, today, groups, travellers, chosen, readiness: readiness[id] || null };
}

function groupsText(groups) {
  const parts = [];
  if (groups.Adult) parts.push(plural(groups.Adult, 'Adult', 'Adults'));
  if (groups.Child) parts.push(plural(groups.Child, 'Child', 'Children'));
  if (groups.Infant) parts.push(plural(groups.Infant, 'Infant', 'Infants'));
  return parts.join(', ');
}

/**
 * "3★ · 2 rooms · Breakfast" from the requirement's values, using the form's labels. Lines (quotation,
 * opportunity products) never carry fields marked "Hide on voucher" (internal); the opportunity's
 * read-only panels may (`internal: true`).
 */
function requirementSummary(service, requirement, max = 6, { internal = false } = {}) {
  if (!requirement || !requirement.values) return '';
  const out = [];
  for (const field of service.fields || []) {
    if (field.enabled === false || field.type === 'textarea') continue;
    if (!internal && field.hideOnVoucher === true) continue;
    const v = requirement.values[field.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const text = Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    out.push(`${field.label}: ${text}`);
    if (out.length >= max) break;
  }
  return out.join(' · ').slice(0, 900);
}

/** Every filled field of a requirement as { label, value } (long text included; hidden fields only when `internal`). */
function requirementDetails(service, requirement, { internal = false } = {}) {
  if (!requirement || !requirement.values) return [];
  const out = [];
  for (const field of service.fields || []) {
    if (field.enabled === false) continue;
    if (!internal && field.hideOnVoucher === true) continue;
    const v = requirement.values[field.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const value = Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    out.push({ label: String(field.label || field.key), value: value.slice(0, 500) });
    if (out.length >= 30) break;
  }
  return out;
}

function travellerName(t) {
  return [str(t.first_name), str(t.last_name)].filter(Boolean).join(' ') || 'Traveller';
}

const PASSPORT_BADGE = {
  expired: 'Passport expired',
  before_travel: 'Passport expires before trip',
  within_6_months: 'Passport < 6 months'
};

/** Name of a requirement on lines and panels: its label when the service has more than one. */
function nameOf(c, inst) {
  return (c.instances.length > 1 ? inst.label : c.service.name).slice(0, 200);
}

/** "Complete · Held", "Complete · Expired", "Draft" (panel badge, at most 40 characters). */
function badgeOf(inst) {
  if (!inst.complete) return inst.status;
  return (inst.check ? `${inst.status} · ${inst.check.effective}` : inst.status).slice(0, 40);
}

/** Travellers panel "Passport": a number on file, only an uploaded passport, or nothing yet. */
function passportText(t, expiry) {
  const base = t.passport_number_enc ? 'On file' : t.passport_file_id ? 'Uploaded' : expiry ? 'On file' : '';
  if (!base) return 'Not added';
  return `${base}${expiry ? `, expires ${expiry}` : ''}`;
}

/** Read-only panels for the opportunity page: the lead's travel services and travellers. */
function panelsFor(trip) {
  const services = trip.chosen.flatMap((c) => {
    if (!c.instances.length) return [{ title: c.service.name, badge: 'Not started', subtitle: '', details: [] }];
    return c.instances.map((inst) => {
      const details = requirementDetails(c.service, inst.requirement, { internal: true });
      if (inst.check) {
        const until = inst.check.valid_until && !inst.check.expired ? ` (valid till ${shortDate(inst.check.valid_until.slice(0, 10), false)})` : '';
        details.unshift(
          ...[
            ['Availability', `${inst.check.effective}${until}`],
            ['Provider', inst.check.provider]
          ].filter(([, v]) => v).map(([label, value]) => ({ label, value }))
        );
      }
      return { title: nameOf(c, inst), badge: badgeOf(inst), subtitle: requirementSummary(c.service, inst.requirement, 4, { internal: true }), details: details.slice(0, 30) };
    });
  });
  const travellers = trip.travellers.map((t) => {
    const info = rules.ageInfo({ dob: str(t.dob).slice(0, 10), yearOfBirth: t.year_of_birth }, trip.referenceDate);
    const expiry = str(t.passport_expiry_date).slice(0, 10);
    const warning = expiry ? rules.expiryWarning(expiry, trip.referenceDate, undefined, trip.timeZone) : '';
    const details = [
      ['Relation', str(t.relation)],
      ['Gender', str(t.gender)],
      ['Nationality', str(t.nationality)],
      ['Passport', passportText(t, expiry)]
    ].filter(([, value]) => value).map(([label, value]) => ({ label, value }));
    return {
      title: travellerName(t),
      subtitle: [info.ageCategory, info.age !== null && info.age !== undefined ? `${info.age} yrs` : '', str(t.relation)].filter(Boolean).join(' · '),
      badge: PASSPORT_BADGE[warning] || '',
      details
    };
  });
  return [
    { title: 'Travel services', empty: 'No travel services selected on the lead.', items: services },
    { title: `Travellers (${travellers.length})`, empty: 'No travellers added to the lead yet.', items: travellers }
  ];
}

function tripType(chosen) {
  return chosen.some((c) => c.service.requiresPassport) ? 'International' : 'Domestic';
}

/** Availability warnings of the Complete requirements (D4): unavailable, expired, not checked. */
function availabilityWarnings(trip) {
  const out = [];
  for (const c of trip.chosen) {
    for (const inst of c.complete) {
      const name = nameOf(c, inst);
      if (!inst.check) {
        if (c.service.availabilityRequired !== false) out.push(`No availability check for ${name}.`);
      } else if (inst.check.status === 'Unavailable') out.push(`${name} is unavailable — propose an alternative.`);
      else if (inst.check.expired) out.push(`Recheck availability for ${name} (the last check expired).`);
    }
  }
  return out;
}

/** Warnings shown on the CRM page (never block; the lead workflow rules do that). */
function warningsFor(trip) {
  const out = [];
  if (trip.readiness && !trip.readiness.ready) out.push(...trip.readiness.reasons.map((r) => `Not ready: ${r}`));
  if (rules.isValidDate(trip.start) && rules.isValidDate(trip.end) && trip.end < trip.start) {
    out.push('Travel End Date is before Travel Start Date on the lead — check the dates.');
  }
  for (const c of trip.chosen) {
    for (const inst of c.complete) {
      const v = inst.requirement.values || {};
      for (const field of c.service.fields || []) {
        if (field.type !== 'date' || !field.after || !v[field.key] || !v[field.after]) continue;
        if (String(v[field.key]) < String(v[field.after])) {
          const other = (c.service.fields || []).find((f) => f.key === field.after);
          out.push(`${nameOf(c, inst)}: ${field.label} is before ${(other && other.label) || field.after} — check the dates.`);
        }
      }
    }
  }
  const missingReq = trip.chosen.filter((c) => !c.complete.length).map((c) => c.service.name);
  if (missingReq.length) out.push(`No Complete requirement yet for ${missingReq.join(', ')} — not included.`);
  for (const t of trip.travellers) {
    const w = rules.expiryWarning(str(t.passport_expiry_date).slice(0, 10), trip.referenceDate, undefined, trip.timeZone);
    const name = travellerName(t);
    if (w === 'expired') out.push(`${name}: passport has expired.`);
    else if (w === 'before_travel') out.push(`${name}: passport expires before the trip.`);
    else if (w === 'within_6_months') out.push(`${name}: passport is valid for less than 6 months after the trip.`);
  }
  return out.slice(0, 20);
}

/**
 * The lead's planned head count against the traveller profiles really added. The lead's count is never
 * changed here: it stays the requirement, and the traveller records drive document readiness.
 */
function travellerNotices(trip) {
  const counts = [trip.values.adults, trip.values.children, trip.values.infants].map(num);
  const totalField = num(trip.values.total_travellers);
  const planned = counts.some((n) => n !== null)
    ? counts.reduce((sum, n) => sum + Math.max(0, Math.floor(n || 0)), 0)
    : totalField !== null ? Math.max(0, Math.floor(totalField)) : 0;
  const added = trip.travellers.length;
  if (!planned || added >= planned) return [];
  const have = added === 0 ? 'no traveller profile has' : `only ${added} traveller profile${added === 1 ? ' has' : 's have'}`;
  return [{
    tone: 'warning',
    text: `Traveller details are incomplete. Lead requires ${planned} traveller${planned === 1 ? '' : 's'}, but ${have} been added.`,
    action: { label: 'View / Add Travellers', leadTab: 'travellers' }
  }];
}

/** Every selected service has a Complete requirement (and at least one service is selected). */
function servicesCheck(trip) {
  const missing = trip.chosen.filter((c) => !c.complete.length).map((c) => c.service.name);
  return {
    label: 'All required services complete',
    ok: trip.chosen.length > 0 && !missing.length,
    hint: !trip.chosen.length ? 'No travel services selected on the lead.' : missing.length ? `Not complete: ${missing.join(', ')}`.slice(0, 200) : ''
  };
}

/**
 * Right-column checks of the opportunity form (CRM 3.18.0 salesFlow checks). "Travellers added match the
 * head count" is not one of them: it follows the Travellers card live (fields.json countCheck.checkLabel).
 */
function opportunityChecks(trip) {
  const datesOk = rules.isValidDate(trip.start) && rules.isValidDate(trip.end) && trip.end >= trip.start;
  return [
    servicesCheck(trip),
    {
      label: 'Trip dates set',
      ok: datesOk,
      hint: datesOk ? '' : rules.isValidDate(trip.start) && rules.isValidDate(trip.end) ? 'The end date is before the start date.' : 'Set the travel start and end dates on the lead.'
    }
  ];
}

/**
 * The head count planned on the lead (Adults / Children / Infants set when the lead was created): the
 * limit the travellers added are compared with. A lead without counts uses the travellers added.
 */
function plannedHeadCount(trip) {
  const counts = [trip.values.adults, trip.values.children, trip.values.infants].map(num);
  if (counts.some((n) => n !== null)) {
    const [adults, children, infants] = counts.map((n) => Math.max(0, Math.floor(n || 0)));
    return { adults, children, infants };
  }
  return { adults: trip.groups.Adult || 0, children: trip.groups.Child || 0, infants: trip.groups.Infant || 0 };
}

/** A traveller with neither a passport number nor an uploaded passport. */
function hasNoPassport(t) {
  return !t.passport_number_enc && !t.passport_file_id;
}

/**
 * Switching the trip to International asks first when a traveller has no passport (or none are added):
 * the agent may continue and add the passports on the lead.
 */
function internationalConfirm(trip) {
  const missing = trip.travellers.filter(hasNoPassport).map(travellerName);
  if (trip.travellers.length && !missing.length) return [];
  const names = missing.length > 5 ? `${missing.slice(0, 5).join(', ')} and ${missing.length - 5} more` : missing.join(', ');
  const message = trip.travellers.length
    ? `International trips need a passport for every traveller. No passport added for: ${names}. Continue and add the passports on the lead?`
    : 'No travellers are added on this lead yet. International trips need a passport for every traveller. Continue and add them on the lead?';
  return [{ field: 'trip_type', value: 'International', title: 'Travellers without a passport', message }];
}

/** The trip was set to International by the prefill: name the travellers who still need a passport. */
function internationalWarnings(trip, type) {
  if (type !== 'International' || !internationalConfirm(trip).length) return [];
  if (!trip.travellers.length) return ['International trip: no travellers are added on the lead yet — add them with their passports.'];
  const missing = trip.travellers.filter(hasNoPassport).map(travellerName);
  const names = missing.length > 5 ? `${missing.slice(0, 5).join(', ')} and ${missing.length - 5} more` : missing.join(', ');
  return [`International trip: no passport added for ${names} — add the passports on the lead.`.slice(0, 300)];
}

async function opportunityPrefill(sdk, leadId) {
  const trip = await loadTrip(sdk, leadId);
  const destination = str(trip.values.destination) || str(trip.values.to);
  const who = groupsText(trip.groups);
  const when = dateRange(trip.start, trip.end);
  // "Goa trip – Priya Shah · Jun 2027" (customer and month when known).
  const customer = str(trip.lead.name) || str(trip.lead.company);
  const month = rules.isValidDate(trip.start) ? `${MONTHS[Number(trip.start.slice(5, 7)) - 1]} ${trip.start.slice(0, 4)}` : '';
  const title = `${destination ? `${destination} trip` : 'Trip'}${customer ? ` – ${customer}` : ''}${month ? ` · ${month}` : ''}`.slice(0, 200);

  // Close the deal N days before travel starts (Settings → Travel), never before tomorrow;
  // without a start date two weeks from today.
  const daysBefore = await numberSetting(sdk, 'expected_close_days_before_trip', 7, 0, 365);
  const tomorrow = addDays(trip.today, 1);
  let expectedCloseDate = addDays(trip.today, 14);
  if (rules.isValidDate(trip.start)) {
    const d = addDays(trip.start, -daysBefore);
    expectedCloseDate = d < tomorrow ? tomorrow : d;
  }
  const nights = daysBetween(trip.start, trip.end);
  const sameDay = rules.isValidDate(trip.start) && trip.end === trip.start;

  const lines = trip.chosen.flatMap((c) =>
    c.complete.map((inst) => ({ name: nameOf(c, inst), description: requirementSummary(c.service, inst.requirement), quantity: 1, unitPrice: 0 }))
  );

  const dealValue = num(trip.lead.value);
  const planned = plannedHeadCount(trip);
  const type = tripType(trip.chosen);
  return {
    title,
    expectedCloseDate,
    dealValue: dealValue !== null && dealValue >= 0 ? dealValue : null,
    panels: panelsFor(trip),
    description: [destination && `Destination: ${destination}`, when && `Travel: ${when}`, who && `Travellers: ${who}`].filter(Boolean).join('\n'),
    lines,
    values: {
      ...(str(trip.values.from) ? { from_city: str(trip.values.from) } : {}),
      destination,
      travel_start_date: trip.start,
      travel_end_date: trip.end,
      ...(nights !== null || sameDay ? { nights: nights || 0, days: (nights || 0) + 1 } : {}),
      ...(flexibilityFor(trip.values.date_flexibility) ? { date_flexibility: flexibilityFor(trip.values.date_flexibility) } : {}),
      trip_type: type,
      adults: planned.adults,
      children: planned.children,
      infants: planned.infants,
      total_travellers: planned.adults + planned.children + planned.infants
    },
    checks: opportunityChecks(trip),
    // The travellers really added on the lead, compared with the planned head count in the Travellers card.
    facts: [{ key: 'travellers_added', label: 'Travellers added on the lead', value: trip.travellers.length, group: 'trip_travellers' }],
    valueConfirms: internationalConfirm(trip),
    notices: travellerNotices(trip),
    warnings: [...internationalWarnings(trip, type), ...warningsFor(trip), ...availabilityWarnings(trip)].slice(0, 20)
  };
}

const GROUP_UNITS = [['Adult', 'Adult', 'Adults', 'Adult fare'], ['Child', 'Child', 'Children', 'Child fare'], ['Infant', 'Infant', 'Infants', 'Infant fare']];

const LINE_AVAILABILITY = new Set(['Available', 'Held', 'On Request']); // the quotation column's options
function price(prices, key) {
  const raw = prices ? prices[key] : undefined;
  const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Quotation lines of one requirement instance: quantity and unit by the service's Pricing; rate,
 * availability and provider from its latest valid check (D4); sourceRef "<requirementId>:<checkId>".
 * Unavailable: the line starts unticked (selected: false), no rate. Expired: no rate or availability.
 */
/** A requirement value by key pattern, as text (lists joined); '' when none. */
function pickValue(values, re) {
  for (const [k, raw] of Object.entries(values || {})) {
    if (!re.test(k)) continue;
    const v = Array.isArray(raw) ? raw.filter((x) => ['string', 'number'].includes(typeof x)).join(', ') : raw !== null && typeof raw === 'object' ? '' : str(raw);
    if (v) return v;
  }
  return '';
}

/**
 * Extra quotation columns of a requirement (salesFlow.quotationLineFields): service_date (by the
 * service's day-plan dates), route "From → To" (travel / transfer services), cabin_class, room_type,
 * meal_plan. Only filled ones.
 */
function lineColumns(service, requirement) {
  const v = (requirement && requirement.values) || {};
  const cfg = itinerary.itinerarySettings(service);
  const day = (key) => (key && rules.isValidDate(str(v[key]).slice(0, 10)) ? str(v[key]).slice(0, 10) : '');
  const start = day(cfg.start);
  const end = day(cfg.end);
  const out = {};
  if (start) out.service_date = (end && end > start ? dateRange(start, end) : shortDate(start, true)).slice(0, 40);
  if (cfg.kind === 'travel' || cfg.kind === 'transfer') {
    const from = pickValue(v, /(^|_)from(_|$)|origin|pick_?up_?(location|point|city)?$/);
    const to = pickValue(v, /(^|_)to(_|$)|destination|drop_?(location|point|city)?$/);
    const path = from && to ? `${from} → ${to}` : from || to;
    if (path) out.route = path.slice(0, 80);
  }
  const cabin = pickValue(v, /cabin|travel_?class/);
  if (cabin) out.cabin_class = cabin.slice(0, 40);
  const room = pickValue(v, /room_?type/);
  if (room) out.room_type = room.slice(0, 60);
  const meal = pickValue(v, /meal_?plan/);
  if (meal) out.meal_plan = meal.slice(0, 40);
  return out;
}

function linesForService(service, requirement, trip, { name = service.name, check = null } = {}) {
  const v = (requirement && requirement.values) || {};
  const summary = requirementSummary(service, requirement, 4);
  const details = requirementDetails(service, requirement);
  const usable = Boolean(check && !check.expired && check.status !== 'Unavailable');
  const prices = usable ? check.prices || {} : {};
  const reqId = str(requirement && requirement._id);
  const ref = reqId ? `${reqId}${check && check.id ? `:${check.id}` : ''}` : '';
  const base = {
    unitPrice: price(prices, 'unit') || 0,
    tax: service.taxRate,
    details,
    group: quotationGroupOf(service),
    extra: {
      availability: usable && LINE_AVAILABILITY.has(check.status) ? check.status : '',
      provider: check && check.status !== 'Unavailable' ? str(check.provider).slice(0, 120) : '',
      ...lineColumns(service, requirement)
    },
    ...(/^[A-Za-z0-9:_-]{1,64}$/.test(ref) ? { sourceRef: ref } : {}),
    ...(check && check.status === 'Unavailable' ? { selected: false } : {})
  };
  if (service.pricing === 'per_person') {
    const lines = [];
    for (const [group, one, many, fare] of GROUP_UNITS) {
      const n = trip.groups[group];
      if (!n) continue;
      const rate = price(prices, group.toLowerCase());
      lines.push({ ...base, unitPrice: rate === null ? 0 : rate, name, description: [summary, fare].filter(Boolean).join(', ').slice(0, 500), quantity: n, unit: plural(n, one, many) });
    }
    return lines.length ? lines : [{ ...base, unitPrice: price(prices, 'adult') || 0, name, description: summary, quantity: 1, unit: '1 Person' }];
  }
  if (service.pricing === 'per_room_night') {
    const rooms = Math.max(1, num(v.number_of_rooms) || 1);
    const nights = Math.max(1, num(v.number_of_nights) || daysBetween(str(v.check_in_date), str(v.check_out_date)) || daysBetween(trip.start, trip.end) || 1);
    const what = `${plural(rooms, 'room', 'rooms')}, ${plural(nights, 'night', 'nights')}`;
    return [{ ...base, name, description: [summary, what].filter(Boolean).join(', ').slice(0, 500), quantity: rooms * nights, unit: 'Rooms × Nights' }];
  }
  const vehicles = num(v.number_of_vehicles);
  const participants = num(v.participants);
  const n = Math.max(1, vehicles || participants || 1);
  const unit = vehicles ? plural(n, 'Vehicle', 'Vehicles') : participants ? plural(n, 'Participant', 'Participants') : plural(n, 'Service', 'Services');
  return [{ ...base, name, description: summary, quantity: n, unit }];
}

function unitForOption(service) {
  return service.pricing === 'per_room_night' ? 'Rooms × Nights' : service.pricing === 'per_person' ? 'Persons' : 'Service';
}

/**
 * Trip values of the quotation's opportunity: its declared values (always current), else its TripPlan
 * copy (saved by /sales-flow/opportunity-saved). Only for an opportunity of this lead; {} otherwise (or when it cannot be read).
 */
async function opportunityTripValues(sdk, opportunityId, leadId) {
  const oid = str(opportunityId);
  if (!ID_RE.test(oid)) return {};
  try {
    const opp = await sdk.crm.opportunities.findById(oid);
    if (!opp || str(opp.leadId) !== leadId) return {};
    const values = await sdk.values.get('opportunity', oid).catch(() => null);
    if (values && typeof values === 'object' && Object.keys(values).length) return values;
    const plan = sdk.models.TripPlan ? await sdk.models.TripPlan.findOne({ opportunity_id: oid }) : null;
    return plan || {};
  } catch {
    return {};
  }
}

/**
 * "Valid till" defaults: the earliest Held availability day among the quoted services (workspace time
 * zone), else today + the quotation validity setting — never after the Travel Start Date (2.12.0:
 * validTill = min(default, travel start); the CRM refuses a later one on save).
 */
async function validity(sdk, trip) {
  let earliest = null;
  for (const c of trip.chosen) {
    for (const inst of c.complete) {
      const k = inst.check;
      if (!k || k.expired || k.status !== 'Held' || !k.valid_until) continue;
      const at = Date.parse(k.valid_until);
      if (Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at;
    }
  }
  const holdDay = earliest === null ? '' : todayIn(trip.timeZone, new Date(earliest));
  const [fromHolds, days] = await Promise.all([flagSetting(sdk, 'validity_from_holds', true), numberSetting(sdk, 'quotation_validity_days', 7, 1, 90)]);
  let validTill = fromHolds && holdDay ? holdDay : addDays(trip.today, days);
  if (rules.isValidDate(trip.start) && validTill > trip.start && trip.start >= trip.today) validTill = trip.start;
  return { validTill, validTillMax: holdDay };
}

/** Read-only "Day plan (from proposed services)" panel: itinerary.generate on the prefilled lines. */
function dayPlanPanel(trip, lines, services) {
  const requirements = new Map();
  for (const c of trip.chosen) for (const inst of c.instances) if (inst.requirement && inst.requirement._id) requirements.set(str(inst.requirement._id), inst.requirement);
  const plan = itinerary.generate({
    quotation: { lineItems: lines.filter((l) => l.selected !== false) },
    leadValues: trip.values,
    requirements,
    services
  });
  const hasItems = plan.days.some((d) => d.items.length) || plan.unscheduled.length > 0;
  const items = !hasItems ? [] : plan.days.slice(0, 49).map((d) => ({
    title: `Day ${d.day}${d.date ? ` · ${itinerary.prettyDate(d.date)}` : ''} — ${d.title}`.slice(0, 200),
    subtitle: d.items.map((i) => `${i.time ? `${i.time} ` : ''}${i.title}`).join(' · ').slice(0, 300),
    details: d.items.slice(0, 30).map((i) => ({ label: i.time || i.kind, value: [i.title, i.details].filter(Boolean).join(' — ').slice(0, 500) }))
  }));
  if (hasItems && plan.unscheduled.length) {
    items.push({ title: 'Included services', subtitle: plan.unscheduled.map((i) => i.title).join(' · ').slice(0, 300), details: [] });
  }
  return {
    title: 'Day plan (from proposed services)',
    empty: 'No dated services to plan yet.',
    note: 'Preview only. Generate the itinerary from the saved quotation to edit it.',
    items
  };
}

async function quotationPrefill(sdk, leadId, opportunityId = '') {
  const trip = await loadTrip(sdk, leadId);
  const lines = trip.chosen.flatMap((c) =>
    c.complete.flatMap((inst) => linesForService(c.service, inst.requirement, trip, { name: nameOf(c, inst), check: inst.check }))
  );
  const services = await readServices(sdk);
  const [oppValues, { validTill, validTillMax }] = await Promise.all([opportunityTripValues(sdk, opportunityId, trip.id), validity(sdk, trip)]);
  // Travellers for the price per person: adults + children (infants usually travel free) of the
  // opportunity, else of the lead.
  const oppCount = num(oppValues.adults) !== null || num(oppValues.children) !== null ? (num(oppValues.adults) || 0) + (num(oppValues.children) || 0) : null;
  const travellersCount = oppCount !== null ? oppCount : (trip.groups.Adult || 0) + (trip.groups.Child || 0);
  const expired = trip.chosen.flatMap((c) => c.complete.filter((i) => i.check && i.check.expired).map((i) => nameOf(c, i)));

  const [inclusions, exclusions, policy, showTravellers] = await Promise.all([
    sdk.settings.get('quotation_inclusions'),
    sdk.settings.get('quotation_exclusions'),
    sdk.settings.get('quotation_cancellation_policy'),
    sdk.settings.get('quotation_show_travellers')
  ]);
  const sections = [];
  if (str(inclusions)) sections.push({ key: 'inclusions', title: 'Inclusions', body: str(inclusions) });
  if (str(exclusions)) sections.push({ key: 'exclusions', title: 'Exclusions', body: str(exclusions) });
  if (str(policy)) sections.push({ key: 'cancellation_policy', title: 'Cancellation policy', body: str(policy) });
  if (showTravellers !== false && trip.travellers.length) {
    const names = trip.travellers.map((t, i) => {
      const cat = rules.ageInfo({ dob: str(t.dob).slice(0, 10), yearOfBirth: t.year_of_birth }, trip.referenceDate).ageCategory;
      return `${i + 1}. ${travellerName(t)}${cat ? ` (${cat})` : ''}`;
    });
    sections.push({ key: 'travellers', title: 'Travellers', body: names.join('\n') });
  }

  const destination = str(trip.values.destination) || str(trip.values.to);
  const who = groupsText(trip.groups);
  const covered = trip.chosen.filter((c) => c.complete.length).map((c) => c.service.name);
  const listText = covered.length > 1 ? `${covered.slice(0, -1).join(', ')} and ${covered[covered.length - 1]}` : covered[0] || '';
  const fmt = (iso) => (rules.isValidDate(iso) ? shortDate(iso, true) : '');

  return {
    title: `${destination || 'Travel'} Holiday Package`.slice(0, 200),
    description: `Quotation for ${destination ? `${destination} ` : ''}holiday package${listText ? ` including ${listText}` : ''}${who ? ` for ${who}` : ''}.`.slice(0, 2000),
    summary: [
      { icon: 'place', label: 'From', value: str(trip.values.from) },
      { icon: 'place', label: 'To', value: str(trip.values.to) },
      { icon: 'beach', label: 'Destination', value: destination },
      { icon: 'event', label: 'Travel Start', value: fmt(trip.start) },
      { icon: 'event', label: 'Travel End', value: fmt(trip.end) },
      { icon: 'flight', label: 'Trip Type', value: tripType(trip.chosen) },
      { icon: 'group', label: 'Travellers', value: who }
    ].filter((s) => s.value),
    panels: [
      {
        title: 'Travellers',
        empty: 'No travellers added to the lead yet.',
        note: 'Traveller document details are not shown on quotation.',
        items: trip.travellers.map((t) => ({ title: travellerName(t) }))
      },
      dayPlanPanel(trip, lines, services)
    ],
    lineOptions: services.filter((s) => s.enabled !== false).map((s) => ({ name: s.name, unit: unitForOption(s), tax: s.taxRate, group: quotationGroupOf(s) })),
    lineNote: 'On Request items are subject to supplier confirmation.',
    lines,
    sections,
    values: {
      travellers: travellersCount,
      ...(str(oppValues.special_requests) ? { special_requests: str(oppValues.special_requests).slice(0, 2000) } : {})
    },
    validTill,
    ...(validTillMax ? { validTillMax } : {}),
    checks: [
      { label: 'No expired availability', ok: !expired.length, hint: expired.length ? `Recheck: ${expired.join(', ')}`.slice(0, 200) : '' },
      servicesCheck(trip)
    ],
    notices: travellerNotices(trip),
    warnings: [...availabilityWarnings(trip), ...warningsFor(trip)].slice(0, 20)
  };
}

module.exports = { travellerNotices, opportunityPrefill, quotationPrefill, requirementSummary, dateRange, linesForService, lineColumns, flexibilityFor };
