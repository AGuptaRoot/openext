'use strict';

/**
 * 2.36.0 (CRM 3.64.0 salesFlow.guidedInvoice) — "Create Invoice from Scratch": the travel steps of the CRM's
 * guided invoice page. Nothing is saved until the user clicks Create on the last step.
 *
 *   draft = {
 *     ref:          a random id of this wizard run (a retry after a failure reuses what it already made)
 *     travel_info:  Step "Travel Information" — from, to, destination, dates, date flexibility, required services
 *     travellers:   [ { firstName, lastName, relation, phone, email, gender, dob, nationality, passport…, aadhaar…,
 *                       panNumber } | { existingTravellerId } ]   at least one
 *     requirements: { <service_key>: form values }   one form per selected service
 *   }
 *
 *   check(sdk, draft, step)  POST /quotation-prefill { draft, check }  → { errors, matches? }   (nothing saved)
 *   preview(sdk, draft)      POST /quotation-prefill { draft }         → the quotation lines to price (nothing saved)
 *   commit(sdk, clientId, draft)  POST /clients/:client_id/quotation-start { draft } → { leadId }:
 *     the client's Travel Requirement is saved, its trip (enquiry lead) opened and the travellers added — the
 *     same checks as the Travel Requirement tab and the lead's Travellers tab. Safe to retry with the same ref.
 *
 * The same rules as everywhere else: travel dates not in the past, each selected service's form complete and
 * inside the trip dates, traveller phone + relation required, passport details when a selected service needs a
 * passport, PAN / Aadhaar by Settings → Travel, no duplicate passport / Aadhaar / PAN / phone / email of another
 * person (an existing traveller is picked instead). Document numbers are never returned or logged.
 */

const { readServices, activeService } = require('./catalog.js');
const { checkValues } = require('./requirement-form.js');
const { tripOf } = require('./trip-dates.js');
const rules = require('./traveller-rules.js');
const store = require('./traveller-store.js');
const alerts = require('./passport-alerts.js');

const { str, ID_RE } = store;
const MAX_TRAVELLERS = 30;
const STEPS = ['travel_info', 'travellers', 'requirements', 'travellers_setup', 'client_prefill'];
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const CR = () => require('../routes/client-requirement.js')._guided;

/** The draft's parts, trimmed to what each step may hold. */
function partsOf(draft) {
  const d = plain(draft);
  const info = plain(d.travel_info);
  const values = Object.fromEntries(CR().TRAVEL_KEYS.filter((k) => info[k] !== undefined && info[k] !== null).map((k) => [k, info[k]]));
  const travellers = (Array.isArray(d.travellers) ? d.travellers : []).filter((t) => t && typeof t === 'object').slice(0, MAX_TRAVELLERS + 1);
  return { ref: str(d.ref).slice(0, 60), values, forms: plain(d.requirements), travellers };
}

/* ------------------------------------------------------------------ checks */

async function checkTravel(sdk, values) {
  const services = (await readServices(sdk)).filter((s) => s.enabled !== false);
  const { errors, selected, trip } = await CR().checkTravelInfo(sdk, values, services);
  return { errors, selected, trip, services };
}

async function checkRequirements(sdk, values, forms, services, selected, trip) {
  const errors = [];
  const checked = {};
  for (const key of selected) {
    const service = activeService(services, key);
    if (!service) continue;
    const result = checkValues(service, forms[key], { trip });
    for (const e of result.errors) errors.push(`${service.name}: ${e}`);
    if (!result.errors.length && result.missing.length) errors.push(`${service.name}: ${result.missing.join(', ')} ${result.missing.length > 1 ? 'are' : 'is'} required.`);
    checked[key] = { service, result };
  }
  return { errors, checked };
}

const personName = (t) => [str(t.firstName), str(t.lastName)].filter(Boolean).join(' ') || 'Traveller';

/**
 * Each traveller as the lead's Travellers tab would check it (no lead yet: the company list of relations).
 * → { errors, matches: [{ index, match }] } — a match is an existing traveller the user may pick instead.
 */
