'use strict';

const creditNoteController = require('../controllers/credit-note.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateCreditNoteCreate,
  validateCreditNoteFromInvoice,
  validateCreditNoteApply,
  validateCreditNoteRefund
} = require('../validation/credit-note.schema');

module.exports = function registerCreditNoteRoutes(app) {
  app.get(
    '/credit-notes',
    requirePermission('crm.finance.read'),
    creditNoteController.list
  );

  app.get(
    '/credit-notes/:id',
    requirePermission('crm.finance.read'),
    creditNoteController.get
  );

  app.get(
    '/credit-notes/:id/print',
    requirePermission('crm.finance.read'),
    creditNoteController.printHtml
  );

  app.post(
    '/credit-notes',
    requirePermission('crm.finance.write'),
    validateBody(validateCreditNoteCreate),
    creditNoteController.create
  );

  app.post(
    '/credit-notes/from-invoice',
    requirePermission('crm.finance.write'),
    validateBody(validateCreditNoteFromInvoice),
    creditNoteController.createFromInvoice
  );

  app.post(
    '/invoices/:invoiceId/credit-note',
    requirePermission('crm.finance.write'),
    (req, res, next) => {
      if (req.params.invoiceId && (!req.body || !req.body.invoiceId)) {
        req.body = req.body || {};
        req.body.invoiceId = req.params.invoiceId;
      }
      next();
    },
    validateBody(validateCreditNoteFromInvoice),
    creditNoteController.createFromInvoice
  );

  app.post(
    '/credit-notes/:id/apply',
    requirePermission('crm.finance.write'),
    validateBody(validateCreditNoteApply),
    creditNoteController.apply
  );

  app.post(
    '/credit-notes/:id/refund',
    requirePermission('crm.finance.write'),
    validateBody(validateCreditNoteRefund),
    creditNoteController.refund
  );

  app.post(
    '/credit-notes/:id/void',
    requirePermission('crm.finance.write'),
    creditNoteController.voidNote
  );

  app.post(
    '/credit-notes/:id/archive',
    requirePermission('crm.finance.write'),
    creditNoteController.archive
  );

  app.post(
    '/credit-notes/:id/restore',
    requirePermission('crm.finance.write'),
    creditNoteController.restore
  );

  app.delete(
    '/credit-notes/:id',
    requirePermission('crm.finance.delete'),
    creditNoteController.remove
  );
};
