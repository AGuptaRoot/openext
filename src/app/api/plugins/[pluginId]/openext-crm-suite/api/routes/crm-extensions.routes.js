'use strict';

const controller = require('../controllers/crm-extension.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * CRM-owned extension registry (Settings → Extensions).
 *
 * Separate from the CMS extension packages under /extensions: these are the
 * workspace modes (Product Sales, Project Delivery, uploaded packages) that
 * fix the lead Request Type, the opportunity pipeline and the visible core
 * modules.
 *
 *   GET    /crm-extensions            registry + active flag          (admin)
 *   GET    /crm-extensions/active     active extension payload        (any CRM user)
 *   POST   /crm-extensions/validate   check an uploaded zip           (admin)
 *   POST   /crm-extensions/install    validate + store an uploaded zip (admin)
 *   POST   /crm-extensions/:id/enable                                 (admin)
 *   POST   /crm-extensions/:id/disable                                (admin)
 *   DELETE /crm-extensions/:id        uninstall an uploaded package   (admin)
 */
module.exports = function registerCrmExtensionRoutes(app) {
  app.get(
    '/crm-extensions/active',
    requireAnyPermission(
      'crm.dashboard.view',
      'crm.leads.read',
      'crm.opportunities.read',
      'crm.finance.read',
      'crm.tickets.read',
      'crm.projects.read'
    ),
    controller.getActive
  );

  app.get('/crm-extensions', requirePermission('crm.settings.manage'), controller.list);

  app.post(
    '/crm-extensions/validate',
    requirePermission('crm.settings.manage'),
    controller.validatePackage
  );

  app.post(
    '/crm-extensions/install',
    requirePermission('crm.settings.manage'),
    controller.installPackage
  );

  app.post(
    '/crm-extensions/:id/enable',
    requirePermission('crm.settings.manage'),
    controller.enable
  );

  app.post(
    '/crm-extensions/:id/disable',
    requirePermission('crm.settings.manage'),
    controller.disable
  );

  app.post(
    '/crm-extensions/:id/approve-backend',
    requirePermission('crm.settings.manage'),
    controller.approveBackend
  );

  app.post(
    '/crm-extensions/:id/revoke-backend',
    requirePermission('crm.settings.manage'),
    controller.revokeBackend
  );

  app.delete('/crm-extensions/:id', requirePermission('crm.settings.manage'), controller.uninstall);
};
