'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength,
  assertOptionalDate
} = require('./common.util');

const SAMPLE_STATUSES = [
  'Requested',
  'Approved',
  'Rejected',
  'Preparing',
  'Dispatched',
  'Delivered',
  'Completed'
];

/**
 * Statuses in which a sample request may still be edited.
 *
 * The window closes at dispatch: once the parcel is with the courier, the
 * docket and the recipient's expectations are already fixed. A rejected request
 * is closed too — it has to be raised again rather than rewritten.
 */
const EDITABLE_SAMPLE_STATUSES = ['Requested', 'Approved', 'Preparing'];

/**
 * Normalises the item rows onto `value`, dropping unnamed rows and deriving the
 * headline product/quantity/unit from the first row when they were not sent
 * separately. Shared by create and update so both read the same payload shape.
 */
function applySampleItems(value, source, errors) {
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = asObject(rawItems[i]);
    const pName = trimString(raw.productName);
    const qVal = Math.max(1, Number(raw.quantity) || 1);
    const uVal = trimString(raw.unit) || 'pcs';
    if (pName) {
      assertMaxLength(errors, pName, 200, `Item ${i + 1} product name`);
      items.push({ productName: pName, quantity: qVal, unit: uVal });
    }
  }

  if (items.length > 0) {
    value.items = items;
    if (!value.productName) {
      value.productName = items[0].productName;
      value.quantity = items.reduce((sum, it) => sum + (Number(it.quantity) || 1), 0);
      value.unit = items[0].unit;
    }
  } else if (value.productName) {
    value.items = [
      {
        productName: value.productName,
        quantity: value.quantity,
        unit: value.unit
      }
    ];
  }
  return value;
}

/**
 * Validates payload for creating a sample request.
 * 
 * Usecase: Validates initial sample request details submitted by Sales Rep.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result containing ok status and cleaned values or error list
 */
