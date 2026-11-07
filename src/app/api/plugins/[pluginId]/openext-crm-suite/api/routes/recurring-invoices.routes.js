'use strict';

const recurringController = require('../controllers/recurring-invoice.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateRecurringInvoiceCreate,
  validateRecurringInvoiceUpdate
} = require('../validation/recurring-invoice.schema');

module.exports = function registerRecurringInvoiceRoutes(app) {
  app.get(
    '/recurring-invoices',
    requirePermission('crm.finance.read'),
    recurringController.list
  );

  app.get(
    '/recurring-invoices/upcoming-report',
    requirePermission('crm.finance.read'),
    recurringController.upcomingReport
  );

  app.get(
    '/recurring-invoices/:id',
    requirePermission('crm.finance.read'),
    recurringController.get
  );

  app.post(
    '/recurring-invoices',
    requirePermission('crm.finance.write'),
    validateBody(validateRecurringInvoiceCreate),
    recurringController.create
  );

  app.put(
    '/recurring-invoices/:id',
    requirePermission('crm.finance.write'),
    validateBody(validateRecurringInvoiceUpdate),
    recurringController.update
  );

  app.delete(
    '/recurring-invoices/:id',
    requirePermission('crm.finance.delete'),
    recurringController.remove
  );

  app.post(
    '/recurring-invoices/:id/toggle-status',
    requirePermission('crm.finance.write'),
    recurringController.toggleStatus
  );

  app.post(
    '/recurring-invoices/:id/run-now',
    requirePermission('crm.finance.write'),
    recurringController.runNow
  );

  app.post(
    '/recurring-invoices/run-due',
    requirePermission('crm.finance.write'),
    recurringController.runDue
  );
};
