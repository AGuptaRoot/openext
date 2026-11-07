'use strict';

const controller = require('../controllers/opportunity-pipeline.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');

/**
 * Opportunity pipeline management routes.
 * Settings → Opportunity → Pipelines
 */
module.exports = function registerOpportunityPipelineRoutes(app) {
  app.get(
    '/opportunity-pipelines/catalog',
    requirePermission('crm.settings.manage'),
    controller.getCatalog
  );

  app.get(
    '/opportunity-pipelines/active',
    requirePermission('crm.opportunities.read'),
    controller.getActive
  );

  app.get(
    '/opportunity-pipelines',
    requirePermission('crm.settings.manage'),
    controller.list
  );

  app.get(
    '/opportunity-pipelines/:id',
    requirePermission('crm.settings.manage'),
    controller.getById
  );

  app.post(
    '/opportunity-pipelines',
    requirePermission('crm.settings.manage'),
    controller.create
  );

  app.put(
    '/opportunity-pipelines/:id',
    requirePermission('crm.settings.manage'),
    controller.update
  );

  app.post(
    '/opportunity-pipelines/:id/activate',
    requirePermission('crm.settings.manage'),
    controller.activate
  );

  app.delete(
    '/opportunity-pipelines/:id',
    requirePermission('crm.settings.manage'),
    controller.remove
  );
};