function validateSampleCreate(body) {
  const source = asObject(body);
  const errors = [];

  const value = {
    leadId: trimString(source.leadId),
    clientId: trimString(source.clientId),
    opportunityId: trimString(source.opportunityId),
    productName: trimString(source.productName),
    quantity: Number(source.quantity) || 1,
    unit: trimString(source.unit) || 'pcs',
    deliveryAddress: trimString(source.deliveryAddress) || '',
    urgency: trimString(source.urgency) || 'Normal',
    notes: trimString(source.notes) || '',
    recipientName: trimString(source.recipientName) || ''
  };

  applySampleItems(value, source, errors);

  if (!value.leadId && !value.clientId && !value.opportunityId) {
    errors.push('Sample request must be linked to a lead, client, or opportunity');
  }

  assertRequired(errors, value.productName, 'Product name');
  assertMaxLength(errors, value.productName, 200, 'Product name');
  assertMaxLength(errors, value.deliveryAddress, 1000, 'Delivery address');
  assertMaxLength(errors, value.notes, 2000, 'Notes');

  if (value.quantity <= 0) {
    errors.push('Quantity must be greater than zero');
  }

  if (!['Low', 'Normal', 'High', 'Urgent'].includes(value.urgency)) {
    errors.push('Urgency must be Low, Normal, High, or Urgent');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates an edit to a sample request that has not been dispatched yet.
 *
 * The link (lead / client / opportunity) and the lifecycle fields are not
 * editable here — only what the warehouse is being asked to send out and where.
 *
 * @param {Object} body Request body
 * @returns {Object} Validation result containing ok status and cleaned values or error list
 */
function validateSampleUpdate(body) {
  const source = asObject(body);
  const errors = [];

  const value = {
    productName: trimString(source.productName),
    quantity: Number(source.quantity) || 1,
    unit: trimString(source.unit) || 'pcs',
    deliveryAddress: trimString(source.deliveryAddress) || '',
    urgency: trimString(source.urgency) || 'Normal',
    notes: trimString(source.notes) || '',
    recipientName: trimString(source.recipientName) || '',
    isChargeable: Boolean(source.isChargeable)
  };

  const chargeAmount = Number(source.chargeAmount);
  value.chargeAmount =
    value.isChargeable && Number.isFinite(chargeAmount) && chargeAmount > 0
      ? Math.round(chargeAmount * 100) / 100
      : 0;

  // Currency and rate stay as stored unless a usable value is supplied.
  const currency = (trimString(source.currencyCode || source.currency) || '').toUpperCase();
  value.currency = /^[A-Z]{3}$/.test(currency) ? currency : '';
  const exchangeRate = Number(source.exchangeRate);
  value.exchangeRate =
    Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : null;

  applySampleItems(value, source, errors);

  assertRequired(errors, value.productName, 'Product name');
  assertMaxLength(errors, value.productName, 200, 'Product name');
  assertMaxLength(errors, value.deliveryAddress, 1000, 'Delivery address');
  assertMaxLength(errors, value.notes, 2000, 'Notes');
  assertMaxLength(errors, value.recipientName, 200, 'Recipient name');

  if (value.quantity <= 0) {
    errors.push('Quantity must be greater than zero');
  }

  if (!['Low', 'Normal', 'High', 'Urgent'].includes(value.urgency)) {
    errors.push('Urgency must be Low, Normal, High, or Urgent');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates Sales Manager approval or rejection payload.
 *
 * Usecase: Validates decision (Approved/Rejected) and stock notes/rejection reason.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result
 */
function validateSampleApproval(body) {
  const source = asObject(body);
  const errors = [];

  const value = {
    action: trimString(source.action), // 'approve' or 'reject'
    stockLocation: trimString(source.stockLocation) || '',
    rejectionReason: trimString(source.rejectionReason) || ''
  };

  if (!['approve', 'reject'].includes(value.action)) {
    errors.push('Action must be either "approve" or "reject"');
  }

  if (value.action === 'reject' && !value.rejectionReason) {
    errors.push('Rejection reason is required when rejecting a sample request');
  }

  assertMaxLength(errors, value.rejectionReason, 1000, 'Rejection reason');
  assertMaxLength(errors, value.stockLocation, 200, 'Stock location');

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates dispatch and shipment tracking details.
 * 
 * Usecase: Validates courier name, tracking number, and dates upon dispatch.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result
 */
/**
 * Stock address picked (or typed) after approval.
 *
 * The route had no schema at all, so an empty body used to be stored as a blank
 * address; the picker is the only way in, but the server still checks.
 */
/** Why the sample is being called off. Optional — a client may just change their mind. */
function validateSampleCancel(body) {
  const source = asObject(body);
  const errors = [];
  const value = { reason: trimString(source.reason || source.cancellationReason) };

  assertMaxLength(errors, value.reason, 500, 'Cancellation reason');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateSampleStockAddress(body) {
  const source = asObject(body);
  const errors = [];
  const value = {
    stockLocation: trimString(source.stockLocation || source.stockAddress)
  };

  assertRequired(errors, value.stockLocation, 'Stock address');
  assertMaxLength(errors, value.stockLocation, 300, 'Stock address');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateSampleDispatch(body) {
  const source = asObject(body);
  const errors = [];

  const value = {
    courierName: trimString(source.courierName),
    trackingNumber: trimString(source.trackingNumber),
    dispatchDate: assertOptionalDate(errors, source.dispatchDate, 'Dispatch date'),
    estimatedDeliveryDate: assertOptionalDate(errors, source.estimatedDeliveryDate, 'Estimated delivery date')
  };

  assertRequired(errors, value.courierName, 'Courier name');

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates customer feedback submission payload.
 * 
 * Usecase: Validates rating (1-5), comments, and order interest boolean.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result
 */
function validateSampleFeedback(body) {
  const source = asObject(body);
  const errors = [];

  const rating = Number(source.rating);
  const value = {
    rating: Number.isFinite(rating) ? rating : null,
    comments: trimString(source.comments) || '',
    interestedInOrder: source.interestedInOrder !== undefined ? Boolean(source.interestedInOrder) : null,
    requiresImprovement: Boolean(source.requiresImprovement),
    routedDepartment: trimString(source.routedDepartment) || 'None',
    improvementNotes: trimString(source.improvementNotes) || ''
  };

  if (!value.rating || value.rating < 1 || value.rating > 5) {
    errors.push('Rating must be between 1 and 5');
  }

  const validDepartments = ['R&D / Technical', 'Quality Control', 'Production', 'Sales', 'None'];
  if (value.requiresImprovement && !validDepartments.includes(value.routedDepartment)) {
    errors.push('Invalid department selected for improvement request routing');
  }

  assertMaxLength(errors, value.comments, 2000, 'Comments');
  assertMaxLength(errors, value.improvementNotes, 2000, 'Improvement notes');

  if (errors.length) return fail(errors);
  return ok(value);
}

module.exports = {
  SAMPLE_STATUSES,
  EDITABLE_SAMPLE_STATUSES,
  validateSampleCreate,
  validateSampleUpdate,
  validateSampleApproval,
  validateSampleCancel,
  validateSampleStockAddress,
  validateSampleDispatch,
  validateSampleFeedback
};
