'use strict';

/**
 * Client → Travel Requirement (2.15.0) and the client quotation steps (CRM salesFlow.clientQuotation).
 *
 * The client's travel request is a travel enquiry (lead) started for the client: its Travel Information is
 * the lead's travel fields and its requirement forms are TravelRequirement rows of that lead — the same
 * records, forms and rules as an enquiry made on the Leads page, so travellers, quotation prefill,
 * itinerary and booking work unchanged. ClientEnquiry (this extension's table) links client → enquiry;
 * nothing is stored on the core client.
 *
 * GET  /clients/:client_id/travel-requirement     the client's open enquiry (Travel Information, requirement
 *                                                 values per service, status) and the enabled services
 * PUT  /clients/:client_id/travel-requirement     { values, requirements: { <service_key>: values } } → saves
 *                                                 everything (all selected forms must be complete); starts the
 *                                                 enquiry the first time
 * GET  /clients/quotation-ready                   clients whose Travel Requirement is complete → { clientIds }
 * GET  /clients/:client_id/quotation-travellers   the traveller picker shown before a client quotation
 * POST /clients/:client_id/quotation-start        { selected: [traveller ids] } → travellers copied onto the
 *                                                 enquiry, its trip opportunity → { leadId, opportunityId }
 */

const { readServices, activeService } = require('../services/catalog.js');
const { checkValues } = require('../services/requirement-form.js');
const { refreshStatuses } = require('../services/requirement-status.js');
const { tripOf, prettyDay } = require('../services/trip-dates.js');
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

/** The client's open enquiry (newest first) → { link, lead } or null. */
async function openEnquiry(sdk, clientId) {
  const links = await sdk.models.ClientEnquiry.find({ client_id: clientId }, { limit: 20, sort: { createdAt: -1 } });
  for (const link of links) {
    const lead = await sdk.crm.leads.findById(str(link.lead_id)).catch(() => null);
    if (isOpen(lead)) return { link, lead };
  }
  return null;
}

/** Live first-instance requirement per selected service, statuses rechecked. */
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

const selectedOf = (values) => (values && Array.isArray(values.required_services) ? values.required_services.map(String) : []);

/** Complete = at least one service selected and each one's requirement Complete. */
function completeOf(selected, rows) {
  return selected.length > 0 && selected.every((k) => rows[k] && rows[k].status === 'Complete');
}

exports.getForClient = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const services = (await readServices(sdk)).filter((s) => s.enabled !== false);
  const found = await openEnquiry(sdk, clientId);
  if (!found) return { enquiry: null, values: {}, requirements: {}, services, complete: false };
  const leadId = str(found.lead._id);
  const values = await sdk.values.get('lead', leadId);
  const selected = selectedOf(values);
  const rows = await requirementsOf(sdk, leadId, services, selected);
  return {
    enquiry: { leadId, title: str(found.lead.title), stage: str(found.lead.stage) },
    values,
    requirements: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, { id: str(r._id), status: str(r.status), values: r.values || {} }])),
    services,
    trip: tripOf(values),
    complete: completeOf(selected, rows)
  };
};

