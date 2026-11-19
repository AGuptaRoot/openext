'use strict';

/**
 * GST on documents (GST suite, CRM 3.53.0; documentation/gst-planning/01).
 *
 * Glue only: every tax figure comes from the GST app's engine (lib/gst-core computeInvoiceTotals) through
 * lib/gst-adapter. Nothing here does tax math of its own.
 *
 * - GST applies to a TAX invoice once Settings → GST is saved (GSTIN + state). Before that, and for
 *   proformas, everything works exactly as before.
 * - Tax invoices then get numbers from GstCounter (INV/26-27/0001, per financial year, no typed numbers).
 * - The engine's result is stored as the invoice's `gst` snapshot and sets the CRM's taxTotal / grandTotal,
 *   so CRM screens and GST reports agree. The snapshot is frozen once the invoice leaves Draft.
 * - The engine never blocks a payment or a conversion: if it fails, the invoice is made as before and
 *   the failure is logged (without personal data).
 */

const { resolveTenantId } = require('../utils/tenant.util');
const { loadGstModule } = require('../lib/gst-core');
const Adapter = require('../lib/gst-adapter');
const GstSettingsService = require('./gst-settings.service');

const ENGINE = 'gst-core 1.10.85';
const SERIES = new Set(['INV', 'RV', 'RF', 'CN']);
const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const SAC_RE = /^\d{4,8}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function appError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

/** The tenant's GST settings and whether GST invoices can be made. */
async function context(req) {
  // No GstSettings model registered (an older host, or a test double): GST is simply not set up.
  if (!req?.cms?.models?.get?.('GstSettings')) return { settings: GstSettingsService.present(null), ready: false };
  const settings = await GstSettingsService.get(req);
  return { settings, ready: Boolean(settings.exists && settings.gstin && settings.stateCode) };
}

