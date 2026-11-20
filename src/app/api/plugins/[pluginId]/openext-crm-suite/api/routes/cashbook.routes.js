'use strict';

const controller = require('../controllers/cashbook.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Cash book (GST suite, CRM 3.53.0; documentation/gst-planning/02 §5). Existing finance permissions only.
 */
module.exports = function registerCashbookRoutes(app) {
  // CRM 3.58.1: the agency's own cash — finance writers or report readers, not read-only finance users.
  app.get('/cashbook', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.book);
  app.get('/cashbook/summary', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.summary);
  app.get('/cashbook/categories', requireAnyPermission('crm.finance.write', 'crm.reports.read'), controller.categories);
  app.post('/cashbook/entry', requirePermission('crm.finance.write'), controller.addEntry);
  app.put('/cashbook/entry/:id', requirePermission('crm.finance.write'), controller.updateEntry);
  app.delete('/cashbook/entry/:id', requirePermission('crm.finance.delete'), controller.removeEntry);
  app.post('/cashbook/contra', requirePermission('crm.finance.write'), controller.contra);
};
