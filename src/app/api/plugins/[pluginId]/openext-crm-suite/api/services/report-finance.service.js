'use strict';

/**
 * Money figures for a set of quotations, for reports (sdk.finance.summary, CRM 3.29.0). Industry-neutral:
 * the caller (an extension's report) chooses the quotations; this service applies the CRM's payment rules.
 *
 *  - verified payments only (not Pending, Refunded, Disputed, Failed, Cancelled), net of refunds
 *  - every payment is one record: an advance moved from the payment request onto the tax invoice is
 *    counted once (as received, and as advance)
 *  - invoiced / outstanding: tax invoices only (never payment requests), not Draft, Cancelled or Written Off
 *  - per quotation: the same payment state the quotation page shows (proforma.computeQuotationPaymentState)
 *
 * Date range (optional, ISO days): invoiced and outstanding by the invoice's issue date, received and advance
 * by the payment date. Tenant-scoped; ids the tenant does not own are ignored.
 */

const { resolveTenantId } = require('../utils/tenant.util');

const ID_RE = /^[a-f0-9]{24}$/i;
const MAX_QUOTATIONS = 5000;
const CHUNK = 500;
const UNVERIFIED = ['Pending', 'Refunded', 'Disputed', 'Failed', 'Cancelled'];
const NOT_INVOICED = ['Draft', 'Cancelled', 'Written Off'];

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dayOf = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** 'day' | 'week' | 'month' bucket key of an ISO day. */
function bucketOf(day, bucket) {
  if (!day) return '';
  if (bucket === 'month') return day.slice(0, 7);
  if (bucket === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    const shift = (d.getUTCDay() + 6) % 7; // Monday
    d.setUTCDate(d.getUTCDate() - shift);
    return d.toISOString().slice(0, 10);
  }
  return day;
}

/** Bucket size for a range: up to 31 days → day, up to ~6 months → week, longer → month. */
function bucketFor(from, to) {
  if (!from || !to) return 'month';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (!Number.isFinite(days) || days < 0) return 'month';
  return days <= 31 ? 'day' : days <= 186 ? 'week' : 'month';
}

/**
 * @param {object} req
 * @param {{ quotationIds: string[], from?: string, to?: string, bucket?: 'day'|'week'|'month' }} options
 * @returns {Promise<{ totals, quotations: Object<string, object>, series: Array, bucket: string }>}
 */
