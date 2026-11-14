'use strict';

/**
 * Client → Travel Requirement (2.15.0; 2.22.0 saved without a lead) and the client quotation steps
 * (CRM salesFlow.clientQuotation).
 *
 * 2.22.0: saving the client's Travel Requirement never creates a lead. It is kept in this extension's own
 * table ClientTravelRequirement (Travel Information + one form per selected service). The trip's enquiry
 * lead — which the opportunity, quotation, travellers, itinerary and bookings are built on — is opened only
 * when the user asks for it: "Create Quotation" (quotation-start) or "Add Travellers" (travel-requirement/trip).
 * It is then filled from the saved requirement (lead values + TravelRequirement rows) and linked in
 * ClientEnquiry; from then on the tab shows and saves that enquiry, exactly as before.
 * A client whose open enquiry was started by an older version keeps using it (no second lead).
 *
 * GET  /clients/:client_id/travel-requirement        the client's current requirement → { saved, enquiry,
 *                                                    values, requirements, services, trip, complete }
 * PUT  /clients/:client_id/travel-requirement        { values, requirements: { <service_key>: values } } →
 *                                                    checked as a whole, then saved (no lead is created)
 * POST /clients/:client_id/travel-requirement/trip   opens the trip from the saved requirement → { leadId }
 * GET  /clients/:client_id/travel-requirement/lead-form-sync   may Lead create copy its Travel Information here?
 *                                                    → { available, message } (not when the open trip has a quotation)
 * POST /clients/:client_id/travel-requirement/lead-form-sync   { values } → Step 1 (Travel Information) only,
 *                                                    into the one current requirement (2.27.0)
 * GET  /clients/quotation-ready                      clients whose Travel Requirement is complete → { clientIds }
 * GET  /clients/:client_id/quotation-travellers      the traveller picker shown before a client quotation
 * POST /clients/:client_id/quotation-start           { selected: [traveller ids] } → the trip is opened if
 *                                                    needed, travellers copied onto it, its opportunity
 *                                                    → { leadId, opportunityId }
 */

const { readServices, activeService } = require('../services/catalog.js');
const { checkValues } = require('../services/requirement-form.js');
const { refreshStatuses } = require('../services/requirement-status.js');
const { tripOf, prettyDay } = require('../services/trip-dates.js');
const { checkOptions } = require('../services/travel-info-options.js');
const reqStore = require('../services/requirement-store.js');
const travellerStore = require('../services/traveller-store.js');
const rules = require('../services/traveller-rules.js');
const alerts = require('../services/passport-alerts.js');

const { ID_RE, str } = reqStore;
// Lead travel fields the client form sets (calculated ones — days, month — are worked out by the CRM).
const TRAVEL_KEYS = ['from', 'to', 'destination', 'travel_start_date', 'travel_end_date', 'date_flexibility', 'required_services'];
const ENQUIRY_LIMIT = 1000;

const clientIdOf = (req, sdk) => {
  const id = str(req.params && req.params.client_id);
  if (!ID_RE.test(id)) throw sdk.error(400, 'client_id is not valid', 'INVALID_INPUT');
  return id;
};

async function loadClient(sdk, clientId) {
  const client = await sdk.crm.clients.findById(clientId);
  if (!client) throw sdk.error(404, 'Client not found', 'NOT_FOUND');
  return client;
}

const closedStage = (lead) => /(^|\b)(won|lost)(\b|$)/i.test(str(lead && lead.stage));
const isOpen = (lead) => Boolean(lead) && !lead.convertedClientId && !closedStage(lead) && !lead.isDeleted;
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The client's open enquiry (newest first) → { link, lead } or null. */
async function openEnquiry(sdk, clientId) {
  const links = await sdk.models.ClientEnquiry.find({ client_id: clientId }, { limit: 20, sort: { createdAt: -1 } });
  for (const link of links) {
    const lead = await sdk.crm.leads.findById(str(link.lead_id)).catch(() => null);
    if (isOpen(lead)) return { link, lead };
  }
  return null;
}

