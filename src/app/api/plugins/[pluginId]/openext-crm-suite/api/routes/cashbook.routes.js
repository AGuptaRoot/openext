'use strict';

const controller = require('../controllers/cashbook.controller');
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * Cash book (GST suite, CRM 3.53.0; documentation/gst-planning/02 §5). Existing finance permissions only.
 */
module.exports = function registerCashbookRoutes(app) {
  app.get('/cashbook', requirePermission('crm.finance.read'), controller.book);
  app.get('/cashbook/summary', requirePermission('crm.finance.read'), controller.summary);
  app.get('/cashbook/categories', requirePermission('crm.finance.read'), controller.categories);
  app.post('/cashbook/entry', requirePermission('crm.finance.write'), controller.addEntry);
  app.put('/cashbook/entry/:id', requirePermission('crm.finance.write'), controller.updateEntry);
  app.delete('/cashbook/entry/:id', requirePermission('crm.finance.delete'), controller.removeEntry);
  app.post('/cashbook/contra', requirePermission('crm.finance.write'), controller.contra);
};
