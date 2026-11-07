'use strict';

const sampleController = require('../controllers/sample.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateSampleCreate,
  validateSampleUpdate,
  validateSampleApproval,
  validateSampleCancel,
  validateSampleStockAddress,
  validateSampleDispatch,
  validateSampleFeedback
} = require('../validation/sample.schema');

/**
 * Sample Management & Customer Feedback routes.
 * Mounted at /api/plugins/openext-crm-suite/samples
 */
module.exports = function registerSampleRoutes(app) {
  app.get(
    '/samples/export',
    requireAnyPermission('crm.samples.export', 'crm.samples.read', 'crm.samples.write'),
    sampleController.exportSamples
  );
  // Declared before /samples/:id so it is never read as a record id.
  app.get(
    '/samples/item-suggestions',
    requirePermission('crm.samples.read'),
    sampleController.listItemSuggestions
  );
  app.get('/samples', requirePermission('crm.samples.read'), sampleController.list);
  app.get('/samples/:id', requirePermission('crm.samples.read'), sampleController.getById);

  // A client portal user may raise a sample request against their own deal
  // (crm.samples.request); staff use their normal sample write permission.
  app.post(
    '/samples',
    requireAnyPermission('crm.samples.write', 'crm.samples.request'),
    validateBody(validateSampleCreate),
    sampleController.create
  );

  app.post(
    '/samples/:id/cancel',
    requireAnyPermission('crm.samples.write', 'crm.samples.request'),
    validateBody(validateSampleCancel),
    sampleController.cancel
  );

  // Edit before dispatch — the stricter lifecycle checks live in the service.
  app.put(
    '/samples/:id',
    requirePermission('crm.samples.write'),
    validateBody(validateSampleUpdate),
    sampleController.update
  );

  app.put(
    '/samples/:id/approve',
    requirePermission('crm.samples.approve'),
    validateBody(validateSampleApproval),
    sampleController.approve
  );

  app.put(
    '/samples/:id/stock-address',
    requireAnyPermission('crm.samples.write', 'crm.samples.approve'),
    validateBody(validateSampleStockAddress),
    sampleController.updateStockAddress
  );

  app.put(
    '/samples/:id/dispatch',
    requirePermission('crm.samples.write'),
    validateBody(validateSampleDispatch),
    sampleController.dispatch
  );

  app.put(
    '/samples/:id/deliver',
    requirePermission('crm.samples.write'),
    sampleController.deliver
  );

  app.post(
    '/samples/:id/feedback',
    requirePermission('crm.samples.feedback'),
    validateBody(validateSampleFeedback),
    sampleController.submitFeedback
  );
};
