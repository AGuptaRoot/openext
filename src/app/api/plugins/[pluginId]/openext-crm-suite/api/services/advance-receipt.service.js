'use strict';

/**
 * Advance receipt vouchers (GST suite, CRM 3.53.0; documentation/gst-planning/01 §5).
 *
 * - recordForPayment: money paid on a proforma (staff entry or Razorpay) gets one voucher, numbered
 *   RV/26-27/0001, with the GST inside the advance split by rate in the quotation's proportions
 *   (each rate: taxable = share / (1 + r/100)). One voucher per payment: retries are safe.
 * - adjustForInvoice: when the tax invoice of those proformas is issued, their open vouchers are marked
 *   adjusted (GSTR-1 Table 11B).
 * Only with Settings → GST saved, INR money. Never blocks or fails a payment; nothing personal is logged.
 */

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const Adapter = require('../lib/gst-adapter');
const GstService = require('./gst.service');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function model(req) {
  return req.cms?.models?.get?.('AdvanceReceipt') || null;
}

async function leanOf(q) {
  return q && typeof q.lean === 'function' ? q.lean() : q;
}

/**
 * The GST inside an advance of `amount`, in the proportions of the document `snapshot`
 * (from GstService.calculate). Pure: exported for tests.
 */
function splitAdvance(amount, snapshot) {
  const total = Number(snapshot && snapshot.total) || 0;
  const share = total > 0 ? Math.min(1, (Number(amount) || 0) / total) : 0;
  const byRate = new Map();
  for (const line of (snapshot && snapshot.lines) || []) {
    const rate = Number(line.taxPercent) || 0;
    const gross = (Number(line.taxable) || 0) + (Number(line.cgst) || 0) + (Number(line.sgst) || 0) + (Number(line.utgst) || 0) + (Number(line.igst) || 0);
    byRate.set(rate, (byRate.get(rate) || 0) + gross);
  }
  // Charges outside GST (shipping) are part of the total but carry no tax.
  const other = Number(snapshot && snapshot.otherCharges) || 0;
  if (other > 0) byRate.set(0, (byRate.get(0) || 0) + other);

  const rates = [];
  for (const [rate, gross] of [...byRate.entries()].sort((a, b) => a[0] - b[0])) {
    const part = gross * share;
    const taxable = r2(part / (1 + rate / 100));
    const tax = r2(part - taxable);
    const half = tax / 2;
    rates.push({
      taxPercent: rate,
      taxable,
      cgst: snapshot.isInterstate ? 0 : half,
      sgst: snapshot.isInterstate || snapshot.isIntraUT ? 0 : half,
      utgst: !snapshot.isInterstate && snapshot.isIntraUT ? half : 0,
      igst: snapshot.isInterstate ? tax : 0
    });
  }
  // Rounding: the parts must add up to the money received exactly.
  const sum = r2(rates.reduce((s, r) => s + r.taxable + r.cgst + r.sgst + r.utgst + r.igst, 0));
  const diff = r2((Number(amount) || 0) - sum);
  if (rates.length && diff !== 0) rates[rates.length - 1].taxable = r2(rates[rates.length - 1].taxable + diff);
  return {
    rates,
    taxable: r2(rates.reduce((s, r) => s + r.taxable, 0)),
    totalTax: r2(rates.reduce((s, r) => s + r.cgst + r.sgst + r.utgst + r.igst, 0))
  };
}

/** The lines (and discount) the advance is for: the quotation's, else the proforma's own. */
async function sourceDocument(req, proforma) {
  const quotationId = String(proforma.quotationId || proforma.convertedQuotationId || '').trim();
  if (quotationId) {
    const Estimate = req.cms?.models?.get?.('Estimate');
    if (Estimate) {
      const q = await leanOf(Estimate.findOne({ tenantId: req.tenantId || resolveTenantId(req), _id: quotationId, isDeleted: { $ne: true } }));
      if (q && Array.isArray(q.lineItems) && q.lineItems.length) return { doc: q, quotationId };
    }
  }
  return { doc: proforma, quotationId };
}

/**
 * Make the voucher for a payment on a proforma. Returns the voucher, or null when none is due
 * (not a proforma, no GST settings, not INR, already made). Never throws.
 */
