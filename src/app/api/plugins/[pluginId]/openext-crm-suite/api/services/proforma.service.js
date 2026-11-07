'use strict';

/**
 * Proforma invoices and advance payments on quotations.
 *
 * A proforma is a payment request raised from a quotation, so a client can pay
 * (in full or as an advance) before any tax invoice exists. It is not a tax
 * document: it has its own numbering series and is excluded from tax and
 * revenue reporting. When the work is delivered, the proforma is converted
 * into a tax invoice **for the full quotation value**, and the advance already
 * paid moves across so the balance due is what is still owed.
 *
 * The whole feature is behind Settings → General → "Enable Proforma & Advance
 * Payment", which is off by default. While it is off nothing here may create
 * anything, and a payment never accepts a quotation — but proformas and
 * payments that already exist are left untouched and stay readable.
 */

const { withCustomerSnapshot } = require('../utils/customer-snapshot.util');
const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { getNextNumber } = require('../utils/numbering.util');
const AuditService = require('./audit.service');
const SettingService = require('./setting.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function getInvoiceModel(req) {
  const Invoice = req.cms?.models.get('Invoice');
  if (!Invoice) throw new Error('Invoice model is not registered');
  return Invoice;
}

function getEstimateModel(req) {
  const Estimate = req.cms?.models.get('Estimate');
  if (!Estimate) throw new Error('Estimate model is not registered');
  return Estimate;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/* ------------------------------------------------------------------ flags */

/** Settings → General → Enable Proforma & Advance Payment. */
async function isProformaEnabled(req) {
  try {
    const settings = await SettingService.getAll(req);
    return Boolean(settings.proforma_advance_enabled);
  } catch {
    // A settings failure must not silently switch a billing feature on.
    return false;
  }
}

/**
 * Auto-accept a quotation when its payment succeeds.
 *
 * Only meaningful while the master switch is on: with the feature off, a
 * payment never accepts a quotation, whatever this says.
 */
/**
 * Auto-convert proforma into tax invoice when a sales order is delivered.
 *
 * Only meaningful while the master switch is on: with proforma_advance_enabled
 * off, auto conversion never happens.
 */
async function isAutoConvertOnDeliveryEnabled(req) {
  try {
    const settings = await SettingService.getAll(req);
    return Boolean(
      settings.proforma_advance_enabled && settings.auto_convert_proforma_on_delivery
    );
  } catch {
    return false;
  }
}

async function isAutoInvoiceOnFullPaymentEnabled(req) {
  try {
    const settings = await SettingService.getAll(req);
    return Boolean(settings.proforma_advance_enabled && settings.auto_invoice_on_full_payment);
  } catch {
    return false;
  }
}

async function isAutoAcceptOnPaymentEnabled(req) {
  try {
    const settings = await SettingService.getAll(req);
    return Boolean(
      (settings.proforma_advance_enabled || settings.proforma_advance_enabled === undefined) &&
      settings.quotation_auto_accept_on_payment
    );
  } catch {
    return false;
  }
}

async function assertProformaEnabled(req) {
  if (await isProformaEnabled(req)) return;
  throw appError(
    'Proforma & advance payment is turned off. Enable it in Settings → General to use this.',
    409
  );
}

/* ----------------------------------------------------------- calculation */

/**
 * What the client is being asked to pay now.
 *
 * `full` is the whole quotation. `advance` is either a percentage of the total
 * or a fixed amount, never more than the total and never zero — an advance of
 * nothing is a mistake, not a free quotation.
 */
function computePayableAmount(quotation, settings = {}) {
  const total = round2(quotation?.grandTotal);
  if (!(total > 0)) {
    throw appError('This quotation has no amount to pay.', 409);
  }

  const paymentType = String(quotation?.paymentType || 'full');
  if (paymentType !== 'advance') {
    return { amount: total, isAdvance: false, total };
  }

  const mode = String(quotation?.advanceMode || 'percent');
  const configuredPercent = Number(settings.default_advance_percent);
  const fallbackPercent = Number.isFinite(configuredPercent) ? configuredPercent : 30;
  const raw = Number(quotation?.advanceValue);

  let amount;
  if (mode === 'amount') {
    amount = round2(raw);
  } else {
    const percent = Number.isFinite(raw) && raw > 0 ? raw : fallbackPercent;
    amount = round2((total * Math.min(100, percent)) / 100);
  }

  if (!(amount > 0)) {
    throw appError('The advance amount must be greater than zero.', 400);
  }
  if (amount > total) {
    throw appError('The advance cannot be more than the quotation total.', 400);
  }

  return { amount, isAdvance: amount < total, total };
}

/* --------------------------------------------------------- payment state */

/**
 * Payments that are real money: verified by the gateway or recorded by finance staff. Counted by
 * excluding what is not money in hand, so a record saved before the status field existed still counts.
 */
const VERIFIED_PAYMENT_STATUSES = ['Completed', 'Partially Refunded'];
const UNVERIFIED_PAYMENT_STATUSES = ['Pending', 'Refunded', 'Disputed', 'Failed', 'Cancelled'];
// Marks a quotation while its tax invoice is being raised, so a repeated payment call cannot raise two.
const INVOICE_CLAIM_PREFIX = 'pending:';

function codedError(message, status, code) {
  const error = appError(message, status);
  error.code = code;
  return error;
}

const isClaim = (value) => String(value || '').startsWith(INVOICE_CLAIM_PREFIX);

/** Runs a find with an optional projection on any model shape (Mongoose query or plain result). */
async function findRows(query, fields) {
  let q = query;
  if (q && typeof q.select === 'function') q = q.select(fields);
  const rows = q && typeof q.lean === 'function' ? await q.lean() : await q;
  return Array.isArray(rows) ? rows : [];
}

/** A proforma turned into the tax invoice: closed, with its history (what was paid on it) kept. */
const PROFORMA_CONVERTED = 'Converted';

/**
 * The verified payments on some documents: real money (not Pending, Refunded, Disputed, Failed or
 * Cancelled). The one place that decides what counts as paid.
 */
async function verifiedPayments(req, invoiceIds) {
  const Payment = req.cms?.models.get('Payment');
  const ids = (invoiceIds || []).map(String).filter(Boolean);
  if (!Payment || !ids.length) return [];
  return findRows(
    Payment.find({
      tenantId: resolveTenantId(req),
      isDeleted: { $ne: true },
      invoiceId: { $in: ids },
      status: { $nin: UNVERIFIED_PAYMENT_STATUSES }
    }),
    '_id invoiceId proformaInvoiceId amount refundedAmount'
  );
}

/** Money kept from payment rows: amount less refunds. */
function paidSum(rows) {
  return round2((rows || []).reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0) - Number(row.refundedAmount || 0)), 0));
}

