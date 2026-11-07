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

module.exports = { visibleLeadIds, leadClause, withVisibleLeads, assertLeadVisible, assertLeadOpen };
