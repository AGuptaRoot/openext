'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertOptionalDate,
  assertDateOrder
} = require('./common.util');

const MAX_LINE_ITEMS = 100;

function validateLineItems(errors, rawItems, { required = false } = {}) {
  if (rawItems === undefined && !required) return undefined;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    errors.push('At least one line item is required');
    return undefined;
  }
  if (rawItems.length > MAX_LINE_ITEMS) {
    errors.push(`A maximum of ${MAX_LINE_ITEMS} line items is allowed`);
    return undefined;
  }

  const items = [];
  rawItems.forEach((rawItem, index) => {
    const item = asObject(rawItem);
    const label = `Line item ${index + 1}`;
    const name = trimString(item.name || item.itemName) || '';
    const description = trimString(item.description) || name || '';
    const qty = Number(item.qty !== undefined ? item.qty : item.quantity);
    const rate = Number(item.rate !== undefined ? item.rate : item.unitPrice);
    const hasTax = item.tax !== undefined && item.tax !== '';
    const tax = hasTax ? Number(item.tax) : undefined;
    const file = trimString(item.file || item.attachmentUrl) || '';
    const productId = trimString(item.productId) || '';
    const unit = trimString(item.unit) || '';
    const sourceRef = trimString(item.sourceRef) || '';
    if (sourceRef && !/^[A-Za-z0-9:_-]{1,64}$/.test(sourceRef)) errors.push(`${label}: sourceRef is not valid`);
    const group = trimString(item.group) || '';
    if (group && !/^[a-z][a-z0-9_]{0,39}$/.test(group)) errors.push(`${label}: group is not valid`);
    if (unit.length > 60) errors.push(`${label}: unit must be 60 characters or fewer`);
    let extra;
    if (item.extra !== undefined && item.extra !== null) {
      if (typeof item.extra !== 'object' || Array.isArray(item.extra)) {
        errors.push(`${label}: extra must be an object`);
      } else {
        extra = {};
        const entries = Object.entries(item.extra);
        if (entries.length > 10) errors.push(`${label}: at most 10 extra values are allowed`);
        for (const [key, value] of entries.slice(0, 10)) {
          if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key)) {
            errors.push(`${label}: "${key}" is not a valid column key`);
            continue;
          }
          const text = value === null || value === undefined ? '' : String(value).trim();
          if (text.length > 200) errors.push(`${label}: ${key} must be 200 characters or fewer`);
          if (text) extra[key] = text;
        }
      }
    }

    if (!description && !name) errors.push(`${label}: description or item name is required`);
    if (description.length > 500) errors.push(`${label}: description must be 500 characters or fewer`);
    if (!Number.isFinite(qty) || qty <= 0) errors.push(`${label}: qty must be greater than zero`);
    if (!Number.isFinite(rate) || rate < 0) errors.push(`${label}: rate must be zero or greater`);
    if (hasTax && (!Number.isFinite(tax) || tax < 0 || tax > 100)) {
      errors.push(`${label}: tax must be between 0 and 100`);
    }

    items.push({
      name: name || description,
      description: description || name,
      qty,
      rate,
      ...(hasTax ? { tax } : {}),
      ...(file ? { file } : {}),
      ...(productId ? { productId } : {}),
      ...(unit ? { unit } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(group ? { group } : {}),
      ...(extra && Object.keys(extra).length ? { extra } : {})
    });
  });

  return items;
}

function validateNotes(errors, value) {
  if (value === undefined) return undefined;
  const notes = trimString(value) || '';
  if (notes.length > 2000) errors.push('Notes must be 2000 characters or fewer');
  return notes;
}

const MAX_SECTIONS = 10;