async function checkTravellers(sdk, values, travellers, selected, trip) {
  const errors = [];
  const matches = [];
  if (!travellers.length) return { errors: ['Add at least one traveller.'], matches };
  if (travellers.length > MAX_TRAVELLERS) errors.push(`At most ${MAX_TRAVELLERS} travellers.`);
  const timeZone = await store.timeZone(sdk);
  const today = rules.todayIso(undefined, timeZone);
  const referenceDate = trip.start || today;
  const [rule, storage] = await Promise.all([store.passportRule(sdk, selected), store.aadhaarStorage(sdk)]);
  const people = [];
  const profiles = new Set();
  for (let i = 0; i < Math.min(travellers.length, MAX_TRAVELLERS); i += 1) {
    const t = travellers[i];
    const label = `Traveller ${i + 1}`;
    const existingId = str(t.existingTravellerId);
    if (existingId) {
      const row = ID_RE.test(existingId) ? await sdk.models.Traveller.findById(existingId).catch(() => null) : null;
      if (!row || !(await store.canReadLead(sdk, str(row.lead_id)))) {
        errors.push(`${label}: the chosen existing traveller was not found.`);
        continue;
      }
      const profile = store.profileOf(row);
      if (profiles.has(profile)) errors.push(`${label}: this traveller is already in the list.`);
      profiles.add(profile);
      if (alerts.passportStatus(row.passport_expiry_date, today) === 'Expired') errors.push(`${label}: passport expired — renew it before travel.`);
      continue;
    }
    const { values: v, errors: inputErrors } = rules.checkInput(t, { create: true, timeZone });
    const name = personName(v);
    for (const e of inputErrors) if (e !== 'OCR_NOT_CONFIRMED') errors.push(`${label} (${name}): ${e}`);
    if (inputErrors.length) continue;
    try {
      await store.checkRelation(sdk, { isPersonLead: false }, v.relation);
      const patch = store.toPatch(sdk, v, {}, storage, referenceDate);
      store.checkPassport(sdk, patch, rule, referenceDate, { timeZone });
      store.checkIdDocuments(sdk, patch, rule, referenceDate);
      const { found, rowsByField } = await store.findDuplicates(sdk, v, patch, {}, null, '');
      if (found.length) {
        errors.push(`${label} (${name}): ${found.map((f) => store.DUPLICATE_TEXT[f]).join(' ')}`);
        const m = await store.duplicateMatch(sdk, rowsByField, '');
        if (m && m.match) matches.push({ index: i, match: m.match });
      }
    } catch (error) {
      errors.push(`${label} (${name}): ${str(error && error.message) || 'not valid'}`);
    }
    if (people.some((p) => rules.samePerson(p, v))) errors.push(`${label} (${name}) is in the list twice.`);
    people.push(v);
  }
  return { errors, matches };
}

/** Every step, in order. → { errors, parts, travel, requirements } */
async function checkAll(sdk, draft) {
  const parts = partsOf(draft);
  const travel = await checkTravel(sdk, parts.values);
  parts.values.required_services = travel.selected;
  const requirements = await checkRequirements(sdk, parts.values, parts.forms, travel.services, travel.selected, travel.trip);
  const people = await checkTravellers(sdk, parts.values, parts.travellers, travel.selected, travel.trip);
  return {
    errors: [...travel.errors, ...people.errors, ...requirements.errors],
    matches: people.matches,
    parts,
    travel,
    requirements
  };
}

/**
 * 2.36.2: what the Travellers step needs to show the lead's own Travellers form (the same component as
 * Lead → Travellers / Travellers → Add) on the unsaved draft: the rules (passport needed by a chosen service,
 * PAN / Aadhaar by Settings → Travel, the trip start date), the choices (company list of relations,
 * nationalities) and the draft's travellers presented like the lead list (numbers masked, nothing saved).
 * Each draft traveller carries its own `draftId` (made by the page); an entry without one is not listed.
 */
