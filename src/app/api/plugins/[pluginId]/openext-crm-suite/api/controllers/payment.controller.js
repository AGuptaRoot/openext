'use strict';

const PaymentService = require('../services/payment.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] payment error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Payment operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await PaymentService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      unlinkedClient: Boolean(result.unlinkedClient),
      message: result.message || 'Payments loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await PaymentService.getById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Payment loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await PaymentService.create(req, req.validatedBody);
    const message = doc.split
      ? `Payment recorded across ${doc.payments.length} invoice(s)`
      : 'Payment recorded';
    res.status(201).json({ success: true, data: doc, message });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const doc = await PaymentService.update(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: 'Payment updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await PaymentService.remove(req, req.params.id);
    res.json({ success: true, data: result, message: 'Payment deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportPayments(req, res) {
  try {
    const result = await PaymentService.exportPayments(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error);
  }
}

async function requestRefund(req, res) {
  try {
    const result = await PaymentService.requestRefund(req, req.params.id, req.validatedBody || req.body);
    res.status(201).json({
      success: true,
      data: result,
      message: result.refund?.status === 'Approved' ? 'Refund approved and processed' : 'Refund request submitted for approval'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function approveRefund(req, res) {
  try {
    const result = await PaymentService.approveRefund(req, req.params.id, req.params.refundId, req.body || {});
    res.json({
      success: true,
      data: result,
      message: 'Refund request approved and processed'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function rejectRefund(req, res) {
  try {
    const result = await PaymentService.rejectRefund(req, req.params.id, req.params.refundId, req.validatedBody || req.body);
    res.json({
      success: true,
      data: result,
      message: 'Refund request rejected'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listRefunds(req, res) {
  try {
    const result = await PaymentService.listRefunds(req, req.query || {});
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: 'Refunds loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function getPaymentRefunds(req, res) {
  try {
    const result = await PaymentService.getPaymentRefunds(req, req.params.id);
    res.json({
      success: true,
      data: result,
      message: 'Payment refunds loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  exportPayments,
  get,
  create,
  update,
  remove,
  requestRefund,
  approveRefund,
  rejectRefund,
  listRefunds,
  getPaymentRefunds
};
