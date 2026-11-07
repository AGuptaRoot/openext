'use strict';

const { withCustomerSnapshot } = require('../utils/customer-snapshot.util');
const { resolveTenantId, resolveUserId, applyClientScope, applyClientScopeAsync } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { allocateUniqueNumber, syncSequenceFromDocumentNumber } = require('../utils/numbering.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const FinanceDocumentUtil = require('../utils/finance-document.util');
const PrintHtmlService = require('./print-html.service');
const MailService = require('./mail.service');
const { buildInvoicePayPortalUrl } = require('../utils/public-origin.util');
const { attachTenantFromRecord } = require('../utils/portal.util');
const { buildLineItems } = require('./quotation.service');
const { buildCustomerLabelMaps, resolveCustomerLabel, enrichWithCustomerLabel } = require('../utils/customer-label.util');

function getInvoiceModel(req) {
  const Invoice = req.cms?.models.get('Invoice');
  if (!Invoice) throw new Error('Invoice model is not registered');
  return Invoice;
}

function getPaymentModel(req) {
  return req.cms?.models.get('Payment');
}

function getCompanyModel(req) {
  return req.cms?.models.get('Company');
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Tenant rows only, with no client scoping.
 *
 * For the single-document path, which proves ownership on the record itself.
 */
function tenantOnlyFilter(req) {
  const tenantId = resolveTenantId(req);
  const scope = tenantId === 'default'
    ? { $in: ['default', null, undefined, ''] }
    : tenantId;
  return { tenantId: scope, isDeleted: { $ne: true } };
}

function baseFilter(req) {
  return applyClientScope(req, tenantOnlyFilter(req), 'clientId');
}

/** Derive display status — Overdue when past dueDate with balance remaining */
function withEffectiveStatus(doc) {
  if (!doc) return doc;
  const copy = { ...doc };
  // Payment status from the money on the invoice (kept in step with verified payments by
  // syncInvoiceBalance): nothing paid → Unpaid, part → Partially Paid, the total → Paid.
  const total = Number(copy.grandTotal) || 0;
  const settled = (Number(copy.amountPaid) || 0) + (Number(copy.creditAmount) || 0);
  copy.paymentStatus = total > 0 && settled + 0.005 >= total ? 'Paid' : settled > 0 ? 'Partially Paid' : 'Unpaid';

  if (copy.status === 'Cancelled' || copy.status === 'Paid' || copy.status === 'Written Off') {
    return copy;
  }

  if (copy.balanceDue <= 0) {
    copy.status = 'Paid';
    return copy;
  }

  if ((copy.amountPaid > 0 || (copy.creditAmount || 0) > 0) && copy.balanceDue > 0) {
    copy.status = 'Partially Paid';
  }

  const due = copy.dueDate ? new Date(copy.dueDate) : null;
  if (
    due &&
    due < new Date() &&
    copy.balanceDue > 0 &&
    ['Sent', 'Viewed', 'Partially Paid', 'Overdue'].includes(copy.status)
  ) {
    copy.status = 'Overdue';
  }

  return copy;
}

async function validateClient(req, clientId) {
  const Company = getCompanyModel(req);
  if (!Company) throw appError('Company model is not registered', 500);
  const client = await Company.findOne({ ...baseFilter(req), mergedIntoId: null, _id: clientId }).lean();
  if (!client) throw appError('Client not found', 404);
  return client;
}

async function findInvoiceOrThrow(req, id) {
  const { isClientUser } = require('../utils/tenant.util');

  /*
   * A portal login is checked against the record rather than through a
   * clientId filter, so a prospect can reach the proforma raised against
   * their own lead — they have no client account yet. Ownership is still
   * exact, and anything they do not own is the same 404 as before.
   */
  if (isClientUser(req)) {
    const doc = await getInvoiceModel(req)
      .findOne({ ...tenantOnlyFilter(req), _id: id })
      .lean();
    if (!doc) throw appError('Invoice not found', 404);

    const {
      resolvePortalIdentity,
      portalOwnsRecord
    } = require('../utils/portal-identity.util');
    const identity = await resolvePortalIdentity(req);
    if (identity.kind === 'none' || !portalOwnsRecord(identity, doc)) {
      throw appError('Invoice not found', 404);
    }
    return doc;
  }

  const doc = await getInvoiceModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Invoice not found', 404);
  const { assertSalesAgentCreatorAccess } = require('../utils/sales-access.util');
  assertSalesAgentCreatorAccess(req, doc, 'Invoice');
  return doc;
}

async function repairInvoiceClientIdIfNeeded(req, invoice) {
  const current = String(invoice?.clientId || '').trim();
  if (current) return invoice;

  if (!invoice?.quotationId) return invoice;

  try {
    const QuotationService = require('./quotation.service');
    const quotation = await QuotationService.getById(req, invoice.quotationId);
    const clientId = await QuotationService.resolveQuotationClientId(req, quotation, {
      convertLead: true
    });
    const userId = resolveUserId(req);
    const updated = await getInvoiceModel(req)
      .findOneAndUpdate(
        { ...baseFilter(req), _id: invoice._id },
        { $set: { clientId, updatedBy: userId } },
        { new: true }
      )
      .lean();
    return updated || { ...invoice, clientId };
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] invoice client repair skipped:', error.message);
    return invoice;
  }
}

async function list(req) {
  const Invoice = getInvoiceModel(req);
  const requestedLimit = parseInt(req.query?.limit, 10);
  const maxLimit = Number.isFinite(requestedLimit) && requestedLimit > 100 ? 500 : 100;
  const { page, limit, skip, sort } = parsePagination(req.query, { maxLimit });
  const filter = baseFilter(req);

  /*
   * Document type: the list is tax invoices unless asked otherwise, so adding
   * proformas never silently changes anyone's totals, GST reporting or ageing.
   * `documentType=proforma` shows the payment requests, `all` shows both.
   * Records saved before this field existed have no documentType, so "tax"
   * matches those too.
   */
  const requestedDocType = String(req.query?.documentType || '').trim().toLowerCase();
  if (requestedDocType === 'proforma') {
    filter.documentType = 'proforma';
  } else if (requestedDocType !== 'all') {
    filter.documentType = { $in: ['tax', null] };
  }

  // Archive filter: default to active (isArchived: false/undefined/null) unless explicitly requested
  if (req.query?.isArchived === 'true' || req.query?.archived === 'true') {
    filter.isArchived = true;
  } else if (req.query?.isArchived === 'all' || req.query?.archived === 'all') {
    // include both
  } else {
    filter.isArchived = { $ne: true };
  }

  if (req.query?.status) {
    const status = String(req.query.status).trim();
    if (status === 'Overdue') {
      filter.balanceDue = { $gt: 0 };
      filter.dueDate = { $lt: new Date() };
      filter.status = { $nin: ['Cancelled', 'Paid', 'Draft', 'Written Off'] };
    } else {
      filter.status = status;
    }
  }

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

  if (req.query?.recurringProfileId) filter.recurringProfileId = String(req.query.recurringProfileId).trim();

  if (req.query?.isRecurring === 'true' || req.query?.isRecurring === true) {
    filter.recurringProfileId = { $exists: true, $nin: [null, ''] };
  }

  if (req.query?.search) {
    const { findMatchingClientIds } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const or = [
        { invoiceNo: { $regex: term, $options: 'i' } },
        { clientId: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { customerLabel: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } },
        { terms: { $regex: term, $options: 'i' } },
        { billingAddress: { $regex: term, $options: 'i' } },
        { shippingAddress: { $regex: term, $options: 'i' } }
      ];
      const clientIds = await findMatchingClientIds(req, req.query.search);
      if (clientIds.length) or.push({ clientId: { $in: clientIds } });
      filter.$or = or;
    }
  }

  const { applySalesAgentCreatorScope } = require('../utils/sales-access.util');
  const finalFilter = applySalesAgentCreatorScope(req, filter);

  const [items, total] = await Promise.all([
    Invoice.find(finalFilter).sort(sort).skip(skip).limit(limit).lean(),
    Invoice.countDocuments(finalFilter)
  ]);

  const repairedItems = await Promise.all(items.map((item) => repairInvoiceClientIdIfNeeded(req, item)));
  const withStatus = repairedItems.map(withEffectiveStatus);
  const enriched = await enrichWithCustomerLabel(req, withStatus);

  return {
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

/**
 * Retrieves a single invoice by ID.
 */
async function getById(req, id) {
  const doc = await findInvoiceOrThrow(req, id);
  const repaired = await repairInvoiceClientIdIfNeeded(req, doc);
  const withStatus = withEffectiveStatus(repaired);
  const result = await enrichWithCustomerLabel(req, withStatus);

  if (result && result.documentType === 'proforma') {
    let isSalesOrderDelivered = false;
    let salesOrderDeliveryStatus = '';

    try {
      const SalesOrder = req.cms?.models.get('SalesOrder');
      if (SalesOrder) {
        let salesOrder = null;
        if (result.salesOrderId) {
          salesOrder = await SalesOrder.findOne({
            ...tenantOnlyFilter(req),
            _id: String(result.salesOrderId)
          }).lean();
        }
        if (!salesOrder && result.quotationId) {
          salesOrder = await SalesOrder.findOne({
            ...tenantOnlyFilter(req),
            quotationId: String(result.quotationId)
          }).lean();
        }
        if (salesOrder) {
          salesOrderDeliveryStatus = String(salesOrder.deliveryStatus || '');
          isSalesOrderDelivered =
            salesOrderDeliveryStatus === 'Delivered' ||
            String(salesOrder.status || '') === 'Completed';
          if (!result.salesOrderId) {
            result.salesOrderId = String(salesOrder._id);
            result.salesOrderNo = salesOrder.orderNumber;
          }
        }
      }
    } catch (_) {}

    result.isSalesOrderDelivered = isSalesOrderDelivered;
    result.salesOrderDeliveryStatus = salesOrderDeliveryStatus;
  }

  return result;
}

/**
 * Preview next invoice number without incrementing counter
 */
async function getNextInvoiceNumber(req) {
  const settings = await SettingService.getAll(req);
  const prefix = settings.invoice_prefix || 'INV-';
  const { formatNumber, parseSequenceFromDocumentNumber } = require('../utils/numbering.util');

  const counterSeq = Number(settings.invoice_sequence || 0);
  let maxSeq = counterSeq;

  const Invoice = getInvoiceModel(req);
  const tenantId = resolveTenantId(req);
  const recent = await Invoice.find({ tenantId, isDeleted: false })
    .select('invoiceNo')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  for (const row of recent) {
    const parsed = parseSequenceFromDocumentNumber(prefix, row.invoiceNo);
    if (parsed != null) maxSeq = Math.max(maxSeq, parsed);
  }

  return formatNumber(prefix, maxSeq + 1);
}

async function invoiceNumberExists(req, invoiceNo) {
  const Invoice = getInvoiceModel(req);
  const tenantId = resolveTenantId(req);
  let query = Invoice.findOne({ tenantId, invoiceNo, isDeleted: false });
  if (query && typeof query.select === 'function') {
    query = query.select('_id');
  }
  if (query && typeof query.lean === 'function') {
    query = query.lean();
  }
  const doc = await query;
  return Boolean(doc);
}

async function allocateInvoiceNumber(req, input = {}) {
  const preferred = input.invoiceNo ? String(input.invoiceNo).trim() : '';

  if (preferred) {
    if (await invoiceNumberExists(req, preferred)) {
      throw appError(`Invoice number "${preferred}" is already in use`, 409);
    }
    await syncSequenceFromDocumentNumber(req, 'invoice', preferred);
    return preferred;
  }

  return allocateUniqueNumber(req, 'invoice', {
    exists: (candidate) => invoiceNumberExists(req, candidate)
  });
}

/**
 * Creates a new Invoice.
 */
async function create(req, input) {
  // salesFlow.invoiceFromQuotation: an invoice is raised from an accepted quotation, with its lines and
  // payments; lines typed on the invoice form are never used.
  const rules = await require('./sales-flow.service').recordRules(req);
  if (rules.invoiceFromQuotation) {
    const quotationId = String((input && input.quotationId) || '').trim();
    if (!quotationId) {
      const error = new Error('Create this invoice from an accepted quotation.');
      error.status = 409;
      error.code = 'INVOICE_FROM_QUOTATION';
      throw error;
    }
    const result = await require('./quotation.service').convertToInvoice(req, quotationId);
    return result.invoice;
  }
  const Invoice = getInvoiceModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const settings = await SettingService.getAll(req);

  // Strict rule: a won opportunity gets one invoice; the invoice remembers the deal it bills.
  const opportunityId = /^[a-f0-9]{24}$/i.test(String((input && input.opportunityId) || '').trim()) ? String(input.opportunityId).trim() : null;
  if (opportunityId) await require('./opportunity.service').assertOpportunityNotInvoiced(req, opportunityId);
  if (!input.clientId) throw appError('clientId is required');
  await validateClient(req, input.clientId);

  const totals = buildLineItems(input.lineItems, Number(settings.tax_rate || 0));
  const invoiceNo = await allocateInvoiceNumber(req, input);
  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date();
  const paymentTerms = Number(settings.payment_terms_days || 30);
  const dueDate = input.dueDate
    ? new Date(input.dueDate)
    : (() => {
        const d = new Date(issueDate);
        d.setDate(d.getDate() + paymentTerms);
        return d;
      })();

  const discountType = input.discountType === 'amount' ? 'amount' : 'percent';
  let discountPercent = Math.min(100, Math.max(0, Number(input.discountPercent || 0)));
  let discountAmount = Math.max(0, Number(input.discountAmount || 0));

  let finalSubtotal = totals.subtotal;
  let finalTaxTotal = totals.taxTotal;
  let finalGrandTotal = totals.grandTotal;

  if (discountType === 'amount' && discountAmount > 0) {
    if (totals.subtotal > 0) {
      discountPercent = Math.min(100, Math.round((discountAmount / totals.subtotal) * 10000) / 100);
    }
    const discountRatio = totals.subtotal > 0 ? Math.min(1, discountAmount / totals.subtotal) : 0;
    if (input.taxCalculation === 'before_discount') {
      finalGrandTotal = Math.max(0, Math.round((totals.grandTotal - discountAmount) * 100) / 100);
    } else {
      finalSubtotal = Math.max(0, Math.round((totals.subtotal - discountAmount) * 100) / 100);
      finalTaxTotal = Math.max(0, Math.round((totals.taxTotal - totals.taxTotal * discountRatio) * 100) / 100);
      finalGrandTotal = Math.round((finalSubtotal + finalTaxTotal) * 100) / 100;
    }
  } else if (discountPercent > 0) {
    discountAmount = Math.round((totals.subtotal * (discountPercent / 100)) * 100) / 100;
    const discountFactor = discountPercent / 100;
    if (input.taxCalculation === 'before_discount') {
      finalGrandTotal = Math.round((totals.grandTotal - totals.subtotal * discountFactor) * 100) / 100;
    } else {
      finalSubtotal = Math.round((totals.subtotal - totals.subtotal * discountFactor) * 100) / 100;
      finalTaxTotal = Math.round((totals.taxTotal - totals.taxTotal * discountFactor) * 100) / 100;
      finalGrandTotal = Math.round((finalSubtotal + finalTaxTotal) * 100) / 100;
    }
  }

  const doc = await Invoice.create(await withCustomerSnapshot(req, {
    tenantId,
    clientId: String(input.clientId),
    projectId: input.projectId ? String(input.projectId).trim() : null,
    quotationId: input.quotationId ? String(input.quotationId) : null,
    opportunityId,
    salesOrderId: input.salesOrderId ? String(input.salesOrderId).trim() : null,
    salesOrderNo: input.salesOrderNo ? String(input.salesOrderNo).trim() : null,
    recurringProfileId: input.recurringProfileId ? String(input.recurringProfileId) : null,
    recurringCycle: input.recurringCycle ? Number(input.recurringCycle) : null,
    invoiceNo,
    issueDate,
    dueDate,
    status: 'Draft',
    currency: input.currency || settings.default_currency || 'INR',
    exchangeRate: Number(input.exchangeRate) || 1,
    lineItems: totals.lineItems,
    discountType,
    discountPercent,
    discountAmount,
    taxCalculation: input.taxCalculation || 'after_discount',
    subtotal: finalSubtotal,
    taxTotal: finalTaxTotal,
    grandTotal: finalGrandTotal,
    amountPaid: 0,
    creditAmount: 0,
    creditNoteIds: [],
    balanceDue: finalGrandTotal,
    bankAccount: input.bankAccount ? String(input.bankAccount).trim() : '',
    paymentDetails: input.paymentDetails ? String(input.paymentDetails).trim() : '',
    billingAddress: input.billingAddress ? String(input.billingAddress).trim() : '',
    shippingAddress: input.shippingAddress ? String(input.shippingAddress).trim() : '',
    file: input.file ? String(input.file).trim() : '',
    attachments: Array.isArray(input.attachments) ? input.attachments : (input.file ? [{ url: input.file, name: 'Attachment' }] : []),
    reminder: input.reminder && typeof input.reminder === 'object' ? {
      enabled: Boolean(input.reminder.enabled),
      timing: input.reminder.timing === 'before_due_date' ? 'before_due_date' : 'after_due_date',
      count: Math.max(1, Number(input.reminder.count) || 1),
      days: Math.max(1, Number(input.reminder.days) || 3)
    } : { enabled: false, timing: 'after_due_date', count: 1, days: 3 },
    notes: input.notes ? String(input.notes).trim() : '',
    terms: input.terms ? String(input.terms).trim() : '',
    isArchived: false,
    createdBy: userId,
    updatedBy: userId
  }));

  let result = doc.toObject();

  // An advance already paid on this quotation's proforma counts on this invoice: only the rest is due.
  if (input.quotationId) {
    const carried = await require('./proforma.service').carryOpenProformaToInvoice(req, String(input.quotationId), result);
    if (carried) result = carried;
  }

  if (input.quotationId) {
    try {
      const Estimate = req.cms?.models.get('Estimate');
      if (Estimate) {
        await Estimate.findOneAndUpdate(
          { tenantId, isDeleted: false, _id: String(input.quotationId) },
          {
            $set: {
              status: 'Converted',
              convertedInvoiceId: result._id.toString(),
              clientId: String(input.clientId),
              updatedBy: userId
            }
          }
        );
      }
    } catch (err) {
      console.warn('[plugin:openext-crm-suite] failed to mark linked quotation as Converted:', err.message);
    }
  }

  await AuditService.log(req, {
    action: 'created',
    module: 'invoice',
    recordId: result._id.toString(),
    description: `Invoice created: ${invoiceNo}`,
    metadata: { clientId: result.clientId, grandTotal: result.grandTotal, quotationId: input.quotationId || '' }
  });

  return result;
}

/**
 * Updates a draft invoice.
 */
async function update(req, id, input) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const existing = await findInvoiceOrThrow(req, id);

  if (['Paid', 'Cancelled', 'Written Off'].includes(existing.status)) {
    throw appError(`Invoices with status "${existing.status}" cannot be directly modified. Please issue a credit note or record an adjustment instead.`, 409);
  }

  // Only a draft can be corrected. The moment an invoice is sent the client
  // holds a copy of those figures, so changing them underneath would leave the
  // CRM disagreeing with the document they received; a credit note or a
  // cancel-and-reissue is the honest correction after that point.
  if (existing.status !== 'Draft') {
    throw appError(
      `Invoice ${existing.invoiceNo || id} has already been sent (${existing.status}), so it can no longer be edited. Issue a credit note, or cancel it and raise a new invoice.`,
      409
    );
  }

  const settings = await SettingService.getAll(req);
  const updates = { updatedBy: userId };

  if (input.clientId !== undefined) {
    await validateClient(req, input.clientId);
    updates.clientId = String(input.clientId);
  }
  if (input.projectId !== undefined) updates.projectId = input.projectId ? String(input.projectId).trim() : null;
  if (input.notes !== undefined) updates.notes = String(input.notes).trim();
  if (input.terms !== undefined) updates.terms = String(input.terms).trim();
  if (input.currency !== undefined) updates.currency = String(input.currency).trim().toUpperCase();
  if (input.exchangeRate !== undefined) updates.exchangeRate = Math.max(0.0001, Number(input.exchangeRate) || 1);
  if (input.taxCalculation !== undefined) updates.taxCalculation = input.taxCalculation;
  if (input.discountType !== undefined) updates.discountType = input.discountType;
  if (input.discountPercent !== undefined) updates.discountPercent = Number(input.discountPercent) || 0;
  if (input.discountAmount !== undefined) updates.discountAmount = Number(input.discountAmount) || 0;
  if (input.bankAccount !== undefined) updates.bankAccount = String(input.bankAccount).trim();
  if (input.paymentDetails !== undefined) updates.paymentDetails = String(input.paymentDetails).trim();
  if (input.billingAddress !== undefined) updates.billingAddress = String(input.billingAddress).trim();
  if (input.shippingAddress !== undefined) updates.shippingAddress = String(input.shippingAddress).trim();
  if (input.file !== undefined) updates.file = String(input.file).trim();
  if (input.attachments !== undefined && Array.isArray(input.attachments)) updates.attachments = input.attachments;
  if (input.reminder !== undefined && typeof input.reminder === 'object') {
    updates.reminder = {
      enabled: Boolean(input.reminder.enabled),
      timing: input.reminder.timing === 'before_due_date' ? 'before_due_date' : 'after_due_date',
      count: Math.max(1, Number(input.reminder.count) || 1),
      days: Math.max(1, Number(input.reminder.days) || 3)
    };
  }
  if (input.issueDate !== undefined) updates.issueDate = new Date(input.issueDate);
  if (input.dueDate !== undefined) updates.dueDate = new Date(input.dueDate);

  if (input.lineItems !== undefined || input.discountPercent !== undefined || input.discountAmount !== undefined || input.discountType !== undefined || input.taxCalculation !== undefined) {
    const rawLines = input.lineItems !== undefined ? input.lineItems : existing.lineItems;
    const discountType = updates.discountType !== undefined ? updates.discountType : (existing.discountType || 'percent');
    const discountPercent = updates.discountPercent !== undefined ? updates.discountPercent : (existing.discountPercent || 0);
    const discountAmount = updates.discountAmount !== undefined ? updates.discountAmount : (existing.discountAmount || 0);
    const taxCalc = updates.taxCalculation || existing.taxCalculation || 'after_discount';

    const totals = buildLineItems(rawLines, Number(settings.tax_rate || 0));
    let finalSubtotal = totals.subtotal;
    let finalTaxTotal = totals.taxTotal;
    let finalGrandTotal = totals.grandTotal;

    if (discountType === 'amount' && discountAmount > 0) {
      const discAmount = Math.min(totals.subtotal, discountAmount);
      const discRatio = totals.subtotal > 0 ? discAmount / totals.subtotal : 0;
      if (taxCalc === 'before_discount') {
        finalGrandTotal = Math.max(0, Math.round(((totals.subtotal + totals.taxTotal) - discAmount) * 100) / 100);
      } else {
        finalSubtotal = Math.round((totals.subtotal - discAmount) * 100) / 100;
        finalTaxTotal = Math.round((totals.taxTotal - totals.taxTotal * discRatio) * 100) / 100;
        finalGrandTotal = Math.round((finalSubtotal + finalTaxTotal) * 100) / 100;
      }
    } else if (discountPercent > 0) {
      const discountFactor = discountPercent / 100;
      if (taxCalc === 'before_discount') {
        finalGrandTotal = Math.round((totals.grandTotal - totals.subtotal * discountFactor) * 100) / 100;
      } else {
        finalSubtotal = Math.round((totals.subtotal - totals.subtotal * discountFactor) * 100) / 100;
        finalTaxTotal = Math.round((totals.taxTotal - totals.taxTotal * discountFactor) * 100) / 100;
        finalGrandTotal = Math.round((finalSubtotal + finalTaxTotal) * 100) / 100;
      }
    }

    const paidAndCredited = (existing.amountPaid || 0) + (existing.creditAmount || 0);
    if (finalGrandTotal < paidAndCredited) {
      throw appError('Invoice total cannot be lower than payments and credits already recorded', 409);
    }

    updates.lineItems = totals.lineItems;
    updates.subtotal = finalSubtotal;
    updates.taxTotal = finalTaxTotal;
    updates.grandTotal = finalGrandTotal;
    updates.balanceDue = Math.max(0, Math.round((finalGrandTotal - paidAndCredited) * 100) / 100);
  }

  const effectiveIssueDate = updates.issueDate || existing.issueDate;
  const effectiveDueDate = updates.dueDate || existing.dueDate;
  if (new Date(effectiveDueDate) < new Date(effectiveIssueDate)) {
    throw appError('Due date cannot be before issue date');
  }

  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'invoice',
    recordId: id,
    description: `Invoice updated: ${doc.invoiceNo}`
  });

  return withEffectiveStatus(doc);
}

