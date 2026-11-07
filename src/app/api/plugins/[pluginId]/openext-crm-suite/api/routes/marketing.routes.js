const path = require('path');
let marketingController;
try {
  marketingController = require('../controllers/marketing.controller.js');
} catch (e) {
  marketingController = require(path.resolve(__dirname, '../controllers/marketing.controller.js'));
}
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Marketing Automation routes.
 * Mounted at /api/plugins/openext-crm-suite/marketing
 */
module.exports = function registerMarketingRoutes(app) {
  // Public Customer Email Click Tracking Redirect
  app.get('/marketing/track/click', marketingController.trackClick);

  // Campaign Management
  app.get('/marketing/export', requireAnyPermission('crm.marketing.export', 'crm.marketing.read', 'crm.marketing.write'), marketingController.exportMarketing);
  app.get('/marketing/campaigns', requirePermission('crm.marketing.read'), marketingController.list);
  app.get('/marketing/campaigns/:id', requirePermission('crm.marketing.read'), marketingController.getById);
  app.post('/marketing/campaigns', requirePermission('crm.marketing.write'), marketingController.create);
  app.put('/marketing/campaigns/:id', requirePermission('crm.marketing.write'), marketingController.update);
  app.delete('/marketing/campaigns/:id', requireAnyPermission('crm.marketing.delete', 'crm.marketing.write'), marketingController.remove);
  app.get('/marketing/audience-stats', requirePermission('crm.marketing.read'), marketingController.audienceStats);

  // Drip Execution & Test Previews
  app.post('/marketing/campaigns/:id/execute', requirePermission('crm.marketing.write'), marketingController.execute);
  app.post('/marketing/campaigns/:id/send-test', requirePermission('crm.marketing.write'), marketingController.sendTest);

  // Pipeline Re-Entry & Eligible Leads
  app.post('/marketing/re-engage', requirePermission('crm.marketing.write'), marketingController.reEngage);
  app.post('/marketing/campaigns/:id/simulate-reengage', requirePermission('crm.marketing.write'), marketingController.simulateReEngage);
  app.get('/marketing/eligible-leads', requirePermission('crm.marketing.read'), marketingController.eligibleLeads);
  app.get('/marketing/activity', requirePermission('crm.marketing.read'), marketingController.activity);

  // Manager Approval Queue
  app.get('/marketing/requests', requirePermission('crm.marketing.read'), marketingController.listRequests);
  app.post('/marketing/requests', requirePermission('crm.marketing.write'), marketingController.createRequest);
  app.post('/marketing/requests/:id/approve', requirePermission('crm.marketing.write'), marketingController.approveRequest);
  app.post('/marketing/requests/:id/reject', requirePermission('crm.marketing.write'), marketingController.rejectRequest);

  // Executive Analytics & ROI Attribution
  app.get('/marketing/analytics', requirePermission('crm.marketing.read'), marketingController.analytics);
};