/** Short financial year of a date in India time: 1 Apr 2026 – 31 Mar 2027 → '26-27'. */
function fyShort(date) {
  const iso = Adapter.localIsoDate(date || new Date()) || Adapter.localIsoDate(new Date());
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The next number of a GST series for the financial year of `date`: 'INV/26-27/0001'.
 * One atomic $inc (upsert), safe with parallel requests.
 */
async function nextNumber(req, series, date) {
  if (!SERIES.has(series)) throw appError(`Unknown GST number series ${series}`, 500);
  const Counter = req.cms?.models?.get?.('GstCounter');
  if (!Counter) throw appError('GstCounter model is not registered', 500);
  const tenantId = req.tenantId || resolveTenantId(req);
  const fy = fyShort(date);
  const take = async () => {
    const q = Counter.findOneAndUpdate(
      { tenantId, series, fy },
      { $inc: { last: 1 }, $setOnInsert: { tenantId, series, fy } },
      { upsert: true, new: true }
    );
    return q && typeof q.lean === 'function' ? q.lean() : q;
  };
  let row;
  try {
    row = await take();
  } catch (error) {
    // Two first-of-the-year requests can both try to insert; the loser simply takes the next number.
    if (error && error.code === 11000) row = await take();
    else throw error;
  }
  const n = Number(row && row.last);
  if (!Number.isInteger(n) || n < 1) throw appError('Could not take a GST number', 500);
  return `${series}/${fy}/${String(n).padStart(4, '0')}`;
}

/** The number the next document of a series would get, without taking it (for the form preview). */
async function peekNumber(req, series, date) {
  const Counter = req.cms?.models?.get?.('GstCounter');
  if (!Counter || !SERIES.has(series)) return '';
  const fy = fyShort(date);
  const q = Counter.findOne({ tenantId: req.tenantId || resolveTenantId(req), series, fy });
  const row = q && typeof q.lean === 'function' ? await q.lean() : await q;
  return `${series}/${fy}/${String((Number(row && row.last) || 0) + 1).padStart(4, '0')}`;
}

/**
 * The number of a new TAX invoice. With GST set up: always from GstCounter. A typed number is ignored
 * (decided by the user, 18 Nov 2026: no typed numbers on GST tax invoices; the form shows the number
 * read-only, and an older screen that still sends one keeps working). Without GST: `fallback(typed)`,
 * the CRM's existing numbering.
 */
async function taxInvoiceNumber(req, { issueDate, typedNumber, fallback } = {}) {
  const { ready } = await context(req);
  if (!ready) return { invoiceNo: await fallback(typedNumber), gstSeries: false };
  return { invoiceNo: await nextNumber(req, 'INV', issueDate), gstSeries: true, ignoredTypedNumber: Boolean(typedNumber && String(typedNumber).trim()) };
}

/** The client fields the engine needs (Company). */
async function clientFor(req, clientId) {
  const Company = req.cms?.models?.get?.('Company');
  if (!Company || !clientId) return {};
  let q = Company.findOne({ tenantId: req.tenantId || resolveTenantId(req), _id: String(clientId) });
  if (q && typeof q.select === 'function') q = q.select('name gst billingAddress');
  const row = q && typeof q.lean === 'function' ? await q.lean() : await q;
  if (!row) return {};
  return {
    name: row.name || '',
    gstin: row.gst?.gstin || '',
    state: row.billingAddress?.state || '',
    country: row.billingAddress?.country || '',
    isSEZ: row.gst?.isSEZ === true,
    isDeemedExport: row.gst?.isDeemedExport === true
  };
}

/**
 * The amount the GST app's engine works TCS out on (computeInvoiceTotals: the receipt including GST =
 * taxable value + line GST + cess), read off a first engine run without TCS.
 */
function tcsBaseOf(totals) {
  const lines = Array.isArray(totals && totals.lines) ? totals.lines : [];
  const tax = r2(lines.reduce((s, l) => s + (Number(l.tax) || 0), 0));
  const cess = r2(lines.reduce((s, l) => s + (Number(l.cess) || 0), 0));
  return r2((Number(totals && totals.taxableAmount) || 0) + tax + cess);
}

/** Clean SAC / service key of a line (bad values become ''). */
function lineCodes(line) {
  const sac = String((line && line.sac) || '').trim();
  const serviceType = String((line && line.serviceType) || '').trim();
  return { sac: SAC_RE.test(sac) ? sac : '', serviceType: KEY_RE.test(serviceType) ? serviceType : '' };
}

/**
 * Tax for one document by the engine. Saves nothing.
 * @returns {{ totals, snapshot }} totals = the engine's result; snapshot = the `gst` sub-document.
 */
async function calculate(req, input = {}) {
  const { settings, ready } = await context(req);
  if (!ready) throw appError('Set the GSTIN and state in Settings → GST first', 409, 'GST_SELLER_NOT_READY');
  const [utils, lut] = await Promise.all([loadGstModule('utils'), loadGstModule('lut')]);

  const client = input.client || (await clientFor(req, input.clientId));
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const issueIso = Adapter.localIsoDate(input.issueDate || new Date());
  const foreign = Boolean(client.country) && !/^(india|in|bharat)$/i.test(String(client.country).trim());
  // Place of supply of a service (IGST Act s.12(2)): the document's own, else the client's state, else the
  // state of the client's GSTIN, else (no address on record) the supplier's state. Exports have none.
  const fromGstin = client.gstin ? utils.stateNameForCode(utils.getStateCode(client.gstin)) || '' : '';
  const ownPos = String(input.placeOfSupply || '').trim() || (foreign ? '' : String(client.state || '').trim() || fromGstin);
  const posFallback = !ownPos && !foreign;
  const placeOfSupply = posFallback ? settings.stateName : ownPos;
  // LUT: an export or SEZ supply, with a LUT that covers the invoice date.
  const lutProfile = { lutArn: settings.lut.number, lutFy: settings.lut.fy };
  const isLUT = (foreign || client.isSEZ === true) && lut.lutCoversDate(lutProfile, issueIso);

  const totalsInput = {
    seller: { gstin: settings.gstin, state: settings.stateName },
    client,
    lines,
    placeOfSupply,
    isLUT,
    reverseCharge: input.reverseCharge === true,
    compositionScheme: settings.compositionScheme,
    discountAmount: input.discountAmount,
    taxCalculation: input.taxCalculation
  };
  let totals = utils.computeInvoiceTotals(Adapter.toGstTotalsInput(totalsInput));
  if (totals.needsProfileFix) throw appError('The seller state or GSTIN is incomplete in Settings → GST', 409, 'GST_SELLER_NOT_READY');

  // TCS by rule (03 §5, Step 5): only for a document with a tcsRuleKey. The rule's slabs give the rate;
  // the engine adds the TCS on top of the total (computeInvoiceTotals showTCS / tcsRate).
  let tcsResult = { tcs: { applicable: false }, warnings: [] };
  if (String(input.tcsRuleKey || '').trim()) {
    tcsResult = await require('./tcs.service').forInvoice(req, {
      settings,
      tcsRuleKey: input.tcsRuleKey,
      clientId: input.clientId,
      clientGstin: client.gstin || '',
      issueDate: issueIso,
      base: tcsBaseOf(totals),
      excludeInvoiceId: input.invoiceId
    });
    if (tcsResult.tcs.applicable) {
      totals = utils.computeInvoiceTotals(Adapter.toGstTotalsInput({ ...totalsInput, tcs: tcsResult.tcs }));
      tcsResult.tcs.amount = r2(totals.tcsAmount);
    }
  }

  const posCode = utils.getStateCode(placeOfSupply || client.gstin || '') || '';
  const engineLines = Array.isArray(totals.lines) ? totals.lines : [];
  const snapshotLines = engineLines.map((l, i) => {
    const tax = Number(l.tax) || 0;
    const half = tax / 2;
    return {
      ...lineCodes(lines[i]),
      taxPercent: Number(l.taxPct) || 0,
      taxable: r2(l.taxable),
      cgst: totals.isInterstate ? 0 : half,
      sgst: totals.isInterstate || totals.isIntraUT ? 0 : half,
      utgst: !totals.isInterstate && totals.isIntraUT ? half : 0,
      igst: totals.isInterstate ? tax : 0,
      cess: r2(l.cess)
    };
  });

  const snapshot = {
    engine: ENGINE,
    issuedAt: null,
    sellerGstin: settings.gstin,
    sellerStateCode: settings.stateCode,
    clientGstin: client.gstin || '',
    posCode,
    placeOfSupply,
    isInterstate: totals.isInterstate === true,
    isIntraUT: totals.isIntraUT === true,
    isLUT: totals.lutZeroRated === true,
    reverseCharge: input.reverseCharge === true,
    isSEZ: client.isSEZ === true,
    isExport: foreign,
    compositionScheme: settings.compositionScheme === true,
    taxableAmount: r2(totals.taxableAmount),
    cgst: r2(totals.cgst),
    sgst: r2(totals.sgst),
    utgst: r2(totals.utgst),
    igst: r2(totals.igst),
    cess: r2(totals.cess),
    totalTax: r2(totals.totalTaxAmount),
    roundOff: r2(totals.roundOff),
    otherCharges: r2(Math.max(0, Number(input.otherCharges) || 0)),
    total: r2((Number(totals.total) || 0) + Math.max(0, Number(input.otherCharges) || 0)),
    amountInWords: utils.numberToWords(Math.round((Number(totals.total) || 0) + Math.max(0, Number(input.otherCharges) || 0))),
    lines: snapshotLines,
    tcs: tcsResult.tcs,
    warnings: [
      ...(posFallback ? ['The client has no state on record, so the place of supply is your own state. Add the client billing state if it is different.'] : []),
      ...tcsResult.warnings,
      ...(Array.isArray(totals.warnings) ? totals.warnings.slice(0, 10).map(String) : [])
    ]
  };
  return { totals, snapshot };
}

/**
 * Put GST on the data of a TAX invoice before it is saved (new invoice or a draft edit).
 * Changes `data` in place and returns it. Proformas, non-INR invoices and tenants without GST settings
 * are returned unchanged. When amountPaid is set (a conversion with an advance), the paid amount,
 * balance and status are worked out again from the new total, by the same rule as the conversion.
 */
async function applyToTaxInvoice(req, data, { otherCharges = 0, agreedTotal } = {}) {
  if (!data || data.documentType === 'proforma') return data;
  if (String(data.currency || 'INR').toUpperCase() !== 'INR') return data;
  let result;
  try {
    const { ready } = await context(req);
    if (!ready) return data;
    result = await calculate(req, {
      clientId: data.clientId,
      lines: data.lineItems,
      placeOfSupply: data.placeOfSupply,
      issueDate: data.issueDate,
      discountAmount: data.discountAmount,
      taxCalculation: data.taxCalculation,
      otherCharges,
      tcsRuleKey: data.tcsRuleKey,
      invoiceId: data._id ? String(data._id) : ''
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] GST not applied to an invoice:', error?.code || '', error?.message || error);
    return data;
  }
  const { snapshot } = result;
  // A conversion bills an amount the client already agreed to (and may have paid). If the GST figures
  // do not match it within ₹1, the invoice keeps the CRM figures and gets no snapshot; this is logged.
  // TCS (income tax, Step 5) is collected ON TOP of the agreed amount, so it is left out of this check.
  const tcsAmount = snapshot.tcs && snapshot.tcs.applicable ? Number(snapshot.tcs.amount) || 0 : 0;
  if (agreedTotal !== undefined && Math.abs(snapshot.total - tcsAmount - (Number(agreedTotal) || 0)) > 1) {
    console.error(`[plugin:openext-crm-suite] GST not applied to a converted invoice: GST total differs from the agreed total by ${r2(snapshot.total - tcsAmount - (Number(agreedTotal) || 0))}`);
    return data;
  }
  if (data.status && data.status !== 'Draft') snapshot.issuedAt = new Date();
  data.gst = snapshot;
  data.placeOfSupply = snapshot.placeOfSupply;
  data.taxTotal = snapshot.totalTax;
  data.grandTotal = snapshot.total;

  const grand = snapshot.total;
  if (data.amountPaid !== undefined) {
    const paid = r2(Math.min(Number(data.amountPaid) || 0, grand));
    data.amountPaid = paid;
    if (data.advancePaid !== undefined) data.advancePaid = r2(Math.min(Number(data.advancePaid) || 0, grand));
    data.balanceDue = r2(Math.max(0, grand - paid - (Number(data.creditAmount) || 0)));
    if (['Paid', 'Partially Paid', 'Sent'].includes(data.status)) {
      data.status = paid > 0 && paid + 0.05 >= grand ? 'Paid' : paid > 0 ? 'Partially Paid' : data.status;
    }
  } else {
    data.balanceDue = grand;
  }
  return data;
}

/**
 * Charges a quotation / proforma added on top of its lines (shipping): grand total less
 * (subtotal - discount + tax). Below 5 paise it is rounding, so 0.
 */
function otherChargesOf(doc) {
  if (!doc) return 0;
  const extra = r2((Number(doc.grandTotal) || 0) - ((Number(doc.subtotal) || 0) - (Number(doc.discountAmount) || 0) + (Number(doc.taxTotal) || 0)));
  return extra > 0.05 ? extra : 0;
}

/** The invoice left Draft (sent, paid…): freeze its snapshot. No-op without a snapshot. */
async function markIssued(req, invoiceId) {
  const Invoice = req.cms?.models?.get?.('Invoice');
  if (!Invoice || !invoiceId) return;
  try {
    await Invoice.updateOne(
      { tenantId: req.tenantId || resolveTenantId(req), _id: String(invoiceId), 'gst.engine': { $nin: ['', null] }, 'gst.issuedAt': null },
      { $set: { 'gst.issuedAt': new Date() } }
    );
  } catch (error) {
    console.error('[plugin:openext-crm-suite] GST snapshot not frozen:', error?.message || error);
  }
}

/**
 * A draft tax invoice with a TCS rule is being issued (sent): its GST snapshot is worked out once more, so
 * the TCS slab split uses the PAN's cumulative base AT ISSUE (03 §5 "working it out on issue"). Returns the
 * fields to $set ({ gst, taxTotal, grandTotal, balanceDue }) or null (no TCS rule, no snapshot, already
 * issued, or the engine failed: then the draft's figures stay, as before). Invoices without a
 * tcsRuleKey are never touched here.
 */
async function refreshForIssue(req, invoice) {
  const inv = invoice || {};
  if (inv.documentType === 'proforma' || !String(inv.tcsRuleKey || '').trim()) return null;
  if (!inv.gst || !inv.gst.engine || inv.gst.issuedAt) return null;
  const lines = Array.isArray(inv.lineItems) ? inv.lineItems : [];
  const gross = lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
  const dType = inv.discountType || 'percent';
  const data = {
    _id: inv._id,
    documentType: inv.documentType,
    currency: inv.currency,
    clientId: inv.clientId,
    lineItems: lines,
    placeOfSupply: inv.placeOfSupply || '',
    issueDate: inv.issueDate,
    discountAmount: dType === 'amount' ? Math.min(gross, Number(inv.discountAmount) || 0) : Math.round(gross * (Number(inv.discountPercent) || 0)) / 100,
    taxCalculation: inv.taxCalculation || 'after_discount',
    tcsRuleKey: inv.tcsRuleKey,
    status: 'Sent'
  };
  await applyToTaxInvoice(req, data, { otherCharges: Number(inv.gst.otherCharges) || 0 });
  if (!data.gst) return null;
  const paidAndCredited = (Number(inv.amountPaid) || 0) + (Number(inv.creditAmount) || 0);
  return {
    gst: data.gst,
    taxTotal: data.taxTotal,
    grandTotal: data.grandTotal,
    balanceDue: r2(Math.max(0, data.grandTotal - paidAndCredited))
  };
}

/** True when the invoice's GST snapshot is frozen (issued) and must not be worked out again. */
function isFrozen(invoice) {
  return Boolean(invoice && invoice.gst && invoice.gst.engine && invoice.gst.issuedAt);
}

/** UPI deep link, the format the GST app prints (InvoicePreview.jsx). */
function upiLink({ upiId, payeeName, amount, docNo } = {}) {
  if (!upiId) return '';
  const e = encodeURIComponent;
  return `upi://pay?pa=${e(String(upiId).trim())}&pn=${e(payeeName || '')}&am=${(Number(amount) || 0).toFixed(2)}&cu=INR&tn=${e(`Payment for ${docNo || 'Invoice'}`)}`;
}

/**
 * For sdk.finance.gstCalculate: tax of an extension's lines. Lines: { serviceType, sac, taxPercent,
 * qty, rate, discount? }. Saves nothing; returns only figures (no client or seller identity).
 */
async function calculateForExtension(req, input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const raw = Array.isArray(src.lines) ? src.lines.slice(0, 200) : [];
  const lines = raw.map((l) => {
    const line = l && typeof l === 'object' ? l : {};
    return {
      description: String(line.description || line.name || line.serviceType || 'Line').slice(0, 200),
      qty: Number(line.qty !== undefined ? line.qty : line.quantity) || 0,
      rate: Number(line.rate) || 0,
      tax: Number(line.taxPercent !== undefined ? line.taxPercent : line.tax) || 0,
      discount: Number(line.discount) || 0,
      ...lineCodes(line)
    };
  });
  const clientId = /^[a-f0-9]{24}$/i.test(String(src.clientId || '')) ? String(src.clientId) : '';
  const { snapshot } = await calculate(req, {
    clientId,
    lines,
    placeOfSupply: typeof src.placeOfSupply === 'string' ? src.placeOfSupply.slice(0, 60) : ''
  });
  return {
    placeOfSupply: snapshot.placeOfSupply,
    posCode: snapshot.posCode,
    sellerStateCode: snapshot.sellerStateCode,
    isInterstate: snapshot.isInterstate,
    isIntraUT: snapshot.isIntraUT,
    isExport: snapshot.isExport,
    isLUT: snapshot.isLUT,
    taxableAmount: snapshot.taxableAmount,
    cgst: snapshot.cgst,
    sgst: snapshot.sgst,
    utgst: snapshot.utgst,
    igst: snapshot.igst,
    cess: snapshot.cess,
    totalTax: snapshot.totalTax,
    total: snapshot.total,
    lines: snapshot.lines,
    warnings: snapshot.warnings
  };
}

module.exports = {
  ENGINE,
  context,
  fyShort,
  nextNumber,
  peekNumber,
  taxInvoiceNumber,
  calculate,
  applyToTaxInvoice,
  otherChargesOf,
  markIssued,
  refreshForIssue,
  tcsBaseOf,
  isFrozen,
  upiLink,
  calculateForExtension
};
