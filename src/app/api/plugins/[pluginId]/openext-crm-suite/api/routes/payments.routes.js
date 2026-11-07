'use strict';



const paymentController = require('../controllers/payment.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validatePaymentCreate,
  validatePaymentUpdate,
  validateRefundRequest,
  validateRefundReject
} = require('../validation/payment.schema');

/**
 * Payments routes (Phase 1 plan Section 6.7).
 */
module.exports = function registerPaymentsRoutes(app) {
  app.get(
    '/payments/export',
    requireAnyPermission('crm.finance.export', 'crm.finance.read', 'crm.finance.write'),
    paymentController.exportPayments
  );

  // Refund listing route across all payments
  app.get(
    '/payments/refunds',
    requirePermission('crm.finance.read'),
    paymentController.listRefunds
  );

  app.get('/payments', requirePermission('crm.finance.read'), paymentController.list);

  app.post(
    '/payments',
    requirePermission('crm.finance.write'),
    validateBody(validatePaymentCreate),
    paymentController.create
  );

  app.get('/payments/:id', requirePermission('crm.finance.read'), paymentController.get);

  // Payment Refunds routes
  app.get(
    '/payments/:id/refunds',
    requirePermission('crm.finance.read'),
    paymentController.getPaymentRefunds
  );

  app.post(
    '/payments/:id/refunds',
    requirePermission('crm.finance.write'),
    validateBody(validateRefundRequest),
    paymentController.requestRefund
  );

  app.post(
    '/payments/:id/refunds/:refundId/approve',
    requirePermission('crm.finance.write'),
    paymentController.approveRefund
  );

  app.post(
    '/payments/:id/refunds/:refundId/reject',
    requirePermission('crm.finance.write'),
    validateBody(validateRefundReject),
    paymentController.rejectRefund
  );

  app.put(
    '/payments/:id',
    requirePermission('crm.finance.write'),
    validateBody(validatePaymentUpdate),
    paymentController.update
  );

  app.delete(
    '/payments/:id',
    requirePermission('crm.finance.delete'),
    paymentController.remove
  );
};

