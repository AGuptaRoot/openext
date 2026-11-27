'use strict';

/**
 * 2.39.0 (CRM 3.67.0 salesFlow.leadCreateExtras) — Lead Create: the Travellers and Travel Requirement sections.
 *
 *   draft = {
 *     ref:          a random id of this form (made by the CRM page)
 *     values:       the lead form's travel fields (adults, children, infants, from, to, dates, required_services)
 *     context:      { isPersonLead }  (a family lead has the family list of relations)
 *     travellers:   [ { firstName, …, draftId } | { existingTravellerId, draftId } ]   0 … 30
 *     requirements: { <service_key>: form values }   kept for every service ever ticked; only ticked ones count
 *   }
 *
 * Nothing is saved before the lead exists. Travellers are optional; requirement forms are not (2.43.1, the user's rule):
 *  - every traveller in the list is checked like Lead → Travellers (an error stops Create);
 *  - a requirement form with values is checked like the Travel Requirement tab (wrong values stop Create);
 *  - every ticked service's form must have its required fields filled in (an empty form too), so Create also needs
 *    Traveller Details and Travel Information filled in (the forms open only then) when a service is ticked;
 *  - when as many travellers are added as Adults + Children + Infants, their ages on the Travel Start Date
 *    (Infant under 2, Child 2–11, Adult 12+; no date of birth = Adult) are compared with those counts → a warning;
 *    more travellers than the counts → a warning. The user may create the lead anyway.
 *
 *   check(sdk, draft, step)    POST /quotation-prefill { leadCreate: true, draft, check? } → { errors, warnings } | setup
 *   commit(sdk, leadId, draft) POST /leads/:lead_id/requirements { leadCreate: true, draft }
 *                              → { ok, message, result: { travellers: [{ draftId, travellerId }] } } (ok false = partly saved)
 * (existing routes with a flag: Travel stays at the 100-route limit)
 *
 * Document numbers are never returned or logged.
 */

const { readServices, activeService } = require('./catalog.js');
const { checkValues } = require('./requirement-form.js');
const { tripOf } = require('./trip-dates.js');
const rules = require('./traveller-rules.js');
const store = require('./traveller-store.js');
const guided = require('./guided-sale.js')._internal;

const { str, ID_RE } = store;
const MAX_TRAVELLERS = 30;
const DRAFT_ID_RE = /^d-[a-z0-9]{1,38}$/;
const COUNT_KEYS = ['adults', 'children', 'infants'];
const STEPS = ['all', 'travellers', 'travellers_setup'];
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const CR = () => require('../routes/client-requirement.js')._guided;
const isEmpty = (v) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length);

/** The draft's parts, trimmed to what Lead Create may send. */
function partsOf(draft) {
  const d = plain(draft);
  const raw = plain(d.values);
  const keys = [...CR().TRAVEL_KEYS, ...COUNT_KEYS];
  const values = Object.fromEntries(keys.filter((k) => raw[k] !== undefined && raw[k] !== null).map((k) => [k, raw[k]]));
  const travellers = (Array.isArray(d.travellers) ? d.travellers : []).filter((t) => t && typeof t === 'object').slice(0, MAX_TRAVELLERS + 1);
  const lead = { isPersonLead: plain(d.context).isPersonLead === true };
  return { ref: str(d.ref).slice(0, 60), values, forms: plain(d.requirements), travellers, lead };
}

/** The enabled services, the ticked ones among them and the trip dates (no rule about From / To here). */
async function tripParts(sdk, values) {
  const services = (await readServices(sdk)).filter((s) => s.enabled !== false);
  const enabled = new Set(services.map((s) => s.key));
  const selected = CR().selectedOf(values).filter((k) => enabled.has(k));
  return { services, selected, trip: tripOf(values) };
}

/** A form the user typed something in. */
const hasValues = (form) => Object.values(plain(form)).some((v) => !isEmpty(v));