async function remove(req, id) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const existing = await findInvoiceOrThrow(req, id);

  if (existing.status !== 'Draft') {
    throw appError('Only draft invoices can be deleted', 409);
  }

  await Invoice.findOneAndUpdate(
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

  await AuditService.log(req, {
    action: 'deleted',
    module: 'invoice',
    recordId: id,
    description: `Invoice deleted: ${existing.invoiceNo}`
  });

  return { deleted: true, id };
}

async function ensurePayToken(req, id) {
  const Invoice = getInvoiceModel(req);
  const existing = await findInvoiceOrThrow(req, id);

  if (existing.payToken) {
    return {
      payToken: existing.payToken,
      payUrl: buildInvoicePayPortalUrl(req, existing.payToken)
    };
  }

  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');

  await Invoice.updateOne(
    { ...baseFilter(req), _id: id },
    { $set: { payToken: token, updatedBy: resolveUserId(req) } }
  );

  return {
    payToken: token,
    payUrl: buildInvoicePayPortalUrl(req, token)
  };
}

async function generatePayToken(req, id) {
  const result = await ensurePayToken(req, id);
  return {
    payToken: result.payToken,
    payUrl: buildInvoicePayPortalUrl(req, result.payToken)
  };
}

async function findInvoiceByPayToken(req, token) {
  return getInvoiceIdByPayToken(req, token);
}