/** The client's saved requirement whose trip is not opened yet (newest), or null. */
async function draftOf(sdk, clientId) {
  const rows = await sdk.models.ClientTravelRequirement.find({ client_id: clientId }, { limit: 20, sort: { updatedAt: -1 } });
  return rows.find((r) => !str(r.lead_id)) || null;
}

/** Live first-instance requirement per selected service of a lead, statuses rechecked. */
async function requirementsOf(sdk, leadId, services, selected) {
  const rows = reqStore.live(await reqStore.rowsForLeads(sdk, [leadId]));
  await reqStore.migrateRows(sdk, rows, services);
  await refreshStatuses(sdk, rows, services);
  const out = {};
  for (const key of selected) {
    const mine = rows.filter((r) => str(r.service_key) === key).sort((a, b) => reqStore.instanceOf(a) - reqStore.instanceOf(b));
    if (mine.length) out[key] = mine[0];
  }
  return out;
}

/** A saved (lead-less) requirement's forms, each rechecked against today's service form and trip dates. */
function draftRequirements(draft, services, selected) {
  const values = plain(draft.values);
  const trip = tripOf(values);
  const forms = plain(draft.requirements);
  const out = {};
  for (const key of selected) {
    const service = activeService(services, key);
    const stored = plain(forms[key]);
    if (!service || !Object.keys(stored).length) continue;
    const result = checkValues(service, stored, { trip });
    out[key] = { id: '', status: result.errors.length || result.missing.length ? 'Draft' : 'Complete', values: stored };
  }
  return out;
}

const selectedOf = (values) => (values && Array.isArray(values.required_services) ? values.required_services.map(String) : []);

/** Complete = at least one service selected and each one's requirement Complete. */
function completeOf(selected, rows) {
  return selected.length > 0 && selected.every((k) => rows[k] && rows[k].status === 'Complete');
}

/**
 * The client's current Travel Requirement:
 *   { kind: 'lead', lead, link }   its trip is open (or an older version started the enquiry)
 *   { kind: 'draft', draft }       saved here, trip not opened yet
 *   null                           nothing yet
 */
async function currentOf(sdk, clientId) {
  const found = await openEnquiry(sdk, clientId);
  if (found) return { kind: 'lead', ...found };
  const draft = await draftOf(sdk, clientId);
  return draft ? { kind: 'draft', draft } : null;
}

async function viewOf(sdk, current, services) {
  if (!current) return { saved: false, enquiry: null, values: {}, requirements: {}, services, complete: false };
  if (current.kind === 'draft') {
    const values = plain(current.draft.values);
    const selected = selectedOf(values);
    const requirements = draftRequirements(current.draft, services, selected);
    return { saved: true, enquiry: null, values, requirements, services, trip: tripOf(values), complete: completeOf(selected, requirements) };
  }
  const leadId = str(current.lead._id);
  const values = await sdk.values.get('lead', leadId);
  const selected = selectedOf(values);
  const rows = await requirementsOf(sdk, leadId, services, selected);
  return {
    saved: true,
    enquiry: { leadId, title: str(current.lead.title), stage: str(current.lead.stage) },
    values,
    requirements: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, { id: str(r._id), status: str(r.status), values: r.values || {} }])),
    services,
    trip: tripOf(values),
    complete: completeOf(selected, rows)
  };
}

exports.getForClient = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const services = (await readServices(sdk)).filter((s) => s.enabled !== false);
  return viewOf(sdk, await currentOf(sdk, clientId), services);
};

/** Step 1 checks (dates, services, and From / To / Date Flexibility against their option lists). */
async function checkTravelInfo(sdk, values, services) {
  const errors = [];
  if (!str(values.from)) errors.push('From is required.');
  if (!str(values.to)) errors.push('To is required.');
  errors.push(...(await checkOptions(sdk, values)));
  const enabled = new Set(services.map((s) => s.key));
  const selected = selectedOf(values).filter((k) => enabled.has(k));
  if (!selected.length) errors.push('Select at least one Required Service.');
  const trip = tripOf(values);
  const today = rules.todayIso(undefined, await travellerStore.timeZone(sdk));
  if (trip.start && trip.start < today) errors.push('Travel Start Date cannot be in the past.');
  if (trip.start && trip.end && trip.end < trip.start) errors.push('Travel End Date cannot be before Travel Start Date.');
  return { errors, selected, trip };
}