/**
 * What has been paid on a quotation, from the payment records only (never from a flag the browser sends):
 * every verified payment on its payment requests (proformas) and on its tax invoice, less refunds.
 *
 * Advance workflow (paymentType 'advance'): the quotation asks for the advance only. Once the advance is
 * paid the quotation's payment step is done (stage 'Advance Paid', nothing payable on it); the rest is
 * payable on the tax invoice, which carries the advance.
 *
 * @returns {{ total, paid, balance, status: 'Unpaid'|'Partially Paid'|'Paid',
 *   stage: 'Unpaid'|'Advance Paid'|'Partially Paid'|'Paid', isAdvanceFlow, advanceRequired, advancePaid,
 *   advanceSatisfied, currency, invoiceId, invoiceNo, invoiceStatus, invoiceTotal, invoicePaid, invoiceBalance,
 *   nextPayment: null | { amount, kind: 'full'|'advance'|'balance'|'invoice' }, canPay: boolean }}
 */
async function quotationPaymentState(req, quotation, options = {}) {
  const quotationId = String(quotation?._id || '');
  const Invoice = req.cms?.models.get('Invoice') || null;
  const convertedId = isClaim(quotation?.convertedInvoiceId) ? '' : String(quotation?.convertedInvoiceId || '');

  const or = [{ quotationId }, { convertedQuotationId: quotationId }];
  if (convertedId) or.push({ _id: convertedId });
  const docs = quotationId && Invoice
    ? await findRows(Invoice.find({ ...baseFilter(req), $or: or }), PAYMENT_STATE_DOC_FIELDS)
    : [];
  const payments = await verifiedPayments(req, docs.map((d) => String(d._id)));
  // What the quotation asks for up front: the advance, or the whole amount.
  let required = null;
  try {
    const settings = options.settings || (await SettingService.getAll(req));
    required = computePayableAmount(quotation, settings);
  } catch {
    required = null;
  }
  return computeQuotationPaymentState(quotation, docs, payments, required);
}

/** Invoice fields the payment state reads. */
const PAYMENT_STATE_DOC_FIELDS =
  '_id documentType status grandTotal amountPaid balanceDue creditAmount convertedInvoiceId invoiceNo currency quotationId convertedQuotationId issueDate dueDate';

/**
 * The payment state of one quotation from its documents (payment requests + tax invoice) and their verified
 * payments — the single formula used by the quotation page, the portal, sdk.finance and the reports.
 * @param {object|null} required  computePayableAmount(quotation, settings)
 */
function computeQuotationPaymentState(quotation, docs, payments, required) {
  const total = round2(quotation?.grandTotal);
  const currency = quotation?.currency || 'INR';
  const convertedId = isClaim(quotation?.convertedInvoiceId) ? '' : String(quotation?.convertedInvoiceId || '');
  const paid = paidSum(payments);
  const paidOn = (id) => paidSum(payments.filter((p) => String(p.invoiceId) === String(id)));
  const proformaIds = new Set(docs.filter((d) => d.documentType === 'proforma').map((d) => String(d._id)));
  // Paid before the tax invoice: on a payment request, or moved from one onto the invoice.
  const prePaid = paidSum(payments.filter((p) => proformaIds.has(String(p.invoiceId)) || p.proformaInvoiceId));

  const status = !(paid > 0) ? 'Unpaid' : total > 0 && paid + 0.05 >= total ? 'Paid' : 'Partially Paid';
  const balance = round2(Math.max(0, total - paid));
  const taxInvoice = docs.find((d) => d.documentType !== 'proforma' && (String(d._id) === convertedId || !convertedId)) || null;

  const isAdvanceFlow = Boolean(required && required.isAdvance);
  const advanceRequired = isAdvanceFlow ? required.amount : 0;
  const advancePaid = isAdvanceFlow ? prePaid : 0;
  const advanceSatisfied = isAdvanceFlow && advancePaid > 0 && advancePaid + 0.05 >= advanceRequired;

  let invoiceTotal = 0;
  let invoicePaid = 0;
  let invoiceBalance = 0;
  if (taxInvoice) {
    invoiceTotal = round2(taxInvoice.grandTotal);
    invoicePaid = paidOn(taxInvoice._id);
    invoiceBalance = round2(Math.max(0, invoiceTotal - invoicePaid - round2(taxInvoice.creditAmount)));
  }

  let nextPayment = null;
  if (status !== 'Paid' && total > 0) {
    if (taxInvoice) {
      // The rest belongs to the tax invoice: its own balance after everything already paid.
      if (invoiceBalance > 0 && !['Cancelled', 'Written Off', 'Draft'].includes(String(taxInvoice.status))) {
        nextPayment = { amount: invoiceBalance, kind: 'invoice' };
      }
    } else if (!advanceSatisfied) {
      const openRequest = docs.find(
        (d) =>
          d.documentType === 'proforma' &&
          !d.convertedInvoiceId &&
          !['Cancelled', PROFORMA_CONVERTED].includes(String(d.status)) &&
          round2(d.grandTotal) - paidOn(d._id) > 0.05
      );
      if (openRequest) {
        const due = round2(round2(openRequest.grandTotal) - paidOn(openRequest._id));
        nextPayment = { amount: due, kind: isAdvanceFlow ? 'advance' : paid > 0 ? 'balance' : 'full' };
      } else if (isAdvanceFlow) {
        nextPayment = { amount: round2(Math.max(0, advanceRequired - advancePaid)), kind: 'advance' };
      } else if (paid > 0) {
        nextPayment = { amount: balance, kind: 'balance' };
      } else if (required) {
        nextPayment = { amount: required.amount, kind: 'full' };
      }
    }
    // advanceSatisfied without a tax invoice: nothing is payable on the quotation.
  }
  const stage =
    status === 'Paid' ? 'Paid' : advanceSatisfied && !taxInvoice ? 'Advance Paid' : paid > 0 ? 'Partially Paid' : 'Unpaid';
  const quotationStatus = String(quotation?.status || '');
  const canPay = Boolean(nextPayment) && !['Draft', 'Rejected', 'Expired', 'Cancelled'].includes(quotationStatus) && !quotation?.isArchived;

  return {
    total,
    paid,
    balance,
    status,
    stage,
    isAdvanceFlow,
    advanceRequired,
    advancePaid,
    advanceSatisfied,
    currency,
    invoiceId: taxInvoice ? String(taxInvoice._id) : null,
    invoiceNo: taxInvoice ? taxInvoice.invoiceNo || '' : '',
    invoiceStatus: taxInvoice ? taxInvoice.status || '' : '',
    invoiceTotal,
    invoicePaid,
    invoiceBalance,
    nextPayment,
    canPay
  };
}

