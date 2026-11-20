'use strict';

const controller = require('../controllers/gst-reports.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * GST reports (GST suite, Step 5; documentation/gst-planning/03 §6): GSTR-1 (summary, portal JSON, CSV per
 * table), Table 11A / 11B, credit notes and the TCS register. All read-only; they show money, so they use
 * the existing finance read permission (no new role). Auto-loaded from api/routes like the other routes.
 */
module.exports = function registerGstReportRoutes(app) {
  // CRM 3.58.1: tenant-wide GST returns (the TCS register holds full client PANs) — finance writers or
  // report readers only, not read-only finance users.
  app.get('/gst/reports/gstr1', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.gstr1);
  app.get('/gst/reports/gstr1/export', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.gstr1Export);
  app.get('/gst/reports/advances', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.advances);
  app.get('/gst/reports/credit-notes', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.creditNotes);
  app.get('/gst/reports/tcs', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.tcs);
};
