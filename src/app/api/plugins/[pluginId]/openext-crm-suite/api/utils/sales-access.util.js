'use strict';

const { resolveTenantId, resolveUserId } = require('./tenant.util');

function accessError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Administrative user — full access within the resolved tenant. */
function isAdmin(req) {
  if (!req?.user) return false;
  if (req.user.isAdmin || req.user.isSuperAdmin) return true;
  if (Array.isArray(req.user.roles)) {
    const lowerRoles = req.user.roles.map((r) => String(r).toLowerCase().trim().replace(/[\s_]+/g, '-'));
    if (lowerRoles.some((r) => {
      if (r === '0' || r === '1' || r === '100') return true;
      if (r.includes('super') || r.includes('owner')) return true;
      if (r === 'crm-manager' || r === 'crmmanager' || r === 'tenant-admin' || r === 'tenantadmin') return true;
      if (r.includes('admin') && !r.includes('project') && !r.includes('finance') && !r.includes('sales')) return true;
      return false;
    })) {
      return true;
    }
  }
  const perms = Array.isArray(req.permissions)
    ? req.permissions
    : (Array.isArray(req.user?.permissions) ? req.user.permissions : []);
  if (perms.includes('*') || perms.includes('crm.users.manage') || perms.includes('crm.settings.manage')) return true;
  if (typeof req.user.role === 'number' && req.user.role <= 1) return true;
  const roleStr = String(req.user.role || req.tenantMembership?.role || req.role || req.user.roleName || req.user.userType || '').toLowerCase().trim();
  if (
    roleStr === '0' ||
    roleStr === '1' ||
    roleStr.includes('admin') ||
    roleStr.includes('super') ||
    roleStr.includes('owner') ||
    roleStr.includes('crm-manager') ||
    roleStr.includes('crm manager')
  ) {
    return true;
  }
  const uid = String(req.user.userId || req.user.id || req.user._id || req.user.username || '').toLowerCase();
  if (uid.startsWith('admin') || uid.startsWith('superadmin') || uid.includes('superadmin') || uid === 'root') return true;
  return false;
}

function collectRoleTokens(req) {
  const collect = [];
  if (Array.isArray(req?.user?.roles)) collect.push(...req.user.roles);
  if (Array.isArray(req?.roles)) collect.push(...req.roles);
  if (req?.tenantMembership?.role) collect.push(req.tenantMembership.role);
  if (req?.tenantMembership?.roles) collect.push(...req.tenantMembership.roles);
  if (req?.user?.role) collect.push(req.user.role);
  if (req?.user?.roleName) collect.push(req.user.roleName);
  if (req?.user?.userType) collect.push(req.user.userType);
  if (req?.tenantRole) collect.push(req.tenantRole);
  if (req?.role) collect.push(req.role);
  return collect;
}

/** Sales Manager — can see unassigned leads and assign after creation. */
function isSalesManager(req) {
  if (isAdmin(req)) return true;
  const { normalizeTenantRoleKey } = require('./tenant-role.util');
  return collectRoleTokens(req).some((r) => normalizeTenantRoleKey(r) === 'sales-manager');
}

/** Sales Representative — may only assign records to themselves (not other users). */
function isSalesRepresentative(req) {
  if (isAdmin(req) || isSalesManager(req)) return false;
  const { normalizeTenantRoleKey } = require('./tenant-role.util');
  return collectRoleTokens(req).some((r) => normalizeTenantRoleKey(r) === 'sales-representative');
}

/** Finance Manager — works on every finance document (invoices, quotations, payments, credit notes). */
function isFinanceManager(req) {
  if (isAdmin(req)) return true;
  const { normalizeTenantRoleKey } = require('./tenant-role.util');
  return collectRoleTokens(req).some((r) => normalizeTenantRoleKey(r) === 'finance-manager');
}

/**
 * Sales Representative rule: assignee must be the current user (or empty when allowEmpty).
 * @returns {string} normalized assignee id (forced to self when empty and forceSelf)
 */