async function summarize(req, options = {}) {
  const Proforma = require('./proforma.service');
  const SettingService = require('./setting.service');
  const tenantId = resolveTenantId(req);
  const ids = [...new Set((Array.isArray(options.quotationIds) ? options.quotationIds : []).map(String).filter((id) => ID_RE.test(id)))].slice(0, MAX_QUOTATIONS);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(options.from || '')) ? String(options.from) : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(options.to || '')) ? String(options.to) : '';
  const bucket = ['day', 'week', 'month'].includes(options.bucket) ? options.bucket : bucketFor(from, to);
  const inRange = (day) => Boolean(day) && (!from || day >= from) && (!to || day <= to);

  const empty = { invoiced: 0, received: 0, advanceReceived: 0, outstanding: 0, invoiceCount: 0, outstandingCount: 0 };
  const Estimate = req.cms?.models?.get?.('Estimate');
  const Invoice = req.cms?.models?.get?.('Invoice');
  const Payment = req.cms?.models?.get?.('Payment');
  if (!ids.length || !Estimate || !Invoice) return { totals: { ...empty }, quotations: {}, series: [], bucket };

  const base = { tenantId, isDeleted: { $ne: true } };
  const quotations = [];
  for (const part of chunks(ids)) {
    quotations.push(...(await Proforma.findRows(Estimate.find({ ...base, _id: { $in: part } }), '_id grandTotal status currency convertedInvoiceId paymentType advanceMode advanceValue')));
  }
  const qIds = quotations.map((q) => String(q._id));
  const convertedIds = quotations.map((q) => String(q.convertedInvoiceId || '')).filter((id) => ID_RE.test(id));

  const docsById = new Map();
  for (const part of chunks(qIds)) {
    const or = [{ quotationId: { $in: part } }, { convertedQuotationId: { $in: part } }];
    for (const d of await Proforma.findRows(Invoice.find({ ...base, $or: or }), Proforma.PAYMENT_STATE_DOC_FIELDS)) docsById.set(String(d._id), d);
  }
  for (const part of chunks(convertedIds.filter((id) => !docsById.has(id)))) {
    for (const d of await Proforma.findRows(Invoice.find({ ...base, _id: { $in: part } }), Proforma.PAYMENT_STATE_DOC_FIELDS)) docsById.set(String(d._id), d);
  }
  const paymentsByDoc = new Map();
  if (Payment) {
    for (const part of chunks([...docsById.keys()])) {
      const rows = await Proforma.findRows(
        Payment.find({ ...base, invoiceId: { $in: part }, status: { $nin: UNVERIFIED } }),
        '_id invoiceId proformaInvoiceId amount refundedAmount paymentDate createdAt'
      );
      for (const p of rows) {
        const key = String(p.invoiceId);
        if (!paymentsByDoc.has(key)) paymentsByDoc.set(key, []);
        paymentsByDoc.get(key).push(p);
      }
    }
  }

  const docsByQuotation = new Map();
  for (const d of docsById.values()) {
    for (const key of new Set([String(d.quotationId || ''), String(d.convertedQuotationId || '')])) {
      if (!key) continue;
      if (!docsByQuotation.has(key)) docsByQuotation.set(key, []);
      docsByQuotation.get(key).push(d);
    }
  }

  let settings = {};
  try {
    settings = await SettingService.getAll(req);
  } catch {
    settings = {};
  }
  const now = dayOf(new Date());
  const totals = { ...empty };
  const series = new Map();
  const point = (key) => {
    if (!series.has(key)) series.set(key, { bucket: key, invoiced: 0, received: 0, outstanding: 0 });
    return series.get(key);
  };
  const out = {};
  const countedInvoices = new Set();
  const countedPayments = new Set();

  for (const q of quotations) {
    const qid = String(q._id);
    const convertedId = String(q.convertedInvoiceId || '');
    const docs = [...new Set([...(docsByQuotation.get(qid) || []), ...(docsById.has(convertedId) ? [docsById.get(convertedId)] : [])])];
    const payments = docs.flatMap((d) => paymentsByDoc.get(String(d._id)) || []);
    let required = null;
    try {
      required = Proforma.computePayableAmount(q, settings);
    } catch {
      required = null;
    }
    const state = Proforma.computeQuotationPaymentState(q, docs, payments, required);
    const taxInvoice = state.invoiceId ? docs.find((d) => String(d._id) === state.invoiceId) : null;
    const overdue = Boolean(taxInvoice && state.status !== 'Paid' && state.invoiceBalance > 0.005 && dayOf(taxInvoice.dueDate) && dayOf(taxInvoice.dueDate) < now);
    out[qid] = {
      total: state.total,
      paid: state.paid,
      advancePaid: state.advancePaid,
      status: state.status,
      stage: state.stage,
      // Unpaid | Advance Paid | Partially Paid | Paid | Overdue (Paid means nothing is due)
      paymentGroup: state.status === 'Paid' ? 'Paid' : overdue ? 'Overdue' : state.stage,
      invoiceId: state.invoiceId,
      invoiceStatus: state.invoiceStatus,
      invoiceTotal: state.invoiceTotal,
      invoiceBalance: state.invoiceBalance,
      overdue,
      currency: state.currency
    };

    for (const d of docs) {
      const docId = String(d._id);
      const onDoc = paymentsByDoc.get(docId) || [];
      for (const p of onDoc) {
        const pid = String(p._id);
        if (countedPayments.has(pid)) continue;
        countedPayments.add(pid);
        const day = dayOf(p.paymentDate || p.createdAt);
        if (from || to ? !inRange(day) : false) continue;
        const net = round2(Math.max(0, Number(p.amount || 0) - Number(p.refundedAmount || 0)));
        totals.received = round2(totals.received + net);
        if (d.documentType === 'proforma' || p.proformaInvoiceId) totals.advanceReceived = round2(totals.advanceReceived + net);
        point(bucketOf(day, bucket)).received = round2(point(bucketOf(day, bucket)).received + net);
      }
      if (d.documentType === 'proforma' || NOT_INVOICED.includes(String(d.status)) || countedInvoices.has(docId)) continue;
      countedInvoices.add(docId);
      const day = dayOf(d.issueDate);
      if (from || to ? !inRange(day) : false) continue;
      const total = round2(d.grandTotal);
      const balance = round2(Math.max(0, total - Proforma.paidSum(onDoc) - round2(d.creditAmount)));
      totals.invoiced = round2(totals.invoiced + total);
      totals.invoiceCount += 1;
      totals.outstanding = round2(totals.outstanding + balance);
      if (balance > 0.005) totals.outstandingCount += 1;
      const pt = point(bucketOf(day, bucket));
      pt.invoiced = round2(pt.invoiced + total);
      pt.outstanding = round2(pt.outstanding + balance);
    }
  }

  return {
    totals,
    quotations: out,
    series: [...series.values()].filter((p) => p.bucket).sort((a, b) => (a.bucket < b.bucket ? -1 : 1)),
    bucket
  };
}

module.exports = { summarize, bucketFor, bucketOf };
