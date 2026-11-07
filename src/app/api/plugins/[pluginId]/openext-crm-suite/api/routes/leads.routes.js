'use strict';

const leadController = require('../controllers/lead.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateLeadCreate,
  validateLeadUpdate,
  validateLeadDuplicateCheck,
  validateLeadStageChange,
  validateLeadQualification,
  validateLeadCommercialRequirement,
  validateLeadImportPreview,
  validateLeadImport,
  validateLeadOcrExtract,
  validateLeadBulkAssign,
  validateLeadBulkStage,
  validateSavedLeadFilterCreate,
  validateSavedLeadFilterUpdate
} = require('../validation/lead.schema');

/**
 * Core leads CRUD routes.
 * Nested detail routes live in lead-detail.routes.js.
 */
module.exports = function registerLeadsRoutes(app) {
  app.get('/leads', requirePermission('crm.leads.read'), leadController.list);
  app.post(
    '/leads/duplicate-check',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadDuplicateCheck),
    leadController.checkDuplicates
  );
  app.post(
    '/leads',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadCreate),
    leadController.create
  );

  // Static Metadata & Settings Routes
  app.get('/leads/sources', requirePermission('crm.leads.read'), leadController.listSources);
  app.post('/leads/sources', requirePermission('crm.leads.write'), leadController.addSource);
  app.get('/leads/statuses', requirePermission('crm.leads.read'), leadController.listStatuses);
  app.post('/leads/statuses', requirePermission('crm.leads.write'), leadController.addStatus);
  app.get('/leads/types', requirePermission('crm.leads.read'), leadController.listTypes);
  app.post('/leads/types', requirePermission('crm.leads.write'), leadController.addType);
  app.get('/leads/priorities', requirePermission('crm.leads.read'), leadController.listPriorities);
  app.post('/leads/priorities', requirePermission('crm.leads.write'), leadController.addPriority);
  app.get(
    '/leads/activity-types',
    requirePermission('crm.leads.read'),
    leadController.listActivityTypes
  );
  app.post(
    '/leads/activity-types',
    requirePermission('crm.settings.manage'),
    leadController.addActivityType
  );
  app.get('/leads/tags', requirePermission('crm.leads.read'), leadController.listTags);
  app.post('/leads/tags', requirePermission('crm.leads.write'), leadController.addTag);
  app.get('/leads/custom-fields', requirePermission('crm.leads.read'), leadController.listCustomFields);
  app.post('/leads/custom-fields', requirePermission('crm.leads.write'), leadController.addCustomField);

  // Saved Filters Routes
  app.get('/leads/saved-filters', requirePermission('crm.leads.read'), leadController.listSavedFilters);
  app.post(
    '/leads/saved-filters',
    requirePermission('crm.leads.read'),
    validateBody(validateSavedLeadFilterCreate),
    leadController.createSavedFilter
  );
  app.put(
    '/leads/saved-filters/:id',
    requirePermission('crm.leads.read'),
    validateBody(validateSavedLeadFilterUpdate),
    leadController.updateSavedFilter
  );
  app.delete(
    '/leads/saved-filters/:id',
    requirePermission('crm.leads.read'),
    leadController.deleteSavedFilter
  );

  // Import & Export Routes
  app.post(
    '/leads/import/preview',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadImportPreview),
    leadController.importPreview
  );
  app.post(
    '/leads/import',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadImport),
    leadController.importExecute
  );
  app.post(
    '/leads/ocr/extract',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadOcrExtract),
    leadController.extractOcr
  );
  app.get(
    '/leads/export',
    requireAnyPermission('crm.leads.export', 'crm.leads.read', 'crm.leads.write'),
    leadController.exportLeads
  );

  // Bulk Operations Routes (must precede /leads/:id routes)
  app.post(
    '/leads/bulk/assign',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadBulkAssign),
    leadController.bulkAssign
  );
  app.post(
    '/leads/bulk-assign',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadBulkAssign),
    leadController.bulkAssign
  );
  app.post(
    '/leads/bulk/stage',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadBulkStage),
    leadController.bulkChangeStage
  );
  app.post(
    '/leads/bulk-stage',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadBulkStage),
    leadController.bulkChangeStage
  );

  // Parameterized /:id Routes
  app.post(
    '/leads/:id/stage',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadStageChange),
    leadController.changeStage
  );
  app.put(
    '/leads/:id/qualification',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadQualification),
    leadController.updateQualification
  );
  app.put(
    '/leads/:id/commercial-requirement',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadCommercialRequirement),
    leadController.updateCommercialRequirement
  );
  app.post(
    '/leads/:id/convert',
    requirePermission('crm.leads.convert'),
    leadController.convert
  );

  app.get('/leads/:id', requirePermission('crm.leads.read'), leadController.get);
  app.put(
    '/leads/:id',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadUpdate),
    leadController.update
  );
  app.delete('/leads/:id', requirePermission('crm.leads.delete'), leadController.remove);
};
