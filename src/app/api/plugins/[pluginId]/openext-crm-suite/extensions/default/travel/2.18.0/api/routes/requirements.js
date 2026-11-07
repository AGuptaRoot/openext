'use strict';

/**
 * Travel Requirements of a lead (T2, requirements v2): several per service ("Hotel – Goa",
 * "Hotel – Mumbai"), each its own record with an id.
 *
 * GET    /leads/:lead_id/requirements                 services, live requirements (with their latest
 *                                                     availability check) and the availability settings
 * POST   /leads/:lead_id/requirements                 { service_key, label?, values } → next instance
 * PUT    /requirements/:id                            { label?, values? } → check and save
 * DELETE /requirements/:id                            soft remove (removed: true); 409 when on a booking
 * PUT    /leads/:lead_id/requirements/:service_key    old route: saves the first live instance (or creates it)
 * DELETE /leads/:lead_id/requirements/:service_key    old route: soft-removes the first live instance
 *
 * Records live in this extension's own table (model TravelRequirement), linked to the core lead by
 * lead_id; the core lead is only read. Statuses are rechecked against the current form whenever they
 * are read (requirement-status.js); rows from before 2.0.0 get an instance and label on read
 * (requirement-store.js). Requirements of a service no longer ticked in Required Services are hidden,
 * not removed: they come back when it is ticked again.
 *
 * 2.12.0: every save is checked against the lead's Travel Start / End Date (api/services/trip-dates.js):
 * dates inside the trip, paired dates in order, nights not more than the stay or the trip.
 */

const { readServices, activeService } = require('../services/catalog.js');
const { checkValues, statusOf } = require('../services/requirement-form.js');
const { notifyIfReady } = require('../services/readiness.js');
const { refreshStatuses } = require('../services/requirement-status.js');
const { summarize } = require('../services/availability.js');
const store = require('../services/requirement-store.js');
const fieldSuggestions = require('../services/field-suggestions.js');
const { tripOf } = require('../services/trip-dates.js');
const { assertLeadOpen } = require('../services/lead-access.js');

const { ID_RE, REC_RE, str } = store;

async function loadLead(sdk, rawId) {
  const id = str(rawId);
  if (!ID_RE.test(id)) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  const lead = await sdk.crm.leads.findById(id);
  if (!lead) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  return { id, lead };
}

/** Services chosen in the lead's "Required Services" field. */
async function selectedKeys(sdk, leadId) {
  const values = await sdk.values.get('lead', leadId);
  return selectedOf(values);
}

function selectedOf(values) {
  const list = values && Array.isArray(values.required_services) ? values.required_services : [];
  return list.map((v) => String(v));
}

/** The lead's trip: { start, end, nights, days } from its Travel Start / End Date. */
async function tripFor(sdk, leadId) {
  return tripOf(await sdk.values.get('lead', leadId));
}

async function settingsFor(sdk) {
  const [needs, days, timezone] = await Promise.all([
    sdk.settings.get('ready_requires_availability'),
    sdk.settings.get('availability_default_validity_days'),
    sdk.settings.get('timezone')
  ]);
  const n = Number(days);
  return {
    readyRequiresAvailability: needs === true,
    availabilityDefaultValidityDays: Number.isInteger(n) && n >= 1 && n <= 30 ? n : 3,
    timezone: str(timezone) || 'Asia/Kolkata',
    maxInstances: store.MAX_INSTANCES,
    labelMax: store.LABEL_MAX
  };
}

const canSeePrices = (sdk) => Boolean(sdk.permissions && typeof sdk.permissions.has === 'function' && sdk.permissions.has('crm.finance.read'));

/** A requirement as the tab shows it: with its latest availability check (prices only with finance read). */
function present(row, check, sdk, now = new Date()) {
  return { ...row, instance: store.instanceOf(row) || 1, label: str(row.label), availability: summarize(check, now, { withPrices: canSeePrices(sdk) }) };
}