async function getPublicPortalInvoice(req, token) {
  const Invoice = getInvoiceModel(req);
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw appError('Payment portal token is required', 400);

  const invoice = await Invoice.findOne({ payToken: cleanToken, isDeleted: false }).lean();
  if (!invoice) throw appError('Invoice payment link is invalid or expired', 404);
  if (invoice.status === 'Draft') {
    throw appError('This invoice is not available for payment yet', 409);
  }
  if (invoice.status === 'Cancelled') {
    throw appError('This invoice has been cancelled', 409);
  }

  attachTenantFromRecord(req, invoice);

  if (invoice.status === 'Sent') {
    await Invoice.updateOne(
      { _id: invoice._id },
      { $set: { status: 'Viewed', viewedAt: new Date(), payTokenViewedAt: new Date() } }
    );
    invoice.status = 'Viewed';
    invoice.viewedAt = new Date();
  } else if (!invoice.payTokenViewedAt) {
    await Invoice.updateOne(
      { _id: invoice._id },
      { $set: { payTokenViewedAt: new Date() } }
    );
  }

  const settings = await SettingService.getAll(req).catch(() => ({}));
  const withStatus = withEffectiveStatus(invoice);
  const [enriched] = await enrichWithCustomerLabel(req, [withStatus]).catch(() => [withStatus]);

  const RazorpayGatewayService = require('./razorpay-gateway.service');
  const razorpay = await RazorpayGatewayService.getStatus(req);

  return {
    invoice: {
      _id: enriched._id,
      invoiceNo: enriched.invoiceNo,
      issueDate: enriched.issueDate,
      dueDate: enriched.dueDate,
      status: enriched.status,
      currency: enriched.currency,
      // Customers see printable extension columns only (same as the quotation portal).
      lineItems: await require('./sales-flow.service').publicLines(req, enriched.lineItems || []),
      subtotal: enriched.subtotal,
      taxTotal: enriched.taxTotal,
      grandTotal: enriched.grandTotal,
      amountPaid: enriched.amountPaid,
      creditAmount: enriched.creditAmount || 0,
      balanceDue: enriched.balanceDue,
      notes: enriched.notes || '',
      terms: enriched.terms || '',
      paymentDetails: enriched.paymentDetails || '',
      bankAccount: enriched.bankAccount || '',
      clientId: enriched.clientId || '',
      clientName: enriched.clientName || enriched.customerLabel || '',
      customerEmail: enriched.customerEmail || ''
    },
    company: {
      name: settings.company_name || 'Root CRM',
      email: settings.company_email || '',
      phone: settings.company_phone || '',
      address: settings.company_address || '',
      gstin: settings.company_gstin || ''
    },
    razorpay: {
      configured: Boolean(razorpay.configured),
      currency: razorpay.currency || enriched.currency || 'INR',
      businessName: razorpay.businessName || settings.company_name || ''
    }
  };
}