/** Step 1 checks before anything is created (the CRM checks them again when the values are saved). */
async function checkTravelInfo(sdk, values, services) {
  const errors = [];
  if (!str(values.from)) errors.push('From is required.');
  if (!str(values.to)) errors.push('To is required.');
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
  const client = await loadClient(sdk, clientId);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  const values = Object.fromEntries(TRAVEL_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  const services = await readServices(sdk);
  const { errors, selected, trip } = await checkTravelInfo(sdk, values, services.filter((s) => s.enabled !== false));
  values.required_services = selected;

  // Every selected form, checked against the trip dates and complete, before anything is saved.
  const forms = body.requirements && typeof body.requirements === 'object' ? body.requirements : {};
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

  // The enquiry: the open one, or a new one for the client (linked here, never on the client record).
  let found = await openEnquiry(sdk, clientId);
  let created = false;
  if (!found) {
    const destination = str(values.to) || str(values.destination);
    const when = trip.start ? ` · ${prettyDay(trip.start)}` : '';
    const lead = await sdk.crm.leads.createForClient(clientId, { title: `${destination} Trip – ${str(client.name)}${when}`.slice(0, 200) });
    const link = await sdk.models.ClientEnquiry.create({ client_id: clientId, lead_id: lead.id, created_by: str(sdk.user && sdk.user.id) });
    found = { link, lead: { _id: lead.id, title: lead.title, stage: lead.stage } };
    created = true;
  }
  const leadId = str(found.lead._id);

  // Requirements first (checked against the new dates), then the Travel Information.
  const existing = await requirementsOf(sdk, leadId, services, selected);
  for (const key of Object.keys(checked)) {
    const { service, result } = checked[key];
    const row = existing[key];
    if (row) await sdk.models.TravelRequirement.updateById(row._id, { values: result.values, status: result.status, service_name: service.name });
    else await reqStore.createInstance(sdk, { leadId, service, label: '', values: result.values, status: result.status });
  }
  await sdk.values.set('lead', leadId, values);
  await sdk.audit(created ? 'created' : 'updated', `Client travel requirement ${created ? 'started' : 'saved'} (enquiry ${leadId})`, { clientId, leadId, services: selected });
  return exports.getForClient({ params: { client_id: clientId } }, sdk);
};

exports.quotationReady = async (req, sdk) => {
  const links = await sdk.models.ClientEnquiry.find({}, { limit: ENQUIRY_LIMIT, sort: { createdAt: -1 } });
  const services = await readServices(sdk);
  const ready = new Set();
  const seen = new Set();
  for (const link of links) {
    const clientId = str(link.client_id);
    if (ready.has(clientId) || seen.has(`${clientId}:${str(link.lead_id)}`)) continue;
    seen.add(`${clientId}:${str(link.lead_id)}`);
    const lead = await sdk.crm.leads.findById(str(link.lead_id)).catch(() => null);
    if (!isOpen(lead)) continue;
    const values = await sdk.values.get('lead', str(lead._id));
    const selected = selectedOf(values);
    if (completeOf(selected, await requirementsOf(sdk, str(lead._id), services, selected))) ready.add(clientId);
  }
  return { clientIds: [...ready] };
};

/** The client's open enquiry when its Travel Requirement is complete, else null. */
async function readyEnquiry(sdk, clientId) {
  const found = await openEnquiry(sdk, clientId);
  if (!found) return null;
  const services = await readServices(sdk);
  const values = await sdk.values.get('lead', str(found.lead._id));
  const selected = selectedOf(values);
  return completeOf(selected, await requirementsOf(sdk, str(found.lead._id), services, selected)) ? found : null;
}

exports.quotationTravellers = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const found = await readyEnquiry(sdk, clientId);
  if (!found) {
    return {
      eligible: false,
      message: 'Fill and save this client’s Travel Requirement first.',
      title: 'Select travellers',
      items: [],
      min: 1,
      emptyLink: { label: 'Open Travel Requirement', link: `/clients/${clientId}?tab=decl_travel_requirement` }
    };
  }
  const leadId = str(found.lead._id);
  const today = rules.todayIso(undefined, await travellerStore.timeZone(sdk));
  const onEnquiry = await sdk.models.Traveller.find({ lead_id: leadId }, { limit: 200 });
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
    intro: `Who travels on "${str(found.lead.title)}"? Choose at least one; they are added to the trip before the quotation opens.`,
    submitLabel: 'Create Quotation',
    min: 1,
    items,
    emptyText: 'This client has no travellers yet.',
    emptyLink: { label: 'Add travellers', link: `/leads/${leadId}?tab=decl_travellers` }
  };
};

exports.quotationStart = async (req, sdk) => {
  const clientId = clientIdOf(req, sdk);
  await loadClient(sdk, clientId);
  const found = await readyEnquiry(sdk, clientId);
  if (!found) throw sdk.error(409, 'Fill and save this client’s Travel Requirement first.', 'REQUIREMENT_NOT_READY');
  const leadId = str(found.lead._id);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const selected = [...new Set((Array.isArray(body.selected) ? body.selected : []).map(str).filter((id) => ID_RE.test(id)))].slice(0, 50);
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
  const opportunity = await sdk.crm.opportunities.createForLead(leadId, { title: str(found.lead.title) });
  await sdk.audit('updated', `Client quotation started (enquiry ${leadId}, ${count} traveller${count === 1 ? '' : 's'})`, { clientId, leadId, opportunityId: opportunity.id });
  return { leadId, opportunityId: opportunity.id };
};
