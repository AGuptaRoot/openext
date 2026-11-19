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

/**
 * TCS (income tax, collected on top of the invoice) as GST-app invoice options (03 §5). `tcsRate` is the
 * rate the CRM's TCS rule worked out (tcs.service.js). The section passed to the engine is always
 * 'custom': the engine then applies the rate from rupee one (no built-in ₹50L threshold of its own),
 * because the thresholds are the rule's slabs, already applied by the CRM.
 */
function toTcsOptions(tcs) {
  if (!tcs || tcs.applicable !== true) return {};
  const rate = Number(tcs.rate);
  return { showTCS: true, tcsRate: Number.isFinite(rate) && rate > 0 ? rate : 0, tcsSection: 'custom' };
}

/** Everything computeInvoiceTotals needs, from CRM values. */
function toGstTotalsInput({
  seller, client, lines, placeOfSupply, taxInclusive, isLUT, reverseCharge,
  compositionScheme, discountAmount, taxCalculation, tcs
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
      ...toBillDiscountOptions({ discountAmount, taxCalculation }),
      ...toTcsOptions(tcs)
    }
  };
}

/**
 * An issued CRM document (tax invoice or credit note) in the GST app's bill shape (00 §3.2, 03 §2), so the
 * copied GSTR-1 / TCS helpers read it as they read the app's own bills. Built ONLY from the frozen `gst`
 * snapshot: the figures are what the document charged, never worked out again.
 *
 * - Each snapshot line becomes one item with its own SAC in `hsn` and its taxable value as quantity × rate
 *   (the quantity of the CRM line, else 1), so the app's per-line tax split gives back the same tax.
 * - `client` is the CRM client (name, billing state / country, deemed export); the GSTIN, SEZ and export
 *   status come from the snapshot (as issued).
 * - `kind`: 'invoice' | 'credit-note'. `cancelled`: true for a cancelled invoice / void credit note.
 * Pure: no database, no request. `client.pan` is only set when the caller passes it (TCS register).
 */
function toGstBill(doc, { kind = 'invoice', seller = {}, client = {}, cancelled = false, original = {} } = {}) {
  const d = doc || {};
  const gst = d.gst || {};
  const isNote = kind === 'credit-note';
  const sourceLines = isNote ? (Array.isArray(d.items) ? d.items : []) : (Array.isArray(d.lineItems) ? d.lineItems : []);
  const gstLines = Array.isArray(gst.lines) ? gst.lines : [];
  const items = gstLines.map((g, i) => {
    const src = sourceLines[i] || {};
    const qtyRaw = Number(isNote ? src.quantity : (src.qty !== undefined ? src.qty : src.quantity));
    const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    const taxable = Number(g.taxable) || 0;
    return {
      name: text(src.description) || text(src.name) || text(g.serviceType) || 'Service',
      hsn: text(g.sac),
      quantity,
      rate: taxable / quantity,
      taxPercent: Number(g.taxPercent) || 0,
      discount: 0
    };
  });
  const tcs = gst.tcs || {};
  const foreign = gst.isExport === true;
  const clientCountry = text(client.country);
  const tcsOn = tcs.applicable === true && (Number(tcs.amount) || 0) > 0;
  return {
    id: String(d._id || ''),
    invoiceType: isNote ? 'credit-note' : (gst.compositionScheme === true ? 'bill-of-supply' : 'tax-invoice'),
    invoiceNumber: text(isNote ? d.creditNoteNumber : d.invoiceNo),
    invoiceDate: localIsoDate(isNote ? d.creditDate : d.issueDate),
    totalAmount: Number(gst.total) || 0,
    totalTaxAmount: Number(gst.totalTax) || 0,
    status: cancelled ? 'cancelled' : '',
    currency: 'INR',
    clientName: text(client.name) || text(d.clientName),
    data: {
      profile: { gstin: text(gst.sellerGstin || seller.gstin).toUpperCase(), state: text(seller.state), country: 'India' },
      client: {
        name: text(client.name) || text(d.clientName),
        gstin: text(gst.clientGstin).toUpperCase(),
        state: text(client.state) || (foreign ? '' : text(gst.placeOfSupply)),
        country: foreign ? (clientCountry && !/^(india|in|bharat)$/i.test(clientCountry) ? clientCountry : 'Outside India') : 'India',
        isSEZ: gst.isSEZ === true,
        isDeemedExport: client.isDeemedExport === true,
        ...(client.pan ? { pan: text(client.pan).toUpperCase() } : {})
      },
      details: {
        placeOfSupply: text(gst.placeOfSupply),
        ...(isNote ? { originalInvoiceNumber: text(original.invoiceNumber || d.invoiceNumber), originalInvoiceDate: localIsoDate(original.invoiceDate) } : {})
      },
      items,
      totals: {
        taxableAmount: Number(gst.taxableAmount) || 0,
        cgst: Number(gst.cgst) || 0,
        sgst: Number(gst.sgst) || 0,
        utgst: Number(gst.utgst) || 0,
        igst: Number(gst.igst) || 0,
        cess: Number(gst.cess) || 0,
        totalTaxAmount: Number(gst.totalTax) || 0,
        roundOff: Number(gst.roundOff) || 0,
        total: Number(gst.total) || 0,
        tcsAmount: tcsOn ? Number(tcs.amount) || 0 : 0,
        isInterstate: gst.isInterstate === true,
        isIntraUT: gst.isIntraUT === true,
        lutZeroRated: gst.isLUT === true
      },
      taxInclusive: false,
      invoiceOptions: {
        isLUT: gst.isLUT === true,
        reverseCharge: gst.reverseCharge === true,
        ...(tcsOn ? { showTCS: true, tcsSection: text(tcs.section) || text(tcs.ruleKey), tcsRate: Number(tcs.rate) || 0 } : {})
      }
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
  toTcsOptions,
  toGstBill,
  assertSellerReady,
  computeTotals
};