/** Titled text sections of a quotation: [{ title (≤ 80), body (≤ 3000) }], at most 10. */
function validateSections(errors, raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push('sections must be a list');
    return [];
  }
  if (raw.length > MAX_SECTIONS) errors.push(`At most ${MAX_SECTIONS} sections are allowed`);
  const out = [];
  raw.slice(0, MAX_SECTIONS).forEach((item, i) => {
    const title = trimString(item && item.title);
    const body = String((item && item.body) || '').replace(/\r\n/g, '\n').trim();
    if (!title && !body) return;
    if (!title) errors.push(`Section ${i + 1} needs a title`);
    if (title.length > 80) errors.push(`Section ${i + 1} title must be 80 characters or fewer`);
    if (!body) errors.push(`Section "${title || i + 1}" needs some text`);
    if (body.length > 3000) errors.push(`Section "${title || i + 1}" must be 3000 characters or fewer`);
    out.push({ title, body });
  });
  return out;
}

function validateQuotationCreate(body) {
  const source = asObject(body);
  const errors = [];
  const clientId = trimString(source.clientId) || '';
  const leadId = trimString(source.leadId) || '';
  const opportunityId = trimString(source.opportunityId || source.dealId) || '';

  if (!clientId && !leadId) errors.push('clientId or leadId is required');
  if (clientId && leadId) errors.push('Provide either clientId or leadId, not both');

  const lineItems = validateLineItems(errors, source.lineItems, { required: true });
  const issueDate = assertOptionalDate(errors, source.issueDate, 'Issue date');
  const expiryDate = assertOptionalDate(errors, source.expiryDate || source.validTill, 'Valid Till / Expiry date');
  const notes = validateNotes(errors, source.notes);
  const recipientNotes = validateNotes(errors, source.recipientNotes || source.noteForRecipient);
  const sections = validateSections(errors, source.sections);
  const title = trimString(source.title) || '';
  const description = trimString(source.description) || '';
  const currency = trimString(source.currency)?.toUpperCase() || 'INR';
  const taxCalculation = trimString(source.taxCalculation)?.toLowerCase() === 'before_discount'
    ? 'before_discount'
    : 'after_discount';

  const discountPercent = source.discountPercent !== undefined ? Math.min(100, Math.max(0, Number(source.discountPercent) || 0)) : undefined;
  const discountAmount = source.discountAmount !== undefined ? Math.max(0, Number(source.discountAmount) || 0) : undefined;
  const shippingCharge = source.shippingCharge !== undefined ? Math.max(0, Number(source.shippingCharge) || 0) : undefined;
  const shippingState = trimString(source.shippingState) || undefined;

  const value = {
    ...(clientId ? { clientId } : {}),
    ...(leadId ? { leadId } : {}),
    ...(opportunityId ? { opportunityId, dealId: opportunityId } : {}),
    lineItems,
    title,
    description,
    currency,
    taxCalculation,
    notes: notes || '',
    recipientNotes: recipientNotes || '',
    sections,
    ...(discountPercent !== undefined ? { discountPercent } : {}),
    ...(discountAmount !== undefined ? { discountAmount } : {}),
    ...(shippingCharge !== undefined ? { shippingCharge } : {}),
    ...(shippingState ? { shippingState } : {}),
    ...(issueDate !== undefined ? { issueDate } : {}),
    ...(expiryDate !== undefined ? { expiryDate } : {})
  };

  applyQuotationPaymentTerms(value, source, errors);

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * How the client is asked to pay a quotation.
 *
 * Accepted on create and update; the service ignores it while proforma &
 * advance payment is off, so a stale value can never take effect.
 */
function applyQuotationPaymentTerms(value, source, errors) {
  if (source.paymentType !== undefined) {
    const paymentType = trimString(source.paymentType)?.toLowerCase();
    if (paymentType && !['full', 'advance'].includes(paymentType)) {
      errors.push('paymentType must be "full" or "advance"');
    } else {
      value.paymentType = paymentType || 'full';
    }
  }
  if (source.advanceMode !== undefined) {
    const mode = trimString(source.advanceMode)?.toLowerCase();
    if (mode && !['percent', 'amount'].includes(mode)) {
      errors.push('advanceMode must be "percent" or "amount"');
    } else {
      value.advanceMode = mode || 'percent';
    }
  }
  if (source.advanceValue !== undefined) {
    const amount = Number(source.advanceValue);
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push('advanceValue must be zero or a positive number');
    } else if ((value.advanceMode || source.advanceMode) === 'percent' && amount > 100) {
      errors.push('An advance percentage cannot be more than 100');
    } else {
      value.advanceValue = Math.round(amount * 100) / 100;
    }
  }
}

function validateQuotationUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  const clientId = source.clientId !== undefined ? trimString(source.clientId) : undefined;
  const leadId = source.leadId !== undefined ? trimString(source.leadId) : undefined;

  if (clientId !== undefined && leadId !== undefined) {
    if (clientId && leadId) {
      errors.push('Provide either clientId or leadId, not both');
    } else if (clientId) {
      value.clientId = clientId;
      value.leadId = '';
    } else if (leadId) {
      value.leadId = leadId;
      value.clientId = '';
    }
  } else if (clientId !== undefined) {
    if (clientId) {
      value.clientId = clientId;
    }
  } else if (leadId !== undefined) {
    if (leadId) {
      value.leadId = leadId;
    }
  }
  if (source.opportunityId !== undefined || source.dealId !== undefined) {
    value.opportunityId = trimString(source.opportunityId || source.dealId) || '';
    value.dealId = value.opportunityId;
  }
  if (source.lineItems !== undefined) {
    value.lineItems = validateLineItems(errors, source.lineItems, { required: true });
  }
  if (source.issueDate !== undefined) {
    value.issueDate = assertOptionalDate(errors, source.issueDate, 'Issue date');
  }
  if (source.expiryDate !== undefined || source.validTill !== undefined) {
    value.expiryDate = assertOptionalDate(errors, source.expiryDate || source.validTill, 'Valid Till / Expiry date');
  }
  if (source.title !== undefined) value.title = trimString(source.title);
  if (source.description !== undefined) value.description = trimString(source.description);
  if (source.currency !== undefined) value.currency = trimString(source.currency)?.toUpperCase() || 'INR';
  if (source.taxCalculation !== undefined) {
    value.taxCalculation = trimString(source.taxCalculation)?.toLowerCase() === 'before_discount' ? 'before_discount' : 'after_discount';
  }
  if (source.discountPercent !== undefined) {
    value.discountPercent = Math.min(100, Math.max(0, Number(source.discountPercent) || 0));
  }
  if (source.discountAmount !== undefined) {
    value.discountAmount = Math.max(0, Number(source.discountAmount) || 0);
  }
  if (source.shippingCharge !== undefined) {
    value.shippingCharge = Math.max(0, Number(source.shippingCharge) || 0);
  }
  if (source.shippingState !== undefined) {
    value.shippingState = trimString(source.shippingState);
  }
  applyQuotationPaymentTerms(value, source, errors);
  if (source.notes !== undefined) value.notes = validateNotes(errors, source.notes);
  if (source.recipientNotes !== undefined || source.noteForRecipient !== undefined) {
    value.recipientNotes = validateNotes(errors, source.recipientNotes || source.noteForRecipient);
  }
  if (source.sections !== undefined) value.sections = validateSections(errors, source.sections);

  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');
  if (errors.length) return fail(errors);
  return ok(value);
}