async function getInvoiceIdByPayToken(req, token) {
  const Invoice = getInvoiceModel(req);
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw appError('Payment portal token is required', 400);

  const invoice = await Invoice.findOne({ payToken: cleanToken, isDeleted: false }).lean();
  if (!invoice) throw appError('Invoice payment link is invalid or expired', 404);

  attachTenantFromRecord(req, invoice);
  return invoice;
}

async function send(req, id) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  let existing = await findInvoiceOrThrow(req, id);

  if (existing.status === 'Cancelled' || existing.status === 'Written Off') {
    throw appError(`Invoices in status "${existing.status}" cannot be sent`, 409);
  }

  existing = await repairInvoiceClientIdIfNeeded(req, existing);
  const clientId = String(existing.clientId || '').trim();
  if (!clientId) {
    throw appError(
      'Invoice has no customer assigned. Edit the invoice or assign a customer before sending.',
      409
    );
  }

  const payLink = await ensurePayToken(req, id);
  const emailDelivery = await MailService.sendFinanceDocumentEmail(req, 'invoice', existing, {
    payUrl: Number(existing.balanceDue) > 0 ? payLink.payUrl : ''
  });

  const nextStatus = existing.status === 'Draft' ? 'Sent' : existing.status;
  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { status: nextStatus, clientId, sentAt: new Date(), updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'sent',
    module: 'invoice',
    recordId: id,
    description: emailDelivery.sent
      ? `Invoice email sent: ${doc.invoiceNo} → ${emailDelivery.to}`
      : `Invoice sent: ${doc.invoiceNo}`,
    metadata: emailDelivery.sent ? { emailTo: emailDelivery.to } : undefined
  });

  return { doc: withEffectiveStatus(doc), emailDelivery };
}

