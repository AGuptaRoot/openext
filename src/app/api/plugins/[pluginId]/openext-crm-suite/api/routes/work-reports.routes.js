'use strict';

const workReportController = require('../controllers/work-report.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * Employee work reports (Tasks → Reports), for CRM managers and project managers;
 * the service checks the role and the project scope.
 * Mounted at /api/plugins/openext-crm-suite/work-reports
 */
module.exports = function registerWorkReportRoutes(app) {
  app.get('/work-reports/employees', requirePermission('crm.time.read'), workReportController.listEmployees);
  app.get(
    '/work-reports/employees/:userId/export',
    requirePermission('crm.time.read'),
    workReportController.exportEmployeeReport
  );
  app.get('/work-reports/employees/:userId', requirePermission('crm.time.read'), workReportController.getEmployeeReport);
};
