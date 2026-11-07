'use strict';

const tenantController = require('../controllers/tenant.controller.js');
const { requirePermission, requireSuperAdmin } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const { validateMemberCreate, validateMemberUpdate } = require('../validation/tenant.schema');

/**
 * Tenant Security & User Governance routes.
 * Mounted at /api/plugins/openext-crm-suite/tenant
 */
module.exports = function registerTenantRoutes(app) {
  /** Every authenticated tenant member may read their own tenant context. */
  app.get('/tenant/context', tenantController.context);
  app.get('/roles', tenantController.roles);
  app.get('/tenant/roles', tenantController.roles);
  app.get('/tenant/members/export', requirePermission('crm.users.manage'), tenantController.exportMembers);
  app.get('/tenant/members', requirePermission('crm.users.manage'), tenantController.members);
  app.get('/tenant/candidates', requirePermission('crm.users.manage'), tenantController.candidates);
  app.post(
    '/tenant/members',
    requirePermission('crm.users.manage'),
    validateBody(validateMemberCreate),
    tenantController.addMember
  );
  app.put(
    '/tenant/members/:userId',
    requirePermission('crm.users.manage'),
    validateBody(validateMemberUpdate),
    tenantController.updateMember
  );
  app.get('/tenant/role-permissions', requirePermission('crm.users.manage'), tenantController.rolePermissions);
  app.put('/tenant/role-permissions', requireSuperAdmin(), tenantController.updateRolePermissions);

  /** Custom Role creation & deletion (Super Admin Only) */
  app.post('/tenant/roles', requireSuperAdmin(), tenantController.createCustomRole);
  app.delete('/tenant/roles/:roleKey', requireSuperAdmin(), tenantController.deleteCustomRole);
};