function resolveSelfOnlyAssignee(req, assigneeId, options = {}) {
  const {
    fieldLabel = 'Assignee',
    allowEmpty = true,
    forceSelf = false
  } = options;
  const userId = String(resolveUserId(req) || '').trim();
  const raw = assigneeId === undefined || assigneeId === null ? '' : String(assigneeId).trim();

  if (!isSalesRepresentative(req)) {
    return raw;
  }

  if (!raw) {
    if (forceSelf && userId) return userId;
    if (allowEmpty) return '';
    throw accessError(`${fieldLabel} is required`, 400);
  }

  if (raw !== userId) {
    throw accessError(
      `Sales representatives can only assign ${fieldLabel.toLowerCase()} to themselves`,
      403
    );
  }
  return raw;
}

function getPermissions(req) {
  return Array.isArray(req?.permissions) ? req.permissions : [];
}

function hasPermission(req, permission) {
  if (isAdmin(req)) return true;
  return getPermissions(req).includes(permission);
}

/**
 * Sales Agent scope: non-admin / non-sales-manager staff only see leads assigned to them.
 * Unassigned leads are visible only to admins and sales managers.
 */
function isSalesAgentScoped(req) {
  if (!req?.user) return false;
  // A CRM-triggered extension hook (runtime callActiveRoute { system: true }) acts for the workspace.
  if (req.crmSystemHook === true) return false;
  if (isAdmin(req) || isSalesManager(req)) return false;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return false;
  return true;
}

/**
 * Who may move a lead along the pipeline by hand.
 *
 * A sales representative works the lead but does not decide when it advances —
 * that call belongs to a manager, so the stage reflects a reviewed position
 * rather than one rep's optimism. Automatic moves (a quotation being accepted,
 * conversion to a client) are not "by hand" and stay allowed for everyone;
 * those callers pass `{ system: true }`.
 */
function canChangeLeadStage(req) {
  if (isAdmin(req)) return true;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return false;
  return !isSalesAgentScoped(req);
}

function assertLeadStageChangeAllowed(req) {
  if (canChangeLeadStage(req)) return;
  throw accessError(
    'Only a CRM manager or sales manager can change the lead stage. Ask your manager to move this lead.',
    403
  );
}

/** The same rule for a deal: a rep works it, a manager decides it has moved. */
function canChangeOpportunityStage(req) {
  return canChangeLeadStage(req);
}

function assertOpportunityStageChangeAllowed(req) {
  if (canChangeOpportunityStage(req)) return;
  throw accessError(
    'Only a CRM manager or sales manager can change the opportunity stage. Ask your manager to move this deal.',
    403
  );
}

/** Lead is accessible only when assigned to the user or created by the user. */
function userOwnsLead(req, lead) {
  const userId = resolveUserId(req);
  const assignedTo = String(lead?.assignedTo || '').trim();

  if (assignedTo && assignedTo === userId) return true;
  if (String(lead?.createdBy || '') === userId) return true;

  return false;
}

function assertLeadWriteAccess(req, lead) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) {
    throw accessError('Clients cannot modify leads', 403);
  }
  if (!isSalesAgentScoped(req)) return;
  if (userOwnsLead(req, lead)) return;

  throw accessError('You can only modify leads assigned to you', 403);
}

/** Hide other agents' leads from list/detail (404 avoids leaking record existence). */
function assertLeadReadAccess(req, lead) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) {
    throw accessError('Lead not found', 404);
  }
  if (!isSalesAgentScoped(req)) return;
  if (userOwnsLead(req, lead)) return;

  throw accessError('Lead not found', 404);
}

/** MongoDB scope: leads visible to a Sales Agent — assigned only (unassigned hidden). */
function salesAgentLeadScope(req) {
  const userId = resolveUserId(req);
  const candidates = [userId];
  try {
    const mongoose = require('mongoose');
    if (mongoose?.Types?.ObjectId?.isValid(userId)) {
      candidates.push(new mongoose.Types.ObjectId(userId));
    }
  } catch {}
  return {
    assignedTo: { $in: candidates }
  };
}

