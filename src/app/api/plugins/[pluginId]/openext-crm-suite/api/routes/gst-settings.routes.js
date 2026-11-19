'use strict';

const controller = require('../controllers/gst-settings.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * GST settings (GST suite, CRM 3.53.0; documentation/gst-planning/05 §5).
 * Existing permission keys only: no new role.
 */
module.exports = function registerGstSettingsRoutes(app) {
  app.get('/gst/settings', requireAnyPermission('crm.finance.read', 'crm.settings.manage'), controller.get);
  app.put('/gst/settings', requirePermission('crm.settings.manage'), controller.save);
  app.post('/gst/settings/seed-services', requirePermission('crm.settings.manage'), controller.seedServices);
  app.post(
    '/gst/validate-gstin',
    requireAnyPermission('crm.finance.read', 'crm.clients.write', 'crm.settings.manage'),
    controller.validateGstin
  );
};
