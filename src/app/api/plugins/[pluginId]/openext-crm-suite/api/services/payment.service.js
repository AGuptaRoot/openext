'use strict';

const { resolveTenantId, resolveUserId, applyClientScope, applyClientScopeAsync } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { getNextNumber } = require('../utils/numbering.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const InvoiceService = require('./invoice.service');
const AuditService = require('./audit.service');
const { buildCustomerLabelMaps, resolveCustomerLabel, enrichWithCustomerLabel } = require('../utils/customer-label.util');
const { isAdmin } = require('../utils/sales-access.util');

const PAYMENT_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other'];

function getPaymentModel(req) {
  const Payment = req.cms?.models.get('Payment');
  if (!Payment) throw new Error('Payment model is not registered');
  return Payment;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  const filter = { tenantId: resolveTenantId(req), isDeleted: false };
  return applyClientScope(req, filter, 'clientId');
}

/**
 * Payments a scoped staff member (sales rep) may see: those on the invoices they created, and those
 * they recorded themselves. null = no limit (finance managers, managers, admins; clients are scoped
 * by baseFilter).
 */
async function staffPaymentScope(req) {
  const { isFinanceCreatorScoped } = require('../utils/sales-access.util');
  if (!isFinanceCreatorScoped(req)) return null;
  const userId = resolveUserId(req);
  const ids = [];
  try {
    const Invoice = req.cms?.models.get('Invoice');
    if (Invoice) {
      let q = Invoice.find({ tenantId: resolveTenantId(req), isDeleted: false, createdBy: userId });
      if (q && typeof q.select === 'function') q = q.select('_id');
      if (q && typeof q.limit === 'function') q = q.limit(5000);
      const rows = (q && typeof q.lean === 'function' ? await q.lean() : await q) || [];
      for (const row of rows) ids.push(String(row._id));
    }
  } catch {
    // only their own recorded payments then
  }
  return ids.length ? { $or: [{ createdBy: userId }, { invoiceId: { $in: ids } }] } : { createdBy: userId };
}

async function withStaffPaymentScope(req, filter) {
  const scope = await staffPaymentScope(req);
  if (!scope) return filter;
  return require('../utils/sales-access.util').mergeScopeIntoFilter(filter, scope);
}

function normalizeMode(mode) {
  const value = String(mode || 'Other').trim();
  if (!PAYMENT_MODES.includes(value)) {
    throw appError(`Invalid payment mode. Allowed: ${PAYMENT_MODES.join(', ')}`);
  }
  return value;
}

function normalizeAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw appError('Payment amount must be greater than zero');
  }
  return Math.round(value * 100) / 100;
}

async function findPaymentOrThrow(req, id) {
  const doc = await getPaymentModel(req).findOne(await withStaffPaymentScope(req, { ...baseFilter(req), _id: id })).lean();
  if (!doc) throw appError('Payment not found', 404);
  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId || String(doc.clientId) !== String(userClientId)) {
      throw appError('Payment not found', 404);
    }
  }
  return doc;
}

async function validateAmountForInvoice(req, invoiceId, amount, excludePaymentId = null) {
  const invoice = await InvoiceService.getById(req, invoiceId);
  const Payment = getPaymentModel(req);

  const filter = { ...baseFilter(req), invoiceId: String(invoiceId) };
  if (excludePaymentId) {
    filter._id = { $ne: excludePaymentId };
  }

  // Money already on the invoice: every live payment (a pending one too, so it is never paid twice),
  // net of refunds; failed and cancelled attempts do not count. Credits reduce what is owed.
  const otherPayments = await Payment.find(filter).lean();
  const otherTotal = otherPayments
    .filter((payment) => !['Failed', 'Cancelled'].includes(String(payment.status || '')))
    .reduce((sum, payment) => sum + Math.max(0, (Number(payment.amount) || 0) - (Number(payment.refundedAmount) || 0)), 0);
  const owed = Math.round((Number(invoice.grandTotal) - Number(invoice.creditAmount || 0)) * 100) / 100;
  if (otherTotal + 0.005 >= owed && owed > 0) {
    const error = appError('This invoice is already paid in full', 409);
    error.code = 'INVOICE_PAID';
    throw error;
  }
  const newTotal = Math.round((otherTotal + amount) * 100) / 100;

  if (newTotal > owed + 0.005) {
    throw appError('Payment exceeds invoice balance due', 409);
  }

  return invoice;
}

