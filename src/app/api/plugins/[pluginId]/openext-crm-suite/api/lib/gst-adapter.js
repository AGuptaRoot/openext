'use strict';

/**
 * GST adapter (CRM 3.53.0, documentation/gst-planning/00 §3.2).
 *
 * The copied GST-app helpers (lib/gst-core) expect the app's own "bill" shape. This is the ONE place
 * that turns CRM values into that shape, so every GST service uses the same mapping. Pure: no database,
 * no request, no personal data logged. It knows no industry; extension values arrive as plain fields.
 */

const { loadGstModule } = require('./gst-core');

const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A date as YYYY-MM-DD in the business time zone. Never `toISOString().slice(0, 10)`: that is the UTC
 * day, which is the previous day for anything saved in India between midnight and 05:30.
 */
function localIsoDate(value, timeZone = DEFAULT_TIME_ZONE) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The seller (agency / business): { gstin, state, country }. The country is always India for GST. */
function toGstProfile(seller = {}) {
  return {
    gstin: text(seller.gstin).toUpperCase(),
    state: text(seller.state),
    country: 'India'
  };
}

/** The buyer: { name, gstin, state, country, isSEZ, isDeemedExport }. */
function toGstClient(client = {}) {
  return {
    name: text(client.name),
    gstin: text(client.gstin).toUpperCase(),
    state: text(client.state),
    country: text(client.country) || 'India',
    isSEZ: client.isSEZ === true,
    isDeemedExport: client.isDeemedExport === true
  };
}

/**
 * CRM line items → GST-app items. CRM lines use { name, description, qty, rate, tax, discount?, sac? }.
 * `discount` is a fixed rupee amount on the line (the GST app's fixed mode).
 */
function toGstItems(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const l = line || {};
    return {
      name: text(l.name) || text(l.description),
      hsn: text(l.sac || l.hsn),
      quantity: num(l.qty !== undefined ? l.qty : l.quantity),
      rate: num(l.rate),
      taxPercent: num(l.tax !== undefined ? l.tax : l.taxPercent),
      discount: num(l.discount)
    };
  });
}

/**
 * The CRM's whole-bill discount as GST-app invoice options. The CRM gives a percent or an amount and
 * taxCalculation 'after_discount' (GST on the discounted value = the app's "Before GST" trade discount)
 * or 'before_discount' (GST on the full value, discount taken off the total = the app's "After GST").
 * The amount the CRM worked out is passed as a fixed value, so both agree on the rupees taken off.
 */
function toBillDiscountOptions({ discountAmount, taxCalculation } = {}) {
  const amount = num(discountAmount);
  if (amount <= 0) return {};
  return {
    invoiceDiscountType: 'fixed',
    invoiceDiscountValue: Math.round(amount * 100) / 100,
    invoiceDiscountBeforeGst: taxCalculation !== 'before_discount'
  };
}

/** Everything computeInvoiceTotals needs, from CRM values. */
function toGstTotalsInput({
  seller, client, lines, placeOfSupply, taxInclusive, isLUT, reverseCharge,
  compositionScheme, discountAmount, taxCalculation
} = {}) {
  const showGST = compositionScheme !== true;
  return {
    profile: toGstProfile(seller),
    client: toGstClient(client),
    details: { placeOfSupply: text(placeOfSupply) },
    items: toGstItems(lines),
    showGST,
    taxInclusive: taxInclusive === true,
    invoiceOptions: {
      isLUT: isLUT === true,
      reverseCharge: reverseCharge === true,
      showGST,
      ...toBillDiscountOptions({ discountAmount, taxCalculation })
    }
  };
}

/** A clear error when the seller's GST details are missing: never fall back to a default state. */
function assertSellerReady(seller, getStateCode) {
  const profile = toGstProfile(seller);
  const code = getStateCode(profile.state || profile.gstin);
  if (!profile.gstin || !code) {
    const error = new Error('Set your GSTIN and state in Settings → GST before issuing a GST document.');
    error.status = 422;
    error.code = 'GST_SELLER_NOT_READY';
    throw error;
  }
  return code;
}

/**
 * Tax for one document by the GST app's engine. Saves nothing.
 * Returns the engine's totals unchanged (cgst, sgst, utgst, igst, taxTotal, isInterstate, warnings, ...).
 */
async function computeTotals(input = {}) {
  const utils = await loadGstModule('utils');
  assertSellerReady(input.seller, utils.getStateCode);
  return utils.computeInvoiceTotals(toGstTotalsInput(input));
}

module.exports = {
  DEFAULT_TIME_ZONE,
  localIsoDate,
  toGstProfile,
  toGstClient,
  toGstItems,
  toGstTotalsInput,
  toBillDiscountOptions,
  assertSellerReady,
  computeTotals
};