async function markAsViewed(req, id) {
  const Invoice = getInvoiceModel(req);
  const existing = await findInvoiceOrThrow(req, id);

  if (existing.status === 'Sent') {
    const doc = await Invoice.findOneAndUpdate(
      { ...baseFilter(req), _id: id },
      { $set: { status: 'Viewed', viewedAt: new Date() } },
      { new: true }
    ).lean();
    return withEffectiveStatus(doc);
  }
  return withEffectiveStatus(existing);
}

async function writeOff(req, id, { reason = 'Uncollectible Bad Debt' } = {}) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const existing = await findInvoiceOrThrow(req, id);

  // Active extension contract (salesFlow.hideInvoiceWriteOff): invoices are never written off here.
  const SalesFlowService = require('./sales-flow.service');
  const flow = await SalesFlowService.config(req).catch(() => null);
  if (flow && flow.hideInvoiceWriteOff) {
    const error = appError('Writing off invoices is turned off in this workspace', 409);
    error.code = 'WRITE_OFF_DISABLED';
    throw error;
  }

  if (['Draft', 'Paid', 'Cancelled', 'Written Off'].includes(existing.status)) {
    throw appError(`Cannot write off an invoice with status ${existing.status}`, 409);
  }

  const uncollectibleAmount = existing.balanceDue;
  if (uncollectibleAmount <= 0) {
    throw appError('Invoice has zero balance due and cannot be written off', 409);
  }

  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        status: 'Written Off',
        balanceDue: 0,
        writtenOffAt: new Date(),
        writtenOffReason: String(reason).trim(),
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'written_off',
    module: 'invoice',
    recordId: id,
    description: `Invoice written off as bad debt: ${doc.invoiceNo} (Amount: ${doc.currency} ${uncollectibleAmount})`,
    metadata: { invoiceNo: doc.invoiceNo, writtenOffAmount: uncollectibleAmount, reason }
  });

  return withEffectiveStatus(doc);
}

