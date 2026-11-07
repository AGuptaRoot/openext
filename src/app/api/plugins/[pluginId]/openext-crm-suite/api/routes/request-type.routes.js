'use strict';

const controller = require('../controllers/request-type.controller');
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * Dynamic Request Type builder routes.
 * Settings → Qualification Match (admin manage)
 * Leads need enabled list for Commercial Requirement selector.
 */
module.exports = function registerRequestTypeRoutes(app) {
  app.get(
    '/request-types',
    requirePermission('crm.leads.read'),
    controller.list
  );

  app.get(
    '/request-types/:id',
    requirePermission('crm.leads.read'),
    controller.getById
  );

  app.post(
    '/request-types',
    requirePermission('crm.settings.manage'),
    controller.create
  );

  app.put(
    '/request-types/:id',
    requirePermission('crm.settings.manage'),
    controller.update
  );

  app.delete(
    '/request-types/:id',
    requirePermission('crm.settings.manage'),
    controller.remove
  );

  /** Promote a lead-specific option into the global Request Type field catalog. */
  app.post(
    '/request-types/:id/fields/:fieldKey/options',
    requirePermission('crm.settings.manage'),
    controller.addFieldOption
  );
};
