'use strict';

const invoiceController = require('../controllers/invoice.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateInvoiceCreate,
  validateInvoiceUpdate,
  validateInvoiceWriteOff
} = require('../validation/finance.schema');

/**
 * Invoices routes with full parity features.
 */
module.exports = function registerInvoicesRoutes(app) {
  app.get('/invoices/public/:token', invoiceController.getPublicPortal);
  app.get('/invoices/public/:token/pdf', invoiceController.downloadPublicPdf);
  app.post('/invoices/public/:token/razorpay/order', invoiceController.createPublicRazorpayOrder);
  app.post('/invoices/public/:token/razorpay/confirm', invoiceController.confirmPublicRazorpayPayment);

  app.get(
    '/invoices/export',
    requireAnyPermission('crm.finance.export', 'crm.finance.read', 'crm.finance.write'),
    invoiceController.exportInvoices
  );
  app.get('/invoices', requirePermission('crm.finance.read'), invoiceController.list);
  app.get('/invoices/next-number', requirePermission('crm.finance.read'), invoiceController.getNextInvoiceNumber);
  app.post(
    '/invoices/ocr/extract',
    requirePermission('crm.finance.write'),
    invoiceController.extractPdfOcr
  );
  app.get(
    '/invoices/razorpay/status',
    requirePermission('crm.finance.read'),
    invoiceController.getRazorpayStatus
  );
  app.post(
    '/invoices',
    requirePermission('crm.finance.write'),
    validateBody(validateInvoiceCreate),
    invoiceController.create
  );

  app.post(
    '/invoices/:id/send',
    requirePermission('crm.finance.write'),
    invoiceController.send
  );
  app.post(
    '/invoices/:id/pay-token',
    requirePermission('crm.finance.write'),
    invoiceController.generatePayToken
  );
  app.post(
    '/invoices/:id/viewed',
    requirePermission('crm.finance.read'),
    invoiceController.markAsViewed
  );
  app.post(
    '/invoices/:id/write-off',
    requirePermission('crm.finance.write'),
    validateBody(validateInvoiceWriteOff),
    invoiceController.writeOff
  );
  app.post(
    '/invoices/:id/archive',
    requirePermission('crm.finance.write'),
    invoiceController.archive
  );
  app.post(
    '/invoices/:id/restore',
    requirePermission('crm.finance.write'),
    invoiceController.restore
  );
  app.post(
    '/invoices/:id/cancel',
    requirePermission('crm.finance.write'),
    invoiceController.cancel
  );
  app.get(
    '/invoices/:id/payments',
    requirePermission('crm.finance.read'),
    invoiceController.listPayments
  );

  app.get(
    '/invoices/:id/print',
    requirePermission('crm.finance.read'),
    invoiceController.printHtml
  );
  app.get(
    '/invoices/:id/pdf',
    requirePermission('crm.finance.read'),
    invoiceController.downloadPdf
  );

  app.post(
    '/invoices/:id/razorpay/order',
    requireAnyPermission('crm.finance.read', 'crm.finance.write'),
    invoiceController.createRazorpayOrder
  );
  app.post(
    '/invoices/:id/razorpay/confirm',
    requireAnyPermission('crm.finance.read', 'crm.finance.write'),
    invoiceController.confirmRazorpayPayment
  );

  app.post(
    '/invoices/:id/convert-proforma',
    requirePermission('crm.finance.write'),
    invoiceController.convertProforma
  );
  app.get('/invoices/:id', requirePermission('crm.finance.read'), invoiceController.get);
  app.put(
    '/invoices/:id',
    requirePermission('crm.finance.write'),
    validateBody(validateInvoiceUpdate),
    invoiceController.update
  );
  app.delete(
    '/invoices/:id',
    requirePermission('crm.finance.delete'),
    invoiceController.remove
  );
};
