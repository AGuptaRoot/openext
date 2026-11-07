'use strict';

/**
 * Permission middleware factory.
 *
 * OpenExt already enforces login (401 if not authenticated).
 * This helper adds per-route permission checks using manifest permissions.
 *
 * Usage in a route file:
 *   app.get('/leads', requirePermission('crm.leads.read'), controller.list);
 *
 * Tenant permissions are authoritative. Platform roles never bypass the
 * tenant membership and permission matrix.
 */
const CLIENT_PORTAL_PERMISSIONS = new Set([
  'crm.dashboard.view',
  'crm.projects.read',
  'crm.tasks.read',
  'crm.time.read',
  'crm.expenses.read',
  'crm.finance.read',
  'crm.contracts.read',
  'crm.samples.read',
  'crm.samples.feedback',
  'crm.tickets.read',
  'crm.tickets.write',
  'crm.customerSuccess.read',
  'crm.customerSuccess.manage',
  'crm.orders.read',
  'crm.orders.return',
  'crm.samples.request',
  'crm.opportunities.read'
]);

function requirePermission(permission) {
  return async (req, res) => {
    if (isSuperAdminUser(req)) {
      return;
    }

    const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
    const clientId = req.resolvedClientId || resolveClientId(req) || (await resolveClientIdAsync(req));

    if (isClientUser(req) || clientId) {
      if (CLIENT_PORTAL_PERMISSIONS.has(permission)) {
        return;
      }
    }

    let permissions = Array.isArray(req.permissions)
      ? req.permissions
      : (Array.isArray(req.user?.permissions) ? req.user.permissions : []);

    if (!permissions.includes(permission) && !permissions.includes('*') && req.user) {
      try {
        const TenantService = require('../services/tenant.service');
        req.permissions = await TenantService.resolvePermissionsForMembership(req);
        permissions = Array.isArray(req.permissions) ? req.permissions : permissions;
      } catch {}
    }

    if (permissions.includes(permission) || permissions.includes('*')) {
      // Do not send a response — let the next route handler run.
      return;
    }

    res.status(403).json({
      success: false,
      error: 'Permission denied',
      details: [`Missing permission: ${permission}`]
    });
  };
}

/**
 * Optional helper: block write methods unless user has at least one write permission.
 * Not wired globally yet — routes will use requirePermission() explicitly.
 */
function requireAnyPermission(...permissionList) {
  const flatList = permissionList.flat(Infinity);
  return async (req, res) => {
    if (isSuperAdminUser(req)) {
      return;
    }

    const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
    const clientId = req.resolvedClientId || resolveClientId(req) || (await resolveClientIdAsync(req));

    if (isClientUser(req) || clientId) {
      if (flatList.some((p) => CLIENT_PORTAL_PERMISSIONS.has(p))) {
        return;
      }
    }

    let permissions = Array.isArray(req.permissions)
      ? req.permissions
      : (Array.isArray(req.user?.permissions) ? req.user.permissions : []);

    if (!flatList.some((p) => permissions.includes(p)) && !permissions.includes('*') && req.user) {
      try {
        const TenantService = require('../services/tenant.service');
        req.permissions = await TenantService.resolvePermissionsForMembership(req);
        permissions = Array.isArray(req.permissions) ? req.permissions : permissions;
      } catch {}
    }

    if (permissions.includes('*') || flatList.some((p) => permissions.includes(p))) {
      return;
    }

    res.status(403).json({
      success: false,
      error: 'Permission denied',
      details: [`Requires one of: ${flatList.join(', ')}`]
    });
  };
}

/**
 * Helper to determine if the requesting user has Super Admin / Admin governance privileges.
 */
function isSuperAdminUser(req) {
  if (typeof req?.user?.role === 'number' && req.user.role <= 1) {
    return true;
  }
  const r = String(req?.user?.role || req?.tenantMembership?.role || req?.role || '').toLowerCase();
  if (['superadmin', 'admin', 'tenant_admin', 'owner', '1', '0'].includes(r)) {
    return true;
  }
  if (Boolean(req?.isAdmin || req?.user?.isAdmin || req?.user?.isSuperAdmin)) {
    return true;
  }
  const perms = Array.isArray(req?.permissions)
    ? req.permissions
    : (Array.isArray(req?.user?.permissions) ? req.user.permissions : []);
  if (perms.includes('crm.users.manage') || perms.includes('crm.settings.manage') || perms.includes('users.manage') || perms.includes('settings.manage') || perms.includes('*')) {
    return true;
  }
  return false;
}

/**
 * Require Super Admin privilege middleware.
 * Restricts custom role creation, role deletion, and security governance to Super Admins.
 */
function requireSuperAdmin() {
  return async (req, res) => {
    if (isSuperAdminUser(req)) {
      return;
    }

    res.status(403).json({
      success: false,
      error: 'Permission denied',
      details: ['Creating or modifying custom roles is restricted to Super Admins only.']
    });
  };
}

module.exports = {
  // Exported so tests can assert what a portal user is allowed to reach.
  CLIENT_PORTAL_PERMISSIONS,
  requirePermission,
  requireAnyPermission,
  requireSuperAdmin,
  isSuperAdminUser
};
