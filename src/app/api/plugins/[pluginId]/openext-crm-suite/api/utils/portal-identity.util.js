'use strict';

/**
 * Who a portal login is, resolved from the email they signed in with.
 *
 * The CMS only knows "this person has the client role". The CRM decides what
 * that means, in this order:
 *
 *   1. client — their email matches a Client record. Always wins, so a lead
 *      that has been converted automatically falls back to the ordinary client
 *      portal rules with no extra code.
 *   2. lead   — their email matches a Lead (or a portal invitation sent for
 *      one) AND that lead has an opportunity flagged `isPortal: true`. They see
 *      that lead's records only.
 *   3. none   — a client-role login we cannot tie to anything. Every list comes
 *      back empty with a reason, rather than falling through unscoped.
 *
 * The result is cached on the request: a single page load asks several services.
 */

const { isClientUser, resolveClientId, resolveClientIdAsync, resolveTenantId } = require('./tenant.util');

const CACHE_KEY = '__crmPortalIdentity';

/** Shown when a portal login matches neither a client nor a portal-enabled lead. */
const PORTAL_UNLINKED_MESSAGE = 'Client email ID not found in CRM records';

function loginEmail(req) {
  return String(req?.user?.email || req?.user?.userEmail || req?.user?.username || '')
    .trim()
    .toLowerCase();
}

function emailRegex(email) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Leads whose own email is the login, or who were sent a portal invitation for it. */
async function findLeadIdsForEmail(req, email) {
  const tenantId = resolveTenantId(req);
  const ids = new Set();

  try {
    const Lead = req.cms?.models.get('Lead');
    if (Lead && typeof Lead.find === 'function') {
      const query = Lead.find({ tenantId, isDeleted: false, email: emailRegex(email) }).select(
        '_id email isDeleted'
      );
      const leads = typeof query?.lean === 'function' ? await query.lean() : await query;
      for (const lead of leads || []) {
        // Re-checked here rather than trusted: an identity must never widen
        // because a data layer returned more than it was asked for.
        if (lead?.isDeleted) continue;
        if (String(lead?.email || '').trim().toLowerCase() !== email) continue;
        ids.add(String(lead._id));
      }
    }
  } catch {
    // fall through to the invitation lookup
  }

  try {
    const Access = req.cms?.models.get('ClientPortalAccess');
    if (Access && typeof Access.find === 'function') {
      const query = Access.find({
        tenantId,
        isDeleted: false,
        email,
        leadId: { $nin: ['', null] }
      }).select('leadId status email isDeleted');
      const rows = typeof query?.lean === 'function' ? await query.lean() : await query;
      for (const row of rows || []) {
        if (row?.isDeleted) continue;
        if (String(row?.email || '').trim().toLowerCase() !== email) continue;
        // A suspended or deactivated invitation is not an identity.
        if (row.status === 'Suspended' || row.status === 'Deactivated') continue;
        if (row.leadId) ids.add(String(row.leadId));
      }
    }
  } catch {
    // an invitation lookup failure must not grant access
  }

  return [...ids];
}

/**
 * Leads that belong to a client login: converted into (or linked to) that client, or carrying the
 * login's own email (the client's new enquiry, not converted until a quotation is accepted).
 * Re-checked after the query so a data layer can never widen it.
 */
async function findClientLeadIds(req, clientId, email) {
  const clauses = [];
  if (clientId) clauses.push({ convertedClientId: String(clientId) });
  if (email && email.includes('@')) clauses.push({ email: emailRegex(email) });
  if (!clauses.length) return [];
  try {
    const Lead = req.cms?.models.get('Lead');
    if (!Lead || typeof Lead.find !== 'function') return [];
    const query = Lead.find({ tenantId: resolveTenantId(req), isDeleted: false, $or: clauses }).select(
      '_id email convertedClientId isDeleted'
    );
    const leads = typeof query?.lean === 'function' ? await query.lean() : await query;
    return (leads || [])
      .filter((lead) => !lead?.isDeleted)
      .filter(
        (lead) =>
          (clientId && String(lead?.convertedClientId || '') === String(clientId)) ||
          (email && String(lead?.email || '').trim().toLowerCase() === email)
      )
      .map((lead) => String(lead._id));
  } catch {
    // A lookup failure leaves the client with their client-linked records only.
    return [];
  }
}

