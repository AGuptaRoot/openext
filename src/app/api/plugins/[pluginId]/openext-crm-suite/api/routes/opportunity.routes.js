'use strict';

const opportunityController = require('../controllers/opportunity.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateOpportunityCreate,
  validateOpportunityUpdate,
  validateStageChange,
  validateAssignOwner
} = require('../validation/opportunity.schema');

/**
 * Opportunity Management & Sales Pipeline routes.
 * Mounted at /api/plugins/openext-crm-suite/opportunities
 */
module.exports = function registerOpportunityRoutes(app) {
  app.get('/opportunities/summary', requirePermission('crm.opportunities.read'), opportunityController.getSummary);
  app.get(
    '/opportunities/export',
    requireAnyPermission('crm.opportunities.export', 'crm.opportunities.read', 'crm.opportunities.write'),
    opportunityController.exportOpportunities
  );
  app.get(
    '/opportunities/item-suggestions',
    requirePermission('crm.opportunities.read'),
    opportunityController.listItemSuggestions
  );
  // The stage a new opportunity opens in (salesFlow.opportunityForm.startStage); for the create page.
  app.get(
    '/opportunities/start-stage',
    requirePermission('crm.opportunities.write'),
    opportunityController.getStartStage
  );
  app.get('/opportunities', requirePermission('crm.opportunities.read'), opportunityController.list);
  app.get('/opportunities/:id', requirePermission('crm.opportunities.read'), opportunityController.getById);

  app.post(
    '/opportunities',
    requirePermission('crm.opportunities.write'),
    validateBody(validateOpportunityCreate),
    opportunityController.create
  );

  app.post(
    '/opportunities/:id/contact-correction',
    requirePermission('crm.opportunities.write'),
    opportunityController.correctContact
  );

  app.put(
    '/opportunities/:id',
    requirePermission('crm.opportunities.write'),
    validateBody(validateOpportunityUpdate),
    opportunityController.update
  );

  app.post(
    '/opportunities/:id/assign-owner',
    requirePermission('crm.opportunities.write'),
    validateBody(validateAssignOwner),
    opportunityController.assignOwner
  );

  app.post(
    '/opportunities/:id/stage',
    requirePermission('crm.opportunities.write'),
    validateBody(validateStageChange),
    opportunityController.changeStage
  );

  app.post(
    '/opportunities/:id/convert-quotation',
    requirePermission('crm.finance.write'),
    opportunityController.convertToQuotation
  );

  app.delete(
    '/opportunities/:id',
    requirePermission('crm.opportunities.delete'),
    opportunityController.remove
  );
};
