'use strict';

const controller = require('../controllers/gst-reports.controller');
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * GST reports (GST suite, Step 5; documentation/gst-planning/03 §6): GSTR-1 (summary, portal JSON, CSV per
 * table), Table 11A / 11B, credit notes and the TCS register. All read-only; they show money, so they use
 * the existing finance read permission (no new role). Auto-loaded from api/routes like the other routes.
 */
module.exports = function registerGstReportRoutes(app) {
  app.get('/gst/reports/gstr1', requirePermission('crm.finance.read'), controller.gstr1);
  app.get('/gst/reports/gstr1/export', requirePermission('crm.finance.read'), controller.gstr1Export);
  app.get('/gst/reports/advances', requirePermission('crm.finance.read'), controller.advances);
  app.get('/gst/reports/credit-notes', requirePermission('crm.finance.read'), controller.creditNotes);
  app.get('/gst/reports/tcs', requirePermission('crm.finance.read'), controller.tcs);
};