/**
 * Whether an extension's booking (fulfilment) may start for a quotation, from its verified payments
 * (quotationPaymentState) and Settings → General "Allow Booking Creation After Advance Payment":
 *   Yes → the required advance verified (or the whole amount) · No → the whole amount verified.
 * @returns {{ eligible: boolean, rule: 'advance'|'full', fullyPaid: boolean, reason: string }}
 */
function bookingEligibility(state, settings = {}) {
  const afterAdvance = Boolean(settings && settings.allow_booking_after_advance);
  const fullyPaid = Boolean(state && state.status === 'Paid');
  const advanceOk = Boolean(afterAdvance && state && state.isAdvanceFlow && state.advanceSatisfied);
  const eligible = fullyPaid || advanceOk;
  let reason = '';
  if (!eligible) {
    reason = afterAdvance && state && state.isAdvanceFlow
      ? 'The required advance payment has not been received yet.'
      : 'The quotation must be paid in full first.';
  }
  return { eligible, rule: afterAdvance ? 'advance' : 'full', fullyPaid, reason };
}

/**
 * The money on one invoice from its verified payments (the formula every page uses):
 * balance = total − verified payments (advance carried from the proforma included) − credits.
 * @returns {{ total, paid, advancePaid, credit, balance, status }}
 */
async function invoicePaymentSummary(req, invoice) {
  if (!invoice) return null;
  const rows = await verifiedPayments(req, [String(invoice._id)]);
  const total = round2(invoice.grandTotal);
  const paid = paidSum(rows);
  const fromProforma = paidSum(rows.filter((p) => p.proformaInvoiceId));
  // Invoices raised before payments kept their proforma link: the advance recorded at conversion.
  const advancePaid = invoice.documentType === 'proforma' ? 0 : fromProforma > 0 ? fromProforma : Math.min(round2(invoice.advancePaid), paid);
  const credit = round2(invoice.creditAmount);
  if (invoice.documentType === 'proforma' && invoice.convertedInvoiceId) {
    // Converted: its payments moved to the tax invoice; what it collected stays on record.
    return { total, paid: round2(invoice.amountPaid), advancePaid: 0, credit, balance: 0, status: invoice.status };
  }
  const balance = round2(Math.max(0, total - paid - credit));
  return { total, paid, advancePaid, credit, balance, status: invoice.status };
}

/**
 * Raise the tax invoice of a quotation that is paid in full, once.
 *
 * Payment is the acceptance: the quotation is accepted first (which runs the active extension's
 * acceptance hook, e.g. a travel booking), then one tax invoice for the full value is raised, every
 * verified payment on its payment requests moves onto it, the requests close and the invoice is Paid.
 * A second call (a repeated confirmation) finds the invoice — or the claim of a call in progress —
 * and raises nothing. Never throws.
 */
async function invoicePaidQuotation(req, quotationId) {
  return invoiceQuotationWithPayments(req, quotationId, { requireFullPayment: true });
}

/**
 * The tax invoice of a quotation for its full value, carrying every verified payment of its payment
 * requests (advance + balance): Paid when nothing is owed, Partially Paid with the rest as the balance,
 * else Sent. The requests close. Raised once (claim on the quotation). With requireFullPayment it waits
 * for full payment and never throws; otherwise (staff invoicing an accepted quotation) errors are thrown.
 * @returns {{ invoiced: boolean, invoiceId?, invoiceNo?, invoice?, alreadyInvoiced?, reason? }}
 */
