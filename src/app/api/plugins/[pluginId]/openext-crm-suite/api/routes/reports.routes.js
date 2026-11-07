'use strict';

const reportController = require('../controllers/report.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Reports routes — sales, conversion, projects, time, ageing, CSV export.
 */
module.exports = function registerReportsRoutes(app) {
  app.get(
    '/reports/activity-location',
    requireAnyPermission(['crm.reports.read', 'crm.leads.read']),
    reportController.activityLocation
  );

  app.get(
    '/reports/sales',
    requirePermission('crm.reports.read'),
    reportController.sales
  );

  app.get(
    '/reports/projects',
    requirePermission('crm.reports.read'),
    reportController.projects
  );

  app.get(
    '/reports/lead-conversion',
    requirePermission('crm.reports.read'),
    reportController.leadConversion
  );

  app.get(
    '/reports/invoice-ageing',
    requirePermission('crm.reports.read'),
    reportController.invoiceAgeing
  );

  app.get(
    '/reports/time',
    requirePermission('crm.reports.read'),
    reportController.timeReport
  );

  app.get(
    '/reports/income-expense',
    requirePermission('crm.reports.read'),
    reportController.incomeExpense
  );

  app.get(
    '/reports/recurring-invoices',
    requireAnyPermission('crm.reports.read', 'crm.finance.read'),
    reportController.recurringInvoices
  );

  app.get(
    '/reports/credit-notes',
    requireAnyPermission('crm.reports.read', 'crm.finance.read'),
    reportController.creditNotes
  );

  app.get(
    '/reports/payment-reconciliation',
    requireAnyPermission('crm.reports.read', 'crm.finance.read'),
    reportController.paymentReconciliation
  );

  app.get(
    '/reports/export',
    requireAnyPermission('crm.reports.export', 'crm.reports.read'),
    reportController.exportCsv
  );
};
