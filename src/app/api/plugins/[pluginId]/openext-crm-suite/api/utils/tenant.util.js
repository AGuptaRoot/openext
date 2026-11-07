'use strict';

/**
 * Resolve tenant scope for every CRM query.
 *
 * Phase 1 plan requires tenantId on all records. OpenExt JWT currently
 * exposes userId/role — when platform adds tenantId to the token, it
 * will be picked up automatically. Until then we use 'default' so one
 * CRM configuration applies per CMS installation.
 */
function resolveTenantId(req) {
  if (req && typeof req.tenantId === 'string' && req.tenantId.trim()) {
    return req.tenantId.trim();
  }
  if (req?.tenant && typeof req.tenant.tenantId === 'string' && req.tenant.tenantId.trim()) {
    return req.tenant.tenantId.trim();
  }
  const user = req?.user;
  if (user && typeof user.tenantId === 'string' && user.tenantId.trim()) {
    return user.tenantId.trim();
  }
  return 'default';
}

function resolveUserId(req) {
  const u = req?.user;
  if (!u) return 'system';
  const id = u.userId || u.id || u._id;
  return id ? String(id) : 'system';
}

/**
 * Safely extracts all user role names, keys, and IDs from user object, membership, or request headers.
 */
function extractAllUserRoles(req) {
  const roles = [];
  const u = req?.user || {};

  const collect = (val) => {
    if (val === null || val === undefined) return;
    if (typeof val === 'string') {
      const s = val.toLowerCase().trim();
      if (s) roles.push(s);
    } else if (typeof val === 'number') {
      roles.push(String(val));
    } else if (Array.isArray(val)) {
      val.forEach(collect);
    } else if (typeof val === 'object') {
      if (val.id) collect(val.id);
      if (val._id) collect(val._id);
      if (val.key) collect(val.key);
      if (val.name) collect(val.name);
      if (val.role) collect(val.role);
      if (val.roleName) collect(val.roleName);
      if (val.title) collect(val.title);
      if (val.userType) collect(val.userType);
      if (val.type) collect(val.type);
    }
  };

  collect(u.role);
  collect(u.roles);
  collect(u.userType);
  collect(u.type);
  collect(u.roleName);
  collect(u.roleTitle);
  collect(u.accountType);
  collect(req?.role);
  collect(req?.roles);
  collect(req?.tenantMembership?.role);
  collect(req?.tenantMembership?.roles);
  collect(req?.tenant?.role);
  collect(req?.user?.designation);
  collect(req?.headers?.['x-user-role']);
  collect(req?.headers?.['x-role']);
  collect(req?.headers?.['x-active-role']);

  return roles;
}

/**
 * Checks if the requesting user is a client/customer portal user.
 */
function isClientUser(req) {
  if (!req?.user && !req?.tenantMembership) return false;

  // Administrative users are never client-scoped
  const { isAdmin } = require('./sales-access.util');
  if (isAdmin(req)) return false;

  // Explicit client indicator or resolved client ID from email
  if (Boolean(req.resolvedClientId || req?.user?.clientId || req?.clientId || req?.user?.companyId || req?.tenantMembership?.clientId)) {
    return true;
  }

  const allRoles = extractAllUserRoles(req);

  // Check if role string explicitly indicates a client / portal customer
  const isClientRole = allRoles.some((r) =>
    r === 'client' ||
    r === 'customer' ||
    r === 'portal' ||
    r.includes('client') ||
    r.includes('customer') ||
    r.includes('portal')
  );

  if (isClientRole) {
    return true;
  }

  if (Boolean(req?.user?.isClient || req?.user?.isCustomer || req?.isClient || req?.isCustomer)) {
    return true;
  }

  const roleStr = String(req?.user?.role || req?.tenantMembership?.role || '').toLowerCase();
  if (['client', 'customer', 'portal'].includes(roleStr)) {
    return true;
  }

  return false;
}

/**
 * Resolves the client/company ID associated with the current user synchronously.
 */