async function invoiceQuotationWithPayments(req, quotationId, { requireFullPayment = true } = {}) {
  try {
    if (!quotationId) return { invoiced: false };
    const Estimate = getEstimateModel(req);
    const Invoice = getInvoiceModel(req);
    let quotation = await Estimate.findOne({ ...baseFilter(req), _id: String(quotationId) }).lean();
    if (!quotation) return { invoiced: false };
    if (quotation.convertedInvoiceId) {
      return { invoiced: false, alreadyInvoiced: true, invoiceId: isClaim(quotation.convertedInvoiceId) ? null : String(quotation.convertedInvoiceId) };
    }
    const state = await quotationPaymentState(req, quotation);
    if (requireFullPayment && state.status !== 'Paid') return { invoiced: false, reason: 'not_paid_in_full', state };

    if (requireFullPayment && !['Accepted', 'Converted'].includes(String(quotation.status))) {
      try {
        const QuotationService = require('./quotation.service');
        await QuotationService.accept(req, String(quotationId), { system: true, paymentVerified: true });
      } catch (error) {
        console.warn('[plugin:openext-crm-suite] accepting a fully paid quotation failed:', error?.message || error);
      }
      quotation = (await Estimate.findOne({ ...baseFilter(req), _id: String(quotationId) }).lean()) || quotation;
      if (quotation.convertedInvoiceId) return { invoiced: false, alreadyInvoiced: true };
    }

    const claim = `${INVOICE_CLAIM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const claimed = await Estimate.findOneAndUpdate(
      { ...baseFilter(req), _id: String(quotationId), $or: [{ convertedInvoiceId: null }, { convertedInvoiceId: '' }] },
      { $set: { convertedInvoiceId: claim } },
      { new: true }
    ).lean();
    if (!claimed) return { invoiced: false, alreadyInvoiced: true };

    try {
      const userId = resolveUserId(req);
      const settings = await SettingService.getAll(req);
      const proformas = await findRows(
        Invoice.find({
          ...baseFilter(req),
          documentType: 'proforma',
          $or: [{ quotationId: String(quotationId) }, { convertedQuotationId: String(quotationId) }],
          convertedInvoiceId: null
        })
      );

      const grandTotal = round2(quotation.grandTotal);
      const paid = Math.min(state.paid, grandTotal);
      const invoiceNo = await getNextNumber(req, 'invoice');
      const issueDate = new Date();
      const paymentDays = Number(settings.invoice_payment_days || settings.payment_terms_days || 30);
      const dueDate = new Date(issueDate);
      dueDate.setDate(dueDate.getDate() + paymentDays);
      const first = proformas[0] || {};

      const created = await Invoice.create(await withCustomerSnapshot(req, {
        tenantId: resolveTenantId(req),
        documentType: 'tax',
        clientId: quotation.clientId || first.clientId || '',
        leadId: quotation.leadId || first.leadId || null,
        quotationId: String(quotationId),
        convertedQuotationId: String(quotationId),
        proformaInvoiceId: first._id ? String(first._id) : null,
        proformaInvoiceNo: first.invoiceNo || '',
        salesOrderId: quotation.convertedSalesOrderId ? String(quotation.convertedSalesOrderId) : null,
        invoiceNo,
        issueDate,
        dueDate,
        status: paid > 0 && paid + 0.05 >= grandTotal ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Sent',
        currency: quotation.currency || settings.default_currency || 'INR',
        exchangeRate: Number(quotation.exchangeRate) || 1,
        lineItems: Array.isArray(quotation.lineItems) ? quotation.lineItems : [],
        subtotal: round2(quotation.subtotal),
        discountPercent: Number(quotation.discountPercent) || 0,
        discountTotal: round2(quotation.discountTotal || quotation.discountAmount),
        taxTotal: round2(quotation.taxTotal),
        shippingCharge: round2(quotation.shippingCharge),
        grandTotal,
        amountPaid: paid,
        advancePaid: paid,
        balanceDue: round2(Math.max(0, grandTotal - paid)),
        notes: quotation.notes ? String(quotation.notes).trim() : '',
        createdBy: userId,
        updatedBy: userId
      }));
      const invoice = created.toObject ? created.toObject() : created;

      // Every verified payment of every payment request moves onto the tax invoice: one money trail.
      let movedPayments = 0;
      for (const proforma of proformas) {
        const collected = paidSum(await verifiedPayments(req, [String(proforma._id)]));
        movedPayments += await movePaymentsToInvoice(req, proforma, invoice);
        await closeConvertedProforma(req, proforma, invoice, collected);
      }
      // From the payment records after the move (a payment confirmed meanwhile counts too).
      const settled = Math.min(paidSum(await verifiedPayments(req, [String(invoice._id)])), grandTotal);
      if (Math.abs(settled - paid) > 0.005) {
        await Invoice.updateOne(
          { ...baseFilter(req), _id: String(invoice._id) },
          {
            $set: {
              amountPaid: settled,
              advancePaid: settled,
              balanceDue: round2(Math.max(0, grandTotal - settled)),
              status: settled > 0 && settled + 0.05 >= grandTotal ? 'Paid' : settled > 0 ? 'Partially Paid' : 'Sent'
            }
          }
        );
      }

      await Estimate.updateOne(
        { ...baseFilter(req), _id: String(quotationId), convertedInvoiceId: claim },
        { $set: { convertedInvoiceId: String(invoice._id), status: 'Converted', updatedBy: userId } }
      );

      await AuditService.log(req, {
        action: requireFullPayment ? 'invoiced_on_full_payment' : 'invoiced_from_quotation',
        module: 'invoice',
        recordId: String(invoice._id),
        description: requireFullPayment
          ? `Quotation ${quotation.quotationNo || quotationId} paid in full: tax invoice ${invoiceNo} raised as Paid`
          : `Quotation ${quotation.quotationNo || quotationId} invoiced as ${invoiceNo} (${paid > 0 ? `${paid} already paid carried over` : 'nothing paid yet'})`,
        metadata: {
          quotationId: String(quotationId),
          invoiceNo,
          grandTotal,
          paid,
          paymentRequests: proformas.map((p) => p.invoiceNo || String(p._id)),
          movedPayments
        }
      });
      const saved = (await Invoice.findOne({ ...baseFilter(req), _id: String(invoice._id) }).lean()) || invoice;
      return { invoiced: true, invoiceId: String(invoice._id), invoiceNo, invoice: saved, movedPayments };
    } catch (error) {
      // Release the claim so the next confirmation (or staff) can raise it.
      await Estimate.updateOne(
        { ...baseFilter(req), _id: String(quotationId), convertedInvoiceId: claim },
        { $set: { convertedInvoiceId: null } }
      ).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (!requireFullPayment) throw error;
    console.warn('[plugin:openext-crm-suite] invoicing a fully paid quotation failed:', error?.message || error);
    return { invoiced: false, error: error?.message || 'invoice failed' };
  }
}

/** True when the quotation has any payment request (proforma) — its money must move onto the invoice. */
async function hasPaymentRequests(req, quotation) {
  const Invoice = getInvoiceModel(req);
  const id = String(quotation?._id || '');
  if (!id) return false;
  const found = await Invoice.findOne({
    ...baseFilter(req),
    documentType: 'proforma',
    $or: [{ quotationId: id }, { convertedQuotationId: id }]
  }).lean();
  return Boolean(found);
}

/* -------------------------------------------------------------- creation */

/**
 * The proforma for a quotation, creating it on first use.
 *
 * One proforma per quotation: pressing Pay twice reuses the open request
 * rather than issuing a second number.
 */
async function ensureProformaForQuotation(req, quotationId, options = {}) {
  const proformaEnabled = await isProformaEnabled(req);
  if (!proformaEnabled && !options.allowPayment && options.source !== 'portal') {
    await assertProformaEnabled(req);
  }

  const Invoice = getInvoiceModel(req);
  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);
  const settings = await SettingService.getAll(req);

  const QuotationService = require('./quotation.service');
  const quotation = await QuotationService.getById(req, quotationId);

  if (['Rejected', 'Expired'].includes(String(quotation.status))) {
    throw appError(`A ${String(quotation.status).toLowerCase()} quotation cannot be paid.`, 409);
  }

  // Paid is decided by the payment records alone; a paid quotation takes no more money.
  const state = await quotationPaymentState(req, quotation, { settings });
  if (state.status === 'Paid') {
    throw codedError('This quotation has already been paid in full.', 409, 'QUOTATION_PAID');
  }
  if (quotation.convertedInvoiceId) {
    throw codedError(
      `This quotation is invoiced${state.invoiceNo ? ` (${state.invoiceNo})` : ''}: pay the invoice instead.`,
      409,
      'QUOTATION_INVOICED'
    );
  }

  // Advance workflow: the advance paid completes the quotation's payment step; the rest is the tax invoice's.
  if (state.advanceSatisfied) {
    throw codedError(
      `The advance of ${state.advancePaid} ${state.currency} is paid. The remaining ${state.balance} ${state.currency} is payable on the Tax Invoice once it is issued.`,
      409,
      'ADVANCE_PAID'
    );
  }

  // One open payment request at a time: pressing Pay twice reuses it.
  const existingId = String(quotation.proformaInvoiceId || '').trim();
  const candidates = [];
  if (existingId) candidates.push(await Invoice.findOne({ ...baseFilter(req), _id: existingId }).lean());
  candidates.push(await openProformaForQuotation(req, quotation));
  const reusable = candidates.find(
    (doc) =>
      doc &&
      doc.documentType === 'proforma' &&
      !doc.convertedInvoiceId &&
      doc.status !== 'Cancelled' &&
      round2(doc.balanceDue ?? doc.grandTotal) > 0
  );
  if (reusable) return { proforma: reusable, quotation, reused: true };

  let payable;
  if (state.isAdvanceFlow && state.paid > 0) {
    // Part of the advance is in: the next request is for the rest of the advance.
    payable = { amount: round2(state.advanceRequired - state.advancePaid), isAdvance: true, total: round2(quotation.grandTotal) };
  } else if (state.paid > 0) {
    // The advance is in: the next request is for exactly what is left.
    payable = { amount: state.balance, isAdvance: false, isBalance: true, total: round2(quotation.grandTotal) };
  } else if (proformaEnabled || quotation?.paymentType === 'advance') {
    payable = computePayableAmount(quotation, settings);
  } else {
    const total = round2(quotation?.grandTotal);
    if (!(total > 0)) {
      throw appError('This quotation has no amount to pay.', 409);
    }
    payable = { amount: total, isAdvance: false, total };
  }
  const { amount, isAdvance, total } = payable;
  const isBalance = Boolean(payable.isBalance);
  const clientId =
    String(quotation.clientId || '').trim() ||
    (await QuotationService.resolveQuotationClientId(req, quotation, { convertLead: false }).catch(
      () => ''
    ));

  const proformaNo = await getNextNumber(req, 'proforma');
  const issueDate = new Date();

  const doc = await Invoice.create(await withCustomerSnapshot(req, {
    tenantId: resolveTenantId(req),
    documentType: 'proforma',
    clientId: clientId || '',
    leadId: quotation.leadId || null,
    quotationId: String(quotationId),
    convertedQuotationId: String(quotationId),
    invoiceNo: proformaNo,
    issueDate,
    dueDate: issueDate,
    status: 'Sent',
    currency: quotation.currency || settings.default_currency || 'INR',
    exchangeRate: Number(quotation.exchangeRate) || 1,
    // The request carries one line for what is being collected now; the full
    // breakdown lives on the quotation and on the tax invoice that follows.
    lineItems: isBalance
      ? [
          {
            name: `Balance against ${quotation.quotationNo || 'quotation'}`,
            description: `Remaining payment — ${amount} of ${total}`,
            qty: 1,
            rate: amount,
            tax: 0,
            amount
          }
        ]
      : isAdvance
      ? [
          {
            name: `Advance against ${quotation.quotationNo || 'quotation'}`,
            description: `Advance payment — ${round2((amount / total) * 100)}% of ${total}`,
            qty: 1,
            rate: amount,
            tax: 0,
            amount
          }
        ]
      : Array.isArray(quotation.lineItems)
        ? quotation.lineItems
        : [],
    subtotal: amount,
    taxTotal: 0,
    grandTotal: amount,
    amountPaid: 0,
    balanceDue: amount,
    notes: isBalance
      ? `Balance payment request for quotation ${quotation.quotationNo || ''}`.trim()
      : isAdvance
      ? `Advance payment request for quotation ${quotation.quotationNo || ''}`.trim()
      : `Payment request for quotation ${quotation.quotationNo || ''}`.trim(),
    createdBy: userId,
    updatedBy: userId
  }));

  const proforma = doc.toObject ? doc.toObject() : doc;

  await Estimate.updateOne(
    { ...baseFilter(req), _id: String(quotationId) },
    {
      $set: {
        proformaInvoiceId: String(proforma._id),
        proformaInvoiceNo: proformaNo,
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'proforma_created',
    module: 'invoice',
    recordId: String(proforma._id),
    description: `Proforma ${proformaNo} raised for quotation ${quotation.quotationNo || quotationId}`,
    metadata: {
      quotationId: String(quotationId),
      proformaNo,
      amount,
      quotationTotal: total,
      isAdvance,
      isBalance,
      requestedBy: options.source || 'staff'
    }
  });

  return { proforma, quotation, reused: false };
}

/* ------------------------------------------------------------ conversion */

/**
 * Turn a proforma into the tax invoice, once.
 *
 * The tax invoice carries the **full** quotation value — an invoice for only the balance would
 * understate the supply — and every verified payment of the quotation's payment requests (the advance)
 * moves onto it, so its balance is total − advance − other payments. The proforma is closed as
 * 'Converted' with what it collected kept on record; the payment records themselves are kept (only
 * their document link moves, the proforma link is remembered), so nothing is counted twice.
 * A repeated call returns the invoice already raised.
 */
async function convertProformaToTaxInvoice(req, proformaId, options = {}) {
  if (!options.skipFeatureCheck) await assertProformaEnabled(req);

  const Invoice = getInvoiceModel(req);
  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);

  const proforma = await Invoice.findOne({ ...baseFilter(req), _id: String(proformaId) }).lean();
  if (!proforma) throw appError('Proforma not found', 404);
  if (proforma.documentType !== 'proforma') {
    throw appError('This document is already a tax invoice.', 409);
  }
  if (proforma.convertedInvoiceId) return alreadyConverted(req, proforma);

  const quotationId = String(proforma.quotationId || proforma.convertedQuotationId || '').trim();
  const quotation = quotationId
    ? await Estimate.findOne({ ...baseFilter(req), _id: quotationId }).lean()
    : null;
  const { salesOrderId, salesOrderNo } = await resolveSalesOrder(req, proforma, quotation, options);

  let invoice;
  let movedPayments = 0;
  if (quotation && quotation.convertedInvoiceId && !isClaim(quotation.convertedInvoiceId)) {
    // The quotation was invoiced another way: this proforma's money moves onto that invoice.
    const existing = await Invoice.findOne({ ...baseFilter(req), _id: String(quotation.convertedInvoiceId) }).lean();
    if (!existing) throw appError('The invoice of this quotation was not found.', 404);
    invoice = (await carryOpenProformaToInvoice(req, quotationId, existing)) || existing;
  } else if (quotation) {
    // One tax invoice for the quotation, carrying every payment request's money (claimed on the quotation).
    const result = await invoiceQuotationWithPayments(req, quotationId, { requireFullPayment: false });
    if (!result.invoiced) {
      const again = await Invoice.findOne({ ...baseFilter(req), _id: String(proformaId) }).lean();
      if (again && again.convertedInvoiceId) return alreadyConverted(req, again);
      throw codedError('This proforma is being converted. Refresh in a moment.', 409, 'CONVERSION_IN_PROGRESS');
    }
    invoice = result.invoice;
    movedPayments = result.movedPayments || 0;
  } else {
    const result = await convertStandaloneProforma(req, proforma);
    if (result.alreadyConverted) return result;
    invoice = result.invoice;
    movedPayments = result.movedPayments;
  }

  if (salesOrderId) {
    await Invoice.updateOne(
      { ...baseFilter(req), _id: String(invoice._id) },
      { $set: { salesOrderId: String(salesOrderId), salesOrderNo: salesOrderNo ? String(salesOrderNo) : null, updatedBy: userId } }
    );
    await Invoice.updateOne(
      { ...baseFilter(req), _id: String(proforma._id) },
      { $set: { salesOrderId: String(salesOrderId), salesOrderNo: salesOrderNo ? String(salesOrderNo) : null, updatedBy: userId } }
    );
    try {
      const SalesOrder = req.cms?.models.get('SalesOrder');
      if (SalesOrder) {
        await SalesOrder.updateOne(
          { ...baseFilter(req), _id: String(salesOrderId), convertedInvoiceId: null },
          {
            $set: {
              convertedInvoiceId: String(invoice._id),
              convertedInvoiceNo: invoice.invoiceNo,
              invoiceStatus: invoice.status || 'Sent',
              updatedBy: userId
            }
          }
        );
      }
    } catch (_) {}
  }

  const saved = (await Invoice.findOne({ ...baseFilter(req), _id: String(invoice._id) }).lean()) || invoice;
  const summary = await invoicePaymentSummary(req, saved);
  await AuditService.log(req, {
    action: 'proforma_converted',
    module: 'invoice',
    recordId: String(saved._id),
    description: `Proforma ${proforma.invoiceNo} converted to tax invoice ${saved.invoiceNo}`,
    metadata: {
      proformaId: String(proforma._id),
      proformaNo: proforma.invoiceNo || '',
      salesOrderId: salesOrderId ? String(salesOrderId) : null,
      salesOrderNo: salesOrderNo ? String(salesOrderNo) : null,
      invoiceNo: saved.invoiceNo,
      grandTotal: summary.total,
      advanceCarried: summary.advancePaid,
      balanceDue: summary.balance,
      movedPayments
    }
  });

  const closed = (await Invoice.findOne({ ...baseFilter(req), _id: String(proforma._id) }).lean()) || proforma;
  return { invoice: saved, proforma: closed, movedPayments, advanceCarried: summary.advancePaid };
}

/** A repeated conversion: the invoice already raised (or 409 while the first call is still running). */
async function alreadyConverted(req, proforma) {
  if (isClaim(proforma.convertedInvoiceId)) {
    throw codedError('This proforma is being converted. Refresh in a moment.', 409, 'CONVERSION_IN_PROGRESS');
  }
  const Invoice = getInvoiceModel(req);
  const invoice = await Invoice.findOne({ ...baseFilter(req), _id: String(proforma.convertedInvoiceId) }).lean();
  if (!invoice) {
    throw appError(`This proforma was already converted into invoice ${proforma.convertedInvoiceNo || proforma.convertedInvoiceId}.`, 409);
  }
  return { invoice, proforma, movedPayments: 0, alreadyConverted: true };
}

/** The sales order of a proforma: given, on the proforma or quotation, or the quotation's order. */
async function resolveSalesOrder(req, proforma, quotation, options = {}) {
  let salesOrderId = options.salesOrderId || proforma.salesOrderId || quotation?.convertedSalesOrderId || null;
  let salesOrderNo = options.salesOrderNo || proforma.salesOrderNo || null;
  try {
    const SalesOrder = req.cms?.models.get('SalesOrder');
    if (SalesOrder && salesOrderId && !salesOrderNo) {
      const so = await SalesOrder.findOne({ ...baseFilter(req), _id: String(salesOrderId) }, { orderNumber: 1 }).lean();
      if (so) salesOrderNo = so.orderNumber;
    }
    if (SalesOrder && !salesOrderId && quotation) {
      const so = await SalesOrder.findOne({ ...baseFilter(req), quotationId: String(quotation._id) }, { _id: 1, orderNumber: 1 }).lean();
      if (so) {
        salesOrderId = String(so._id);
        salesOrderNo = so.orderNumber;
      }
    }
  } catch (_) {}
  return { salesOrderId, salesOrderNo };
}

/** A proforma with no quotation behind it: the tax invoice is raised from the proforma itself (claimed). */
async function convertStandaloneProforma(req, proforma) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const settings = await SettingService.getAll(req);
  const claim = `${INVOICE_CLAIM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const claimed = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: String(proforma._id), $or: [{ convertedInvoiceId: null }, { convertedInvoiceId: '' }] },
    { $set: { convertedInvoiceId: claim } },
    { new: true }
  ).lean();
  if (!claimed) {
    const again = await Invoice.findOne({ ...baseFilter(req), _id: String(proforma._id) }).lean();
    return alreadyConverted(req, again || proforma);
  }
  try {
    const grandTotal = round2(proforma.grandTotal);
    const paid = Math.min(paidSum(await verifiedPayments(req, [String(proforma._id)])), grandTotal);
    const invoiceNo = await getNextNumber(req, 'invoice');
    const issueDate = new Date();
    const paymentDays = Number(settings.invoice_payment_days || settings.payment_terms_days || 30);
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + paymentDays);
    const created = await Invoice.create(await withCustomerSnapshot(req, {
      tenantId: resolveTenantId(req),
      documentType: 'tax',
      clientId: proforma.clientId || '',
      leadId: proforma.leadId || null,
      proformaInvoiceId: String(proforma._id),
      proformaInvoiceNo: proforma.invoiceNo || '',
      invoiceNo,
      issueDate,
      dueDate,
      status: paid > 0 && paid + 0.05 >= grandTotal ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Sent',
      currency: proforma.currency || settings.default_currency || 'INR',
      exchangeRate: Number(proforma.exchangeRate) || 1,
      lineItems: Array.isArray(proforma.lineItems) ? proforma.lineItems : [],
      subtotal: round2(proforma.subtotal),
      taxTotal: round2(proforma.taxTotal),
      grandTotal,
      amountPaid: paid,
      advancePaid: paid,
      balanceDue: round2(Math.max(0, grandTotal - paid)),
      notes: proforma.notes ? String(proforma.notes).trim() : '',
      createdBy: userId,
      updatedBy: userId
    }));
    const invoice = created.toObject ? created.toObject() : created;
    const movedPayments = await movePaymentsToInvoice(req, proforma, invoice);
    await closeConvertedProforma(req, proforma, invoice, paid);
    return { invoice, movedPayments };
  } catch (error) {
    await Invoice.updateOne(
      { ...baseFilter(req), _id: String(proforma._id), convertedInvoiceId: claim },
      { $set: { convertedInvoiceId: null } }
    ).catch(() => {});
    throw error;
  }
}