function sortRows(rows, services) {
  const order = new Map(services.map((s, i) => [s.key, i]));
  return rows.slice().sort((a, b) => {
    const sa = order.has(str(a.service_key)) ? order.get(str(a.service_key)) : 1e6;
    const sb = order.has(str(b.service_key)) ? order.get(str(b.service_key)) : 1e6;
    return sa - sb || store.instanceOf(a) - store.instanceOf(b);
  });
}

exports.listForLead = async (req, sdk) => {
  const { id } = await loadLead(sdk, req.params && req.params.lead_id);
  const [services, values, all, settings] = await Promise.all([readServices(sdk), sdk.values.get('lead', id), store.rowsForLeads(sdk, [id]), settingsFor(sdk)]);
  const selected = selectedOf(values);
  await store.migrateRows(sdk, all, services);
  // Unticked services: hidden (kept, not removed). Removed rows: never shown.
  const rows = store.live(all).filter((r) => selected.includes(str(r.service_key)));
  await refreshStatuses(sdk, rows, services);
  const checks = await store.latestChecks(sdk, rows.map((r) => r._id));
  const now = new Date();
  return {
    leadId: id,
    selected,
    services,
    requirements: sortRows(rows, services).map((r) => present(r, checks.get(str(r._id)), sdk, now)),
    settings,
    // The range every requirement date must stay in (the form disables other days).
    trip: tripOf(values)
  };
};

/** The active, selected service for a write; 400 / 404 otherwise. */
async function writableService(sdk, leadId, serviceKey) {
  await assertLeadOpen(sdk, leadId);
  const services = await readServices(sdk);
  const service = activeService(services, serviceKey);
  if (!service) throw sdk.error(400, `"${serviceKey}" is not an active travel service`, 'SERVICE_NOT_FOUND');
  const selected = await selectedKeys(sdk, leadId);
  if (!selected.includes(serviceKey)) {
    throw sdk.error(400, `Add ${service.name} to the lead's Required Services first`, 'SERVICE_NOT_SELECTED');
  }
  return service;
}

function checked(sdk, service, values, trip) {
  const result = checkValues(service, values, { trip });
  if (result.errors.length) {
    const error = sdk.error(400, result.errors.slice(0, 6).join(' · '), 'INVALID_REQUIREMENT');
    error.details = result.errors.slice(0, 20);
    throw error;
  }
  return result;
}

async function createFor(sdk, leadId, service, body) {
  const label = store.cleanLabel(sdk, body.label);
  const result = checked(sdk, service, body.values, await tripFor(sdk, leadId));
  const row = await store.createInstance(sdk, { leadId, service, label, values: result.values, status: result.status });
  // The typed text values become type-ahead suggestions for the same fields.
  await fieldSuggestions.recordFromValues(sdk, service, result.values);
  await sdk.audit('created', `Travel requirement "${str(row.label) || service.name}" (${result.status}) for lead ${leadId}`, {
    leadId,
    requirementId: str(row._id),
    serviceKey: service.key,
    instance: store.instanceOf(row),
    status: result.status
  });
  const workflow = await notifyIfReady(sdk, leadId);
  return { requirement: present(row, null, sdk), status: result.status, missing: result.missing, warnings: result.warnings, workflow };
}

async function updateRow(sdk, row, service, body) {
  const patch = { service_name: service.name };
  let result;
  if (body.values !== undefined) {
    result = checked(sdk, service, body.values, await tripFor(sdk, str(row.lead_id)));
    Object.assign(patch, { values: result.values, status: result.status });
  } else {
    const status = statusOf(service, row.values && typeof row.values === 'object' ? row.values : {});
    result = { ...checkValues(service, row.values || {}), status };
    patch.status = status;
  }
  if (body.label !== undefined) {
    const label = store.cleanLabel(sdk, body.label);
    patch.label = label || store.defaultLabel(service.name, store.instanceOf(row) || 1);
  }
  const updated = await sdk.models.TravelRequirement.updateById(row._id, patch);
  if (body.values !== undefined) await fieldSuggestions.recordFromValues(sdk, service, result.values);
  await sdk.audit('updated', `Travel requirement "${str((updated || row).label) || service.name}" (${result.status}) for lead ${str(row.lead_id)}`, {
    leadId: str(row.lead_id),
    requirementId: str(row._id),
    serviceKey: service.key,
    status: result.status
  });
  const workflow = await notifyIfReady(sdk, str(row.lead_id));
  const [check] = [...(await store.latestChecks(sdk, [row._id])).values()];
  return { requirement: present(updated || { ...row, ...patch }, check, sdk), status: result.status, missing: result.missing, warnings: result.warnings, workflow };
}