async function archive(req, id) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const existing = await findInvoiceOrThrow(req, id);

  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isArchived: true,
        archivedAt: new Date(),
        archivedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'archived',
    module: 'invoice',
    recordId: id,
    description: `Invoice archived: ${existing.invoiceNo}`
  });

  return withEffectiveStatus(doc);
}

async function restore(req, id) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const existing = await findInvoiceOrThrow(req, id);

  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isArchived: false,
        archivedAt: null,
        archivedBy: null,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'restored',
    module: 'invoice',
    recordId: id,
    description: `Invoice restored: ${existing.invoiceNo}`
  });

  return withEffectiveStatus(doc);
}

async function cancel(req, id) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const existing = await findInvoiceOrThrow(req, id);

  if (existing.status === 'Cancelled') {
    throw appError('Invoice is already cancelled', 409);
  }
  if (existing.status === 'Paid' || (existing.amountPaid || 0) > 0 || (existing.creditAmount || 0) > 0) {
    throw appError('Cannot cancel an invoice with payments or credit notes recorded', 409);
  }

  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { status: 'Cancelled', updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'cancelled',
    module: 'invoice',
    recordId: id,
    description: `Invoice cancelled: ${doc.invoiceNo}`
  });

  return doc;
}

async function listPayments(req, invoiceId) {
  await findInvoiceOrThrow(req, invoiceId);
  const Payment = getPaymentModel(req);
  if (!Payment) return [];

  return Payment.find({
    ...baseFilter(req),
    invoiceId: String(invoiceId)
  })
    .sort({ paymentDate: -1 })
    .lean();
}