/** The payments of a proforma now count on the tax invoice; the records stay, remembering the proforma. */
async function movePaymentsToInvoice(req, proforma, invoice) {
  const Payment = req.cms?.models.get('Payment');
  if (!Payment || typeof Payment.updateMany !== 'function') return 0;
  const result = await Payment.updateMany(
    { ...baseFilter(req), invoiceId: String(proforma._id) },
    { $set: { invoiceId: String(invoice._id), proformaInvoiceId: String(proforma._id), updatedBy: resolveUserId(req) } }
  );
  return result?.modifiedCount || 0;
}

/** The proforma closes as Converted: settled, pointing at the invoice, with what it collected kept. */
async function closeConvertedProforma(req, proforma, invoice, collected) {
  const Invoice = getInvoiceModel(req);
  await Invoice.updateOne(
    { ...baseFilter(req), _id: String(proforma._id) },
    {
      $set: {
        status: PROFORMA_CONVERTED,
        convertedInvoiceId: String(invoice._id),
        convertedInvoiceNo: invoice.invoiceNo || '',
        convertedAt: new Date(),
        amountPaid: round2(collected),
        balanceDue: 0,
        updatedBy: resolveUserId(req)
      }
    }
  );
}

/* ------------------------------------------------------- payment side-effect */

/**
 * Accept the quotation behind a paid proforma, when the tenant asked for that.
 *
 * Both switches must be on. Accepting runs the ordinary accept path, which
 * also marks the opportunity Won and locks the deal — which is why it is a
 * setting and not a default.
 */