/** A live requirement by id, with its lead checked (exists, readable). */
async function loadRequirement(sdk, rawId) {
  const id = str(rawId);
  const row = REC_RE.test(id) ? await sdk.models.TravelRequirement.findById(id) : null;
  if (!row || row.removed === true) throw sdk.error(404, 'Requirement not found', 'NOT_FOUND');
  await loadLead(sdk, row.lead_id);
  if (store.instanceOf(row) && str(row.label)) return row;
  // Saved before 2.0.0: migrate its lead + service group first (idempotent).
  const group = await store.findAll(sdk.models.TravelRequirement, { lead_id: str(row.lead_id), service_key: str(row.service_key) });
  await store.migrateRows(sdk, group, await readServices(sdk));
  return group.find((r) => str(r._id) === id) || row;
}

async function softRemove(sdk, row) {
  await assertLeadOpen(sdk, row.lead_id);
  await store.assertNotBooked(sdk, row._id);
  await sdk.models.TravelRequirement.updateById(row._id, { removed: true });
  await sdk.audit('deleted', `Travel requirement "${str(row.label) || str(row.service_name) || str(row.service_key)}" removed from lead ${str(row.lead_id)}`, {
    leadId: str(row.lead_id),
    requirementId: str(row._id),
    serviceKey: str(row.service_key),
    soft: true
  });
}

/* ------------------------------------------------------------------ v2 */

exports.createForLead = async (req, sdk) => {
  const { id } = await loadLead(sdk, req.params && req.params.lead_id);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const service = await writableService(sdk, id, str(body.service_key));
  return createFor(sdk, id, service, body);
};

exports.updateById = async (req, sdk) => {
  const row = await loadRequirement(sdk, req.params && req.params.id);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const service = await writableService(sdk, str(row.lead_id), str(row.service_key));
  return updateRow(sdk, row, service, body);
};

exports.removeById = async (req, sdk) => {
  const row = await loadRequirement(sdk, req.params && req.params.id);
  await softRemove(sdk, row);
  return { removed: true, id: str(row._id) };
};

/* ------------------------------------------------- old routes (instance 1) */

/** The first live instance of a service on a lead (instance 1 for data saved before 2.0.0). */
async function firstLive(sdk, leadId, serviceKey) {
  const rows = await store.findAll(sdk.models.TravelRequirement, { lead_id: leadId, service_key: serviceKey });
  await store.migrateRows(sdk, rows, await readServices(sdk));
  return store.live(rows).sort((a, b) => store.instanceOf(a) - store.instanceOf(b))[0] || null;
}

exports.saveForLead = async (req, sdk) => {
  const { id } = await loadLead(sdk, req.params && req.params.lead_id);
  const serviceKey = str(req.params && req.params.service_key);
  const service = await writableService(sdk, id, serviceKey);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const existing = await firstLive(sdk, id, serviceKey);
  return existing ? updateRow(sdk, existing, service, { values: body.values }) : createFor(sdk, id, service, { values: body.values });
};

exports.removeForLead = async (req, sdk) => {
  const { id } = await loadLead(sdk, req.params && req.params.lead_id);
  const existing = await firstLive(sdk, id, str(req.params && req.params.service_key));
  if (!existing) return { deleted: false };
  await softRemove(sdk, existing);
  return { deleted: true };
};

exports._present = present;