async function assertClientExists(req, clientId) {
  const Company = req.cms?.models.get('Company');
  if (!Company) throw appError('Company model is not registered', 500);

  const id = String(clientId || '').trim();
  if (!id) throw appError('clientId is required', 400);

  const client = await Company.findOne({ ...baseFilter(req), mergedIntoId: null, _id: id }).lean();
  if (client) return client;

  /** Allow payment when open invoices exist for this client (e.g. converted lead not in agent scope). */
  const Invoice = req.cms?.models.get('Invoice');
  if (Invoice) {
    const hasOpenInvoice = await Invoice.exists({
      ...baseFilter(req),
      clientId: id,
      balanceDue: { $gt: 0 },
      status: { $nin: ['Cancelled', 'Draft'] }
    });
    if (hasOpenInvoice) {
      return { _id: id, name: `Customer (${id.slice(-6)})` };
    }
  }

  throw appError('Client not found', 404);
}

/** Open invoices for a client — oldest due date first (FIFO allocation). */
async function listOpenInvoicesForClient(req, clientId) {
  const Invoice = req.cms?.models.get('Invoice');
  if (!Invoice) throw appError('Invoice model is not registered', 500);

  await assertClientExists(req, clientId);

  return Invoice.find({
    ...baseFilter(req),
    clientId: String(clientId),
    balanceDue: { $gt: 0 },
    status: { $nin: ['Cancelled', 'Draft'] }
  })
    .sort({ dueDate: 1, createdAt: 1 })
    .lean();
}

async function recordRazorpayPayment(req, input) {
  const invoiceId = String(input.invoiceId || '').trim();
  if (!invoiceId) throw appError('invoiceId is required', 400);

  const amount = normalizeAmount(input.amount);
  const invoice = await validateAmountForInvoice(req, invoiceId, amount);

  if (invoice.status === 'Cancelled') {
    throw appError('Cannot record payment against a cancelled invoice', 409);
  }
  if (invoice.status === 'Draft') {
    throw appError('Cannot record payment against a draft invoice. Send the invoice first.', 409);
  }

  const transactionId = String(input.transactionId || '').trim();
  if (!transactionId) throw appError('transactionId is required', 400);

  const Payment = getPaymentModel(req);
  const duplicate = await Payment.findOne({
    ...baseFilter(req),
    transactionId,
    isDeleted: false
  }).lean();
  if (duplicate) {
    throw appError('This Razorpay payment has already been recorded', 409);
  }

  const mode = input.mode && PAYMENT_MODES.includes(input.mode) ? input.mode : 'Other';
  const remark = input.remark ? String(input.remark).trim() : '';

  return recordPaymentAgainstInvoice(req, {
    mode,
    currency: input.currency,
    transactionId,
    reference: transactionId,
    paymentGateway: 'Razorpay',
    remark,
    notes: remark,
    paymentDate: input.paymentDate
  }, invoiceId, amount);
}

