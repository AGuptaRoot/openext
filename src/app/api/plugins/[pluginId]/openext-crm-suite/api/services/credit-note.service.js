'use strict';

const { resolveTenantId, resolveUserId, applyClientScope } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { getNextNumber } = require('../utils/numbering.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const AuditService = require('./audit.service');
const SettingService = require('./setting.service');
const PrintHtmlService = require('./print-html.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getCreditNoteModel(req) {
  const CreditNote = req.cms?.models.get('CreditNote');
  if (!CreditNote) throw appError('CreditNote model is not registered', 500);
  return CreditNote;
}

function getInvoiceModel(req) {
  const Invoice = req.cms?.models.get('Invoice');
  if (!Invoice) throw appError('Invoice model is not registered', 500);
  return Invoice;
}

function getCompanyModel(req) {
  return req.cms?.models.get('Company');
}

function baseFilter(req) {
  const tenantId = resolveTenantId(req);
  const tenantFilter = tenantId === 'default'
    ? { $in: ['default', null, undefined, ''] }
    : tenantId;
  const filter = { tenantId: tenantFilter, isDeleted: { $ne: true } };
  return applyClientScope(req, filter, 'clientId');
}

async function validateClient(req, clientId) {
  const Company = getCompanyModel(req);
  if (!Company) throw appError('Company model is not registered', 500);

  const id = String(clientId || '').trim();
  if (!id) throw appError('clientId is required', 400);

  const client = await Company.findOne({ ...baseFilter(req), mergedIntoId: null, _id: id }).lean();
  if (client) return client;

  // Fallback if client exists on active invoices
  const Invoice = getInvoiceModel(req);
  if (Invoice) {
    const hasInvoice = await Invoice.exists({
      ...baseFilter(req),
      clientId: id
    });
    if (hasInvoice) {
      return { _id: id, name: `Customer (${id.slice(-6)})` };
    }
  }

  throw appError('Client not found', 404);
}

async function list(req) {
  const CreditNote = getCreditNoteModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query, { maxLimit: 100 });
  const filter = baseFilter(req);

  if (req.query?.status) {
    filter.status = String(req.query.status).trim();
  }
  // A client's own customer id is already in baseFilter; a query may never replace it.
  if (req.query?.clientId && !require('../utils/tenant.util').isClientUser(req)) {
    filter.clientId = String(req.query.clientId).trim();
  }
  if (req.query?.invoiceId) {
    filter.invoiceId = String(req.query.invoiceId).trim();
  }
  if (req.query?.isArchived === 'true') {
    filter.isArchived = true;
  } else if (req.query?.isArchived === 'all') {
    // include both
  } else if (req.query?.isArchived !== undefined) {
    filter.isArchived = { $ne: true };
  }

  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      filter.$or = [
        { creditNoteNumber: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { invoiceNumber: { $regex: term, $options: 'i' } },
        { reason: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const { applySalesAgentCreatorScope } = require('../utils/sales-access.util');
  const scopedFilter = applySalesAgentCreatorScope(req, filter);
  const [items, total] = await Promise.all([
    CreditNote.find(scopedFilter).sort(sort).skip(skip).limit(limit).lean(),
    CreditNote.countDocuments(scopedFilter)
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function getById(req, id) {
  const doc = await getCreditNoteModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Credit Note not found', 404);
  require('../utils/sales-access.util').assertSalesAgentCreatorAccess(req, doc, 'Credit Note');
  return doc;
}

function calculateItemTotals(items = []) {
  let subtotal = 0;
  let taxTotal = 0;
  const processed = [];

  for (const raw of items) {
    const qty = Number(raw.quantity) || 1;
    const unitPrice = Number(raw.unitPrice) || 0;
    const taxRate = Number(raw.tax) || 0;
    const lineSub = Math.round(qty * unitPrice * 100) / 100;
    const lineTax = Math.round(lineSub * (taxRate / 100) * 100) / 100;
    const lineTotal = Math.round((lineSub + lineTax) * 100) / 100;

    subtotal += lineSub;
    taxTotal += lineTax;
    processed.push({
      description: raw.description,
      quantity: qty,
      unitPrice,
      tax: taxRate,
      amount: lineTotal
    });
  }

  subtotal = Math.round(subtotal * 100) / 100;
  taxTotal = Math.round(taxTotal * 100) / 100;
  const totalAmount = Math.round((subtotal + taxTotal) * 100) / 100;

  return { items: processed, subtotal, taxTotal, totalAmount };
}

async function create(req, payload = {}) {
  const CreditNote = getCreditNoteModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req);
  const defaultCurrency = String(settings.default_currency || 'INR').trim().toUpperCase() || 'INR';

  const client = await validateClient(req, payload.clientId);
  const clientName = client.companyName || client.name || 'Client';

  const totals = calculateItemTotals(payload.items || []);
  const creditNoteNumber = await getNextNumber(req, 'creditNote');

  const doc = await CreditNote.create({
    tenantId,
    creditNoteNumber,
    clientId: String(payload.clientId),
    clientName,
    invoiceId: payload.invoiceId ? String(payload.invoiceId) : null,
    invoiceNumber: payload.invoiceNumber ? String(payload.invoiceNumber) : '',
    creditDate: payload.creditDate ? new Date(payload.creditDate) : new Date(),
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    totalAmount: totals.totalAmount,
    remainingBalance: totals.totalAmount,
    refundAmount: 0,
    currency: payload.currency || defaultCurrency,
    status: 'Open',
    reason: payload.reason || 'Customer Return / Adjustment',
    items: totals.items,
    appliedInvoices: [],
    notes: payload.notes || '',
    createdBy: userId,
    updatedBy: userId
  });

  const result = doc.toObject();

  await AuditService.log(req, {
    action: 'created',
    module: 'credit_note',
    recordId: result._id.toString(),
    description: `Credit Note created: ${creditNoteNumber} (${result.currency} ${result.totalAmount})`,
    metadata: { creditNoteNumber, clientId: result.clientId, totalAmount: result.totalAmount }
  });

  return result;
}

/**
 * Creates a Credit Note from an existing Invoice.
 * Prevents crediting above the eligible remaining invoice balance.
 */
async function createFromInvoice(req, invoiceId, payload = {}) {
  const InvoiceService = require('./invoice.service');
  const invoice = await InvoiceService.getById(req, invoiceId);

  if (invoice.status === 'Draft') {
    throw appError('Cannot issue a credit note for a draft invoice. Send or approve the invoice first.', 409);
  }
  if (invoice.status === 'Cancelled') {
    throw appError('Cannot issue a credit note for a cancelled invoice.', 409);
  }

  const existingCredits = Number(invoice.creditAmount) || 0;
  const maxEligibleCredit = Math.max(0, Math.round((invoice.grandTotal - existingCredits) * 100) / 100);

  if (maxEligibleCredit <= 0) {
    throw appError('Invoice has already been fully credited.', 409);
  }

  let items = [];
  let totalRequestedCredit = 0;

  if (Array.isArray(payload.items) && payload.items.length > 0) {
    const calc = calculateItemTotals(payload.items);
    items = calc.items;
    totalRequestedCredit = calc.totalAmount;
  } else if (payload.creditAmount !== undefined && payload.creditAmount !== null) {
    totalRequestedCredit = Math.round(Number(payload.creditAmount) * 100) / 100;
    items = [
      {
        description: payload.reason || `Credit adjustment for invoice ${invoice.invoiceNo}`,
        quantity: 1,
        unitPrice: totalRequestedCredit,
        tax: 0,
        amount: totalRequestedCredit
      }
    ];
  } else {
    // Default: credit remaining balance due (or full invoice amount if unpaid)
    totalRequestedCredit = Math.min(maxEligibleCredit, invoice.balanceDue > 0 ? invoice.balanceDue : invoice.grandTotal);
    items = [
      {
        description: payload.reason || `Credit for invoice ${invoice.invoiceNo}`,
        quantity: 1,
        unitPrice: totalRequestedCredit,
        tax: 0,
        amount: totalRequestedCredit
      }
    ];
  }

  if (totalRequestedCredit > maxEligibleCredit) {
    throw appError(
      `Credit amount (${totalRequestedCredit}) exceeds maximum eligible credit (${maxEligibleCredit}) for invoice ${invoice.invoiceNo}.`,
      409
    );
  }

  const createPayload = {
    clientId: invoice.clientId,
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNo,
    reason: payload.reason || `Credit for invoice ${invoice.invoiceNo}`,
    currency: invoice.currency,
    items,
    notes: payload.notes || `Issued against invoice ${invoice.invoiceNo}`
  };

  const creditNote = await create(req, createPayload);

  // If the invoice has an outstanding balance, automatically apply the credit note to clear the balance
  if (invoice.balanceDue > 0 && !payload.keepOpen) {
    const amountToApply = Math.min(totalRequestedCredit, invoice.balanceDue);
    if (amountToApply > 0) {
      await applyToInvoice(req, creditNote._id, {
        invoiceId: invoice._id,
        amount: amountToApply
      });
      return getById(req, creditNote._id);
    }
  }

  return creditNote;
}

/**
 * Applies a Credit Note to an unpaid invoice, safely recalculating balances.
 */
async function applyToInvoice(req, creditNoteId, { invoiceId, amount }) {
  const CreditNote = getCreditNoteModel(req);
  const InvoiceService = require('./invoice.service');
  const userId = resolveUserId(req);

  const creditNote = await getById(req, creditNoteId);
  if (!['Open', 'Partially Applied'].includes(creditNote.status)) {
    throw appError(`Credit Note is ${creditNote.status} and cannot be applied.`, 409);
  }

  const applyAmount = Math.round(Number(amount) * 100) / 100;
  if (applyAmount <= 0) {
    throw appError('Amount to apply must be greater than zero.');
  }

  if (applyAmount > creditNote.remainingBalance) {
    throw appError(
      `Cannot apply ${applyAmount}. Credit Note remaining balance is ${creditNote.remainingBalance}.`,
      409
    );
  }

  const invoice = await InvoiceService.getById(req, invoiceId);
  if (String(invoice.clientId) !== String(creditNote.clientId)) {
    throw appError('Invoice client does not match Credit Note client.', 409);
  }
  if (['Draft', 'Cancelled'].includes(invoice.status)) {
    throw appError(`Cannot apply credit note to a ${invoice.status} invoice.`, 409);
  }
  if (invoice.balanceDue <= 0) {
    throw appError('Invoice has zero balance due.', 409);
  }
  if (applyAmount > invoice.balanceDue) {
    throw appError(
      `Amount to apply (${applyAmount}) exceeds invoice balance due (${invoice.balanceDue}).`,
      409
    );
  }

  // Atomically apply credit adjustment to invoice
  await InvoiceService.applyCreditNoteAdjustment(
    req,
    invoiceId,
    applyAmount,
    creditNote.creditNoteNumber,
    creditNote._id
  );

  // Update credit note record
  const newRemaining = Math.max(0, Math.round((creditNote.remainingBalance - applyAmount) * 100) / 100);
  const newStatus = newRemaining <= 0 ? 'Applied' : 'Partially Applied';

  const appliedEntry = {
    invoiceId: String(invoice._id),
    invoiceNo: invoice.invoiceNo,
    amount: applyAmount,
    appliedAt: new Date(),
    appliedBy: userId
  };

  const updatedCreditNote = await CreditNote.findOneAndUpdate(
    { ...baseFilter(req), _id: creditNoteId },
    {
      $set: {
        remainingBalance: newRemaining,
        status: newStatus,
        updatedBy: userId
      },
      $push: {
        appliedInvoices: appliedEntry
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'applied',
    module: 'credit_note',
    recordId: String(creditNoteId),
    description: `Applied ${creditNote.currency} ${applyAmount} from ${creditNote.creditNoteNumber} to invoice ${invoice.invoiceNo}`,
    metadata: { invoiceId, invoiceNo: invoice.invoiceNo, amount: applyAmount }
  });

  return updatedCreditNote;
}

/**
 * Records a cash/bank refund against an open credit note.
 */
async function refund(req, id, { amount, refundMode = 'Bank Transfer', notes = '' }) {
  const CreditNote = getCreditNoteModel(req);
  const userId = resolveUserId(req);

  const creditNote = await getById(req, id);
  if (!['Open', 'Partially Applied'].includes(creditNote.status)) {
    throw appError(`Credit Note is ${creditNote.status} and cannot be refunded.`, 409);
  }

  const refundAmt = Math.round(Number(amount) * 100) / 100;
  if (refundAmt <= 0) {
    throw appError('Refund amount must be greater than zero.');
  }
  if (refundAmt > creditNote.remainingBalance) {
    throw appError(`Refund amount (${refundAmt}) exceeds credit note remaining balance (${creditNote.remainingBalance}).`, 409);
  }

  const newRefundTotal = Math.round(((creditNote.refundAmount || 0) + refundAmt) * 100) / 100;
  const newRemaining = Math.max(0, Math.round((creditNote.remainingBalance - refundAmt) * 100) / 100);
  const newStatus = newRemaining <= 0 ? 'Refunded' : 'Partially Applied';

  const updated = await CreditNote.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        refundAmount: newRefundTotal,
        remainingBalance: newRemaining,
        status: newStatus,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'refunded',
    module: 'credit_note',
    recordId: String(id),
    description: `Refunded ${creditNote.currency} ${refundAmt} via ${refundMode} for ${creditNote.creditNoteNumber}`,
    metadata: { refundAmount: refundAmt, refundMode, notes }
  });

  return updated;
}

/**
 * Voids an unapplied credit note.
 */
async function voidCreditNote(req, id, { reason = 'Voided by user' } = {}) {
  const CreditNote = getCreditNoteModel(req);
  const userId = resolveUserId(req);

  const creditNote = await getById(req, id);
  if (creditNote.status === 'Void') {
    throw appError('Credit Note is already void.', 409);
  }
  if (Array.isArray(creditNote.appliedInvoices) && creditNote.appliedInvoices.length > 0) {
    throw appError('Cannot void a Credit Note that has already been applied to invoices.', 409);
  }
  if ((creditNote.refundAmount || 0) > 0) {
    throw appError('Cannot void a Credit Note with refunds recorded.', 409);
  }

  const updated = await CreditNote.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        status: 'Void',
        remainingBalance: 0,
        voidReason: String(reason).trim(),
        voidedAt: new Date(),
        voidedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'voided',
    module: 'credit_note',
    recordId: String(id),
    description: `Voided Credit Note: ${creditNote.creditNoteNumber}`,
    metadata: { reason }
  });

  return updated;
}

async function remove(req, id) {
  const CreditNote = getCreditNoteModel(req);
  const userId = resolveUserId(req);
  const existing = await getById(req, id);

  if (existing.status !== 'Draft' && existing.status !== 'Void') {
    throw appError('Only Draft or Void credit notes can be deleted.', 409);
  }

  await CreditNote.findOneAndUpdate(
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
    module: 'credit_note',
    recordId: String(id),
    description: `Deleted Credit Note: ${existing.creditNoteNumber}`
  });

  return { deleted: true, id };
}

async function archive(req, id) {
  const CreditNote = getCreditNoteModel(req);
  const userId = resolveUserId(req);
  const existing = await getById(req, id);

  const updated = await CreditNote.findOneAndUpdate(
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
    module: 'credit_note',
    recordId: String(id),
    description: `Archived Credit Note: ${existing.creditNoteNumber}`
  });

  return updated;
}