async function travellersSetup(sdk, parts) {
  const zone = await store.timeZone(sdk);
  const ref = store.referenceFromValues(parts.values, zone);
  const [rule, storage, options] = await Promise.all([
    store.passportRule(sdk, ref.selected),
    store.aadhaarStorage(sdk),
    store.fieldOptions(sdk, { isPersonLead: false })
  ]);
  const travellers = [];
  for (const t of parts.travellers.slice(0, MAX_TRAVELLERS)) {
    const draftId = str(t.draftId).slice(0, 40);
    if (!draftId) continue;
    const existingId = str(t.existingTravellerId);
    let row;
    if (existingId) {
      row = ID_RE.test(existingId) ? await sdk.models.Traveller.findById(existingId).catch(() => null) : null;
      if (!row || !(await store.canReadLead(sdk, str(row.lead_id)))) continue;
    } else {
      const { values: v } = rules.checkInput(t, { create: true, timeZone: zone });
      const last4 = (n) => (n ? String(n).slice(-4) : '');
      row = {
        first_name: v.firstName || str(t.firstName), last_name: v.lastName || '', dob: v.dob || '',
        year_of_birth: v.dob ? null : v.yearOfBirth === undefined ? null : v.yearOfBirth,
        gender: v.gender || '', nationality: v.nationality || '', relation: v.relation || '', phone: v.phone || '', email: v.email || '',
        passport_issue_date: v.passportIssueDate || '', passport_expiry_date: v.passportExpiryDate || '', passport_country: v.passportCountry || '',
        passport_last4: last4(v.passportNumber), aadhaar_last4: last4(v.aadhaarNumber), pan_last4: last4(v.panNumber)
      };
    }
    const shown = store.present(row, ref.referenceDate, rule, zone);
    travellers.push({ ...shown, id: draftId, profileId: '', leadId: '', contactId: '', existing: Boolean(existingId), createdAt: undefined, updatedAt: undefined });
  }
  const counts = { Adult: 0, Child: 0, Infant: 0, total: travellers.length };
  for (const t of travellers) if (counts[t.ageCategory] !== undefined) counts[t.ageCategory] += 1;
  const { counted, unknownAge } = rules.travellerGroups(travellers.map((t) => t.ageCategory), ref.expected);
  return {
    travellers,
    qty: travellers.length,
    counts,
    groups: { ...counted, unknownAge },
    expected: ref.expected,
    referenceDate: ref.referenceDate,
    referenceSource: ref.referenceSource,
    leadContact: null,
    passportRequired: rule.required,
    passportRequiredBy: rule.services,
    panRequired: rule.pan,
    aadhaarRequired: rule.aadhaar,
    aadhaarStorage: storage,
    nationalityOptions: options.nationalityOptions,
    relationOptions: options.relationOptions,
    relationKind: options.relationKind,
    canEdit: true
  };
}

/**
 * 2.36.3: an existing client picked in step 1 → its saved Travel Information, requirement forms and (open trip)
 * travellers, to fill the wizard's steps. Only while that trip has NO quotation (the user's rule); a trip with a
 * quotation is not shown and blocks the wizard (one open trip per client: finish or close it first).
 * → { available, blocked, message, source: 'trip' | 'requirement' | '', travel_info, requirements, travellers }
 */
const QUOTED_TEXT = (what) =>
  `This client’s ${what} already has a quotation, so its forms are not filled in here. A client has one open trip: finish that trip (or close the enquiry) from the client’s Travel Requirement tab first.`;