async function recordPaymentAgainstInvoice(req, input, invoiceId, amount) {
  const Payment = getPaymentModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const normalizedAmount = normalizeAmount(amount);
  const mode = normalizeMode(input.mode);
  // The stored balance is recounted from verified payments first (advance carried from the proforma
  // included), so the checks below and the status after this payment never rest on a stale figure.
  if (typeof InvoiceService.syncInvoiceBalance === 'function') {
    try {
      await InvoiceService.syncInvoiceBalance(req, invoiceId);
    } catch {
      /* validated below on the stored figures */
    }
  }
  const invoice = await validateAmountForInvoice(req, invoiceId, normalizedAmount);

  if (invoice.status === 'Cancelled') {
    throw appError('Cannot record payment against a cancelled invoice', 409);
  }
  if (invoice.documentType === 'proforma' && invoice.convertedInvoiceId) {
    throw appError(`This proforma was converted to tax invoice ${invoice.convertedInvoiceNo || ''}: record the payment on that invoice.`.replace(' :', ':'), 409);
  }
  if (invoice.status === 'Draft') {
    throw appError('Cannot record payment against a draft invoice. Send the invoice first.', 409);
  }
  if (normalizedAmount > invoice.balanceDue) {
    throw appError('Payment exceeds invoice balance due', 409);
  }

  const paymentNo = await getNextNumber(req, 'payment');
  const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date();
  const txId = input.transactionId ? String(input.transactionId).trim() : (input.reference ? String(input.reference).trim() : '');
  const rmk = input.remark ? String(input.remark).trim() : (input.notes ? String(input.notes).trim() : '');
  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req);
  const defaultCurrency = String(settings.default_currency || 'INR').trim().toUpperCase() || 'INR';
  const currency = input.currency
    ? String(input.currency).trim()
    : String(invoice.currency || defaultCurrency).trim();

  const doc = await Payment.create({
    tenantId,
    clientId: invoice.clientId,
    projectId: input.projectId ? String(input.projectId).trim() : (invoice.projectId ? String(invoice.projectId).trim() : ''),
    invoiceId: String(invoiceId),
    paymentNo,
    paymentDate,
    amount: normalizedAmount,
    currency,
    exchangeRate: Number(input.exchangeRate) > 0 ? Number(input.exchangeRate) : (Number(invoice.exchangeRate) || 1),
    mode,
    transactionId: txId,
    reference: txId,
    paymentGateway: input.paymentGateway ? String(input.paymentGateway).trim() : '',
    bankAccount: input.bankAccount ? String(input.bankAccount).trim() : '',
    receipt: input.receipt ? String(input.receipt).trim() : '',
    remark: rmk,
    notes: rmk,
    createdBy: userId,
    updatedBy: userId
  });

  try {
    await InvoiceService.applyPayment(req, invoiceId, normalizedAmount);
  } catch (error) {
    await Payment.deleteOne({ _id: doc._id });
    throw error;
  }
  // Status from the verified payments now on the invoice: 0 → unpaid, below the total → Partially Paid,
  // the total → Paid (Balance Due 0).
  if (typeof InvoiceService.syncInvoiceBalance === 'function') {
    try {
      await InvoiceService.syncInvoiceBalance(req, invoiceId);
    } catch (error) {
      console.warn('[plugin:openext-crm-suite] invoice balance recount after payment failed:', error?.message || error);
    }
  }

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'payment',
    recordId: result._id.toString(),
    description: `Payment recorded: ${paymentNo} (${normalizedAmount}) against ${invoice.invoiceNo}`,
    metadata: { invoiceId: result.invoiceId, clientId: result.clientId, amount: normalizedAmount }
  });

  // Money on a proforma may accept its quotation and raise the tax invoice (Settings → General).
  // Same for Razorpay and for payments entered by staff; never fails the payment.
  if (invoice.documentType === 'proforma') {
    const followUp = await require('./proforma.service').afterProformaPayment(req, String(invoiceId));
    if (followUp) result.proformaFollowUp = followUp;
  }

  // The active extension hears of every verified payment on a quotation (salesFlow.quotationForm.paidRoute).
  const paidQuotationId = String(invoice.quotationId || invoice.convertedQuotationId || '').trim();
  if (paidQuotationId) await require('./sales-flow.service').quotationPaid(req, paidQuotationId);

  return result;
}