async function listByClient(req, clientId) {
  await validateClient(req, clientId);
  // Also the invoices of its lead's / opportunities' quotations, made before the client existed.
  const or = [{ clientId: String(clientId) }];
  try {
    const { leadIds, opportunityIds } = await require('./client.service').clientSalesOrigins(req, clientId);
    if (opportunityIds.length) or.push({ opportunityId: { $in: opportunityIds } });
    if (leadIds.length || opportunityIds.length) {
      const Estimate = req.cms?.models?.get?.('Estimate');
      const qOr = [];
      if (leadIds.length) qOr.push({ leadId: { $in: leadIds } });
      if (opportunityIds.length) qOr.push({ opportunityId: { $in: opportunityIds } }, { dealId: { $in: opportunityIds } });
      const quotes = Estimate ? await Estimate.find({ ...baseFilter(req), $or: qOr }).select('_id').limit(500).lean() : [];
      const quoteIds = (quotes || []).map((q) => String(q._id));
      if (quoteIds.length) or.push({ quotationId: { $in: quoteIds } }, { convertedQuotationId: { $in: quoteIds } });
    }
  } catch {
    /* the client's own invoices only */
  }
  const items = await getInvoiceModel(req)
    .find({ ...baseFilter(req), $or: or })
    .sort({ createdAt: -1 })
    .lean();
  return items.map(withEffectiveStatus);
}

/**
 * Called by Payments module when a payment is recorded.
 */
async function applyPayment(req, invoiceId, paymentAmount) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);

  const amount = Number(paymentAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw appError('Payment amount must be greater than zero');
  }

  const doc = await Invoice.findOneAndUpdate(
    {
      ...baseFilter(req),
      _id: invoiceId,
      status: { $nin: ['Cancelled', 'Draft', 'Written Off'] },
      balanceDue: { $gte: amount }
    },
    [
      {
        $set: {
          amountPaid: { $round: [{ $add: ['$amountPaid', amount] }, 2] },
          balanceDue: { $round: [{ $subtract: ['$balanceDue', amount] }, 2] },
          updatedBy: userId
        }
      },
      {
        $set: {
          status: {
            $cond: [{ $lte: ['$balanceDue', 0] }, 'Paid', 'Partially Paid']
          }
        }
      }
    ],
    { new: true }
  ).lean();

  if (!doc) {
    const existing = await findInvoiceOrThrow(req, invoiceId);
    if (existing.status === 'Cancelled') {
      throw appError('Cannot record payment against a cancelled invoice', 409);
    }
    if (existing.status === 'Draft') {
      throw appError('Cannot record payment against a draft invoice. Send the invoice first.', 409);
    }
    if (existing.status === 'Written Off') {
      throw appError('Cannot record payment against a written-off invoice', 409);
    }
    throw appError('Payment exceeds invoice balance due or the balance changed. Refresh and try again.', 409);
  }

  return withEffectiveStatus(doc);
}

/**
 * Called by Credit Notes module when a credit note is applied to an invoice.
 */
async function applyCreditNoteAdjustment(req, invoiceId, creditAmount, creditNoteNumber, creditNoteId) {
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const amount = Math.round(Number(creditAmount) * 100) / 100;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw appError('Credit amount must be greater than zero');
  }

  const existing = await findInvoiceOrThrow(req, invoiceId);
  if (['Draft', 'Cancelled', 'Written Off'].includes(existing.status)) {
    throw appError(`Cannot apply credit note to a ${existing.status} invoice`, 409);
  }
  if (amount > existing.balanceDue) {
    throw appError(`Credit amount (${amount}) exceeds invoice balance due (${existing.balanceDue})`, 409);
  }

  const newCreditAmount = Math.round(((existing.creditAmount || 0) + amount) * 100) / 100;
  const newBalanceDue = Math.max(0, Math.round((existing.balanceDue - amount) * 100) / 100);
  const newStatus = newBalanceDue <= 0 ? 'Paid' : 'Partially Paid';

  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: invoiceId },
    {
      $set: {
        creditAmount: newCreditAmount,
        balanceDue: newBalanceDue,
        status: newStatus,
        updatedBy: userId
      },
      $addToSet: {
        creditNoteIds: String(creditNoteId)
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'credit_applied',
    module: 'invoice',
    recordId: String(invoiceId),
    description: `Applied Credit Note ${creditNoteNumber} (${doc.currency} ${amount}) to invoice ${doc.invoiceNo}`,
    metadata: { creditNoteNumber, creditAmount: amount, newBalanceDue }
  });

  return withEffectiveStatus(doc);
}

/**
 * Recalculate invoice balance from all active payments and credit notes.
 */