function resolveClientId(req) {
  const { isAdmin } = require('./sales-access.util');
  if (isAdmin(req)) return null;

  const u = req?.user;
  const clientId = req?.resolvedClientId || u?.clientId || req?.clientId || u?.companyId || req?.tenantMembership?.clientId;
  return clientId ? String(clientId) : null;
}

/**
 * Resolves the client/company ID associated with the current user asynchronously.
 * Auto-detects client information by matching the user's OpenNext CMS login email
 * with Client Account primary email or registered contact emails.
 */
async function resolveClientIdAsync(req) {
  const { isAdmin } = require('./sales-access.util');
  if (isAdmin(req)) return null;

  const cached = resolveClientId(req);
  if (cached) return cached;

  const email = (req?.user?.email || req?.user?.userEmail || req?.user?.username || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return null;
  }

  try {
    const ClientModel = req?.cms?.models?.get?.('Client') || req?.cms?.models?.get?.('Company') || req?.storage?.db?.models?.Company || req?.storage?.db?.models?.Client;
    if (ClientModel) {
      const tenantId = resolveTenantId(req);
      const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const emailRegex = new RegExp(`^${escaped}$`, 'i');

      const found = await ClientModel.findOne({
        tenantId,
        $or: [
          { email: emailRegex },
          { officialEmail: emailRegex },
          { primaryContactEmail: emailRegex },
          { billingEmail: emailRegex },
          { companyEmail: emailRegex },
          { 'contacts.email': emailRegex },
          { 'contactPersons.email': emailRegex },
          { 'contactPersons.contactEmail': emailRegex }
        ],
        isDeleted: { $ne: true }
      }).select('_id email name companyName').lean();

      if (found && (found._id || found.id)) {
        req.resolvedClientId = String(found._id || found.id);
        return req.resolvedClientId;
      }

      const ContactModel = req?.cms?.models?.get?.('Contact') || req?.storage?.db?.models?.Contact;
      if (ContactModel) {
        const foundContact = await ContactModel.findOne({
          tenantId,
          $or: [
            { email: emailRegex },
            { contactEmail: emailRegex }
          ],
          isDeleted: { $ne: true }
        }).select('companyId clientId').lean();

        if (foundContact && (foundContact.companyId || foundContact.clientId)) {
          req.resolvedClientId = String(foundContact.companyId || foundContact.clientId);
          return req.resolvedClientId;
        }
      }
    }
  } catch (err) {
    // Graceful fallback if database lookup encounters transient error
  }

  return null;
}

/**
 * Checks synchronously if the user is a client whose email ID is not linked to any client in the database.
 */
function isUnlinkedClientUser(req) {
  if (!isClientUser(req)) return false;
  const clientId = resolveClientId(req);
  return !clientId;
}

/**
 * Checks asynchronously if the user is a client whose email ID is not linked to any client in the database.
 */
async function isUnlinkedClientUserAsync(req) {
  if (!isClientUser(req)) return false;
  const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
  return !clientId;
}

/**
 * Applies client-scoping filter to MongoDB query if the user is a client.
 * e.g. ensures clients only see their own projects, tasks, invoices, etc.
 */
function applyClientScope(req, filter = {}, clientField = 'clientId') {
  if (isClientUser(req)) {
    const clientId = resolveClientId(req);
    filter[clientField] = clientId || '__UNLINKED_CLIENT_NO_MATCH__';
  }
  return filter;
}

/**
 * Async version of applyClientScope that guarantees email-based client resolution.
 */
async function applyClientScopeAsync(req, filter = {}, clientField = 'clientId') {
  if (isClientUser(req)) {
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    filter[clientField] = clientId || '__UNLINKED_CLIENT_NO_MATCH__';
  }
  return filter;
}

module.exports = {
  resolveTenantId,
  resolveUserId,
  isClientUser,
  isUnlinkedClientUser,
  isUnlinkedClientUserAsync,
  resolveClientId,
  resolveClientIdAsync,
  applyClientScope,
  applyClientScopeAsync
};