/**
 * Merge an access scope into a list filter (handles existing $or search clauses).
 */
function mergeScopeIntoFilter(filter, scopeClause) {
  const next = { ...filter };

  if (next.$and) {
    next.$and = [...next.$and, scopeClause];
    return next;
  }

  if (next.$or) {
    next.$and = [{ $or: next.$or }, scopeClause];
    delete next.$or;
    return next;
  }

  return { ...next, ...scopeClause };
}

function applySalesAgentLeadListScope(req, filter) {
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) {
    return { ...filter, _id: '__UNLINKED_CLIENT_NO_MATCH__' };
  }
  if (!isSalesAgentScoped(req)) return filter;
  return mergeScopeIntoFilter(filter, salesAgentLeadScope(req));
}

/**
 * MongoDB scope: clients visible to a Sales Agent.
 * @param {Function} getLeadModel — `(req) => LeadModel` from the calling service
 */
async function buildSalesAgentClientListScope(req, getLeadModel) {
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const Lead = getLeadModel(req);

  const ownedLeadIds = Lead
    ? (
        await Lead.find({
          tenantId,
          isDeleted: false,
          ...salesAgentLeadScope(req)
        })
          .select('_id')
          .lean()
      ).map((lead) => String(lead._id))
    : [];

  const scope = {
    $or: [{ createdBy: userId }]
  };

  if (ownedLeadIds.length) {
    scope.$or.push({ leadId: { $in: ownedLeadIds } });
  }

  return scope;
}

async function applySalesAgentClientListScope(req, filter, getLeadModel) {
  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('./tenant.util');
  if (isClientUser(req)) {
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!clientId) {
      return { ...filter, _id: '__UNLINKED_CLIENT_NO_MATCH__' };
    }
    return { ...filter, _id: clientId };
  }
  if (!isSalesAgentScoped(req)) return filter;
  const scope = await buildSalesAgentClientListScope(req, getLeadModel);
  return mergeScopeIntoFilter(filter, scope);
}

/**
 * Client is owned when created by the user or converted from a lead they own.
 * @param {Function} getLeadModel — `(req) => LeadModel` from the calling service
 */
async function userOwnsClient(req, company, getLeadModel) {
  const userId = resolveUserId(req);

  if (String(company?.createdBy || '') === userId) return true;

  const leadId = String(company?.leadId || '').trim();
  if (!leadId || leadId === 'null') return false;

  const Lead = getLeadModel(req);
  if (!Lead) return false;

  const lead = await Lead.findOne({
    tenantId: resolveTenantId(req),
    isDeleted: false,
    _id: leadId
  })
    .select('assignedTo createdBy')
    .lean();

  if (!lead) return false;

  return userOwnsLead(req, lead);
}

/**
 * Sales Manager and above may edit any client; Sales Agent only own records.
 * @param {Function} getLeadModel — `(req) => LeadModel` from the calling service
 */
async function assertClientWriteAccess(req, company, getLeadModel) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) {
    throw accessError('Clients cannot modify client accounts', 403);
  }
  if (!isSalesAgentScoped(req)) return;

  const owns = await userOwnsClient(req, company, getLeadModel);
  if (!owns) {
    throw accessError(
      'You can only modify clients you created or converted from your leads',
      403
    );
  }
}

/** Hide other agents' clients from detail/tabs (404 avoids leaking record existence). */
async function assertClientReadAccess(req, company, getLeadModel) {
  if (isAdmin(req)) return;
  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('./tenant.util');
  if (isClientUser(req)) {
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (clientId && String(company._id || company.id) === String(clientId)) return;
    throw accessError('Client not found', 404);
  }
  if (!isSalesAgentScoped(req)) return;

  const owns = await userOwnsClient(req, company, getLeadModel);
  if (!owns) {
    throw accessError('Client not found', 404);
  }
}

/**
 * Scopes queries to records created by the current non-admin internal user (custom role / freelancer / employee).
 */
