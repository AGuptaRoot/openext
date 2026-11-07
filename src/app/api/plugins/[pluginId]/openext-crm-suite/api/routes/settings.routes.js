'use strict';

const settingController = require('../controllers/setting.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Settings routes (Phase 1 plan Section 6.1).
 *
 * GET  /settings           → crm.settings.manage (full config)
 * PUT  /settings           → crm.settings.manage (update config)
 * GET  /settings/pipeline  → crm.leads.read (sales users need stages)
 * PUT  /settings/pipeline  → crm.settings.manage
 * GET  /settings/opportunity-pipeline → crm.opportunities.read
 * PUT  /settings/opportunity-pipeline → crm.settings.manage
 */
module.exports = function registerSettingsRoutes(app) {
  app.get(
    '/settings/pipeline',
    requirePermission('crm.leads.read'),
    settingController.getPipeline
  );

  app.get(
    '/settings/opportunity-pipeline',
    requirePermission('crm.opportunities.read'),
    settingController.getOpportunityPipeline
  );

  app.get(
    '/settings/delivery',
    requirePermission('crm.projects.read'),
    settingController.getDelivery
  );

  app.put(
    '/settings/pipeline',
    requirePermission('crm.settings.manage'),
    settingController.putPipeline
  );

  app.put(
    '/settings/opportunity-pipeline',
    requirePermission('crm.settings.manage'),
    settingController.putOpportunityPipeline
  );

  app.get(
    '/settings',
    requirePermission('crm.settings.manage'),
    settingController.getSettings
  );

  app.put(
    '/settings',
    requirePermission('crm.settings.manage'),
    settingController.putSettings
  );

  app.post(
    '/settings/test-email',
    requirePermission('crm.settings.manage'),
    settingController.testEmail
  );

  app.get(
    '/settings/email-status',
    requirePermission('crm.settings.manage'),
    settingController.getEmailStatus
  );

  app.get(
    '/settings/integrations/groq',
    requirePermission('crm.settings.manage'),
    settingController.getGroqIntegration
  );

  app.put(
    '/settings/integrations/groq',
    requirePermission('crm.settings.manage'),
    settingController.putGroqIntegration
  );

  app.get(
    '/settings/integrations/google-maps',
    requirePermission('crm.settings.manage'),
    settingController.getGoogleMapsIntegration
  );

  app.put(
    '/settings/integrations/google-maps',
    requirePermission('crm.settings.manage'),
    settingController.putGoogleMapsIntegration
  );

  /** Client Places Autocomplete — authenticated lead/settings users only */
  app.get(
    '/settings/integrations/google-maps/client-key',
    requireAnyPermission(
      'crm.settings.manage',
      'crm.leads.read',
      'crm.leads.write',
      'crm.clients.read',
      'crm.clients.write'
    ),
    settingController.getGoogleMapsClientKey
  );
};
