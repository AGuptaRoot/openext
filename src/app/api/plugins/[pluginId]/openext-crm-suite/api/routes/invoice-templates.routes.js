'use strict';

const templateController = require('../controllers/invoice-template.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateInvoiceTemplateCreate,
  validateInvoiceTemplateUpdate
} = require('../validation/invoice-template.schema');

module.exports = function registerInvoiceTemplateRoutes(app) {
  app.get(
    '/invoice-templates',
    requirePermission('crm.finance.read'),
    templateController.list
  );

  app.get(
    '/invoice-templates/:id',
    requirePermission('crm.finance.read'),
    templateController.get
  );

  app.post(
    '/invoice-templates',
    requirePermission('crm.finance.write'),
    validateBody(validateInvoiceTemplateCreate),
    templateController.create
  );

  app.put(
    '/invoice-templates/:id',
    requirePermission('crm.finance.write'),
    validateBody(validateInvoiceTemplateUpdate),
    templateController.update
  );

  app.delete(
    '/invoice-templates/:id',
    requirePermission('crm.finance.delete'),
    templateController.remove
  );

  app.post(
    '/invoices/:id/save-as-template',
    requirePermission('crm.finance.write'),
    templateController.saveAsTemplate
  );
};