exports.saveForClient = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = plain(body.values);
  const values = Object.fromEntries(TRAVEL_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  const services = await readServices(sdk);
  const { errors, selected, trip } = await checkTravelInfo(sdk, values, services.filter((s) => s.enabled !== false));
  values.required_services = selected;

  // Every selected form, checked against the trip dates and complete, before anything is saved.
  const forms = plain(body.requirements);
  const checked = {};
  for (const key of selected) {
    const service = activeService(services, key);
    if (!service) continue;
    const result = checkValues(service, forms[key], { trip });
    for (const e of result.errors) errors.push(`${service.name}: ${e}`);
    if (!result.errors.length && result.missing.length) errors.push(`${service.name}: ${result.missing.join(', ')} ${result.missing.length > 1 ? 'are' : 'is'} required.`);
    checked[key] = { service, result };
  }
  if (errors.length) {
    const error = sdk.error(400, errors.slice(0, 8).join(' '), 'INVALID_TRAVEL_REQUIREMENT');
    error.details = errors.slice(0, 30);
    throw error;
  }

  const current = await currentOf(sdk, clientId);
  const userId = str(sdk.user && sdk.user.id);

  if (current && current.kind === 'lead') {
    // The trip is open: its enquiry is the record (requirements first, checked against the new dates).
    const leadId = str(current.lead._id);
    await saveOnLead(sdk, leadId, services, values, checked);
    await sdk.audit('updated', `Client travel requirement saved (enquiry ${leadId})`, { clientId, leadId, services: selected });
    return exports.getForClient({ params: { client_id: clientId } }, sdk);
  }

  // No trip yet: kept in this extension's table only — no lead is created.
  const row = {
    values,
    requirements: Object.fromEntries(Object.entries(checked).map(([k, { result }]) => [k, result.values])),
    status: 'Complete',
    updated_by: userId
  };
  if (current) await sdk.models.ClientTravelRequirement.updateById(current.draft._id, row);
  else await sdk.models.ClientTravelRequirement.create({ client_id: clientId, lead_id: '', created_by: userId, ...row });
  await sdk.audit(current ? 'updated' : 'created', `Client travel requirement ${current ? 'saved' : 'added'}`, { clientId, services: selected });
  return exports.getForClient({ params: { client_id: clientId } }, sdk);
};

/* --------------------------- 2.27.0: Lead create → "Add as Secondary Contact" → Sync Travel Information */

const SYNC_BLOCKED = 'This client’s open trip already has a quotation, so its Travel Information is not changed from a lead form.';

/**
 * Whether Step 1 may be copied from a lead form: always into a saved requirement (or a new one); into the
 * client's open trip only while that trip has no quotation (the user's rule). An older CRM that cannot say
 * whether the trip has a quotation is treated as "has one" (never changes a priced trip).
 */
async function leadFormSyncState(sdk, clientId) {
  const current = await currentOf(sdk, clientId);
  if (current && current.kind === 'lead') {
    const leadId = str(current.lead._id);
    const priced = typeof sdk.crm.leads.hasQuotation === 'function' ? await sdk.crm.leads.hasQuotation(leadId) : true;
    if (priced) return { current, available: false, message: SYNC_BLOCKED };
  }
  return { current, available: true, message: '' };
}

exports.leadFormSyncStatus = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const { available, message } = await leadFormSyncState(sdk, clientId);
  return { available, message };
};

/**
 * Copies the lead form's Travel Information (From, To, Destination, Travel Start / End Date, Date Flexibility,
 * Required Services) to the client's ONE current requirement — Number of Days and Travel Month follow from
 * the dates. Step 2 forms of services that stay selected are kept (rechecked against the new dates when shown).
 * Never creates a lead, a quotation or a second requirement.
 */
