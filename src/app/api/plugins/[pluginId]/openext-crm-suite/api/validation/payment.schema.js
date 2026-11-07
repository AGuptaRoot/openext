'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertPositiveAmount,
  assertOptionalDate,
  assertMaxLength
} = require('./common.util');

const PAYMENT_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other'];

function normalizeMode(mode) {
  return trimString(mode) || 'Other';
}

function validatePaymentCreate(body) {
  const source = asObject(body);
  const errors = [];

  const clientId = trimString(source.clientId);
  const invoiceId = trimString(source.invoiceId);
  let allocations = [];

  if (Array.isArray(source.allocations) && source.allocations.length) {
    for (let i = 0; i < source.allocations.length; i++) {
      const item = asObject(source.allocations[i]);
      const invId = trimString(item.invoiceId || item.id);
      const allocAmt = Number(item.amount);
      if (!invId) {
        errors.push(`Allocation at index ${i} requires invoiceId`);
      } else if (!Number.isFinite(allocAmt) || allocAmt <= 0) {
        errors.push(`Allocation for invoice at index ${i} must have a positive amount`);
      } else {
        allocations.push({ invoiceId: invId, amount: Math.round(allocAmt * 100) / 100 });
      }
    }
  }

  if (!clientId && !invoiceId && !allocations.length) {
    errors.push('clientId, invoiceId, or allocations is required');
  }

  let amount;
  if (source.amount !== undefined && source.amount !== null && source.amount !== '') {
    amount = assertPositiveAmount(errors, source.amount, 'Amount');
  } else if (allocations.length) {
    amount = Math.round(allocations.reduce((sum, a) => sum + a.amount, 0) * 100) / 100;
  } else {
    amount = assertPositiveAmount(errors, source.amount, 'Amount');
  }

  const mode = normalizeMode(source.mode);

  if (!PAYMENT_MODES.includes(mode)) {
    errors.push(`Invalid payment mode. Allowed: ${PAYMENT_MODES.join(', ')}`);
  }

  const paymentDate = assertOptionalDate(errors, source.paymentDate, 'Payment date');
  const transactionId = trimString(source.transactionId || source.reference) || '';
  const remark = trimString(source.remark || source.notes) || '';
  const paymentGateway = trimString(source.paymentGateway) || '';
  const bankAccount = trimString(source.bankAccount) || '';
  const receipt = trimString(source.receipt) || '';
  const currency = trimString(source.currency) || 'INR';
  const exchangeRate = Number(source.exchangeRate) || 1;
  const projectId = trimString(source.projectId) || '';

  assertMaxLength(errors, transactionId, 150, 'Transaction ID');
  assertMaxLength(errors, remark, 1000, 'Remark / Notes');
  assertMaxLength(errors, paymentGateway, 100, 'Payment Gateway');
  assertMaxLength(errors, bankAccount, 150, 'Bank Account');

  if (errors.length) return fail(errors);

  const value = {
    amount,
    mode,
    currency,
    exchangeRate: exchangeRate > 0 ? exchangeRate : 1,
    transactionId,
    reference: transactionId,
    paymentGateway,
    bankAccount,
    receipt,
    remark,
    notes: remark
  };

  if (clientId) value.clientId = clientId;
  if (projectId) value.projectId = projectId;
  if (invoiceId) value.invoiceId = invoiceId;
  if (allocations.length) value.allocations = allocations;
  if (paymentDate !== undefined) value.paymentDate = paymentDate;

  return ok(value);
}

function validatePaymentUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.amount !== undefined) {
    value.amount = assertPositiveAmount(errors, source.amount, 'Amount');
  }
  if (source.mode !== undefined) {
    const mode = normalizeMode(source.mode);
    if (!PAYMENT_MODES.includes(mode)) {
      errors.push(`Invalid payment mode. Allowed: ${PAYMENT_MODES.join(', ')}`);
    } else {
      value.mode = mode;
    }
  }
  if (source.transactionId !== undefined || source.reference !== undefined) {
    const tid = trimString(source.transactionId || source.reference) || '';
    assertMaxLength(errors, tid, 150, 'Transaction ID');
    value.transactionId = tid;
    value.reference = tid;
  }
  if (source.remark !== undefined || source.notes !== undefined) {
    const rmk = trimString(source.remark || source.notes) || '';
    assertMaxLength(errors, rmk, 1000, 'Remark / Notes');
    value.remark = rmk;
    value.notes = rmk;
  }
  if (source.projectId !== undefined) value.projectId = trimString(source.projectId) || '';
  if (source.paymentGateway !== undefined) value.paymentGateway = trimString(source.paymentGateway) || '';
  if (source.bankAccount !== undefined) value.bankAccount = trimString(source.bankAccount) || '';
  if (source.receipt !== undefined) value.receipt = trimString(source.receipt) || '';
  if (source.currency !== undefined) value.currency = trimString(source.currency) || 'INR';
  if (source.exchangeRate !== undefined) {
    const er = Number(source.exchangeRate);
    value.exchangeRate = er > 0 ? er : 1;
  }
  if (source.paymentDate !== undefined) {
    value.paymentDate = assertOptionalDate(errors, source.paymentDate, 'Payment date');
  }

  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');

  if (errors.length) return fail(errors);
  return ok(value);
}

const REFUND_MODES = ['Bank Transfer', 'UPI', 'Original Payment Method', 'Cash', 'Card', 'Cheque', 'Other'];

function validateRefundRequest(body) {
  const source = asObject(body);
  const errors = [];

  const amount = assertPositiveAmount(errors, source.amount, 'Refund Amount');
  const reason = trimString(source.reason || source.notes || source.remark);
  if (!reason) {
    errors.push('Refund reason is required');
  }
  assertMaxLength(errors, reason, 1000, 'Refund reason');

  const mode = trimString(source.mode) || 'Bank Transfer';
  if (mode && !REFUND_MODES.includes(mode)) {
    errors.push(`Invalid refund mode. Allowed: ${REFUND_MODES.join(', ')}`);
  }

  const bankAccount = trimString(source.bankAccount) || '';
  const transactionId = trimString(source.transactionId || source.reference) || '';
  const receipt = trimString(source.receipt) || '';

  assertMaxLength(errors, transactionId, 150, 'Transaction ID / Reference');
  assertMaxLength(errors, bankAccount, 150, 'Bank Account');

  if (errors.length) return fail(errors);

  return ok({
    amount,
    reason,
    mode,
    bankAccount,
    transactionId,
    receipt,
    autoApprove: Boolean(source.autoApprove)
  });
}

function validateRefundReject(body) {
  const source = asObject(body);
  const errors = [];

  const reason = trimString(source.reason || source.rejectionReason);
  if (!reason) {
    errors.push('Rejection reason is required');
  }
  assertMaxLength(errors, reason, 1000, 'Rejection reason');

  if (errors.length) return fail(errors);
  return ok({ reason });
}

module.exports = {
  PAYMENT_MODES,
  REFUND_MODES,
  validatePaymentCreate,
  validatePaymentUpdate,
  validateRefundRequest,
  validateRefundReject
};