function salesAgentCreatorScope(req) {
  const userId = resolveUserId(req);
  return { createdBy: userId };
}

/**
 * Finance documents a staff member sees only when they created them: sales reps and other scoped staff.
 * Finance managers (and admins, sales managers) see them all.
 */
function isFinanceCreatorScoped(req) {
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return false;
  if (!isSalesAgentScoped(req)) return false;
  return !isFinanceManager(req);
}

function applySalesAgentCreatorScope(req, filter) {
  if (!isFinanceCreatorScoped(req)) return filter;
  return mergeScopeIntoFilter(filter, salesAgentCreatorScope(req));
}

function assertSalesAgentCreatorAccess(req, doc, recordName = 'Record') {
  if (!isFinanceCreatorScoped(req)) return;
  const userId = resolveUserId(req);
  if (String(doc?.createdBy || '') !== userId) {
    throw accessError(`${recordName} not found`, 404);
  }
}

function salesAgentTicketScope(req) {
  const userId = resolveUserId(req);
  return {
    $or: [
      { createdBy: userId },
      { assignedTo: userId }
    ]
  };
}

function applySalesAgentTicketScope(req, filter) {
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return filter;
  if (!isSalesAgentScoped(req)) return filter;
  return mergeScopeIntoFilter(filter, salesAgentTicketScope(req));
}

function assertSalesAgentTicketAccess(req, ticket) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return;
  if (!isSalesAgentScoped(req)) return;
  const userId = resolveUserId(req);
  if (String(ticket?.createdBy || '') === userId || String(ticket?.assignedTo || '') === userId) {
    return;
  }
  throw accessError('Ticket not found', 404);
}

function salesAgentSalesOrderScope(req) {
  const userId = resolveUserId(req);
  return {
    $or: [
      { createdBy: userId },
      { assignedTo: userId }
    ]
  };
}

function applySalesAgentSalesOrderScope(req, filter) {
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return filter;
  if (!isSalesAgentScoped(req)) return filter;
  return mergeScopeIntoFilter(filter, salesAgentSalesOrderScope(req));
}

function assertSalesAgentSalesOrderAccess(req, salesOrder) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return;
  if (!isSalesAgentScoped(req)) return;
  const userId = resolveUserId(req);
  if (String(salesOrder?.createdBy || '') === userId || String(salesOrder?.assignedTo || '') === userId) {
    return;
  }
  throw accessError('Sales Order not found', 404);
}

function salesAgentSampleScope(req) {
  const userId = resolveUserId(req);
  return {
    $or: [
      { createdBy: userId },
      { assignedTo: userId },
      { requestedBy: userId }
    ]
  };
}

function applySalesAgentSampleScope(req, filter) {
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return filter;
  if (!isSalesAgentScoped(req)) return filter;
  return mergeScopeIntoFilter(filter, salesAgentSampleScope(req));
}

function assertSalesAgentSampleAccess(req, sample) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return;
  if (!isSalesAgentScoped(req)) return;
  const userId = resolveUserId(req);
  if (
    String(sample?.createdBy || '') === userId ||
    String(sample?.assignedTo || '') === userId ||
    String(sample?.requestedBy || '') === userId
  ) {
    return;
  }
  throw accessError('Sample request not found', 404);
}

function salesAgentOpportunityScope(req) {
  const userId = resolveUserId(req);
  return {
    $or: [
      { createdBy: userId },
      { salesOwner: userId }
    ]
  };
}

function applySalesAgentOpportunityScope(req, filter) {
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return filter;
  if (!isSalesAgentScoped(req)) return filter;
  return mergeScopeIntoFilter(filter, salesAgentOpportunityScope(req));
}

/**
 * MongoDB scope: opportunities visible to a Sales Agent.
 *
 * Wider than `salesAgentOpportunityScope` by one rule — a deal attached to a
 * lead the agent owns is theirs to see even when a manager created it.
 * Otherwise a rep could not see the opportunities raised on their own lead.
 *
 * @param {Function} getLeadModel — `(req) => LeadModel` from the calling service
 */