async function maybeAutoAcceptQuotationForInvoice(req, invoice) {
  if (!invoice || invoice.documentType !== 'proforma') return { accepted: false };
  // In the proforma flow the client has no Accept button: the first verified payment is the acceptance.
  if (!(await isProformaEnabled(req)) && !(await isAutoAcceptOnPaymentEnabled(req))) return { accepted: false };
  if (!(round2(invoice.amountPaid) > 0)) return { accepted: false };

  const quotationId = String(invoice.quotationId || invoice.convertedQuotationId || '').trim();
  if (!quotationId) return { accepted: false };

  try {
    const QuotationService = require('./quotation.service');
    const quotation = await QuotationService.getById(req, quotationId);
    if (String(quotation.status) === 'Accepted' || String(quotation.status) === 'Converted') {
      return { accepted: false, alreadyAccepted: true };
    }
    await QuotationService.accept(req, quotationId, { system: true, paymentVerified: true });
    return { accepted: true, quotationId };
  } catch (error) {
    // A payment must never fail because the acceptance did.
    console.warn(
      '[plugin:openext-crm-suite] auto-accept after payment failed:',
      error?.message || error
    );
    return { accepted: false, error: error?.message || 'auto-accept failed' };
  }
}

/** The open (not converted, not cancelled) proforma of a quotation, or null. */
async function openProformaForQuotation(req, quotation) {
  const Invoice = getInvoiceModel(req);
  const quotationId = String(quotation && quotation._id || '');
  if (!quotationId) return null;
  const or = [{ quotationId }];
  if (quotation.proformaInvoiceId) or.push({ _id: String(quotation.proformaInvoiceId) });
  return Invoice.findOne({
    ...baseFilter(req),
    documentType: 'proforma',
    convertedInvoiceId: null,
    status: { $nin: ['Cancelled', PROFORMA_CONVERTED] },
    isDeleted: { $ne: true },
    $or: or
  }).lean();
}

