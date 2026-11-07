'use strict';

const quotationController = require('../controllers/quotation.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateQuotationCreate,
  validateQuotationUpdate,
  validateQuotationRevision,
  validatePortalAccept,
  validatePortalReject
} = require('../validation/finance.schema');
const {
  validateEstimateTemplateCreate,
  validateEstimateTemplateUpdate
} = require('../validation/estimate-template.schema');

/**
 * Quotations routes including templates, revisioning, archive, and public client portal.
 * Mounted at /api/plugins/openext-crm-suite/quotations
 */
module.exports = function registerQuotationsRoutes(app) {
  // Public client portal signoff endpoints (no admin auth required)
  app.get('/quotations/public/:token', quotationController.getPublicPortal);
  app.post(
    '/quotations/public/:token/accept',
    validateBody(validatePortalAccept),
    quotationController.clientPortalAccept
  );
  app.post(
    '/quotations/public/:token/reject',
    validateBody(validatePortalReject),
    quotationController.clientPortalReject
  );
  app.post('/quotations/public/:token/razorpay/order', quotationController.createPublicRazorpayOrder);
  app.post('/quotations/public/:token/razorpay/confirm', quotationController.confirmPublicRazorpayPayment);

  // Template endpoints
  app.get(
    '/quotations/templates',
    requirePermission('crm.finance.read'),
    quotationController.listTemplates
  );
  app.post(
    '/quotations/templates',
    requirePermission('crm.finance.write'),
    validateBody(validateEstimateTemplateCreate),
    quotationController.createTemplate
  );
  app.get(
    '/quotations/templates/:id',
    requirePermission('crm.finance.read'),
    quotationController.getTemplate
  );
  app.put(
    '/quotations/templates/:id',
    requirePermission('crm.finance.write'),
    validateBody(validateEstimateTemplateUpdate),
    quotationController.updateTemplate
  );
  app.delete(
    '/quotations/templates/:id',
    requirePermission('crm.finance.delete'),
    quotationController.deleteTemplate
  );
  app.post(
    '/quotations/:id/save-as-template',
    requirePermission('crm.finance.write'),
    quotationController.saveAsTemplate
  );

  // Core Quotations List & Create
  app.get(
    '/quotations/export',
    requireAnyPermission('crm.finance.export', 'crm.finance.read', 'crm.finance.write'),
    quotationController.exportQuotations
  );
  app.get('/quotations', requirePermission('crm.finance.read'), quotationController.list);
  app.post(
    '/quotations/ocr/extract',
    requirePermission('crm.finance.write'),
    quotationController.extractPdfOcr
  );
  app.post(
    '/quotations',
    requirePermission('crm.finance.write'),
    validateBody(validateQuotationCreate),
    quotationController.create
  );

  /*
   * Advance / full payment on a quotation. Both raise or reuse the proforma,
   * and both are refused while proforma & advance payment is off in Settings.
   */
  app.post(
    '/quotations/:id/razorpay/order',
    requireAnyPermission('crm.finance.read', 'crm.finance.write'),
    quotationController.createQuotationRazorpayOrder
  );
  app.post(
    '/quotations/:id/proforma',
    requirePermission('crm.finance.write'),
    quotationController.createQuotationProforma
  );

  // Revisions
  app.post(
    '/quotations/:id/revise',
    requirePermission('crm.finance.write'),
    validateBody(validateQuotationRevision),
    quotationController.createRevision
  );
  app.get(
    '/quotations/:id/revisions',
    requirePermission('crm.finance.read'),
    quotationController.getRevisions
  );

  // Archive & Restore
  app.post(
    '/quotations/:id/archive',
    requirePermission('crm.finance.write'),
    quotationController.archive
  );
  app.post(
    '/quotations/:id/restore',
    requirePermission('crm.finance.write'),
    quotationController.restore
  );

  // Portal Token Generator
  app.post(
    '/quotations/:id/portal-token',
    requirePermission('crm.finance.read'),
    quotationController.generatePortalToken
  );

  // Status Actions & Workflow
  app.post(
    '/quotations/:id/send',
    requirePermission('crm.finance.write'),
    quotationController.send
  );
  app.post(
    '/quotations/:id/accept',
    requirePermission('crm.finance.write'),
    quotationController.accept
  );
  app.post(
    '/quotations/:id/reject',
    requirePermission('crm.finance.write'),
    quotationController.reject
  );
  app.post(
    '/quotations/:id/convert-to-invoice',
    requirePermission('crm.finance.write'),
    quotationController.convertToInvoice
  );

  app.get(
    '/quotations/:id/print',
    requirePermission('crm.finance.read'),
    quotationController.printHtml
  );
  app.get(
    '/quotations/:id/pdf',
    requirePermission('crm.finance.read'),
    quotationController.downloadPdf
  );

  app.get('/quotations/:id', requirePermission('crm.finance.read'), quotationController.get);
  app.put(
    '/quotations/:id',
    requirePermission('crm.finance.write'),
    validateBody(validateQuotationUpdate),
    quotationController.update
  );
  app.delete(
    '/quotations/:id',
    requirePermission('crm.finance.delete'),
    quotationController.remove
  );
};