function validateInvoiceCreate(body) {
  const source = asObject(body);
  const errors = [];
  const clientId = trimString(source.clientId);
  if (!clientId) errors.push('clientId is required');

  const lineItems = validateLineItems(errors, source.lineItems, { required: true });
  const issueDate = assertOptionalDate(errors, source.issueDate, 'Issue date');
  const dueDate = assertOptionalDate(errors, source.dueDate, 'Due date');
  const notes = validateNotes(errors, source.notes);
  const terms = trimString(source.terms) || '';
  const currency = trimString(source.currency)?.toUpperCase() || 'INR';
  const exchangeRate = source.exchangeRate !== undefined ? Math.max(0.0001, Number(source.exchangeRate) || 1) : 1;
  const taxCalculation = trimString(source.taxCalculation)?.toLowerCase() === 'before_discount'
    ? 'before_discount'
    : 'after_discount';
  const discountType = trimString(source.discountType) === 'amount' ? 'amount' : 'percent';
  const discountPercent = source.discountPercent !== undefined ? Math.min(100, Math.max(0, Number(source.discountPercent) || 0)) : 0;
  const discountAmount = source.discountAmount !== undefined ? Math.max(0, Number(source.discountAmount) || 0) : 0;

  assertDateOrder(errors, issueDate, dueDate, 'Issue date', 'Due date');

  if (errors.length) return fail(errors);
  return ok({
    clientId,
    lineItems,
    notes: notes || '',
    terms,
    currency,
    exchangeRate,
    taxCalculation,
    discountType,
    discountPercent,
    discountAmount,
    ...(trimString(source.invoiceNo) ? { invoiceNo: trimString(source.invoiceNo) } : {}),
    ...(trimString(source.projectId) ? { projectId: trimString(source.projectId) } : {}),
    ...(trimString(source.bankAccount) ? { bankAccount: trimString(source.bankAccount) } : {}),
    ...(trimString(source.paymentDetails) ? { paymentDetails: trimString(source.paymentDetails) } : {}),
    ...(trimString(source.billingAddress) ? { billingAddress: trimString(source.billingAddress) } : {}),
    ...(trimString(source.shippingAddress) ? { shippingAddress: trimString(source.shippingAddress) } : {}),
    ...(trimString(source.file) ? { file: trimString(source.file) } : {}),
    ...(Array.isArray(source.attachments) ? { attachments: source.attachments } : {}),
    ...(source.reminder && typeof source.reminder === 'object' ? {
      reminder: {
        enabled: Boolean(source.reminder.enabled),
        timing: trimString(source.reminder.timing) === 'before_due_date' ? 'before_due_date' : 'after_due_date',
        count: Math.max(1, Number(source.reminder.count) || 1),
        days: Math.max(1, Number(source.reminder.days) || 3)
      }
    } : {}),
    ...(trimString(source.quotationId) ? { quotationId: trimString(source.quotationId) } : {}),
    ...(trimString(source.recurringProfileId) ? { recurringProfileId: trimString(source.recurringProfileId) } : {}),
    ...(issueDate !== undefined ? { issueDate } : {}),
    ...(dueDate !== undefined ? { dueDate } : {})
  });
}

function validateInvoiceUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.clientId !== undefined) {
    const clientId = trimString(source.clientId);
    if (!clientId) errors.push('clientId cannot be empty');
    else value.clientId = clientId;
  }
  if (source.lineItems !== undefined) {
    value.lineItems = validateLineItems(errors, source.lineItems, { required: true });
  }
  if (source.issueDate !== undefined) {
    value.issueDate = assertOptionalDate(errors, source.issueDate, 'Issue date');
  }
  if (source.dueDate !== undefined) {
    value.dueDate = assertOptionalDate(errors, source.dueDate, 'Due date');
  }
  if (source.notes !== undefined) value.notes = validateNotes(errors, source.notes);
  if (source.terms !== undefined) value.terms = trimString(source.terms);
  if (source.currency !== undefined) value.currency = trimString(source.currency)?.toUpperCase() || 'INR';
  if (source.exchangeRate !== undefined) value.exchangeRate = Math.max(0.0001, Number(source.exchangeRate) || 1);
  if (source.taxCalculation !== undefined) {
    value.taxCalculation = trimString(source.taxCalculation)?.toLowerCase() === 'before_discount' ? 'before_discount' : 'after_discount';
  }
  if (source.discountType !== undefined) {
    value.discountType = trimString(source.discountType) === 'amount' ? 'amount' : 'percent';
  }
  if (source.discountPercent !== undefined) {
    value.discountPercent = Math.min(100, Math.max(0, Number(source.discountPercent) || 0));
  }
  if (source.discountAmount !== undefined) {
    value.discountAmount = Math.max(0, Number(source.discountAmount) || 0);
  }
  if (source.projectId !== undefined) value.projectId = trimString(source.projectId);
  if (source.bankAccount !== undefined) value.bankAccount = trimString(source.bankAccount);
  if (source.paymentDetails !== undefined) value.paymentDetails = trimString(source.paymentDetails);
  if (source.billingAddress !== undefined) value.billingAddress = trimString(source.billingAddress);
  if (source.shippingAddress !== undefined) value.shippingAddress = trimString(source.shippingAddress);
  if (source.file !== undefined) value.file = trimString(source.file);
  if (source.attachments !== undefined && Array.isArray(source.attachments)) value.attachments = source.attachments;
  if (source.reminder !== undefined && typeof source.reminder === 'object') {
    value.reminder = {
      enabled: Boolean(source.reminder.enabled),
      timing: trimString(source.reminder.timing) === 'before_due_date' ? 'before_due_date' : 'after_due_date',
      count: Math.max(1, Number(source.reminder.count) || 1),
      days: Math.max(1, Number(source.reminder.days) || 3)
    };
  }

  assertDateOrder(errors, value.issueDate, value.dueDate, 'Issue date', 'Due date');
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');
  if (errors.length) return fail(errors);
  return ok(value);
}

