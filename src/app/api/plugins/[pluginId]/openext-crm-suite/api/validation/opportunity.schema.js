'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength,
  assertOptionalDate,
  assertEmail,
  assertMobile
} = require('./common.util');

const OPPORTUNITY_STAGES = [
  'Discovery',
  'Requirement Confirmed',
  'Product Validated',
  'Sample Approved',
  'Commercial Discussion',
  'Quotation Sent',
  'Won',
  'Negotiation',
  'Lost'
];

const STAGE_PROBABILITIES = {
  Discovery: 10,
  'Requirement Confirmed': 25,
  'Product Validated': 40,
  'Sample Approved': 55,
  'Commercial Discussion': 70,
  Negotiation: 85,
  'Quotation Sent': 95,
  Won: 100,
  Lost: 0
};

/**
 * Validates payload for creating an Opportunity.
 * 
 * Usecase: Validates initial deal fields, product line items array, and client account link.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result containing ok status and cleaned values or error list
 */
function validateOpportunityCreate(body) {
  const source = asObject(body);
  const errors = [];

  const rawProducts = Array.isArray(source.products) ? source.products : [];
  const products = rawProducts.map((p) => {
    const item = asObject(p);
    const qty = Math.max(1, Number(item.quantity) || 1);
    const price = Math.max(0, Number(item.unitPrice) || 0);
    const tax = item.tax !== undefined && item.tax !== null ? Math.min(100, Math.max(0, Number(item.tax) || 0)) : 18;
    return {
      productName: trimString(item.productName) || 'General Item',
      description: trimString(item.description) || '',
      quantity: qty,
      unitPrice: price,
      tax,
      amount: Math.round(qty * price * 100) / 100
    };
  });

  const computedRevenue = products.reduce((sum, p) => sum + p.amount, 0);
  const manualRevenue = Number(
    source.estimatedDealValue != null ? source.estimatedDealValue : source.expectedRevenue
  );
  const expectedRevenue = Number.isFinite(manualRevenue) && manualRevenue >= 0
    ? Math.round(manualRevenue * 100) / 100
    : Math.round(computedRevenue * 100) / 100;

  const stage = trimString(source.stage) || 'Discovery';
  if (!stage) {
    errors.push('Pipeline stage is required');
  }

  const probInput = Number(source.probability);
  const probability = Number.isFinite(probInput) && probInput >= 0 && probInput <= 100
    ? probInput
    : (STAGE_PROBABILITIES[stage] ?? 50);

  const weightedRevenue = Math.round(expectedRevenue * (probability / 100) * 100) / 100;
  const isLost = String(stage).toLowerCase() === 'lost';

  const rawCurrency = (trimString(source.currencyCode || source.currency) || '').toUpperCase();
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : '';
  const exchangeRateRaw = Number(source.exchangeRate);
  const exchangeRate =
    Number.isFinite(exchangeRateRaw) && exchangeRateRaw > 0 ? exchangeRateRaw : 1;

  const value = {
    title: trimString(source.title),
    leadId: trimString(source.leadId) || null,
    clientId: trimString(source.clientId) || '',
    contactPerson: trimString(source.contactPerson) || '',
    contactEmail: trimString(source.contactEmail) || '',
    contactMobile: trimString(source.contactMobile) || '',
    contactId: trimString(source.contactId) || null,
    products,
    expectedRevenue,
    currency,
    currencyCode: currency,
    exchangeRate,
    shippingState: trimString(source.shippingState) || '',
    shippingCharge: Math.max(0, Number(source.shippingCharge) || 0),
    probability,
    weightedRevenue,
    stage,
    salesOwner: trimString(source.salesOwner) || '',
    expectedCloseDate: assertOptionalDate(errors, source.expectedCloseDate, 'Expected close date'),
    // Normally stamped by the stage change that closes the deal; accepted here so
    // a deal created from an already-closed record can carry its real close date.
    closedAt: assertOptionalDate(errors, source.closedAt, 'Closed at'),
    lostReason: isLost ? trimString(source.lostReason) : null
  };

  assertRequired(errors, value.title, 'Opportunity title');
  if (!value.clientId && !value.leadId) {
    errors.push('Select a client account or an inbound lead');
  }
  assertMaxLength(errors, value.title, 200, 'Opportunity title');
  assertEmail(errors, value.contactEmail, 'Contact email');
  assertMobile(errors, value.contactMobile, 'Contact mobile');

  if (isLost && !value.lostReason) {
    errors.push('Lost reason is required when marking opportunity as Lost');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates an edit to an existing opportunity.
 *
 * Every field is optional — only what the caller sends is changed. Products,
 * shipping and currency belong to the deal's own commercial detail; contact
 * fields may additionally be pushed onto the linked Contacts record by the
 * service.
 */
function validateOpportunityUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined) {
    value.title = trimString(source.title);
    assertRequired(errors, value.title, 'Opportunity title');
    assertMaxLength(errors, value.title, 200, 'Opportunity title');
  }

  if (source.products !== undefined) {
    if (!Array.isArray(source.products)) {
      errors.push('Products must be an array');
    } else if (source.products.length > 200) {
      errors.push('An opportunity cannot hold more than 200 line items');
    } else {
      value.products = source.products.map((raw, index) => {
        const item = asObject(raw);
        const productName = trimString(item.productName || item.name);
        if (!productName) errors.push(`Line ${index + 1}: product name is required`);
        assertMaxLength(errors, productName, 200, `Line ${index + 1} product name`);
        assertMaxLength(errors, trimString(item.description), 2000, `Line ${index + 1} description`);

        const qty = Number(item.quantity);
        if (!Number.isFinite(qty) || qty < 1) {
          errors.push(`Line ${index + 1}: quantity must be at least 1`);
        }
        const unitPrice = Number(item.unitPrice);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
          errors.push(`Line ${index + 1}: unit price cannot be negative`);
        }
        const tax =
          item.tax === undefined || item.tax === null || item.tax === '' ? 18 : Number(item.tax);
        if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
          errors.push(`Line ${index + 1}: tax must be between 0 and 100`);
        }

        const safeQty = Number.isFinite(qty) && qty >= 1 ? qty : 1;
        const safePrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0;
        return {
          productName: productName || 'General Item',
          description: trimString(item.description) || '',
          quantity: safeQty,
          unitPrice: safePrice,
          tax: Number.isFinite(tax) ? Math.min(100, Math.max(0, tax)) : 18,
          amount: Math.round(safeQty * safePrice * 100) / 100
        };
      });
    }
  }

  if (source.shippingState !== undefined) {
    value.shippingState = trimString(source.shippingState) || '';
    assertMaxLength(errors, value.shippingState, 120, 'Shipping state');
  }

  if (source.shippingCharge !== undefined) {
    const charge = Number(source.shippingCharge);
    if (!Number.isFinite(charge) || charge < 0) {
      errors.push('Shipping charge cannot be negative');
    } else {
      value.shippingCharge = Math.round(charge * 100) / 100;
    }
  }

  if (source.probability !== undefined) {
    const prob = Number(source.probability);
    if (!Number.isFinite(prob) || prob < 0 || prob > 100) {
      errors.push('Probability must be between 0 and 100');
    } else {
      value.probability = prob;
    }
  }

  if (source.currency !== undefined || source.currencyCode !== undefined) {
    const raw = (trimString(source.currencyCode || source.currency) || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(raw)) {
      errors.push('Currency must be a 3-letter ISO code (e.g. INR, USD)');
    } else {
      value.currency = raw;
      value.currencyCode = raw;
    }
  }

  if (source.exchangeRate !== undefined) {
    const rate = Number(source.exchangeRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      errors.push('Exchange rate must be greater than zero');
    } else {
      value.exchangeRate = rate;
    }
  }

  if (source.contactPerson !== undefined) {
    value.contactPerson = trimString(source.contactPerson) || '';
    assertMaxLength(errors, value.contactPerson, 200, 'Contact person');
  }
  if (source.contactEmail !== undefined) {
    value.contactEmail = trimString(source.contactEmail) || '';
    assertEmail(errors, value.contactEmail, 'Contact email');
  }
  if (source.contactMobile !== undefined) {
    value.contactMobile = trimString(source.contactMobile) || '';
    assertMobile(errors, value.contactMobile, 'Contact mobile');
  }
  if (source.syncContactRecord !== undefined) {
    value.syncContactRecord = Boolean(source.syncContactRecord);
  }

  if (!Object.keys(value).length && !errors.length) {
    errors.push('No supported fields were provided');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates payload for changing an opportunity's stage.
 * 
 * Usecase: Handles stage transition and updates probability % and lost reason if applicable.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result
 */
function validateStageChange(body) {
  const source = asObject(body);
  const errors = [];

  const stage = trimString(source.stage);
  if (!stage) {
    errors.push('Stage is required');
  }

  const probInput = Number(source.probability);
  const probability = Number.isFinite(probInput) && probInput >= 0 && probInput <= 100
    ? probInput
    : (STAGE_PROBABILITIES[stage] ?? 50);

  const isLost = String(stage).toLowerCase() === 'lost';
  const lostReason = isLost ? trimString(source.lostReason) : null;
  if (isLost && !lostReason) {
    errors.push('Lost reason is required when moving opportunity to Lost');
  }

  if (errors.length) return fail(errors);
  return ok({ stage, probability, lostReason });
}

/**
 * Validates payload for reassigning opportunity sales ownership.
 *
 * Usecase: Admin / sales manager assigns a deal to another sales representative.
 *
 * @param {Object} body Request body
 * @returns {Object} Validation result
 */
function validateAssignOwner(body) {
  const source = asObject(body);
  const errors = [];
  const salesOwner = trimString(source.salesOwner);

  assertRequired(errors, salesOwner, 'Sales owner');

  if (errors.length) return fail(errors);
  return ok({ salesOwner });
}

module.exports = {
  OPPORTUNITY_STAGES,
  STAGE_PROBABILITIES,
  validateOpportunityCreate,
  validateOpportunityUpdate,
  validateStageChange,
  validateAssignOwner
};
