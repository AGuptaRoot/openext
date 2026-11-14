'use strict';

/**
 * Which leads this user may see, for the extension's own records that hang off a lead (bookings,
 * travellers, itineraries). The CRM decides (sdk.access.leadIds): a sales agent sees the leads assigned
 * to them; everyone else (and a CRM-triggered hook) sees all. Lead tabs are already protected by
 * sdk.crm.leads.findById — this covers the lists and records opened by their own id.
 */

const NONE = '000000000000000000000000';

/** null = every lead; otherwise the visible lead ids. */
async function visibleLeadIds(sdk) {
  if (!sdk.access || typeof sdk.access.leadIds !== 'function') return null;
  return sdk.access.leadIds();
}

/** A filter clause on `lead_id` for the visible leads ({} when every lead is visible). */
async function leadClause(sdk, field = 'lead_id') {
  const ids = await visibleLeadIds(sdk);
  if (ids === null) return {};
  return { [field]: { $in: ids.length ? ids : [NONE] } };
}

/** `where` narrowed to the visible leads; an existing $or / $and is kept. */
async function withVisibleLeads(sdk, where, field = 'lead_id') {
  const clause = await leadClause(sdk, field);
  if (!Object.keys(clause).length) return where;
  return { $and: [where || {}, clause] };
}

/** 404 when a record's lead is not one this user may see. */
async function assertLeadVisible(sdk, leadId, label = 'Record') {
  const ids = await visibleLeadIds(sdk);
  if (ids === null) return;
  if (!ids.includes(String(leadId || ''))) throw sdk.error(404, `${label} not found`, 'NOT_FOUND');
}

/**
 * 2.15.0: a Won (or converted) lead is read-only (CRM salesFlow.lockWonLead): its Travel Requirement,
 * travellers and their documents cannot be changed. 409 LEAD_LOCKED. A CRM without the lock check
 * (older than 3.34.0) locks nothing.
 */
async function assertLeadOpen(sdk, leadId) {
  if (!sdk.workflow || typeof sdk.workflow.leadLocked !== 'function') return;
  if (await sdk.workflow.leadLocked(String(leadId || ''))) {
    throw sdk.error(409, 'This lead is Won and locked: its travel details can be viewed but not changed.', 'LEAD_LOCKED');
  }
}

/* ------------------------------------------- 2.28.0: bookings of client trips (no lead, a client_id) */

function canReadClients(sdk) {
  try {
    return Boolean(sdk.permissions && sdk.permissions.has('crm.clients.read'));
  } catch {
    return false;
  }
}

async function portalOf(sdk) {
  if (!sdk.access || typeof sdk.access.portal !== 'function') return null;
  try {
    return await sdk.access.portal();
  } catch {
    return null;
  }
}

/**
 * `where` narrowed to the bookings this user may see: the bookings of their visible leads, plus client-trip
 * bookings (no lead) — a portal login only its own client's, staff when they may read clients.
 */
async function withVisibleBookings(sdk, where) {
  const ids = await visibleLeadIds(sdk);
  if (ids === null) return where;
  const leadPart = { lead_id: { $in: ids.length ? ids : [NONE] } };
  const portal = await portalOf(sdk);
  let clientPart = null;
  if (portal) clientPart = portal.clientId ? { client_id: String(portal.clientId) } : null;
  else if (canReadClients(sdk)) clientPart = { client_id: { $nin: ['', null] } };
  return { $and: [where || {}, clientPart ? { $or: [leadPart, clientPart] } : leadPart] };
}

/** 404 when this user may not see the booking (or a record of it): by its lead, or a client trip's client. */
async function assertBookingVisible(sdk, row, label = 'Booking') {
  const leadId = String((row && row.lead_id) || '');
  const clientId = String((row && row.client_id) || '');
  if (leadId || !clientId) return assertLeadVisible(sdk, leadId, label);
  const ids = await visibleLeadIds(sdk);
  if (ids === null) return;
  const portal = await portalOf(sdk);
  if (portal ? String(portal.clientId || '') === clientId : canReadClients(sdk)) return;
  throw sdk.error(404, `${label} not found`, 'NOT_FOUND');
}

module.exports = { visibleLeadIds, leadClause, withVisibleLeads, withVisibleBookings, assertLeadVisible, assertBookingVisible, assertLeadOpen };
