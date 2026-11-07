const path = require('path');
let analyticsAiController;
try {
  analyticsAiController = require('../controllers/analytics-ai.controller.js');
} catch (e) {
  analyticsAiController = require(path.resolve(__dirname, '../controllers/analytics-ai.controller.js'));
}
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * Analytics & AI Intelligence routes.
 * Mounted at /api/plugins/openext-crm-suite/analytics-ai
 */
module.exports = function registerAnalyticsAiRoutes(app) {
  // Sales Dashboard & Revenue Forecasting
  app.get('/analytics-ai/sales', requirePermission('crm.analytics.read'), analyticsAiController.salesAnalytics);

  // Customer Behavior & Product Demand Prediction
  app.get('/analytics-ai/customer-behavior', requirePermission('crm.ai.read'), analyticsAiController.customerBehavior);

  // AI Next-Best-Action Decisioning & Module 4 Qualification Feedback Loop
  app.get('/analytics-ai/next-best-actions', requirePermission('crm.ai.read'), analyticsAiController.nextBestActions);
  app.post('/analytics-ai/apply-action', requirePermission('crm.ai.write'), analyticsAiController.applyAction);
};