async function clientPrefill(sdk, clientId) {
  const cr = CR();
  const empty = { available: false, blocked: false, message: '', source: '', travel_info: {}, requirements: {}, travellers: [] };
  if (!ID_RE.test(clientId)) throw sdk.error(400, 'clientId is not valid', 'INVALID_INPUT');
  await cr.loadClient(sdk, clientId);
  const current = await cr.currentOf(sdk, clientId);
  if (!current) return empty;
  const pick = (values) => Object.fromEntries(cr.TRAVEL_KEYS.filter((k) => plain(values)[k] !== undefined && plain(values)[k] !== null).map((k) => [k, plain(values)[k]]));
  if (current.kind === 'lead') {
    const leadId = str(current.lead._id);
    // An older CRM that cannot say whether the trip has a quotation is treated as "has one".
    const priced = typeof sdk.crm.leads.hasQuotation === 'function' ? await sdk.crm.leads.hasQuotation(leadId) : true;
    const title = str(current.lead.title);
    if (priced) return { ...empty, blocked: true, message: QUOTED_TEXT(title ? `open trip “${title}”` : 'open trip') };
    const services = (await readServices(sdk)).filter((s) => s.enabled !== false);
    const values = await sdk.values.get('lead', leadId);
    const rows = await cr.requirementsOf(sdk, leadId, services, cr.selectedOf(values));
    const onTrip = await sdk.models.Traveller.find({ lead_id: leadId }, { limit: MAX_TRAVELLERS, sort: { createdAt: 1 } });
    return {
      ...empty,
      available: true,
      source: 'trip',
      message: `Filled from this client’s open trip${title ? ` “${title}”` : ''} (no quotation yet). Create saves your changes on that same trip.`,
      travel_info: pick(values),
      requirements: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, plain(r.values)])),
      travellers: onTrip.map((r) => ({ existingTravellerId: str(r._id), onTrip: true }))
    };
  }
  const row = current.draft;
  if (str(row.status) === 'Quoted' || ID_RE.test(str(row.quotation_id))) {
    return { ...empty, blocked: true, message: QUOTED_TEXT('saved Travel Requirement') };
  }
  return {
    ...empty,
    available: true,
    source: 'requirement',
    message: 'Filled from this client’s saved Travel Requirement (no quotation yet). Create saves your changes on it.',
    travel_info: pick(row.values),
    requirements: plain(row.requirements),
    travellers: []
  };
}

/** POST /quotation-prefill { draft, check: step } → { errors, matches? } — one step, nothing saved. */
exports.check = async (sdk, draft, step, body = {}) => {
  if (!STEPS.includes(step)) throw sdk.error(400, 'check must be travel_info, travellers, requirements, travellers_setup or client_prefill', 'INVALID_INPUT');
  if (step === 'client_prefill') return clientPrefill(sdk, str(body && body.clientId));
  const parts = partsOf(draft);
  if (step === 'travellers_setup') return travellersSetup(sdk, parts);
  const travel = await checkTravel(sdk, parts.values);
  if (step === 'travel_info') return { errors: travel.errors };
  // Later steps need valid Travel Information first.
  if (travel.errors.length) return { errors: ['Fix the Travel Information step first.', ...travel.errors] };
  if (step === 'requirements') {
    return { errors: (await checkRequirements(sdk, parts.values, parts.forms, travel.services, travel.selected, travel.trip)).errors };
  }
  return checkTravellers(sdk, parts.values, parts.travellers, travel.selected, travel.trip);
};

/** POST /quotation-prefill { draft } → the quotation lines for the unsaved trip, or { errors }. */
exports.preview = async (sdk, draft) => {
  const all = await checkAll(sdk, draft);
  if (all.errors.length) return { errors: all.errors.slice(0, 30) };
  const { parts } = all;
  const rows = [];
  for (const t of parts.travellers) {
    const existingId = str(t.existingTravellerId);
    if (existingId) {
      const row = await sdk.models.Traveller.findById(existingId).catch(() => null);
      if (row) rows.push(row);
      continue;
    }
    const { values: v } = rules.checkInput(t, { create: true });
    rows.push({ first_name: v.firstName, last_name: v.lastName || '', dob: v.dob || '', year_of_birth: v.yearOfBirth === undefined ? null : v.yearOfBirth });
  }
  const forms = Object.fromEntries(Object.entries(all.requirements.checked).map(([k, { result }]) => [k, result.values]));
  const { buildClientTrip, quotationPrefill } = require('./sales-prefill.js');
  const trip = await buildClientTrip(sdk, { values: parts.values, forms, travellers: rows, name: '' });
  return quotationPrefill(sdk, '', '', { trip });
};

/**
 * POST /clients/:client_id/quotation-start { draft } → { leadId }. The trip of this wizard run: its saved
 * Travel Requirement, the opened trip lead, the travellers on it. A retry (same draft.ref) reuses them.
 */