async function list(req) {
  const Payment = getPaymentModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query, { sortField: 'paymentDate' });
  const filter = baseFilter(req);

  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: 'Client email ID not found in CRM records'
      };
    }
    filter.clientId = userClientId;
  } else {
    const queryClientId = req.query?.clientId || req.query?.client || req.query?.companyId;
    if (queryClientId) filter.clientId = String(queryClientId).trim();
  }

  if (req.query?.invoiceId) filter.invoiceId = String(req.query.invoiceId).trim();
  if (req.query?.mode) filter.mode = String(req.query.mode).trim();

  if (req.query?.search) {
    const { findMatchingClientIds } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const or = [
        { paymentNo: { $regex: term, $options: 'i' } },
        { paymentNumber: { $regex: term, $options: 'i' } },
        { receiptNumber: { $regex: term, $options: 'i' } },
        { transactionId: { $regex: term, $options: 'i' } },
        { invoiceNumber: { $regex: term, $options: 'i' } },
        { invoiceId: { $regex: term, $options: 'i' } },
        { clientId: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { customerLabel: { $regex: term, $options: 'i' } },
        { reference: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } }
      ];
      const clientIds = await findMatchingClientIds(req, req.query.search);
      if (clientIds.length) or.push({ clientId: { $in: clientIds } });
      filter.$or = or;
    }
  }

  const scopedFilter = await withStaffPaymentScope(req, filter);
  const [items, total] = await Promise.all([
    Payment.find(scopedFilter).sort(sort).skip(skip).limit(limit).lean(),
    Payment.countDocuments(scopedFilter)
  ]);

  const enriched = await enrichWithCustomerLabel(req, items);

  return {
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function getById(req, id) {
  const doc = await findPaymentOrThrow(req, id);
  return enrichWithCustomerLabel(req, doc);
}

async function listByClient(req, clientId) {
  const Company = req.cms?.models.get('Company');
  if (!Company) throw appError('Company model is not registered', 500);

  const client = await Company.findOne({ ...baseFilter(req), mergedIntoId: null, _id: clientId }).lean();
  if (!client) throw appError('Client not found', 404);

  return getPaymentModel(req)
    .find({ ...baseFilter(req), clientId: String(clientId) })
    .sort({ paymentDate: -1 })
    .lean();
}

async function createForClient(req, input) {
  const clientId = String(input.clientId || '').trim();
  if (!clientId) throw appError('clientId is required');

  const openInvoices = await listOpenInvoicesForClient(req, clientId);
  if (!openInvoices.length) {
    throw appError('This client has no open invoices to pay', 409);
  }

  const totalAmount = normalizeAmount(input.amount);
  const totalOutstanding = Math.round(
    openInvoices.reduce((sum, inv) => sum + (Number(inv.balanceDue) || 0), 0) * 100
  ) / 100;

  if (totalAmount > totalOutstanding) {
    throw appError('Payment exceeds total outstanding balance for this client', 409);
  }

  let remaining = totalAmount;
  const created = [];

  try {
    for (const invoice of openInvoices) {
      if (remaining <= 0) break;
      const balanceDue = Number(invoice.balanceDue) || 0;
      if (balanceDue <= 0) continue;

      const applyAmount = Math.min(remaining, balanceDue);
      const payment = await recordPaymentAgainstInvoice(req, input, invoice._id, applyAmount);
      created.push(payment);
      remaining = Math.round((remaining - applyAmount) * 100) / 100;
    }
  } catch (error) {
    for (const payment of created.slice().reverse()) {
      try {
        await remove(req, payment._id);
      } catch (rollbackError) {
        console.error('[plugin:openext-crm-suite] split payment rollback failed:', rollbackError);
      }
    }
    throw error;
  }

  if (created.length === 1) return created[0];

  return {
    split: true,
    clientId,
    totalAmount,
    payments: created
  };
}

async function createWithAllocations(req, input, allocations) {
  if (!Array.isArray(allocations) || !allocations.length) {
    throw appError('At least one invoice allocation is required', 400);
  }

  const created = [];
  let totalAllocated = 0;

  try {
    for (const alloc of allocations) {
      const invoiceId = String(alloc.invoiceId).trim();
      const applyAmount = normalizeAmount(alloc.amount);
      if (applyAmount <= 0) continue;
      totalAllocated = Math.round((totalAllocated + applyAmount) * 100) / 100;

      const payment = await recordPaymentAgainstInvoice(req, input, invoiceId, applyAmount);
      created.push(payment);
    }
  } catch (error) {
    for (const payment of created.slice().reverse()) {
      try {
        await remove(req, payment._id);
      } catch (rollbackError) {
        console.error('[plugin:openext-crm-suite] custom allocation rollback failed:', rollbackError);
      }
    }
    throw error;
  }

  if (created.length === 1) return created[0];

  return {
    split: true,
    clientId: input.clientId || created[0]?.clientId,
    totalAmount: totalAllocated,
    payments: created
  };
}

async function create(req, input) {
  if (Array.isArray(input.allocations) && input.allocations.length) {
    return createWithAllocations(req, input, input.allocations);
  }

  if (input.clientId && !input.invoiceId) {
    return createForClient(req, input);
  }

  if (!input.invoiceId) {
    throw appError('clientId or invoiceId is required');
  }

  const amount = normalizeAmount(input.amount);
  return recordPaymentAgainstInvoice(req, input, input.invoiceId, amount);
}

async function update(req, id, input) {
  const Payment = getPaymentModel(req);
  const userId = resolveUserId(req);
  const existing = await findPaymentOrThrow(req, id);

  const updates = { updatedBy: userId };

  if (input.paymentDate !== undefined) updates.paymentDate = new Date(input.paymentDate);
  if (input.mode !== undefined) updates.mode = normalizeMode(input.mode);
  if (input.transactionId !== undefined || input.reference !== undefined) {
    const tId = String(input.transactionId || input.reference || '').trim();
    updates.transactionId = tId;
    updates.reference = tId;
  }
  if (input.remark !== undefined || input.notes !== undefined) {
    const rmk = String(input.remark || input.notes || '').trim();
    updates.remark = rmk;
    updates.notes = rmk;
  }
  if (input.paymentGateway !== undefined) updates.paymentGateway = String(input.paymentGateway || '').trim();
  if (input.bankAccount !== undefined) updates.bankAccount = String(input.bankAccount || '').trim();
  if (input.receipt !== undefined) updates.receipt = String(input.receipt || '').trim();
  if (input.currency !== undefined) updates.currency = String(input.currency || '').trim();
  if (input.exchangeRate !== undefined) updates.exchangeRate = Number(input.exchangeRate) || 1;
  if (input.projectId !== undefined) updates.projectId = String(input.projectId || '').trim();

  if (input.amount !== undefined) {
    const amount = normalizeAmount(input.amount);
    await validateAmountForInvoice(req, existing.invoiceId, amount, id);
    updates.amount = amount;
  }

  const doc = await Payment.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await InvoiceService.syncInvoiceBalance(req, existing.invoiceId);

  await AuditService.log(req, {
    action: 'updated',
    module: 'payment',
    recordId: id,
    description: `Payment updated: ${doc.paymentNo}`
  });

  return doc;
}

async function remove(req, id) {
  const Payment = getPaymentModel(req);
  const userId = resolveUserId(req);
  const existing = await findPaymentOrThrow(req, id);

  await Payment.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );

  await InvoiceService.syncInvoiceBalance(req, existing.invoiceId);

  await AuditService.log(req, {
    action: 'deleted',
    module: 'payment',
    recordId: id,
    description: `Payment deleted: ${existing.paymentNo}`,
    metadata: { invoiceId: existing.invoiceId, amount: existing.amount }
  });

  return { deleted: true, id };
}