/** The lead's deals that have been opened to the portal. */
async function findPortalOpportunityIds(req, leadIds) {
  if (!leadIds.length) return [];
  try {
    const Opportunity = req.cms?.models.get('Opportunity');
    if (!Opportunity || typeof Opportunity.find !== 'function') return [];
    const query = Opportunity.find({
      tenantId: resolveTenantId(req),
      isDeleted: false,
      leadId: { $in: leadIds },
      isPortal: true
    }).select('_id leadId isPortal isDeleted');
    const deals = typeof query?.lean === 'function' ? await query.lean() : await query;
    return (deals || [])
      // isPortal and the lead link are re-checked for the same reason: the
      // flag is the whole permission, so it is never assumed.
      .filter((deal) => deal?.isPortal === true && !deal?.isDeleted)
      .filter((deal) => leadIds.includes(String(deal.leadId || '')))
      .map((deal) => ({ id: String(deal._id), leadId: String(deal.leadId || '') }));
  } catch {
    return [];
  }
}

/**
 * Resolve the portal identity for this request.
 *
 * `kind: 'staff'` means this is not a portal login at all, so callers should
 * apply their normal staff scoping.
 */
async function resolvePortalIdentity(req) {
  if (!req) return { kind: 'none' };
  if (req[CACHE_KEY]) return req[CACHE_KEY];

  const identity = await (async () => {
    if (!isClientUser(req)) return { kind: 'staff' };

    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    const email = loginEmail(req);
    if (clientId) {
      return { kind: 'client', clientId: String(clientId), leadIds: await findClientLeadIds(req, clientId, email) };
    }

    if (!email.includes('@')) return { kind: 'none' };

    const leadIds = await findLeadIdsForEmail(req, email);
    if (!leadIds.length) return { kind: 'none' };

    const deals = await findPortalOpportunityIds(req, leadIds);
    if (!deals.length) return { kind: 'none' };

    // Only the leads that actually have a portal-enabled deal.
    const enabledLeadIds = [...new Set(deals.map((deal) => deal.leadId).filter(Boolean))];
    return {
      kind: 'lead',
      leadIds: enabledLeadIds.length ? enabledLeadIds : leadIds,
      leadId: (enabledLeadIds.length ? enabledLeadIds : leadIds)[0],
      opportunityIds: deals.map((deal) => deal.id)
    };
  })();

  req[CACHE_KEY] = identity;
  return identity;
}

/**
 * Filter clause restricting a list to what this portal login may see.
 *
 * Returns null for a staff request (no portal scoping) and `false` for an
 * identity we could not resolve, which callers turn into an empty result.
 */
function portalScopeFilter(identity, options = {}) {
  const clientField = options.clientField || 'clientId';
  const leadField = options.leadField || 'leadId';

  if (!identity || identity.kind === 'staff') return null;
  if (identity.kind === 'client') return { [clientField]: identity.clientId };
  if (identity.kind === 'lead') {
    return identity.leadIds.length === 1
      ? { [leadField]: identity.leadIds[0] }
      : { [leadField]: { $in: identity.leadIds } };
  }
  return false;
}

/**
 * The full portal scope as one clause — the client's own records plus those still on their leads.
 * May hold `$or`, so callers merge it LAST (sales-access mergeScopeIntoFilter): a later `filter.$or`
 * (e.g. search) must never replace it. null for staff, false for an unresolved login.
 */
function portalScopeClause(identity) {
  if (!identity || identity.kind === 'staff') return null;
  if (identity.kind === 'client') {
    const leadIds = Array.isArray(identity.leadIds) ? identity.leadIds : [];
    return leadIds.length
      ? { $or: [{ clientId: identity.clientId }, { leadId: { $in: leadIds } }] }
      : { clientId: identity.clientId };
  }
  return portalScopeFilter(identity);
}

/** True when this record belongs to the portal login. */
function portalOwnsRecord(identity, record) {
  if (!identity || !record) return false;
  if (identity.kind === 'staff') return true;
  if (identity.kind === 'client') {
    if (String(record.clientId || '') === identity.clientId) return true;
    const leadId = String(record.leadId || '');
    return Boolean(leadId) && Array.isArray(identity.leadIds) && identity.leadIds.includes(leadId);
  }
  if (identity.kind === 'lead') {
    return identity.leadIds.includes(String(record.leadId || ''));
  }
  return false;
}

module.exports = {
  PORTAL_UNLINKED_MESSAGE,
  resolvePortalIdentity,
  portalScopeFilter,
  portalScopeClause,
  portalOwnsRecord
};
