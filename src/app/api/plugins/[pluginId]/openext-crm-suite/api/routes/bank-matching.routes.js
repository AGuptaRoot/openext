'use strict';

const controller = require('../controllers/bank-matching.controller');
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * Razorpay fees and bank statement matching (GST suite, CRM 3.53.0; documentation/gst-planning/04).
 * Existing finance permissions only (no new role).
 */
module.exports = function registerBankMatchingRoutes(app) {
  app.post('/reconciliation/statements', requirePermission('crm.finance.write'), controller.importStatement);
  app.get('/reconciliation/lines', requirePermission('crm.finance.read'), controller.lines);
  app.get('/reconciliation/pick', requirePermission('crm.finance.read'), controller.pick);
  app.post('/reconciliation/match', requirePermission('crm.finance.write'), controller.match);
  app.post('/reconciliation/unmatch', requirePermission('crm.finance.write'), controller.unmatch);
  app.post('/reconciliation/ignore', requirePermission('crm.finance.write'), controller.ignore);
  app.get('/reconciliation/gateway-fees', requirePermission('crm.finance.read'), controller.gatewayFees);
  app.post('/reconciliation/gateway-fees/refresh', requirePermission('crm.finance.write'), controller.refreshGatewayFees);
};