/** What is still empty before the Travel Requirement forms open on Lead Create (as missingBeforeForms on the page). */
function formsNotOpen(values) {
  const v = plain(values);
  const total = COUNT_KEYS.reduce((n, k) => {
    const c = Number(v[k]);
    return n + (Number.isFinite(c) && c > 0 ? Math.floor(c) : 0);
  }, 0);
  const missing = [];
  if (!total) missing.push('Traveller Details (Adults, Children or Infants)');
  if (!str(v.from).trim()) missing.push('From');
  if (!str(v.to).trim()) missing.push('To');
  if (!str(v.travel_start_date).trim()) missing.push('Travel Start Date');
  if (!str(v.travel_end_date).trim()) missing.push('Travel End Date');
  return missing;
}

/**
 * 2.43.1: every ticked service's requirement form must have its required fields filled in before Create
 * (empty forms too) → [error]. The forms open only once Traveller Details and Travel Information are filled in.
 */
function requiredErrors(services, selected, forms, trip, values) {
  const active = selected.map((key) => activeService(services, key)).filter(Boolean);
  if (!active.length) return [];
  const notOpen = formsNotOpen(values);
  if (notOpen.length) {
    return [`Fill in ${notOpen.join(', ')} so the Travel Requirement forms open, then fill in their required fields.`];
  }
  const errors = [];
  for (const service of active) {
    const { missing } = checkValues(service, plain(forms[service.key]), { trip });
    if (missing.length) errors.push(`${service.name} Requirement: fill in ${missing.join(', ')}.`);
  }
  return errors;
}

/** Each ticked service's form that has values → { errors, checked } (wrong values; required fields: requiredErrors). */
function checkForms(services, selected, forms, trip) {
  const errors = [];
  const checked = {};
  for (const key of selected) {
    if (!hasValues(forms[key])) continue;
    const service = activeService(services, key);
    if (!service) continue;
    const result = checkValues(service, forms[key], { trip });
    for (const e of result.errors) errors.push(`${service.name}: ${e}`);
    checked[key] = { service, result };
  }
  return { errors, checked };
}