function validateInvoiceWriteOff(body) {
  const source = asObject(body);
  const reason = trimString(source.reason || source.notes || 'Uncollectible Bad Debt');
  return ok({ reason });
}

function validateQuotationRevision(body) {
  const source = asObject(body);
  const errors = [];

  const revisionNotes = trimString(source.revisionNotes || source.notes || source.reason);
  const value = {
    revisionNotes
  };

  if (source.lineItems !== undefined) {
    value.lineItems = validateLineItems(errors, source.lineItems, { required: true });
  }
  if (source.expiryDate !== undefined || source.validTill !== undefined) {
    value.expiryDate = assertOptionalDate(errors, source.expiryDate || source.validTill, 'Expiry date');
  }
  if (source.discountPercent !== undefined) {
    value.discountPercent = Math.min(100, Math.max(0, Number(source.discountPercent) || 0));
  }
  if (source.recipientNotes !== undefined) {
    value.recipientNotes = validateNotes(errors, source.recipientNotes);
  }
  if (source.terms !== undefined) {
    value.terms = trimString(source.terms);
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function validatePortalAccept(body) {
  const source = asObject(body);
  const errors = [];

  const name = trimString(source.name || source.acceptedBy);
  const email = trimString(source.email || source.acceptedEmail);
  const signature = trimString(source.signature);
  const comments = trimString(source.comments || source.notes);

  if (!name && !signature) {
    errors.push('Name or electronic signature is required for acceptance');
  }

  if (errors.length) return fail(errors);
  return ok({
    name: name || 'Authorized Signatory',
    email,
    signature: signature || `Signed by ${name}`,
    comments
  });
}

function validateInvoiceWriteOff(body) {
  const source = asObject(body);
  const reason = trimString(source.reason || source.writtenOffReason || 'Uncollectible Bad Debt');
  return ok({
    reason: reason || 'Uncollectible Bad Debt'
  });
}

function validatePortalReject(body) {
  const source = asObject(body);
  const errors = [];

  const reason = trimString(source.reason || source.rejectionReason || source.feedback);
  if (!reason) {
    errors.push('Rejection reason / feedback is required');
  }

  const name = trimString(source.name || source.rejectedBy);
  const email = trimString(source.email || source.rejectedEmail);

  if (errors.length) return fail(errors);
  return ok({
    reason,
    name: name || 'Client',
    email
  });
}

module.exports = {
  MAX_LINE_ITEMS,
  validateSections,
  validateLineItems,
  validateQuotationCreate,
  validateQuotationUpdate,
  validateQuotationRevision,
  validatePortalAccept,
  validatePortalReject,
  validateInvoiceCreate,
  validateInvoiceUpdate,
  validateInvoiceWriteOff
};