/**
 * A tax invoice was made another way (the invoice form, an opportunity) for a quotation whose
 * proforma already holds money: move that money onto the new invoice, so only the rest is due,
 * and close the proforma as Converted — the same end state as converting the proforma. Never throws.
 * @returns {Promise<object|null>} the updated invoice, or null when there was nothing to carry
 */
async function carryOpenProformaToInvoice(req, quotationId, invoice) {
  try {
    if (!quotationId || !invoice || invoice.documentType === 'proforma') return null;
    const Invoice = getInvoiceModel(req);
    const Estimate = getEstimateModel(req);
    const userId = resolveUserId(req);
    const quotation = await Estimate.findOne({ ...baseFilter(req), _id: String(quotationId) }).lean();
    if (!quotation) return null;
    const proforma = await openProformaForQuotation(req, quotation);
    if (!proforma || String(proforma._id) === String(invoice._id)) return null;
    const collected = paidSum(await verifiedPayments(req, [String(proforma._id)]));
    const movedPayments = collected > 0 ? await movePaymentsToInvoice(req, proforma, invoice) : 0;

    // The invoice's money from its payment records after the move.
    const total = round2(invoice.grandTotal);
    const onInvoice = paidSum(await verifiedPayments(req, [String(invoice._id)]));
    const paid = Math.min(onInvoice, total);
    const invoiceSet = {
      proformaInvoiceId: String(proforma._id),
      proformaInvoiceNo: proforma.invoiceNo || '',
      updatedBy: userId
    };
    if (paid > 0) {
      const balance = round2(Math.max(0, total - paid - round2(invoice.creditAmount)));
      invoiceSet.amountPaid = paid;
      invoiceSet.advancePaid = round2(Number(invoice.advancePaid || 0) + collected);
      invoiceSet.balanceDue = balance;
      invoiceSet.status = balance <= 0 ? 'Paid' : 'Partially Paid';
    }
    await Invoice.updateOne({ ...baseFilter(req), _id: String(invoice._id) }, { $set: invoiceSet });
    await closeConvertedProforma(req, proforma, invoice, collected);
    await AuditService.log(req, {
      action: 'proforma_converted',
      module: 'invoice',
      recordId: String(invoice._id),
      description: `Advance of ${collected} from proforma ${proforma.invoiceNo || ''} applied to invoice ${invoice.invoiceNo || ''}`.trim(),
      metadata: {
        proformaId: String(proforma._id),
        quotationId: String(quotationId),
        advanceCarried: collected,
        // More was paid than this invoice asks for: kept on record for a refund or credit note.
        excess: round2(Math.max(0, onInvoice - total)),
        movedPayments
      }
    });
    return { ...invoice, ...invoiceSet };
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] applying the proforma advance to the invoice failed:', error?.message || error);
    return null;
  }
}