exports.commit = async (sdk, clientId, draft) => {
  const cr = CR();
  const all = await checkAll(sdk, draft);
  if (all.errors.length) {
    const error = sdk.error(400, all.errors.slice(0, 6).join(' '), 'INVALID_GUIDED_SALE');
    error.details = all.errors.slice(0, 30);
    throw error;
  }
  const { parts, requirements } = all;
  if (!parts.ref) throw sdk.error(400, 'draft.ref is required', 'INVALID_INPUT');
  await cr.loadClient(sdk, clientId);
  const services = await readServices(sdk);
  const userId = str(sdk.user && sdk.user.id);
  const forms = Object.fromEntries(Object.entries(requirements.checked).map(([k, { result }]) => [k, result.values]));

  const current = await cr.currentOf(sdk, clientId);
  if (current && current.kind === 'lead') {
    // Only this wizard run's own trip is reused; another open trip of the client is never overwritten.
    const leadId = str(current.lead._id);
    const own = await sdk.models.ClientTravelRequirement.find({ client_id: clientId, lead_id: leadId }, { limit: 5 });
    // 2.36.3: the open trip without a quotation was shown in the wizard (client_prefill) — it is updated, never
    // duplicated. A trip that has a quotation is never changed here (an older CRM that cannot tell: refused).
    if (!own.some((r) => str(r.guided_ref) === parts.ref)) {
      const priced = typeof sdk.crm.leads.hasQuotation === 'function' ? await sdk.crm.leads.hasQuotation(leadId) : true;
      if (priced) {
        throw sdk.error(409, 'This client’s open trip already has a quotation. Finish it from the client’s Travel Requirement tab, or close that enquiry first.', 'CLIENT_TRIP_OPEN');
      }
      for (const r of own) await sdk.models.ClientTravelRequirement.updateById(r._id, { guided_ref: parts.ref });
    }
    await cr.saveOnLead(sdk, leadId, services, parts.values, requirements.checked);
  } else {
    // A saved requirement already being quoted (client trip, no lead) belongs to that quotation: never replaced.
    if (current && str(current.draft.status) === 'Quoted' && str(current.draft.guided_ref) !== parts.ref) {
      throw sdk.error(409, 'This client already has a trip with a quotation. Finish it from the client’s Travel Requirement tab first.', 'CLIENT_TRIP_OPEN');
    }
    const row = { values: parts.values, requirements: forms, status: 'Complete', updated_by: userId, guided_ref: parts.ref };
    if (current) await sdk.models.ClientTravelRequirement.updateById(current.draft._id, row);
    else await sdk.models.ClientTravelRequirement.create({ client_id: clientId, lead_id: '', created_by: userId, ...row });
  }
  const { leadId } = await cr.openTrip(sdk, clientId);

  // Travellers: the same create / "add existing" routes as the lead's Travellers tab. Already there → skipped.
  const travellersRoute = require('../routes/travellers.js');
  const onLead = await sdk.models.Traveller.find({ lead_id: leadId }, { limit: 200 });
  const profiles = new Set(onLead.map((r) => store.profileOf(r)));
  const people = onLead.map((r) => ({ firstName: str(r.first_name), lastName: str(r.last_name), dob: str(r.dob).slice(0, 10), phone: str(r.phone) }));
  let added = 0;
  for (const t of parts.travellers) {
    const existingId = str(t.existingTravellerId);
    if (existingId) {
      const row = await sdk.models.Traveller.findById(existingId);
      if (!row || profiles.has(store.profileOf(row))) continue;
      await travellersRoute.copy({ params: { lead_id: leadId }, body: { travellerId: existingId } }, sdk);
      profiles.add(store.profileOf(row));
      added += 1;
      continue;
    }
    const { values: v } = rules.checkInput(t, { create: true });
    if (people.some((p) => rules.samePerson(p, v))) continue;
    await travellersRoute.create({ params: { lead_id: leadId }, body: t }, sdk);
    people.push(v);
    added += 1;
  }
  await sdk.audit('created', `Trip saved from Create Direct Invoice / Quotation (enquiry ${leadId}, ${added} traveller${added === 1 ? '' : 's'} added)`, { clientId, leadId });
  return { leadId };
};

exports._internal = { partsOf, checkAll, checkTravellers, travellersSetup, clientPrefill };