exports.leadFormSync = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const { current, available, message } = await leadFormSyncState(sdk, clientId);
  if (!available) throw sdk.error(409, message, 'SYNC_NOT_ALLOWED');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = plain(body.values);
  const values = Object.fromEntries(TRAVEL_KEYS.filter((k) => raw[k] !== undefined && raw[k] !== null).map((k) => [k, raw[k]]));
  const services = (await readServices(sdk)).filter((s) => s.enabled !== false);
  const { errors, selected } = await checkTravelInfo(sdk, values, services);
  if (errors.length) {
    const error = sdk.error(400, errors.slice(0, 8).join(' '), 'INVALID_TRAVEL_REQUIREMENT');
    error.details = errors.slice(0, 30);
    throw error;
  }
  values.required_services = selected;
  const userId = str(sdk.user && sdk.user.id);
  const meta = { clientId, services: selected, source: 'lead_create_secondary_contact' };

  if (current && current.kind === 'lead') {
    // The open trip has no quotation yet: its enquiry is the record (the CRM checks the values again).
    const leadId = str(current.lead._id);
    await sdk.values.set('lead', leadId, values);
    await sdk.audit('updated', `Client travel information copied from a lead form (enquiry ${leadId})`, { ...meta, leadId });
  } else {
    const kept = current ? plain(current.draft.requirements) : {};
    const requirements = Object.fromEntries(selected.filter((k) => plain(kept[k]) && Object.keys(plain(kept[k])).length).map((k) => [k, kept[k]]));
    const draft = { values, requirements };
    const status = completeOf(selected, draftRequirements(draft, services, selected)) ? 'Complete' : 'Draft';
    const row = { values, requirements, status, updated_by: userId };
    if (current) await sdk.models.ClientTravelRequirement.updateById(current.draft._id, row);
    else await sdk.models.ClientTravelRequirement.create({ client_id: clientId, lead_id: '', created_by: userId, ...row });
    await sdk.audit(current ? 'updated' : 'created', 'Client travel information copied from a lead form', meta);
  }
  return { synced: true, ...(await exports.getForClient({ params: { client_id: clientId } }, sdk)) };
};

/** Saves checked forms and Travel Information on a trip lead (the CRM checks the values again). */
async function saveOnLead(sdk, leadId, services, values, checked) {
  const selected = selectedOf(values);
  const existing = await requirementsOf(sdk, leadId, services, selected);
  for (const key of Object.keys(checked)) {
    const { service, result } = checked[key];
    const row = existing[key];
    if (row) await sdk.models.TravelRequirement.updateById(row._id, { values: result.values, status: result.status, service_name: service.name });
    else await reqStore.createInstance(sdk, { leadId, service, label: '', values: result.values, status: result.status });
  }
  await sdk.values.set('lead', leadId, values);
}

/**
 * The client's trip lead: the open one, or a new one opened from the saved, complete requirement
 * (only from quotation-start / Add Travellers — never from a save). → { leadId, lead, created }
 */
async function openTrip(sdk, clientId) {
  const client = await loadClient(sdk, clientId);
  const current = await currentOf(sdk, clientId);
  if (current && current.kind === 'lead') return { leadId: str(current.lead._id), lead: current.lead, created: false };
  if (!current) throw sdk.error(409, 'Fill and save this client’s Travel Requirement first.', 'REQUIREMENT_NOT_READY');

  // Everything is checked again before the lead is made, so a bad value never leaves a half-made trip.
  const services = await readServices(sdk);
  const values = Object.fromEntries(TRAVEL_KEYS.filter((k) => plain(current.draft.values)[k] !== undefined).map((k) => [k, plain(current.draft.values)[k]]));
  const { errors, selected, trip } = await checkTravelInfo(sdk, values, services.filter((s) => s.enabled !== false));
  values.required_services = selected;
  const checked = {};
  for (const key of selected) {
    const service = activeService(services, key);
    if (!service) continue;
    const result = checkValues(service, plain(current.draft.requirements)[key], { trip });
    if (result.errors.length || result.missing.length) errors.push(`${service.name} requirement is not complete.`);
    checked[key] = { service, result };
  }
  if (errors.length) {
    const error = sdk.error(409, `Update this client’s Travel Requirement first: ${errors.slice(0, 4).join(' ')}`, 'REQUIREMENT_NOT_READY');
    error.details = errors.slice(0, 30);
    throw error;
  }

  const destination = str(values.to) || str(values.destination);
  const when = trip.start ? ` · ${prettyDay(trip.start)}` : '';
  const lead = await sdk.crm.leads.createForClient(clientId, { title: `${destination} Trip – ${str(client.name)}${when}`.slice(0, 200) });
  // Linked at once, so a retry after a later failure reuses this lead instead of making another.
  await sdk.models.ClientEnquiry.create({ client_id: clientId, lead_id: lead.id, created_by: str(sdk.user && sdk.user.id) });
  await sdk.models.ClientTravelRequirement.updateById(current.draft._id, { lead_id: lead.id, trip_started_at: new Date().toISOString() });
  await saveOnLead(sdk, lead.id, services, values, checked);
  await sdk.audit('created', `Client trip opened from the Travel Requirement (enquiry ${lead.id})`, { clientId, leadId: lead.id, services: selected });
  return { leadId: lead.id, lead: { _id: lead.id, title: lead.title, stage: lead.stage }, created: true };
}