/**
 * Raise the tax invoice of an accepted quotation that is paid in full (Settings → General →
 * "Raise the tax invoice when paid in full"). The payment moves onto the invoice, which is then Paid.
 * An advance alone never invoices. Never throws: the payment and the acceptance already stand.
 */
async function maybeAutoInvoicePaidQuotation(req, quotationId) {
  try {
    if (!quotationId) return { invoiced: false };
    // The proforma flow always invoices at full payment, from every payment request (advance + balance).
    if (await isProformaEnabled(req)) return invoicePaidQuotation(req, quotationId);
    if (!(await isAutoInvoiceOnFullPaymentEnabled(req))) return { invoiced: false };
    const Estimate = getEstimateModel(req);
    const quotation = await Estimate.findOne({ ...baseFilter(req), _id: String(quotationId) }).lean();
    if (!quotation || quotation.convertedInvoiceId) return { invoiced: false };
    if (!['Accepted', 'Converted'].includes(String(quotation.status))) return { invoiced: false, reason: 'not_accepted' };
    const proforma = await openProformaForQuotation(req, quotation);
    if (!proforma) return { invoiced: false };
    const paid = round2(proforma.amountPaid);
    if (!(paid > 0) || paid + 0.05 < round2(quotation.grandTotal)) return { invoiced: false, reason: 'not_paid_in_full' };
    const result = await convertProformaToTaxInvoice(req, proforma._id);
    return { invoiced: true, invoiceId: String(result.invoice._id), invoiceNo: result.invoice.invoiceNo };
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] auto invoice after full payment failed:', error?.message || error);
    return { invoiced: false, error: error?.message || 'auto invoice failed' };
  }
}

/**
 * After money is recorded against an invoice (Razorpay or entered by staff): when it is a proforma,
 * accept its quotation (if switched on) and raise the tax invoice once it is paid in full (if switched on).
 * Never throws.
 */
async function afterProformaPayment(req, invoiceId) {
  try {
    const Invoice = getInvoiceModel(req);
    const invoice = await Invoice.findOne({ ...baseFilter(req), _id: String(invoiceId) }).lean();
    if (!invoice || invoice.documentType !== 'proforma') return null;
    const autoAccept = await maybeAutoAcceptQuotationForInvoice(req, invoice);
    const quotationId = String(invoice.quotationId || invoice.convertedQuotationId || '').trim();
    const autoInvoice = await maybeAutoInvoicePaidQuotation(req, quotationId);
    return { autoAccept, autoInvoice };
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] proforma payment follow-up failed:', error?.message || error);
    return null;
  }
}

/**
 * Auto-convert an unconverted proforma linked to a sales order (or its quotation)
 * into a tax invoice when the order reaches Delivered status.
 *
 * Safe: fails gracefully and returns { converted: false } if the setting is off,
 * no proforma exists, or it has already been converted.
 */
async function maybeAutoConvertProformaForSalesOrder(req, salesOrder) {
  if (!salesOrder) return { converted: false };
  if (!(await isAutoConvertOnDeliveryEnabled(req))) return { converted: false };

  const orderId = salesOrder._id ? String(salesOrder._id) : (salesOrder.id ? String(salesOrder.id) : null);
  const quotationId = salesOrder.quotationId ? String(salesOrder.quotationId).trim() : null;
  const orderNumber = salesOrder.orderNumber || salesOrder.orderNo || '';

  const Invoice = getInvoiceModel(req);

  const orConditions = [];
  if (orderId) {
    orConditions.push({ salesOrderId: orderId });
  }
  if (quotationId) {
    orConditions.push({ quotationId: quotationId });
  }

  if (!orConditions.length) {
    return { converted: false };
  }

  const query = {
    ...baseFilter(req),
    documentType: 'proforma',
    convertedInvoiceId: null,
    $or: orConditions
  };

  const proforma = await Invoice.findOne(query).lean();
  if (!proforma) {
    return { converted: false };
  }

  try {
    const result = await convertProformaToTaxInvoice(req, proforma._id, {
      salesOrderId: orderId,
      salesOrderNo: orderNumber
    });
    return {
      converted: true,
      proformaId: String(proforma._id),
      invoiceId: String(result.invoice._id),
      invoiceNo: result.invoice.invoiceNo,
      invoice: result.invoice
    };
  } catch (error) {
    console.warn(
      '[plugin:openext-crm-suite] proforma auto-convert on sales order delivery failed:',
      error?.message || error
    );
    return { converted: false, error: error?.message || 'Conversion failed' };
  }
}

module.exports = {
  computeQuotationPaymentState,
  PAYMENT_STATE_DOC_FIELDS,
  findRows,
  paidSum,
  bookingEligibility,
  isProformaEnabled,
  isAutoAcceptOnPaymentEnabled,
  isAutoConvertOnDeliveryEnabled,
  isAutoInvoiceOnFullPaymentEnabled,
  assertProformaEnabled,
  computePayableAmount,
  ensureProformaForQuotation,
  convertProformaToTaxInvoice,
  maybeAutoAcceptQuotationForInvoice,
  maybeAutoInvoicePaidQuotation,
  afterProformaPayment,
  carryOpenProformaToInvoice,
  openProformaForQuotation,
  quotationPaymentState,
  invoicePaidQuotation,
  invoiceQuotationWithPayments,
  hasPaymentRequests,
  invoicePaymentSummary,
  verifiedPayments,
  PROFORMA_CONVERTED,
  VERIFIED_PAYMENT_STATUSES,
  maybeAutoConvertProformaForSalesOrder
};