/* ----------------------------------------------------------------- the age check */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function describe(c) {
  const parts = [];
  if (c.Adult) parts.push(plural(c.Adult, 'adult', 'adults'));
  if (c.Child) parts.push(plural(c.Child, 'child', 'children'));
  if (c.Infant) parts.push(plural(c.Infant, 'infant', 'infants'));
  if (!parts.length) return 'no travellers';
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

/** Age category of each traveller on the reference date ('' = no date / year of birth). */
async function categoriesOf(sdk, travellers, referenceDate, timeZone) {
  const out = [];
  for (const t of travellers.slice(0, MAX_TRAVELLERS)) {
    const existingId = str(t.existingTravellerId);
    let dob = '';
    let yearOfBirth = null;
    if (existingId) {
      const row = ID_RE.test(existingId) ? await sdk.models.Traveller.findById(existingId).catch(() => null) : null;
      if (row) {
        dob = str(row.dob).slice(0, 10);
        yearOfBirth = row.year_of_birth || null;
      }
    } else {
      const { values: v } = rules.checkInput(t, { create: true, timeZone });
      dob = str(v.dob);
      yearOfBirth = v.yearOfBirth || null;
    }
    out.push(rules.ageInfo({ dob, yearOfBirth }, referenceDate).ageCategory);
  }
  return out;
}

/**
 * The travellers against Traveller Details → [warning]. Only when the counts are filled in; fewer travellers than
 * the counts is fine (the rest are added later on the lead).
 */
async function countWarnings(sdk, values, travellers) {
  const zone = await store.timeZone(sdk);
  const ref = store.referenceFromValues(values, zone);
  if (!ref.expected) return [];
  const expected = { Adult: ref.expected.adults, Child: ref.expected.children, Infant: ref.expected.infants };
  const total = expected.Adult + expected.Child + expected.Infant;
  const added = Math.min(travellers.length, MAX_TRAVELLERS);
  if (!total || !added || added < total) return [];
  if (added > total) {
    return [`You added ${plural(added, 'traveller', 'travellers')}, but Traveller Details says ${total} (${describe(expected)}). Change the counts or remove a traveller.`];
  }
  const categories = await categoriesOf(sdk, travellers, ref.referenceDate, zone);
  const { counted, unknownAge } = rules.travellerGroups(categories, null);
  if (counted.Adult === expected.Adult && counted.Child === expected.Child && counted.Infant === expected.Infant) return [];
  const on = ref.referenceSource === 'travel_start_date' ? `on the Travel Start Date (${ref.referenceDate})` : 'today (no Travel Start Date yet)';
  const unknown = unknownAge
    ? ` ${plural(unknownAge, 'traveller has', 'travellers have')} no date of birth and ${unknownAge === 1 ? 'counts' : 'count'} as adult.`
    : '';
  return [
    `Traveller Details says ${describe(expected)}, but by their ages ${on} the travellers are ${describe(counted)}.${unknown} ` +
      'Check the dates of birth or the Adults / Children / Infants counts (Infant: under 2, Child: 2–11, Adult: 12 or more).'
  ];
}

/* ------------------------------------------------------------------------ check */

/**
 * POST /quotation-prefill { leadCreate: true, draft, check? }
 *   'all' (default, the CRM's Create): → { errors, warnings }
 *   'travellers' (one traveller saved in the browser list): → { errors, matches }
 *   'travellers_setup' (the Travellers form's rules and the list, numbers masked): → like GET /leads/:id/travellers
 */
exports.check = async (sdk, draft, step = 'all') => {
  const which = step || 'all';
  if (!STEPS.includes(which)) throw sdk.error(400, 'check must be all, travellers or travellers_setup', 'INVALID_INPUT');
  const parts = partsOf(draft);
  if (which === 'travellers_setup') {
    const setup = await guided.travellersSetup(sdk, parts);
    // The counts are compared only once every traveller is added (no "the lead says…" while still adding).
    const e = setup.expected;
    const total = e ? (Number(e.adults) || 0) + (Number(e.children) || 0) + (Number(e.infants) || 0) : 0;
    if (e && setup.qty < total) setup.expected = null;
    return setup;
  }
  const { services, selected, trip } = await tripParts(sdk, parts.values);
  const errors = [];
  if (trip.start && trip.end && trip.end < trip.start) errors.push('Travel End Date cannot be before Travel Start Date.');
  if (parts.travellers.length > MAX_TRAVELLERS) errors.push(`At most ${MAX_TRAVELLERS} travellers.`);
  let matches = [];
  if (parts.travellers.length) {
    const people = await guided.checkTravellers(sdk, parts.values, parts.travellers, selected, trip, parts.lead);
    errors.push(...people.errors);
    matches = people.matches;
  }
  if (which === 'travellers') return { errors, matches };
  errors.push(...checkForms(services, selected, parts.forms, trip).errors);
  errors.push(...requiredErrors(services, selected, parts.forms, trip, parts.values));
  const warnings = errors.length ? [] : await countWarnings(sdk, parts.values, parts.travellers);
  return { errors: errors.slice(0, 30), warnings };
};

/* ----------------------------------------------------------------------- commit */

/**
 * POST /leads/:lead_id/requirements { leadCreate: true, draft } — right after the CRM created the lead: the requirement forms with
 * values and the travellers are saved on it with the same routes and rules as its tabs. The lead's own saved
 * travel fields decide the services and dates (not the draft). A retry skips what is already there.
 */
exports.commit = async (sdk, leadId, draft) => {
  await store.loadLead(sdk, leadId); // the lead exists and this user may see it
  const parts = partsOf(draft);
  const values = plain(await sdk.values.get('lead', leadId));
  const { services, selected, trip } = await tripParts(sdk, values);
  const failed = [];

  // Requirement forms: one per ticked service that has values (a form with wrong values is not saved).
  const forms = checkForms(services, selected, parts.forms, trip);
  const good = {};
  for (const [key, entry] of Object.entries(forms.checked)) {
    if (entry.result.errors.length) failed.push(`${entry.service.name} requirement: ${entry.result.errors[0]}`);
    else good[key] = entry;
  }
  if (Object.keys(good).length) await CR().saveOnLead(sdk, leadId, services, values, good);

  // Travellers: the lead's own create / "add existing" routes. Already on the lead → skipped.
  const travellersRoute = require('../routes/travellers.js');
  const onLead = await sdk.models.Traveller.find({ lead_id: leadId }, { limit: 200 });
  const profiles = new Set(onLead.map((r) => store.profileOf(r)));
  const people = onLead.map((r) => ({ firstName: str(r.first_name), lastName: str(r.last_name), dob: str(r.dob).slice(0, 10), phone: str(r.phone) }));
  let added = 0;
  // 2.41.0: which new traveller each form made ({ draftId, travellerId }) — the page uploads the document
  // photos kept for that form onto it. Only travellers created here (a skipped or copied one gets none).
  const created = [];
  const list = parts.travellers.slice(0, MAX_TRAVELLERS);
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    const label = `Traveller ${i + 1}`;
    try {
      const existingId = str(t.existingTravellerId);
      if (existingId) {
        const row = ID_RE.test(existingId) ? await sdk.models.Traveller.findById(existingId) : null;
        if (!row) throw new Error('the chosen existing traveller was not found');
        if (profiles.has(store.profileOf(row))) continue;
        await travellersRoute.copy({ params: { lead_id: leadId }, body: { travellerId: existingId } }, sdk);
        profiles.add(store.profileOf(row));
        added += 1;
        continue;
      }
      const { values: v } = rules.checkInput(t, { create: true });
      if (people.some((p) => rules.samePerson(p, v))) continue;
      const body = { ...t };
      delete body.draftId;
      const res = await travellersRoute.create({ params: { lead_id: leadId }, body }, sdk);
      const draftId = str(t.draftId).slice(0, 40);
      const travellerId = str(res && res.traveller && res.traveller.id);
      if (DRAFT_ID_RE.test(draftId) && ID_RE.test(travellerId)) created.push({ draftId, travellerId });
      people.push(v);
      added += 1;
    } catch (error) {
      const name = [str(t.firstName), str(t.lastName)].filter(Boolean).join(' ');
      failed.push(`${label}${name ? ` (${name})` : ''}: ${str(error && error.message) || 'not saved'}`);
    }
  }

  const savedForms = Object.keys(good).length;
  await sdk.audit(
    'created',
    `Lead created with ${plural(added, 'traveller', 'travellers')} and ${plural(savedForms, 'requirement form', 'requirement forms')}`,
    { leadId, travellers: added, requirementForms: savedForms, notSaved: failed.length }
  );
  const result = { travellers: created };
  // 2.41.0 (CRM 3.68.0): a partial save is an answer, not an error — the CRM passes `result` to the page even
  // then, so the photos of the travellers that were saved are still uploaded.
  if (failed.length) {
    return {
      ok: false,
      message: `Saved ${plural(added, 'traveller', 'travellers')} and ${plural(savedForms, 'requirement form', 'requirement forms')}. Not saved — add on the lead: ${failed.slice(0, 4).join(' · ')}`,
      result
    };
  }
  const what = [added ? plural(added, 'traveller', 'travellers') : '', savedForms ? plural(savedForms, 'requirement form', 'requirement forms') : '']
    .filter(Boolean)
    .join(' and ');
  return { ok: true, message: what ? `Lead created with ${what}.` : '', result };
};

exports._internal = { partsOf, countWarnings, checkForms, requiredErrors, formsNotOpen, describe };