exports.startTrip = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  const { leadId, created } = await openTrip(sdk, clientId);
  return { leadId, created };
};

exports.quotationReady = async (req, sdk) => {
  const services = await readServices(sdk);
  const ready = new Set();
  // Saved requirements whose trip is not opened yet.
  const drafts = await sdk.models.ClientTravelRequirement.find({}, { limit: ENQUIRY_LIMIT, sort: { updatedAt: -1 } });
  const withEnquiry = new Set();
  const links = await sdk.models.ClientEnquiry.find({}, { limit: ENQUIRY_LIMIT, sort: { createdAt: -1 } });
  const seen = new Set();
  for (const link of links) {
    const clientId = str(link.client_id);
    if (ready.has(clientId) || seen.has(`${clientId}:${str(link.lead_id)}`)) continue;
    seen.add(`${clientId}:${str(link.lead_id)}`);
    const lead = await sdk.crm.leads.findById(str(link.lead_id)).catch(() => null);
    if (!isOpen(lead)) continue;
    withEnquiry.add(clientId);
    const values = await sdk.values.get('lead', str(lead._id));
    const selected = selectedOf(values);
    if (completeOf(selected, await requirementsOf(sdk, str(lead._id), services, selected))) ready.add(clientId);
  }
  for (const draft of drafts) {
    const clientId = str(draft.client_id);
    if (str(draft.lead_id) || withEnquiry.has(clientId) || ready.has(clientId)) continue;
    const selected = selectedOf(plain(draft.values));
    if (completeOf(selected, draftRequirements(draft, services, selected))) ready.add(clientId);
  }
  return { clientIds: [...ready] };
};

/** The client's current requirement when it is complete, else null. */
async function readyCurrent(sdk, clientId) {
  const current = await currentOf(sdk, clientId);
  if (!current) return null;
  const services = await readServices(sdk);
  const view = await viewOf(sdk, current, services);
  return view.complete ? current : null;
}