async function recordForPayment(req, { payment, proforma } = {}) {
  try {
    const Receipt = model(req);
    if (!Receipt || !payment || !proforma || proforma.documentType !== 'proforma') return null;
    if (String(payment.currency || proforma.currency || 'INR').toUpperCase() !== 'INR') return null;
    if (!(await GstService.context(req)).ready) return null;

    const tenantId = req.tenantId || resolveTenantId(req);
    const paymentId = String(payment._id || '');
    if (!paymentId) return null;
    const existing = await leanOf(Receipt.findOne({ tenantId, paymentId }));
    if (existing) return existing;

    const { doc, quotationId } = await sourceDocument(req, proforma);
    const { snapshot } = await GstService.calculate(req, {
      clientId: proforma.clientId || doc.clientId,
      lines: doc.lineItems,
      placeOfSupply: doc.placeOfSupply,
      issueDate: payment.paymentDate,
      discountAmount: doc.discountAmount,
      taxCalculation: doc.taxCalculation,
      otherCharges: GstService.otherChargesOf(doc)
    });
    const amount = r2(payment.amount);
    const split = splitAdvance(amount, snapshot);
    const receiptDate = Adapter.localIsoDate(payment.paymentDate || new Date());
    // Step 5 (03 §6): no voucher (a GST document) dated on or before Settings → GST "Books locked up to".
    // The payment itself is never refused; the missing voucher is logged (no personal data).
    if (await require('./period-lock.service').isLocked(req, receiptDate)) {
      console.error('[plugin:openext-crm-suite] advance receipt voucher not made: the payment date is in a locked GST period');
      return null;
    }
    const receiptNo = await GstService.nextNumber(req, 'RV', receiptDate);
    try {
      const created = await Receipt.create({
        tenantId,
        receiptNo,
        receiptDate,
        paymentId,
        clientId: String(proforma.clientId || doc.clientId || ''),
        quotationId,
        proformaId: String(proforma._id || ''),
        placeOfSupply: snapshot.placeOfSupply,
        posCode: snapshot.posCode,
        isInterstate: snapshot.isInterstate,
        amount,
        rates: split.rates,
        taxable: split.taxable,
        totalTax: split.totalTax,
        engine: snapshot.engine,
        createdBy: resolveUserId(req)
      });
      return created && typeof created.toObject === 'function' ? created.toObject() : created;
    } catch (error) {
      // A repeated confirmation raced us: the other request made the voucher.
      if (error && error.code === 11000) return leanOf(Receipt.findOne({ tenantId, paymentId }));
      throw error;
    }
  } catch (error) {
    console.error('[plugin:openext-crm-suite] advance receipt voucher not made:', error?.code || '', error?.message || error);
    return null;
  }
}

/** The tax invoice of these proformas is issued: their open vouchers are adjusted against it. Never throws. */
async function adjustForInvoice(req, proformaIds, invoice) {
  try {
    const Receipt = model(req);
    const ids = (proformaIds || []).map(String).filter(Boolean);
    if (!Receipt || !ids.length || !invoice || !invoice._id) return 0;
    const result = await Receipt.updateMany(
      { tenantId: req.tenantId || resolveTenantId(req), proformaId: { $in: ids }, status: 'open' },
      {
        $set: {
          status: 'adjusted',
          adjustedInvoiceId: String(invoice._id),
          adjustedInvoiceNo: String(invoice.invoiceNo || ''),
          adjustedOn: Adapter.localIsoDate(invoice.issueDate || new Date())
        }
      }
    );
    return (result && (result.modifiedCount ?? result.nModified)) || 0;
  } catch (error) {
    console.error('[plugin:openext-crm-suite] advance receipt vouchers not adjusted:', error?.message || error);
    return 0;
  }
}

/** Vouchers of one client / proforma / quotation (for screens and reports). */
async function list(req, { proformaId, quotationId, invoiceId } = {}) {
  const Receipt = model(req);
  if (!Receipt) return [];
  const filter = { tenantId: req.tenantId || resolveTenantId(req) };
  if (proformaId) filter.proformaId = String(proformaId);
  if (quotationId) filter.quotationId = String(quotationId);
  if (invoiceId) filter.adjustedInvoiceId = String(invoiceId);
  let q = Receipt.find(filter);
  if (q && typeof q.sort === 'function') q = q.sort({ receiptDate: 1, receiptNo: 1 });
  const rows = await leanOf(q);
  return Array.isArray(rows) ? rows : [];
}

module.exports = { splitAdvance, recordForPayment, adjustForInvoice, list };