/** Sum of payment amounts in the requested period for dashboard */
async function sumThisMonth(req, { startDate = null, endDate = null } = {}) {
  const Payment = getPaymentModel(req);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const filter = {
    ...baseFilter(req)
  };
  if (startDate || endDate) {
    filter.paymentDate = {
      ...(startDate ? { $gte: startDate } : {}),
      ...(endDate ? { $lte: endDate } : {})
    };
  } else if (startDate === null && endDate === null && req?.query?.period === 'all') {
    // no date filter for 'all'
  } else {
    filter.paymentDate = { $gte: start, $lt: end };
  }

  const rows = await Payment.find(filter)
    .select('amount')
    .lean();

  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return Math.round(total * 100) / 100;
}

async function exportPayments(req, query = {}) {
  const Payment = getPaymentModel(req);
  let filter = baseFilter(req);

  const { isClientUser } = require('../utils/tenant.util');
  if (query.invoiceId) filter.invoiceId = String(query.invoiceId).trim();
  // A client's own customer id is already in baseFilter; a query may never replace it.
  if (query.clientId && !isClientUser(req)) filter.clientId = String(query.clientId).trim();
  if (query.paymentMode) filter.paymentMode = String(query.paymentMode).trim();
  if (query.from || query.to) {
    filter.paymentDate = {};
    if (query.from) filter.paymentDate.$gte = new Date(query.from);
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      filter.paymentDate.$lte = toDate;
    }
  }
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { paymentNo: { $regex: term, $options: 'i' } },
        { invoiceNo: { $regex: term, $options: 'i' } },
        { transactionId: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const raw = await Payment.find(await withStaffPaymentScope(req, filter)).sort({ paymentDate: -1, createdAt: -1 }).lean();
  const enriched = await enrichWithCustomerLabel(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'payment',
    recordId: 'export',
    description: `Exported ${enriched.length} payments in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `payments_export_${nowStr}.json`,
      content: JSON.stringify(enriched, null, 2),
      data: enriched,
      count: enriched.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'ID',
    'Payment Receipt Number',
    'Invoice Number',
    'Client Name',
    'Amount Received',
    'Payment Mode / Method',
    'Transaction Reference / ID',
    'Payment Date',
    'Notes',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const pay of enriched) {
    rows.push(
      [
        pay._id,
        pay.paymentNo || '',
        pay.invoiceNo || '',
        pay.clientCompany || pay.clientName || '',
        Number(pay.amount || 0),
        pay.paymentMode || '',
        pay.transactionId || '',
        pay.paymentDate ? new Date(pay.paymentDate).toISOString().slice(0, 10) : '',
        pay.notes || '',
        pay.createdAt ? new Date(pay.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `payments_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

/**
 * Requests a refund against an existing payment.
 */
async function requestRefund(req, paymentId, input) {
  const Payment = getPaymentModel(req);
  const userId = resolveUserId(req);
  const userName = req.user?.name || req.user?.username || req.user?.displayName || userId;
  const payment = await findPaymentOrThrow(req, paymentId);

  const amount = normalizeAmount(input.amount);
  const reason = String(input.reason || '').trim();
  if (!reason) throw appError('Refund reason is required', 400);

  const existingRefunds = Array.isArray(payment.refunds) ? payment.refunds : [];
  const approvedTotal = existingRefunds
    .filter((r) => ['Approved', 'Processed'].includes(r.status))
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const pendingTotal = existingRefunds
    .filter((r) => r.status === 'Pending Approval')
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  const availableRefundable = Math.max(0, Math.round((payment.amount - approvedTotal - pendingTotal) * 100) / 100);
  if (amount > availableRefundable) {
    throw appError(`Refund amount (${amount}) exceeds available refundable payment balance (${availableRefundable})`, 409);
  }

  const refundNo = await getNextNumber(req, 'refund');
  const now = new Date();
  const shouldAutoApprove = Boolean(input.autoApprove && isAdmin(req));

  const refundRecord = {
    refundNo,
    amount,
    reason,
    mode: input.mode || 'Bank Transfer',
    bankAccount: String(input.bankAccount || payment.bankAccount || '').trim(),
    transactionId: String(input.transactionId || '').trim(),
    receipt: String(input.receipt || '').trim(),
    status: shouldAutoApprove ? 'Approved' : 'Pending Approval',
    requestedBy: userId,
    requestedByName: userName,
    requestedAt: now,
    approvedBy: shouldAutoApprove ? userId : null,
    approvedByName: shouldAutoApprove ? userName : null,
    approvedAt: shouldAutoApprove ? now : null,
    rejectedBy: null,
    rejectedByName: null,
    rejectedAt: null,
    rejectionReason: '',
    processedAt: shouldAutoApprove ? now : null
  };

  const newRefundedAmount = shouldAutoApprove
    ? Math.round((approvedTotal + amount) * 100) / 100
    : (payment.refundedAmount || 0);

  const newPaymentStatus = shouldAutoApprove
    ? (newRefundedAmount >= payment.amount ? 'Refunded' : 'Partially Refunded')
    : (payment.status || 'Completed');

  const newRefundStatus = shouldAutoApprove ? 'Approved' : 'Pending Approval';

  const doc = await Payment.findOneAndUpdate(
    { ...baseFilter(req), _id: paymentId },
    {
      $push: { refunds: refundRecord },
      $set: {
        refundedAmount: newRefundedAmount,
        status: newPaymentStatus,
        refundStatus: newRefundStatus,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (shouldAutoApprove && payment.invoiceId) {
    await InvoiceService.syncInvoiceBalance(req, payment.invoiceId);
  }

  await AuditService.log(req, {
    action: shouldAutoApprove ? 'refund_approved' : 'refund_requested',
    module: 'payment',
    recordId: paymentId,
    description: `Refund ${refundNo} (${amount} ${payment.currency}) ${shouldAutoApprove ? 'approved' : 'requested'} on payment ${payment.paymentNo}`,
    metadata: { paymentNo: payment.paymentNo, refundNo, amount, reason, autoApproved: shouldAutoApprove }
  });

  return {
    success: true,
    payment: await enrichWithCustomerLabel(req, doc),
    refund: doc.refunds[doc.refunds.length - 1]
  };
}

/**
 * Approves a pending refund request (Admin/Finance Manager only).
 */
async function approveRefund(req, paymentId, refundId, options = {}) {
  if (!isAdmin(req)) {
    throw appError('Only administrators or finance managers can approve refunds', 403);
  }

  const Payment = getPaymentModel(req);
  const userId = resolveUserId(req);
  const userName = req.user?.name || req.user?.username || req.user?.displayName || userId;
  const payment = await findPaymentOrThrow(req, paymentId);

  const refunds = Array.isArray(payment.refunds) ? payment.refunds : [];
  const targetRefund = refunds.find((r) => String(r._id) === String(refundId) || r.refundNo === refundId);
  if (!targetRefund) throw appError('Refund request not found', 404);

  if (targetRefund.status === 'Approved' || targetRefund.status === 'Processed') {
    throw appError('Refund is already approved', 409);
  }
  if (targetRefund.status === 'Rejected') {
    throw appError('Cannot approve a rejected refund', 409);
  }

  const alreadyApproved = refunds
    .filter((r) => String(r._id) !== String(targetRefund._id) && ['Approved', 'Processed'].includes(r.status))
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  const newRefundedAmount = Math.round((alreadyApproved + targetRefund.amount) * 100) / 100;
  if (newRefundedAmount > payment.amount) {
    throw appError('Approved refund total exceeds original payment amount', 409);
  }

  const newPaymentStatus = newRefundedAmount >= payment.amount ? 'Refunded' : 'Partially Refunded';
  const now = new Date();

  const remainingPending = refunds.some(
    (r) => String(r._id) !== String(targetRefund._id) && r.status === 'Pending Approval'
  );
  const overallRefundStatus = remainingPending ? 'Pending Approval' : 'Approved';

  const doc = await Payment.findOneAndUpdate(
    { ...baseFilter(req), _id: paymentId, 'refunds._id': targetRefund._id },
    {
      $set: {
        'refunds.$.status': 'Approved',
        'refunds.$.approvedBy': userId,
        'refunds.$.approvedByName': userName,
        'refunds.$.approvedAt': now,
        'refunds.$.processedAt': now,
        refundedAmount: newRefundedAmount,
        status: newPaymentStatus,
        refundStatus: overallRefundStatus,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (payment.invoiceId) {
    await InvoiceService.syncInvoiceBalance(req, payment.invoiceId);
  }

  await AuditService.log(req, {
    action: 'refund_approved',
    module: 'payment',
    recordId: paymentId,
    description: `Refund ${targetRefund.refundNo} (${targetRefund.amount} ${payment.currency}) approved on payment ${payment.paymentNo}`,
    metadata: { paymentNo: payment.paymentNo, refundNo: targetRefund.refundNo, amount: targetRefund.amount }
  });

  return {
    success: true,
    payment: await enrichWithCustomerLabel(req, doc),
    refund: doc.refunds.find((r) => String(r._id) === String(targetRefund._id))
  };
}

/**
 * Rejects a pending refund request (Admin/Finance Manager only).
 */
async function rejectRefund(req, paymentId, refundId, { reason }) {
  if (!isAdmin(req)) {
    throw appError('Only administrators or finance managers can reject refunds', 403);
  }

  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) throw appError('Rejection reason is required', 400);

  const Payment = getPaymentModel(req);
  const userId = resolveUserId(req);
  const userName = req.user?.name || req.user?.username || req.user?.displayName || userId;
  const payment = await findPaymentOrThrow(req, paymentId);

  const refunds = Array.isArray(payment.refunds) ? payment.refunds : [];
  const targetRefund = refunds.find((r) => String(r._id) === String(refundId) || r.refundNo === refundId);
  if (!targetRefund) throw appError('Refund request not found', 404);

  if (targetRefund.status === 'Approved' || targetRefund.status === 'Processed') {
    throw appError('Cannot reject an approved refund', 409);
  }

  const now = new Date();
  const remainingPending = refunds.some(
    (r) => String(r._id) !== String(targetRefund._id) && r.status === 'Pending Approval'
  );
  const overallRefundStatus = remainingPending
    ? 'Pending Approval'
    : (payment.refundedAmount > 0 ? 'Approved' : 'Rejected');

  const doc = await Payment.findOneAndUpdate(
    { ...baseFilter(req), _id: paymentId, 'refunds._id': targetRefund._id },
    {
      $set: {
        'refunds.$.status': 'Rejected',
        'refunds.$.rejectedBy': userId,
        'refunds.$.rejectedByName': userName,
        'refunds.$.rejectedAt': now,
        'refunds.$.rejectionReason': trimmedReason,
        refundStatus: overallRefundStatus,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'refund_rejected',
    module: 'payment',
    recordId: paymentId,
    description: `Refund ${targetRefund.refundNo} rejected on payment ${payment.paymentNo}: ${trimmedReason}`,
    metadata: { paymentNo: payment.paymentNo, refundNo: targetRefund.refundNo, reason: trimmedReason }
  });

  return {
    success: true,
    payment: await enrichWithCustomerLabel(req, doc),
    refund: doc.refunds.find((r) => String(r._id) === String(targetRefund._id))
  };
}

/**
 * Lists all refund requests across all payments with filtering.
 */
async function listRefunds(req, query = {}) {
  const Payment = getPaymentModel(req);
  const filter = {
    ...baseFilter(req),
    'refunds.0': { $exists: true }
  };

  const { isClientUser } = require('../utils/tenant.util');
  if (query.clientId && !isClientUser(req)) filter.clientId = String(query.clientId).trim();
  if (query.invoiceId) filter.invoiceId = String(query.invoiceId).trim();

  const payments = await Payment.find(await withStaffPaymentScope(req, filter)).sort({ paymentDate: -1, createdAt: -1 }).lean();
  const enrichedPayments = await enrichWithCustomerLabel(req, payments);

  const flatRefunds = [];
  for (const pay of enrichedPayments) {
    for (const ref of (pay.refunds || [])) {
      if (query.status && ref.status !== query.status) continue;
      if (query.search) {
        const s = String(query.search).toLowerCase();
        const match =
          (ref.refundNo && ref.refundNo.toLowerCase().includes(s)) ||
          (pay.paymentNo && pay.paymentNo.toLowerCase().includes(s)) ||
          (pay.customerLabel && pay.customerLabel.toLowerCase().includes(s)) ||
          (ref.reason && ref.reason.toLowerCase().includes(s)) ||
          (ref.transactionId && ref.transactionId.toLowerCase().includes(s));
        if (!match) continue;
      }
      flatRefunds.push({
        ...ref,
        paymentId: pay._id,
        paymentNo: pay.paymentNo,
        paymentAmount: pay.amount,
        paymentDate: pay.paymentDate,
        clientId: pay.clientId,
        customerLabel: pay.customerLabel,
        invoiceId: pay.invoiceId,
        currency: pay.currency
      });
    }
  }

  flatRefunds.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
  const total = flatRefunds.length;
  const skip = (page - 1) * limit;
  const paginated = flatRefunds.slice(skip, skip + limit);

  return {
    items: paginated,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
}

/**
 * Gets all refunds for a specific payment.
 */
async function getPaymentRefunds(req, paymentId) {
  const payment = await findPaymentOrThrow(req, paymentId);
  return {
    paymentId: payment._id,
    paymentNo: payment.paymentNo,
    amount: payment.amount,
    refundedAmount: payment.refundedAmount || 0,
    refundableRemaining: Math.max(0, Math.round((payment.amount - (payment.refundedAmount || 0)) * 100) / 100),
    refundStatus: payment.refundStatus || 'None',
    currency: payment.currency || 'INR',
    refunds: payment.refunds || []
  };
}

module.exports = {
  list,
  getById,
  listByClient,
  create,
  update,
  remove,
  sumThisMonth,
  PAYMENT_MODES,
  exportPayments,
  requestRefund,
  approveRefund,
  rejectRefund,
  listRefunds,
  getPaymentRefunds,
  recordRazorpayPayment
};