exports.quotationTravellers = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const current = await readyCurrent(sdk, clientId);
  const requirementLink = `/clients/${clientId}?tab=decl_travel_requirement`;
  if (!current) {
    return {
      eligible: false,
      message: 'Fill and save this client’s Travel Requirement first.',
      title: 'Select travellers',
      items: [],
      min: 1,
      emptyLink: { label: 'Open Travel Requirement', link: requirementLink }
    };
  }
  const leadId = current.kind === 'lead' ? str(current.lead._id) : '';
  const title = current.kind === 'lead' ? str(current.lead.title) : 'this trip';
  const today = rules.todayIso(undefined, await travellerStore.timeZone(sdk));
  const onEnquiry = leadId ? await sdk.models.Traveller.find({ lead_id: leadId }, { limit: 200 }) : [];
  const onProfiles = new Set(onEnquiry.map((r) => travellerStore.profileOf(r)));
  const { forClient } = require('./client-travellers.js');
  const list = (await forClient({ params: { client_id: clientId } }, sdk)).travellers;
  const item = (id, label, row) => {
    const status = alerts.passportStatus(row.passportExpiry || row.passport_expiry_date, today);
    return {
      id,
      label,
      detail: [row.relation, row.ageCategory || row.age_category, status === 'Missing' ? 'No passport' : `Passport ${status}`].filter(Boolean).join(' · '),
      ...(status === 'Expired' ? { disabled: true, hint: 'Passport expired — renew it before travel.' } : {})
    };
  };
  const items = onEnquiry.map((r) => ({ ...item(str(r._id), alerts.fullName(r), r), checked: true, disabled: true, hint: 'Already travelling on this trip' }));
  for (const t of list) {
    const row = onEnquiry.find((r) => str(r._id) === t.id);
    if (row) continue;
    const profile = await sdk.models.Traveller.findById(t.id).catch(() => null);
    if (profile && onProfiles.has(travellerStore.profileOf(profile))) continue;
    items.push(item(t.id, t.name, t));
  }
  return {
    eligible: true,
    title: 'Select travellers',
    intro: `Who travels on "${title}"? Choose at least one; they are added to the trip before the quotation opens.`,
    submitLabel: 'Create Quotation',
    min: 1,
    items,
    emptyText: 'This client has no travellers yet.',
    // Without a trip yet, travellers are added from the Travel Requirement tab ("Add Travellers" opens the trip).
    emptyLink: leadId
      ? { label: 'Add travellers', link: `/leads/${leadId}?tab=decl_travellers` }
      : { label: 'Add travellers', link: requirementLink }
  };
};

exports.quotationStart = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const current = await readyCurrent(sdk, clientId);
  if (!current) throw sdk.error(409, 'Fill and save this client’s Travel Requirement first.', 'REQUIREMENT_NOT_READY');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const selected = [...new Set((Array.isArray(body.selected) ? body.selected : []).map(str).filter((id) => ID_RE.test(id)))].slice(0, 50);

  // Nothing is opened without at least one traveller.
  const knownLead = current.kind === 'lead' ? str(current.lead._id) : '';
  const already = knownLead ? await sdk.models.Traveller.find({ lead_id: knownLead }, { limit: 200 }) : [];
  if (!already.length && !selected.length) throw sdk.error(400, 'Choose at least one traveller.', 'TRAVELLERS_REQUIRED');
  for (const id of selected) {
    if (!(await sdk.models.Traveller.findById(id))) throw sdk.error(404, 'A chosen traveller was not found', 'NOT_FOUND');
  }

  const { leadId, lead } = await openTrip(sdk, clientId);
  const onEnquiry = await sdk.models.Traveller.find({ lead_id: leadId }, { limit: 200 });
  const onIds = new Set(onEnquiry.map((r) => str(r._id)));
  const onProfiles = new Set(onEnquiry.map((r) => travellerStore.profileOf(r)));
  const { copy } = require('./travellers.js');
  let count = onEnquiry.length;
  for (const id of selected) {
    if (onIds.has(id)) continue;
    const row = await sdk.models.Traveller.findById(id);
    if (!row) throw sdk.error(404, 'A chosen traveller was not found', 'NOT_FOUND');
    if (onProfiles.has(travellerStore.profileOf(row))) continue;
    // The same checks as "Add existing traveller" on a lead (passport, duplicates, visibility).
    await copy({ params: { lead_id: leadId }, body: { travellerId: id } }, sdk);
    onProfiles.add(travellerStore.profileOf(row));
    count += 1;
  }
  if (!count) throw sdk.error(400, 'Choose at least one traveller.', 'TRAVELLERS_REQUIRED');
  // 2.25.0: no opportunity. The quotation is saved for the client and this trip (CRM 3.45.0
  // salesFlow.clientQuotation.withoutOpportunity); its lines come from the trip's requirements.
  if (!lead) throw sdk.error(409, 'The trip could not be opened.', 'REQUIREMENT_NOT_READY');
  await sdk.audit('updated', `Client quotation started (enquiry ${leadId}, ${count} traveller${count === 1 ? '' : 's'})`, { clientId, leadId });
  return { leadId };
};