async function syncInvoiceBalance(req, invoiceId) {
  const Invoice = getInvoiceModel(req);
  const Payment = getPaymentModel(req);
  const userId = resolveUserId(req);
  const existing = await findInvoiceOrThrow(req, invoiceId);
  // A converted proforma is settled: its payments count on the tax invoice now.
  if (existing.documentType === 'proforma' && existing.convertedInvoiceId) return withEffectiveStatus(existing);

  let amountPaid = 0;
  if (Payment) {
    // Verified money only (the same rule as the quotation's payment state).
    const payments = await Payment.find({
      ...baseFilter(req),
      invoiceId: String(invoiceId),
      status: { $nin: ['Pending', 'Refunded', 'Disputed', 'Failed', 'Cancelled'] }
    }).lean();
    amountPaid = payments.reduce((sum, payment) => {
      const pAmt = Number(payment.amount) || 0;
      const refAmt = Number(payment.refundedAmount) || 0;
      return sum + Math.max(0, pAmt - refAmt);
    }, 0);
  }

  amountPaid = Math.round(amountPaid * 100) / 100;
  const creditAmount = Number(existing.creditAmount || 0);
  const balanceDue = Math.max(0, Math.round((existing.grandTotal - amountPaid - creditAmount) * 100) / 100);

  let status = existing.status;
  if (!['Cancelled', 'Written Off', 'Converted'].includes(existing.status)) {
    // Paid once verified payments (+ credits) reach the total (paise rounding allowed).
    if (balanceDue <= 0.005 || amountPaid + creditAmount + 0.005 >= Number(existing.grandTotal || 0)) {
      status = 'Paid';
    } else if ((amountPaid > 0 || creditAmount > 0) && existing.status !== 'Draft') {
      status = 'Partially Paid';
    } else if (
      amountPaid === 0 &&
      creditAmount === 0 &&
      existing.status !== 'Draft' &&
      ['Partially Paid', 'Paid'].includes(existing.status)
    ) {
      status = 'Sent';
    }
  }

  const doc = await Invoice.findOneAndUpdate(
    { ...baseFilter(req), _id: invoiceId },
    {
      $set: {
        amountPaid,
        balanceDue,
        status,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  return withEffectiveStatus(doc);
}

async function exportPrintHtml(req, id) {
  const doc = withEffectiveStatus(await findInvoiceOrThrow(req, id));
  const payload = await FinanceDocumentUtil.buildInvoicePayload(req, doc);
  const html = PrintHtmlService.renderFinancePrintHtml(payload);

  await AuditService.log(req, {
    action: 'print_opened',
    module: 'invoice',
    recordId: String(id),
    description: `Print view opened: ${doc.invoiceNo}`,
    metadata: { documentNo: doc.invoiceNo }
  });

  return { html, title: doc.invoiceNo || 'invoice' };
}

async function exportInvoices(req, query = {}) {
  const Invoice = getInvoiceModel(req);
  let filter = baseFilter(req);

  if (query.status) {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  const { isClientUser } = require('../utils/tenant.util');
  // A client's own customer id is already in baseFilter; a query may never replace it.
  if (query.clientId && !isClientUser(req)) filter.clientId = String(query.clientId).trim();
  if (query.from || query.to) {
    filter.issueDate = {};
    if (query.from) filter.issueDate.$gte = new Date(query.from);
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      filter.issueDate.$lte = toDate;
    }
  }
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { invoiceNo: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } }
      ];
    }
  }

  filter = require('../utils/sales-access.util').applySalesAgentCreatorScope(req, filter);

  const raw = await Invoice.find(filter).sort({ issueDate: -1, createdAt: -1 }).lean();
  const repairedItems = await Promise.all(raw.map((item) => repairInvoiceClientIdIfNeeded(req, item)));
  const withStatus = repairedItems.map(withEffectiveStatus);
  const enriched = await enrichWithCustomerLabel(req, withStatus);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'invoice',
    recordId: 'export',
    description: `Exported ${enriched.length} invoices in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `invoices_export_${nowStr}.json`,
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
    'Invoice Number',
    'Client Name',
    'Status',
    'Issue Date',
    'Due Date',
    'Subtotal',
    'Tax Total',
    'Discount Total',
    'Total Amount',
    'Amount Paid',
    'Balance Due',
    'Currency',
    'Payment Terms',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const inv of enriched) {
    const total = Number(inv.total || 0);
    const paid = Number(inv.amountPaid || 0);
    const balance = Math.max(0, total - paid);
    rows.push(
      [
        inv._id,
        inv.invoiceNo || '',
        inv.clientCompany || inv.clientName || '',
        inv.status || '',
        inv.issueDate ? new Date(inv.issueDate).toISOString().slice(0, 10) : '',
        inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : '',
        Number(inv.subtotal || 0),
        Number(inv.taxTotal || 0),
        Number(inv.discountTotal || 0),
        total,
        paid,
        balance,
        inv.currency || 'INR',
        inv.paymentTerms || '',
        inv.createdAt ? new Date(inv.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `invoices_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  list,
  getById,
  /** Alias used by PDF/print controllers (and older builds). */
  get: getById,
  create,
  update,
  remove,
  send,
  markAsViewed,
  writeOff,
  archive,
  restore,
  cancel,
  listPayments,
  listByClient,
  applyPayment,
  applyCreditNoteAdjustment,
  syncInvoiceBalance,
  exportPrintHtml,
  getNextInvoiceNumber,
  withEffectiveStatus,
  exportInvoices,
  ensurePayToken,
  generatePayToken,
  findInvoiceByPayToken,
  getPublicPortalInvoice,
  getInvoiceIdByPayToken
};
