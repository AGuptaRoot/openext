'use strict';

const controller = require('../controllers/customer-success.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Customer Success routes.
 * Mounted at /api/plugins/openext-crm-suite
 */
module.exports = function registerCustomerSuccessRoutes(app) {
  app.get(
    '/customer-success/summary',
    requirePermission('crm.customerSuccess.read'),
    controller.getSummary
  );

  app.get(
    '/customer-success/export',
    requireAnyPermission('crm.customerSuccess.export', 'crm.customerSuccess.read', 'crm.customerSuccess.write'),
    controller.exportCustomerSuccess
  );

  app.get(
    '/customer-success/accounts',
    requirePermission('crm.customerSuccess.read'),
    controller.listAccounts
  );

  app.get(
    '/customer-success/accounts/:clientId',
    requirePermission('crm.customerSuccess.read'),
    controller.getAccountHealth
  );
};