async function restore(req, id) {
  const CreditNote = getCreditNoteModel(req);
  const userId = resolveUserId(req);
  const existing = await getById(req, id);

  const updated = await CreditNote.findOneAndUpdate(
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
    module: 'credit_note',
    recordId: String(id),
    description: `Restored Credit Note: ${existing.creditNoteNumber}`
  });

  return updated;
}

async function exportPrintHtml(req, id) {
  const doc = await getById(req, id);
  const client = await validateClient(req, doc.clientId);
  const settings = await SettingService.getAll(req);

  const linesHtml = (doc.items || [])
    .map(
      (item) => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #e2e8f0;">${item.description || 'Item'}</td>
        <td style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:right;">${item.quantity}</td>
        <td style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:right;">${doc.currency} ${Number(item.unitPrice).toFixed(2)}</td>
        <td style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:right;">${item.tax || 0}%</td>
        <td style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:right; font-weight:600;">${doc.currency} ${Number(item.amount).toFixed(2)}</td>
      </tr>
    `
    )
    .join('');

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Credit Note ${doc.creditNoteNumber}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1e293b; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.5; }
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #0284c7; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { margin: 0; color: #0284c7; font-size: 28px; }
        .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 700; background: #e0f2fe; color: #0369a1; text-transform: uppercase; }
        .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        th { background: #f8fafc; padding: 10px; text-align: left; font-size: 12px; text-transform: uppercase; color: #64748b; border-bottom: 1px solid #cbd5e1; }
        .totals { float: right; width: 300px; }
        .totals-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
        .totals-row.grand { font-weight: 700; font-size: 16px; border-top: 2px solid #0284c7; border-bottom: none; color: #0f172a; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <h1>CREDIT NOTE</h1>
          <p style="font-weight: 600; color: #64748b; margin: 4px 0 0 0;">${settings.company_name || 'Root CRM'}</p>
        </div>
        <div style="text-align: right;">
          <h2 style="margin: 0; font-size: 20px;">${doc.creditNoteNumber}</h2>
          <span class="badge">${doc.status}</span>
        </div>
      </div>

      <div class="meta-grid">
        <div>
          <strong style="color: #64748b; font-size: 12px; text-transform: uppercase;">Credit Issued To:</strong>
          <p style="margin: 4px 0 0 0; font-weight: 700; font-size: 16px;">${doc.clientName}</p>
          <p style="margin: 2px 0 0 0; color: #475569;">${client.email || ''}</p>
          <p style="margin: 2px 0 0 0; color: #475569;">${client.billingAddress?.street || ''} ${client.billingAddress?.city || ''}</p>
        </div>
        <div style="text-align: right;">
          <p style="margin: 0;"><strong>Date:</strong> ${new Date(doc.creditDate).toLocaleDateString()}</p>
          ${doc.invoiceNumber ? `<p style="margin: 4px 0 0 0;"><strong>Invoice Reference:</strong> ${doc.invoiceNumber}</p>` : ''}
          <p style="margin: 4px 0 0 0;"><strong>Reason:</strong> ${doc.reason || 'General Credit'}</p>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th style="text-align:right;">Qty</th>
            <th style="text-align:right;">Unit Price</th>
            <th style="text-align:right;">Tax</th>
            <th style="text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${linesHtml}
        </tbody>
      </table>

      <div class="totals">
        <div class="totals-row">
          <span>Subtotal:</span>
          <span>${doc.currency} ${Number(doc.subtotal || 0).toFixed(2)}</span>
        </div>
        <div class="totals-row">
          <span>Tax Total:</span>
          <span>${doc.currency} ${Number(doc.taxTotal || 0).toFixed(2)}</span>
        </div>
        <div class="totals-row grand">
          <span>Total Credit:</span>
          <span>${doc.currency} ${Number(doc.totalAmount).toFixed(2)}</span>
        </div>
        <div class="totals-row" style="color: #0284c7; font-weight: 600;">
          <span>Remaining Balance:</span>
          <span>${doc.currency} ${Number(doc.remainingBalance).toFixed(2)}</span>
        </div>
      </div>

      ${doc.notes ? `<div style="clear:both; padding-top: 30px;"><strong style="font-size: 12px; color: #64748b; text-transform: uppercase;">Notes:</strong><p style="margin: 4px 0 0 0; color: #475569;">${doc.notes}</p></div>` : ''}
    </body>
    </html>
  `;

  await AuditService.log(req, {
    action: 'print_opened',
    module: 'credit_note',
    recordId: String(id),
    description: `Print view opened for Credit Note: ${doc.creditNoteNumber}`
  });

  return { html, title: doc.creditNoteNumber };
}

module.exports = {
  list,
  getById,
  create,
  createFromInvoice,
  applyToInvoice,
  refund,
  voidCreditNote,
  remove,
  archive,
  restore,
  exportPrintHtml
};
