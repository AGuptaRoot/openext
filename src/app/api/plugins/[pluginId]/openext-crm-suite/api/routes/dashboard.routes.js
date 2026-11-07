'use strict';

const dashboardController = require('../controllers/dashboard.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * Dashboard + health routes.
 *
 * Routes are mounted under:
 *   /api/plugins/openext-crm-suite
 */
module.exports = function registerDashboardRoutes(app) {
  app.get('/health', dashboardController.health);

  app.get(
    '/dashboard',
    requirePermission('crm.dashboard.view'),
    dashboardController.summary
  );

  app.get(
    '/dashboard/widgets',
    requirePermission('crm.dashboard.view'),
    dashboardController.getWidgets
  );

  app.put(
    '/dashboard/widgets',
    requirePermission('crm.dashboard.view'),
    dashboardController.saveWidgets
  );
};