async function buildSalesAgentOpportunityListScope(req, getLeadModel) {
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const Lead = typeof getLeadModel === 'function' ? getLeadModel(req) : null;

  const ownedLeadIds = Lead
    ? (
        await Lead.find({
          tenantId,
          isDeleted: false,
          ...salesAgentLeadScope(req)
        })
          .select('_id')
          .lean()
      ).map((lead) => String(lead._id))
    : [];

  const scope = {
    $or: [{ createdBy: userId }, { salesOwner: userId }]
  };

  if (ownedLeadIds.length) {
    scope.$or.push({ leadId: { $in: ownedLeadIds } });
  }

  return scope;
}

async function applySalesAgentOpportunityListScope(req, filter, getLeadModel) {
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return filter;
  if (!isSalesAgentScoped(req)) return filter;
  const scope = await buildSalesAgentOpportunityListScope(req, getLeadModel);
  return mergeScopeIntoFilter(filter, scope);
}

/**
 * Opportunity is accessible when the agent created it, owns it, or owns the
 * lead it hangs off. `getLeadModel` is optional — without it the lead-ownership
 * route is skipped and only the direct ownership rules apply.
 */
async function assertSalesAgentOpportunityAccessAsync(req, opportunity, getLeadModel) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return;
  if (!isSalesAgentScoped(req)) return;

  const userId = resolveUserId(req);
  if (
    String(opportunity?.createdBy || '') === userId ||
    String(opportunity?.salesOwner || '') === userId
  ) {
    return;
  }

  const leadId = String(opportunity?.leadId || '').trim();
  const Lead = typeof getLeadModel === 'function' ? getLeadModel(req) : null;
  if (leadId && leadId !== 'null' && Lead) {
    const lead = await Lead.findOne({
      tenantId: resolveTenantId(req),
      _id: leadId,
      isDeleted: false
    })
      .select('assignedTo createdBy')
      .lean();
    if (lead && userOwnsLead(req, lead)) return;
  }

  throw accessError('Opportunity not found', 404);
}

function assertSalesAgentOpportunityAccess(req, opportunity) {
  if (isAdmin(req)) return;
  const { isClientUser } = require('./tenant.util');
  if (isClientUser(req)) return;
  if (!isSalesAgentScoped(req)) return;
  const userId = resolveUserId(req);
  if (
    String(opportunity?.createdBy || '') === userId ||
    String(opportunity?.salesOwner || '') === userId
  ) {
    return;
  }
  throw accessError('Opportunity not found', 404);
}

module.exports = {
  accessError,
  isAdmin,
  isSalesManager,
  isFinanceManager,
  isFinanceCreatorScoped,
  salesAgentLeadScope,
  isSalesRepresentative,
  resolveSelfOnlyAssignee,
  getPermissions,
  hasPermission,
  isSalesAgentScoped,
  // Composes a scope clause without dropping an existing $or.
  mergeScopeIntoFilter,
  canChangeLeadStage,
  assertLeadStageChangeAllowed,
  canChangeOpportunityStage,
  assertOpportunityStageChangeAllowed,
  userOwnsLead,
  userOwnsClient,
  assertLeadWriteAccess,
  assertLeadReadAccess,
  applySalesAgentLeadListScope,
  applySalesAgentClientListScope,
  buildSalesAgentOpportunityListScope,
  applySalesAgentOpportunityListScope,
  assertSalesAgentOpportunityAccessAsync,
  assertClientWriteAccess,
  assertClientReadAccess,
  applySalesAgentCreatorScope,
  assertSalesAgentCreatorAccess,
  applySalesAgentTicketScope,
  assertSalesAgentTicketAccess,
  applySalesAgentSalesOrderScope,
  assertSalesAgentSalesOrderAccess,
  applySalesAgentSampleScope,
  assertSalesAgentSampleAccess,
  applySalesAgentOpportunityScope,
  assertSalesAgentOpportunityAccess
};
