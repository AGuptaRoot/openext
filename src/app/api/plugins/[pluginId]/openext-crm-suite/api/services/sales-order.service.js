'use strict';

const { withCustomerSnapshot } = require('../utils/customer-snapshot.util');
const { resolveTenantId, resolveUserId, applyClientScope, applyClientScopeAsync } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { getNextNumber } = require('../utils/numbering.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const { enrichWithCustomerLabel } = require('../utils/customer-label.util');

function getSalesOrderModel(req) {
  const SalesOrder = req.cms?.models?.get?.('SalesOrder') || req.storage?.db?.models?.SalesOrder;
  if (!SalesOrder) throw new Error('SalesOrder model is not registered');
  return SalesOrder;
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

function isWonOpportunityStage(stage, stageType) {
  if (String(stageType || '').trim().toUpperCase() === 'WON') return true;
  return String(stage || '').trim().toLowerCase() === 'won';
}

/**
 * Safe findOne + optional select + lean for CMS plugin models.
 * OpenNext plugin queries often return a thenable from `.lean()` that has no `.catch`,
 * so `Model.findOne().select().lean().catch(...)` throws "catch is not a function".
 */
async function safeLeanFindOne(Model, filter = {}, selectFields) {
  if (!Model || typeof Model.findOne !== 'function') return null;
  try {
    let query = Model.findOne(filter);
    if (selectFields && query && typeof query.select === 'function') {
      query = query.select(selectFields);
    }
    if (query && typeof query.lean === 'function') {
      const leaned = query.lean();
      if (leaned != null && typeof leaned.then === 'function') {
        return await leaned;
      }
      if (leaned != null && typeof leaned.exec === 'function') {
        return await leaned.exec();
      }
      if (leaned && typeof leaned === 'object' && leaned !== query) {
        return leaned;
      }
    }
    if (query && typeof query.exec === 'function') {
      return await query.exec();
    }
    return (await query) || null;
  } catch {
    return null;
  }
}

async function safeUpdateOne(Model, filter, update) {
  if (!Model || typeof Model.updateOne !== 'function') return;
  try {
    const result = Model.updateOne(filter, update);
    if (result != null && typeof result.then === 'function') {
      await result;
      return;
    }
    if (result != null && typeof result.exec === 'function') {
      await result.exec();
    }
  } catch {
    // ignore link failures — SO create/detail must still succeed
  }
}

/**
 * Mark opportunity as converted once a sales order is linked.
 * Keeps the first linked SO id (does not overwrite a different existing id).
 */
async function linkOpportunitySalesOrder(req, opportunityId, salesOrderId, orderNumber) {
  const oppId = String(opportunityId || '').trim();
  const soId = String(salesOrderId || '').trim();
  if (!oppId || !soId) return;
  const Opportunity = req.cms?.models?.get?.('Opportunity');
  if (!Opportunity) return;
  const existing = await safeLeanFindOne(
    Opportunity,
    { ...baseFilter(req), _id: oppId },
    'generatedSalesOrderId'
  );
  if (existing?.generatedSalesOrderId && String(existing.generatedSalesOrderId) !== soId) {
    return;
  }
  await safeUpdateOne(
    Opportunity,
    { ...baseFilter(req), _id: oppId },
    {
      $set: {
        generatedSalesOrderId: soId,
        updatedBy: resolveUserId(req),
      },
    }
  );
  void orderNumber;
}

/**
 * Lists sales orders with pagination, search, and status filtering.
 * 
 * Usecase: Sales order dashboard list view.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<Object>} Paginated list of sales orders
 */
async function list(req) {
  const SalesOrder = getSalesOrderModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query);
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
  } else if (req.query?.clientId) {
    filter.clientId = String(req.query.clientId).trim();
  }

  if (req.query?.status) filter.status = String(req.query.status).trim();
  if (req.query?.projectId) filter.projectId = String(req.query.projectId).trim();
  if (req.query?.leadId) filter.leadId = String(req.query.leadId).trim();
  if (req.query?.generatedBy) filter.generatedBy = String(req.query.generatedBy).trim();

  if (req.query?.search) {
    const { findMatchingClientIds } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const or = [
        { orderNumber: { $regex: term, $options: 'i' } },
        { clientId: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { customerLabel: { $regex: term, $options: 'i' } },
        { customerName: { $regex: term, $options: 'i' } },
        { trackingNumber: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } },
        { generatedBy: { $regex: term, $options: 'i' } }
      ];
      const clientIds = await findMatchingClientIds(req, req.query.search);
      if (clientIds.length) or.push({ clientId: { $in: clientIds } });
      filter.$or = or;
    }
  }

  const { applySalesAgentCreatorScope, assertSalesAgentCreatorAccess } = require('../utils/sales-access.util');
  const finalFilter = applySalesAgentCreatorScope(req, filter);

  const [items, total] = await Promise.all([
    SalesOrder.find(finalFilter).sort(sort).skip(skip).limit(limit).lean(),
    SalesOrder.countDocuments(finalFilter)
  ]);

  const enriched = await enrichWithCustomerLabel(req, items);

  return {
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

/**
 * Fetches a single Sales Order document by ID.
 * 
 * Usecase: Sales Order detail view.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @returns {Promise<Object>} Sales Order record
 */
/**
 * Attach related Opportunity summary (by opportunityId only — never by name).
 */
async function enrichWithRelatedOpportunity(req, doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const opportunityId = doc.opportunityId ? String(doc.opportunityId).trim() : '';
  if (!opportunityId) {
    return {
      ...doc,
      opportunityTitle: doc.opportunityTitle || null,
      opportunityStage: doc.opportunityStage || null,
      opportunityStageType: doc.opportunityStageType || null,
      opportunityExpectedRevenue:
        doc.opportunityExpectedRevenue != null ? Number(doc.opportunityExpectedRevenue) : null,
      opportunityCurrency: doc.opportunityCurrency || null,
    };
  }
  const Opportunity = req.cms?.models?.get?.('Opportunity');
  if (!Opportunity) {
    return {
      ...doc,
      opportunityTitle: doc.opportunityTitle || null,
      opportunityStage: doc.opportunityStage || null,
      opportunityStageType: doc.opportunityStageType || null,
      opportunityExpectedRevenue:
        doc.opportunityExpectedRevenue != null ? Number(doc.opportunityExpectedRevenue) : null,
      opportunityCurrency: doc.opportunityCurrency || null,
    };
  }
  const opp = await safeLeanFindOne(
    Opportunity,
    {
      ...baseFilter(req),
      _id: opportunityId,
    },
    'title stage stageType expectedRevenue currency'
  );
  return {
    ...doc,
    opportunityId,
    opportunityTitle: opp?.title || doc.opportunityTitle || null,
    opportunityStage: opp?.stage || doc.opportunityStage || null,
    opportunityStageType: opp?.stageType || doc.opportunityStageType || null,
    opportunityExpectedRevenue:
      opp?.expectedRevenue != null
        ? Number(opp.expectedRevenue)
        : doc.opportunityExpectedRevenue != null
          ? Number(doc.opportunityExpectedRevenue)
          : null,
    opportunityCurrency: opp?.currency || doc.opportunityCurrency || null,
  };
}

async function getById(req, id) {
  const doc = await getSalesOrderModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Sales order not found', 404);
  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId || String(doc.clientId) !== String(userClientId)) {
      throw appError('Sales order not found', 404);
    }
  } else {
    const { assertSalesAgentCreatorAccess } = require('../utils/sales-access.util');
    assertSalesAgentCreatorAccess(req, doc, 'Sales order');
  }
  const withCustomer = await enrichWithCustomerLabel(req, doc);
  return enrichWithRelatedOpportunity(req, withCustomer);
}

/**
 * Creates a new Sales Order document.
 * 
 * Usecase: Manual Sales Order creation.
 * 
 * @param {Object} req Express request object
 * @param {Object} input Sales Order data payload
 * @returns {Promise<Object>} Created Sales Order document
 */
async function create(req, input) {
  const SalesOrder = getSalesOrderModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const settings = await SettingService.getAll(req);

  if (!input.clientId && !input.leadId) throw appError('clientId or leadId is required');

  let clientId = input.clientId ? String(input.clientId).trim() : '';
  const leadId = input.leadId ? String(input.leadId).trim() : '';

  if (!clientId && leadId) {
    const QuotationService = require('./quotation.service');
    clientId = await QuotationService.resolveQuotationClientId(req, { clientId, leadId }, { convertLead: true });
  }

  if (!clientId) throw appError('clientId is required to create a Sales Order');

  // Enforce 1 Opportunity → 1 Sales Order (identify by opportunityId only).
  const opportunityIdForCreate = input.opportunityId ? String(input.opportunityId).trim() : '';
  if (opportunityIdForCreate) {
    const existingForOpp = await SalesOrder.findOne({
      ...baseFilter(req),
      opportunityId: opportunityIdForCreate,
    })
      .sort({ createdAt: -1 })
      .lean();
    if (existingForOpp) {
      const err = appError('A Sales Order already exists for this Opportunity.', 409);
      err.code = 'SALES_ORDER_EXISTS';
      err.salesOrderId = String(existingForOpp._id);
      throw err;
    }
    const Opportunity = req.cms?.models?.get?.('Opportunity');
    if (Opportunity) {
      const opp = await Opportunity.findOne({
        ...baseFilter(req),
        _id: opportunityIdForCreate,
      })
        .select('generatedSalesOrderId')
        .lean();
      if (opp?.generatedSalesOrderId) {
        const err = appError('A Sales Order already exists for this Opportunity.', 409);
        err.code = 'SALES_ORDER_EXISTS';
        err.salesOrderId = String(opp.generatedSalesOrderId);
        throw err;
      }
    }
  }

  const lineItems = (input.lineItems || []).map((item) => ({
    description: String(item.description || '').trim(),
    qty: Number(item.qty || 1),
    rate: Number(item.rate || 0),
    tax: Number(item.tax || 0),
    productId: item.productId ? String(item.productId).trim() : null,
    amount: Math.round(Number(item.qty || 1) * Number(item.rate || 0) * 100) / 100
  }));

  if (!lineItems.length) throw appError('At least one line item is required');

  const subtotal = lineItems.reduce((sum, item) => sum + item.qty * item.rate, 0);
  const taxTotal = lineItems.reduce((sum, item) => sum + (item.qty * item.rate * (item.tax / 100)), 0);

  const discountType = input.discountType === 'amount' ? 'amount' : 'percent';
  let discountValue = Math.max(0, Number(input.discountValue ?? (discountType === 'amount' ? input.discountTotal : input.discountPercent) ?? 0));
  if (discountType === 'percent') {
    discountValue = Math.min(100, discountValue);
  }
  let discountTotal = 0;
  let discountPercent = 0;

  if (discountType === 'amount') {
    discountTotal = Math.min(subtotal, Math.round(discountValue * 100) / 100);
    discountPercent = subtotal > 0 ? Math.round((discountTotal / subtotal) * 10000) / 100 : 0;
  } else {
    discountPercent = discountValue;
    discountTotal = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
  }

  const ShippingService = require('./shipping.service');
  const shippingState = input.shippingState ? String(input.shippingState).trim() : (settings.company_state || 'Maharashtra');
  const totalWeightKg = Number(input.totalWeightKg) || 1;
  const autoShipping = ShippingService.calculateShippingCharge({
    state: shippingState,
    totalWeightKg,
    subtotal,
    customRates: settings.state_shipping_rates,
    freeThreshold: settings.free_shipping_threshold
  });
  const shippingCharge = input.shippingCharge !== undefined ? Number(input.shippingCharge) : autoShipping.shippingCharge;

  const grandTotal = Math.max(0, Math.round((subtotal - discountTotal + taxTotal + shippingCharge) * 100) / 100);

  const orderNumber = (input.orderNumber && String(input.orderNumber).trim())
    ? String(input.orderNumber).trim()
    : await getNextNumber(req, 'salesOrder');
  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date();

  const doc = await SalesOrder.create(await withCustomerSnapshot(req, {
    tenantId,
    orderNumber,
    quotationId: input.quotationId || null,
    opportunityId: input.opportunityId || null,
    clientId,
    projectId: input.projectId ? String(input.projectId).trim() : null,
    leadId: leadId || null,
    generatedBy: input.generatedBy ? String(input.generatedBy).trim() : 'Root CRM',
    issueDate,
    deliveryTargetDate: input.deliveryTargetDate ? new Date(input.deliveryTargetDate) : null,
    status: input.status || 'Approved',
    currency: (() => {
      const { resolveRecordCurrency, resolveExchangeRate } = require('../utils/record-currency.util');
      return resolveRecordCurrency(input, settings);
    })(),
    exchangeRate: (() => {
      const { resolveExchangeRate } = require('../utils/record-currency.util');
      return resolveExchangeRate(input);
    })(),
    lineItems,
    subtotal,
    discountType,
    discountValue,
    discountPercent,
    discountTotal,
    taxTotal,
    shippingCharge,
    shippingState,
    totalWeightKg,
    grandTotal,
    deliveryStatus: input.deliveryStatus || 'Pending Allocation',
    courierName: input.courierName || '',
    trackingNumber: input.trackingNumber || '',
    billingAddress: input.billingAddress || '',
    shippingAddress: input.shippingAddress || '',
    notes: input.notes ? String(input.notes).trim() : '',
    createdBy: userId,
    updatedBy: userId
  }));

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'sales_order',
    recordId: result._id.toString(),
    description: `Sales Order created: ${orderNumber}`,
    metadata: { clientId: result.clientId, grandTotal: result.grandTotal, generatedBy: result.generatedBy }
  });

  if (result.opportunityId) {
    await linkOpportunitySalesOrder(
      req,
      result.opportunityId,
      result._id.toString(),
      result.orderNumber
    );
  }

  return result;
}

/**
 * Converts an Accepted Quotation into a Sales Order.
 * 
 * Usecase: 1-Click conversion from accepted quotation to sales order.
 * 
 * @param {Object} req Express request object
 * @param {string} quotationId Quotation ID
 * @returns {Promise<Object>} Created Sales Order document
 */
async function createFromQuotation(req, quotationId) {
  const { isSalesRepresentative, isAdmin, isSalesManager } = require('../utils/sales-access.util');
  if (isSalesRepresentative(req) && !isAdmin(req) && !isSalesManager(req)) {
    throw appError('Sales representatives cannot convert quotations to sales orders', 403);
  }

  const Estimate = req.cms?.models.get('Estimate');
  const quotation = await Estimate.findOne({ ...baseFilter(req), _id: quotationId }).lean();

  if (!quotation) throw appError('Quotation not found', 404);

  if (quotation.convertedSalesOrderId) {
    const SalesOrder = getSalesOrderModel(req);
    const existingOrder = await SalesOrder.findOne({ ...baseFilter(req), _id: quotation.convertedSalesOrderId }).lean();
    if (existingOrder) return existingOrder;
  }

  if (!['Accepted', 'Converted'].includes(quotation.status)) {
    throw appError('Only Accepted quotations can be converted to a Sales Order', 400);
  }

  const QuotationService = require('./quotation.service');
  const clientId = await QuotationService.resolveQuotationClientId(req, quotation, { convertLead: true });

  const order = await create(req, {
    quotationId: quotation._id.toString(),
    opportunityId: quotation.opportunityId || undefined,
    clientId,
    leadId: quotation.leadId || undefined,
    // Inherit quotation currency — do NOT fall back to global default when source has currency.
    currency: quotation.currency || quotation.currencyCode || undefined,
    exchangeRate: quotation.exchangeRate,
    lineItems: quotation.lineItems,
    discountPercent: quotation.discountPercent || 0,
    discountType: quotation.discountType,
    discountValue: quotation.discountValue ?? quotation.discount,
    shippingState: quotation.shippingState || undefined,
    shippingCharge: quotation.shippingCharge,
    status: 'Approved',
    notes: `Converted from Quotation ${quotation.quotationNo}: ${quotation.notes || ''}`
  });

  await Estimate.updateOne(
    { ...baseFilter(req), _id: quotationId },
    { $set: { status: 'Converted', clientId, convertedSalesOrderId: order._id.toString(), updatedBy: resolveUserId(req) } }
  );

  if (quotation.opportunityId || quotation.dealId) {
    try {
      const OpportunityService = require('./opportunity.service');
      await OpportunityService.syncOpportunityQuotationAccepted(req, quotation);
    } catch (err) {
      console.warn('[plugin:openext-crm-suite] opportunity Won sync on sales order convert failed:', err?.message || err);
    }
  }

  const oppId = quotation.opportunityId || quotation.dealId;
  if (oppId) {
    const Opportunity = req.cms?.models?.get ? req.cms.models.get('Opportunity') : null;
    if (Opportunity) {
      await Opportunity.updateOne(
        { ...baseFilter(req), _id: oppId },
        {
          $set: {
            stage: 'Won',
            stageType: 'WON',
            closedAt: new Date(),
            acceptedQuotationId: quotation._id ? quotation._id.toString() : undefined,
            generatedSalesOrderId: order._id.toString(),
            updatedBy: resolveUserId(req)
          }
        }
      );
    }
  }

  await AuditService.log(req, {
    action: 'converted_to_sales_order',
    module: 'quotation',
    recordId: String(quotationId),
    description: `Quotation ${quotation.quotationNo} converted to Sales Order ${order.orderNumber}`
  });

  return order;
}

/**
 * Converts a Won Opportunity into a Sales Order.
 * 
 * Usecase: Direct Sales Order creation from Won Opportunity deals.
 * 
 * @param {Object} req Express request object
 * @param {string} opportunityId Opportunity ID
 * @returns {Promise<Object>} Created Sales Order document
 */
async function createFromOpportunity(req, opportunityId) {
  const Opportunity = req.cms?.models.get('Opportunity');
  const opp = await Opportunity.findOne({ ...baseFilter(req), _id: opportunityId }).lean();

  if (!opp) throw appError('Opportunity not found', 404);
  if (!isWonOpportunityStage(opp.stage, opp.stageType)) {
    throw appError('Only Won opportunities can be converted into a Sales Order', 400);
  }

  const SalesOrder = getSalesOrderModel(req);
  const existingOrder = await SalesOrder.findOne({
    ...baseFilter(req),
    opportunityId: String(opportunityId),
  })
    .sort({ createdAt: -1 })
    .lean();
  const existingId = existingOrder
    ? String(existingOrder._id)
    : opp.generatedSalesOrderId
      ? String(opp.generatedSalesOrderId)
      : '';
  if (existingId) {
    if (existingOrder) {
      await linkOpportunitySalesOrder(
        req,
        opportunityId,
        existingOrder._id.toString(),
        existingOrder.orderNumber
      );
    }
    const err = appError('A Sales Order already exists for this Opportunity.', 409);
    err.code = 'SALES_ORDER_EXISTS';
    err.salesOrderId = existingId;
    throw err;
  }

  const settings = await SettingService.getAll(req);
  const defaultTax = Number(settings.tax_rate ?? 18);

  const lineItems = (opp.products || []).map((p) => ({
    description: p.productName || opp.title,
    qty: p.quantity || 1,
    rate: p.unitPrice || 0,
    tax: p.tax !== undefined && p.tax !== null ? Number(p.tax) : defaultTax
  }));

  if (!lineItems.length) {
    lineItems.push({
      description: opp.title,
      qty: 1,
      rate: opp.expectedRevenue,
      tax: defaultTax
    });
  }

  const order = await create(req, {
    opportunityId: opp._id.toString(),
    clientId: opp.clientId,
    leadId: opp.leadId || undefined,
    // Inherit opportunity currency — do NOT replace with global default.
    currency: opp.currency || opp.currencyCode || undefined,
    exchangeRate: opp.exchangeRate,
    shippingState: opp.shippingState || undefined,
    shippingCharge: opp.shippingCharge !== undefined ? opp.shippingCharge : undefined,
    lineItems,
    status: 'Approved',
    notes: `Converted from Won Opportunity ${opp.opportunityNumber}: ${opp.title}`
  });

  // create() already links; force-set so the convert button hides on next load.
  await Opportunity.updateOne(
    { ...baseFilter(req), _id: opportunityId },
    {
      $set: {
        generatedSalesOrderId: order._id.toString(),
        updatedBy: resolveUserId(req),
      },
    }
  );

  await AuditService.log(req, {
    action: 'converted_to_sales_order',
    module: 'opportunity',
    recordId: String(opportunityId),
    description: `Won Opportunity ${opp.opportunityNumber} converted to Sales Order ${order.orderNumber}`
  });

  return order;
}

/**
 * Generates or retrieves a linked Tax Invoice from a Sales Order.
 * 
 * Usecase: Converting fulfilled or confirmed Sales Orders into billable Tax Invoices.
 * 
 * @param {Object} req Express request object
 * @param {string} salesOrderId Sales Order ID
 * @returns {Promise<Object>} Created or linked Invoice document
 */
async function createInvoiceFromSalesOrder(req, salesOrderId, options = {}) {
  const SalesOrder = getSalesOrderModel(req);
  const order = await SalesOrder.findOne({ ...baseFilter(req), _id: salesOrderId }).lean();

  if (!order) throw appError('Sales Order not found', 404);

  const shouldSendEmail = Boolean(options.sendEmail ?? req.body?.sendEmail);
  const targetEmail = options.clientEmail ?? options.email ?? req.body?.clientEmail ?? req.body?.email;
  const emailMsg = options.emailMessage ?? options.message ?? req.body?.emailMessage ?? req.body?.message;

  const InvoiceService = require('./invoice.service');
  const Invoice = req.cms?.models.get('Invoice');

  // If already converted to an invoice, return existing invoice if it still exists
  if (order.convertedInvoiceId && Invoice) {
    const existingInv = await Invoice.findOne({ ...baseFilter(req), _id: order.convertedInvoiceId }).lean();
    if (existingInv) {
      if (shouldSendEmail) {
        try {
          const sendResult = await InvoiceService.send(req, existingInv._id.toString(), {
            email: targetEmail,
            message: emailMsg
          });
          if (sendResult?.doc) {
            existingInv.status = sendResult.doc.status;
          }
          existingInv.emailDelivery = sendResult?.emailDelivery || { sent: true };
        } catch (mailErr) {
          console.warn('[plugin:openext-crm-suite] Failed to send email for existing invoice:', mailErr.message);
          existingInv.emailWarning = mailErr.message;
        }
      }
      return existingInv;
    }
  }

  // Resolve client ID (convert lead if necessary)
  let clientId = order.clientId;
  if (!clientId && order.leadId) {
    const LeadService = require('./lead.service');
    const converted = await LeadService.convert(req, order.leadId).catch(() => null);
    if (converted && converted.clientId) {
      clientId = converted.clientId;
    }
  }

  if (!clientId) {
    throw appError('Client account is required to generate an invoice', 400);
  }

  // Map line items from Sales Order to Invoice format
  const lineItems = (order.lineItems || []).map((item) => ({
    description: item.description,
    qty: item.qty || 1,
    rate: item.rate || 0,
    tax: item.tax !== undefined && item.tax !== null ? item.tax : 0
  }));

  const issueDate = new Date();
  const dueDate = order.deliveryTargetDate ? new Date(order.deliveryTargetDate) : new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

  const invoiceInput = {
    clientId,
    salesOrderId: order._id.toString(),
    salesOrderNo: order.orderNumber,
    projectId: order.projectId || undefined,
    issueDate,
    dueDate,
    currency: order.currency || 'INR',
    discountType: order.discountType || 'percent',
    discountPercent: order.discountPercent || (order.discountType === 'percent' ? order.discountValue : 0),
    discountAmount: order.discountType === 'amount' ? order.discountValue : 0,
    billingAddress: order.billingAddress || '',
    shippingAddress: order.shippingAddress || '',
    lineItems,
    notes: `Generated from Sales Order ${order.orderNumber}${order.notes ? ` · Notes: ${order.notes}` : ''}`,
    status: 'Draft'
  };

  const invoice = await InvoiceService.create(req, invoiceInput);

  // Update SalesOrder with linked invoice info
  const orderDoc = await SalesOrder.findOne({ ...baseFilter(req), _id: salesOrderId });
  if (orderDoc) {
    orderDoc.convertedInvoiceId = invoice._id.toString();
    orderDoc.convertedInvoiceNo = invoice.invoiceNo;
    orderDoc.invoiceStatus = invoice.status || 'Draft';
    orderDoc.updatedBy = resolveUserId(req);
    if (typeof orderDoc.save === 'function') {
      await orderDoc.save();
    }
  } else if (typeof SalesOrder.updateOne === 'function') {
    await SalesOrder.updateOne(
      { ...baseFilter(req), _id: salesOrderId },
      {
        $set: {
          convertedInvoiceId: invoice._id.toString(),
          convertedInvoiceNo: invoice.invoiceNo,
          invoiceStatus: invoice.status || 'Draft',
          updatedBy: resolveUserId(req)
        }
      }
    );
  }

  await AuditService.log(req, {
    action: 'converted_to_invoice',
    module: 'sales_order',
    recordId: String(salesOrderId),
    description: `Sales Order ${order.orderNumber} converted to Tax Invoice ${invoice.invoiceNo}`
  });

  if (shouldSendEmail) {
    try {
      const sendResult = await InvoiceService.send(req, invoice._id.toString(), {
        email: targetEmail,
        message: emailMsg
      });
      if (sendResult?.doc) {
        invoice.status = sendResult.doc.status;
      }
      invoice.emailDelivery = sendResult?.emailDelivery || { sent: true };
    } catch (mailErr) {
      console.warn('[plugin:openext-crm-suite] Invoice generated, but failed to send email to client:', mailErr.message);
      invoice.emailWarning = mailErr.message;
    }
  }

  return invoice;
}

/**
 * Updates a Sales Order status (Approved, Processing, Completed, Cancelled).
 * 
 * Usecase: Sales Order fulfillment workflow stage updates.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {string} status New status string
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function updateStatus(req, id, status) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const doc = await SalesOrder.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { status, updatedBy: userId } },
    { new: true }
  ).lean();

  if (!doc) throw appError('Sales Order not found', 404);

  await AuditService.log(req, {
    action: 'status_changed',
    module: 'sales_order',
    recordId: id,
    description: `Sales Order ${doc.orderNumber} status changed to ${status}`
  });

  return doc;
}

/**
 * Soft deletes a Sales Order record.
 * 
 * Usecase: Deleting draft or cancelled sales orders.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @returns {Promise<Object>} Deletion summary
 */
async function remove(req, id) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sales Order not found', 404);

  await SalesOrder.updateOne(
    { ...baseFilter(req), _id: id },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'sales_order',
    recordId: id,
    description: `Sales Order ${existing.orderNumber} deleted`
  });

  return { deleted: true, id };
}

/**
 * Adds a new shipment (partial or full) to the Sales Order.
 * 
 * Usecase: Multiple shipments per order with line item selection and tracking.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {Object} input Shipment details ({ courierName, trackingNumber, shippingState, weightKg, shippedItems, notes })
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function addShipment(req, id, input) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Sales Order not found', 404);

  if (['Cancelled', 'Draft'].includes(existing.status)) {
    throw appError(`Cannot dispatch shipment for order in ${existing.status} status`, 400);
  }

  const courierName = String(input.courierName || '').trim();
  const trackingNumber = String(input.trackingNumber || '').trim();
  if (!courierName) throw appError('Courier name is required for shipment');

  // Reads "via BlueDart (AWB 12345)" or just "via BlueDart" — never "via BlueDart ()".
  const courierLabel = trackingNumber
    ? `${courierName} (AWB ${trackingNumber})`
    : `${courierName} (no tracking number yet)`;

  const shipments = existing.shipments || [];
  const shipmentNumber = `${existing.orderNumber}-S${shipments.length + 1}`;

  // Process shipped items
  let shippedItems = [];
  if (Array.isArray(input.shippedItems) && input.shippedItems.length) {
    shippedItems = input.shippedItems.map((item) => {
      const idx = item.lineItemIndex !== undefined ? Number(item.lineItemIndex) : 0;
      const orderLine = existing.lineItems[idx];
      const desc = String(item.description || orderLine?.description || `Item #${idx + 1}`).trim();
      const qty = Math.max(1, Number(item.qty || 1));
      const productId = item.productId || orderLine?.productId || null;

      // Update lineItem shippedQty
      if (orderLine) {
        orderLine.shippedQty = (orderLine.shippedQty || 0) + qty;
      }

      return {
        lineItemIndex: idx,
        description: desc,
        qty,
        productId
      };
    });
  } else {
    // Default: Ship all remaining un-shipped items
    existing.lineItems.forEach((orderLine, idx) => {
      const remainingQty = Math.max(0, (orderLine.qty || 1) - (orderLine.shippedQty || 0));
      if (remainingQty > 0) {
        orderLine.shippedQty = (orderLine.shippedQty || 0) + remainingQty;
        shippedItems.push({
          lineItemIndex: idx,
          description: orderLine.description,
          qty: remainingQty,
          productId: orderLine.productId || null
        });
      }
    });
  }

  if (!shippedItems.length) {
    throw appError('No un-shipped items available to dispatch for this order', 400);
  }

  const newShipment = {
    shipmentNumber,
    courierName,
    trackingNumber,
    shippingState: input.shippingState ? String(input.shippingState).trim() : (existing.shippingState || ''),
    weightKg: Number(input.weightKg) || 1,
    shippedItems,
    dispatchedAt: input.dispatchedAt ? new Date(input.dispatchedAt) : new Date(),
    deliveredAt: null,
    deliveryStatus: input.deliveryStatus || 'Dispatched',
    proofOfDelivery: '',
    notes: input.notes ? String(input.notes).trim() : '',
    createdBy: userId
  };

  existing.shipments.push(newShipment);

  // Sync latest shipment fields to top-level order for backwards compatibility
  existing.courierName = courierName;
  existing.trackingNumber = trackingNumber;
  existing.dispatchedAt = newShipment.dispatchedAt;

  // Determine overall order fulfillment status
  const totalOrdered = existing.lineItems.reduce((acc, item) => acc + (item.qty || 1), 0);
  const totalShipped = existing.lineItems.reduce((acc, item) => acc + (item.shippedQty || 0), 0);

  if (totalShipped >= totalOrdered) {
    existing.deliveryStatus = 'Dispatched';
    existing.status = 'Processing';
  } else {
    existing.deliveryStatus = 'Partially Dispatched';
    existing.status = 'Partially Shipped';
  }

  // Stock deduction recording
  existing.inventoryDeducted = true;
  existing.inventoryDeductedAt = new Date();
  existing.stockAudit.push({
    action: 'inventory_deducted',
    performedAt: new Date(),
    performedBy: userId,
    details: `Dispatched shipment ${shipmentNumber} with ${shippedItems.length} items via ${courierLabel}`
  });

  existing.updatedBy = userId;
  await existing.save();

  const result = existing.toObject();
  await AuditService.log(req, {
    action: 'shipment_dispatched',
    module: 'sales_order',
    recordId: id,
    description: `Shipment ${shipmentNumber} dispatched for Sales Order ${existing.orderNumber} via ${courierLabel}`,
    metadata: { shipmentNumber, trackingNumber, totalShipped, totalOrdered }
  });

  return enrichWithCustomerLabel(req, result);
}

/**
 * Updates an individual shipment status (e.g. In-Transit, Delivered) and attaches POD.
 * 
 * Usecase: Multi-shipment lifecycle & delivery confirmation.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {string} shipmentId Shipment ID or shipmentNumber
 * @param {Object} input Update details ({ deliveryStatus, proofOfDelivery, notes })
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function updateShipmentStatus(req, id, shipmentId, input) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Sales Order not found', 404);

  const targetShipment = existing.shipments.find(
    (s) => String(s._id) === String(shipmentId) || s.shipmentNumber === shipmentId
  );
  if (!targetShipment) throw appError('Shipment not found in this Sales Order', 404);

  // The AWB usually arrives after dispatch, so it can be added (or corrected)
  // on any later update without touching the delivery status.
  if (input.trackingNumber !== undefined) {
    const tracking = String(input.trackingNumber || '').trim();
    targetShipment.trackingNumber = tracking;
    const latest = existing.shipments[existing.shipments.length - 1];
    if (latest && String(latest._id) === String(targetShipment._id)) {
      existing.trackingNumber = tracking;
    }
  }

  if (input.deliveryStatus) {
    targetShipment.deliveryStatus = input.deliveryStatus;
  }
  if (input.proofOfDelivery) {
    targetShipment.proofOfDelivery = String(input.proofOfDelivery).trim();
  }
  if (input.notes) {
    targetShipment.notes = String(input.notes).trim();
  }

  if (input.deliveryStatus === 'Delivered') {
    targetShipment.deliveredAt = new Date();
    // Sync top-level if latest
    existing.deliveredAt = new Date();
    if (targetShipment.proofOfDelivery) {
      existing.proofOfDelivery = targetShipment.proofOfDelivery;
    }
  }

  // Check if all shipments are Delivered and all items are fulfilled
  const allShipmentsDelivered = existing.shipments.length > 0 &&
    existing.shipments.every((s) => s.deliveryStatus === 'Delivered');

  const totalOrdered = existing.lineItems.reduce((acc, item) => acc + (item.qty || 1), 0);
  const totalShipped = existing.lineItems.reduce((acc, item) => acc + (item.shippedQty || 0), 0);

  if (allShipmentsDelivered && totalShipped >= totalOrdered) {
    existing.deliveryStatus = 'Delivered';
    existing.status = 'Completed';
  }

  existing.updatedBy = userId;
  await existing.save();

  const result = existing.toObject();

  if (existing.deliveryStatus === 'Delivered' || result.deliveryStatus === 'Delivered') {
    try {
      const ProformaService = require('./proforma.service');
      await ProformaService.maybeAutoConvertProformaForSalesOrder(req, result);
    } catch (convErr) {
      console.warn('[plugin:openext-crm-suite] proforma auto-convert failed on shipment delivery:', convErr?.message || convErr);
    }
  }

  await AuditService.log(req, {
    action: 'shipment_status_updated',
    module: 'sales_order',
    recordId: id,
    description: `Shipment ${targetShipment.shipmentNumber} status updated to ${targetShipment.deliveryStatus} (Sales Order ${existing.orderNumber})`
  });

  return enrichWithCustomerLabel(req, result);
}

/**
 * Creates a Return Merchandise Authorization (RMA) or Replacement request.
 * 
 * Usecase: Reverse logistics, customer returns, defect replacements, and refund tracking.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {Object} input Return details ({ type, reason, returnedItems, refundAmount, notes })
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function createReturn(req, id, input) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Sales Order not found', 404);

  // Nothing can come back before it has arrived. 'Completed' counts because the
  // order moves there once every shipment is delivered.
  const delivered =
    String(existing.deliveryStatus || '') === 'Delivered' ||
    String(existing.status || '') === 'Completed' ||
    String(existing.status || '').toLowerCase() === 'completed';
  if (!delivered) {
    throw appError(
      `Returns can only be raised after the order is delivered. ${existing.orderNumber || 'This order'} is currently ${existing.deliveryStatus || existing.status}.`,
      409
    );
  }

  const reason = String(input.reason || '').trim();
  if (!reason) throw appError('Reason for return/replacement is required');

  const returns = existing.returns || [];
  const rmaNumber = `${existing.orderNumber}-RMA${returns.length + 1}`;
  const type = input.type === 'Replacement' ? 'Replacement' : 'Return';

  // Process returned items
  let calculatedRefund = 0;
  const returnedItems = (input.returnedItems || []).map((item) => {
    const desc = String(item.description || '').trim();
    const qty = Math.max(1, Number(item.qty || 1));
    const unitRate = Number(item.unitRate || 0);
    const itemReason = String(item.reason || reason).trim();
    const productId = item.productId || null;

    calculatedRefund += qty * unitRate;

    // Track returnedQty on order line items
    const matchLine = existing.lineItems.find((l) => l.description === desc || (productId && l.productId === productId));
    if (matchLine) {
      matchLine.returnedQty = (matchLine.returnedQty || 0) + qty;
    }

    return {
      description: desc,
      qty,
      unitRate,
      reason: itemReason,
      productId
    };
  });

  if (!returnedItems.length) {
    throw appError('At least one item must be specified for return', 400);
  }

  const { isClientUser } = require('../utils/tenant.util');
  const isClient = isClientUser(req) || req.user?.isClient || req.user?.isClientUser;
  const refundAmount = isClient
    ? calculatedRefund
    : (input.refundAmount !== undefined ? Math.max(0, Number(input.refundAmount)) : calculatedRefund);

  const newReturn = {
    rmaNumber,
    type,
    status: 'Requested',
    returnedItems,
    reason,
    refundAmount,
    replacementOrderId: null,
    requestedAt: new Date(),
    resolvedAt: null,
    notes: input.notes ? String(input.notes).trim() : '',
    inspectedBy: null,
    createdBy: userId
  };

  existing.returns.push(newReturn);

  // Check if whole order is returned
  const totalOrdered = existing.lineItems.reduce((acc, item) => acc + (item.qty || 1), 0);
  const totalReturned = existing.lineItems.reduce((acc, item) => acc + (item.returnedQty || 0), 0);

  if (totalReturned >= totalOrdered) {
    existing.deliveryStatus = 'Returned';
    existing.status = 'Returned';
  }

  existing.updatedBy = userId;
  await existing.save();

  const result = existing.toObject();
  await AuditService.log(req, {
    action: 'return_requested',
    module: 'sales_order',
    recordId: id,
    description: `RMA ${rmaNumber} (${type}) created for Sales Order ${existing.orderNumber}: ${reason}`,
    metadata: { rmaNumber, type, refundAmount }
  });

  return enrichWithCustomerLabel(req, result);
}

/**
 * Updates an RMA return status (Approved, Received, Inspected, Refunded, Replaced, Rejected).
 * 
 * Usecase: Reverse logistics inspection, refund authorization, and replacement order creation.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {string} returnId RMA ID or rmaNumber
 * @param {Object} input Update payload ({ status, notes, createReplacementOrder })
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function updateReturnStatus(req, id, returnId, input) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Sales Order not found', 404);

  const targetReturn = existing.returns.find(
    (r) => String(r._id) === String(returnId) || r.rmaNumber === returnId
  );
  if (!targetReturn) throw appError('RMA record not found in this Sales Order', 404);

  const newStatus = input.status;
  if (!newStatus) throw appError('Status is required');

  targetReturn.status = newStatus;
  targetReturn.inspectedBy = userId;
  if (input.notes) {
    targetReturn.notes = String(input.notes).trim();
  }

  if (['Refunded', 'Replaced', 'Rejected'].includes(newStatus)) {
    targetReturn.resolvedAt = new Date();
  }

  // Handle Replacement Order Creation if approved
  let replacementOrderCreated = null;
  if (newStatus === 'Replaced' && (input.createReplacementOrder === true || targetReturn.type === 'Replacement')) {
    if (!targetReturn.replacementOrderId) {
      const repLineItems = targetReturn.returnedItems.map((item) => ({
        description: `[Replacement for ${targetReturn.rmaNumber}] ${item.description}`,
        qty: item.qty,
        rate: item.unitRate || 0,
        tax: 0,
        amount: 0,
        productId: item.productId || null
      }));

      const repOrder = await create(req, {
        clientId: existing.clientId,
        leadId: existing.leadId || undefined,
        lineItems: repLineItems,
        shippingAddress: existing.shippingAddress,
        billingAddress: existing.billingAddress,
        shippingState: existing.shippingState,
        shippingCharge: 0,
        notes: `Automated replacement order for ${existing.orderNumber} (RMA: ${targetReturn.rmaNumber})`
      });

      targetReturn.replacementOrderId = repOrder._id.toString();
      replacementOrderCreated = repOrder;
    }
  }

  existing.updatedBy = userId;
  await existing.save();

  const result = existing.toObject();
  await AuditService.log(req, {
    action: 'return_status_updated',
    module: 'sales_order',
    recordId: id,
    description: `RMA ${targetReturn.rmaNumber} status changed to ${newStatus} (Sales Order ${existing.orderNumber})`,
    metadata: { rmaNumber: targetReturn.rmaNumber, newStatus, replacementOrderId: targetReturn.replacementOrderId }
  });

  return enrichWithCustomerLabel(req, result);
}

/**
 * Safely cancels a Sales Order with safety validation against already dispatched/delivered shipments.
 * 
 * Usecase: Cancellation safety guard and inventory reservation release.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {Object} input Cancellation details ({ reason })
 * @returns {Promise<Object>} Cancelled Sales Order document
 */
async function cancel(req, id, input) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Sales Order not found', 404);

  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId || String(existing.clientId) !== String(userClientId)) {
      throw appError('Sales Order not found', 404);
    }
  }

  if (existing.status === 'Cancelled') {
    return existing.toObject();
  }

  if (existing.status === 'Completed') {
    throw appError('Completed sales orders cannot be cancelled', 400);
  }

  // Safety rule: Cannot cancel if shipments are already Dispatched, In-Transit, or Delivered
  const hasDispatchedShipment = (existing.shipments || []).some(
    (s) => ['Dispatched', 'In-Transit', 'Delivered'].includes(s.deliveryStatus)
  );

  if (hasDispatchedShipment || ['Dispatched', 'In-Transit', 'Delivered'].includes(existing.deliveryStatus)) {
    throw appError(
      'Cannot cancel Sales Order because packages have already been dispatched or delivered. Please initiate an RMA Return instead.',
      400
    );
  }

  const reason = String(input?.reason || 'Order cancelled by user').trim();
  const cancelledByClient = isClientUser(req);

  existing.status = 'Cancelled';
  existing.cancellationReason = reason;
  existing.notes = existing.notes
    ? `${existing.notes} | Cancellation Reason: ${reason}${cancelledByClient ? ' (by client)' : ''}`
    : `Cancellation Reason: ${reason}${cancelledByClient ? ' (by client)' : ''}`;
  existing.updatedBy = userId;

  // Release stock reservation if any
  if (existing.stockReserved && !existing.inventoryDeducted) {
    existing.stockReserved = false;
    existing.stockAudit.push({
      action: 'stock_reservation_released',
      performedAt: new Date(),
      performedBy: userId,
      details: `Stock reservation released upon order cancellation: ${reason}`
    });
  }

  await existing.save();

  const result = existing.toObject();
  await AuditService.log(req, {
    action: 'order_cancelled',
    module: 'sales_order',
    recordId: id,
    description: `Sales Order ${existing.orderNumber} cancelled: ${reason}`,
    metadata: { reason }
  });

  return enrichWithCustomerLabel(req, result);
}

/**
 * Reserves stock in inventory for approved sales orders.
 * 
 * Usecase: Warehouse inventory allocation before dispatch.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function reserveStock(req, id) {
  const SalesOrder = getSalesOrderModel(req);
  const userId = resolveUserId(req);

  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Sales Order not found', 404);

  existing.stockReserved = true;
  existing.stockReservedAt = new Date();
  existing.stockAudit.push({
    action: 'stock_reserved',
    performedAt: new Date(),
    performedBy: userId,
    details: `Stock reserved for ${existing.lineItems.length} order line items.`
  });

  existing.updatedBy = userId;
  await existing.save();

  return enrichWithCustomerLabel(req, existing.toObject());
}

/**
 * Dispatches a Sales Order with courier assignment and AWB tracking (Legacy Single Dispatch).
 * 
 * Usecase: Single-dispatch shortcut that adds a primary shipment.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {Object} input Dispatch details ({ courierName, trackingNumber })
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function dispatch(req, id, input) {
  return addShipment(req, id, input);
}

/**
 * Confirms delivery fulfillment and attaches Proof of Delivery (Legacy Single Delivery).
 * 
 * Usecase: Single delivery shortcut that updates the active shipment to Delivered.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sales Order ID
 * @param {Object} input Delivery details ({ proofOfDelivery })
 * @returns {Promise<Object>} Updated Sales Order document
 */
async function confirmDelivery(req, id, input) {
  const SalesOrder = getSalesOrderModel(req);
  const existing = await SalesOrder.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sales Order not found', 404);

  if (Array.isArray(existing.shipments) && existing.shipments.length) {
    const lastShipment = existing.shipments[existing.shipments.length - 1];
    const targetShipmentId = lastShipment._id ? String(lastShipment._id) : lastShipment.shipmentNumber;
    return updateShipmentStatus(req, id, targetShipmentId, {
      deliveryStatus: 'Delivered',
      proofOfDelivery: input.proofOfDelivery || 'Confirmed Delivery'
    });
  }

  // Fallback single shipment delivery
  const userId = resolveUserId(req);
  const proofOfDelivery = String(input.proofOfDelivery || 'Confirmed Delivery').trim();

  const updated = await SalesOrder.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        deliveryStatus: 'Delivered',
        status: 'Completed',
        deliveredAt: new Date(),
        proofOfDelivery,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (updated && (updated.deliveryStatus === 'Delivered' || updated.status === 'Completed')) {
    try {
      const ProformaService = require('./proforma.service');
      await ProformaService.maybeAutoConvertProformaForSalesOrder(req, updated);
    } catch (convErr) {
      console.warn('[plugin:openext-crm-suite] proforma auto-convert failed on delivery confirmation:', convErr?.message || convErr);
    }
  }

  await AuditService.log(req, {
    action: 'delivered',
    module: 'sales_order',
    recordId: id,
    description: `Sales Order ${existing.orderNumber} confirmed delivered (POD attached)`
  });

  return updated;
}

async function exportSalesOrders(req, query = {}) {
  const SalesOrder = getSalesOrderModel(req);
  let filter = baseFilter(req);

  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    filter.clientId = userClientId || '__UNLINKED_CLIENT_NO_MATCH__';
  }

  if (query.status) {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  if (query.deliveryStatus) {
    const d = toLiteralSearchTerm(String(query.deliveryStatus).trim());
    if (d) filter.deliveryStatus = new RegExp(`^${d}$`, 'i');
  }
  if (!isClientUser(req) && query.clientId) filter.clientId = String(query.clientId).trim();
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { orderNumber: { $regex: term, $options: 'i' } },
        { customerName: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } }
      ];
    }
  }

  filter = require('../utils/sales-access.util').applySalesAgentSalesOrderScope(req, filter);

  const raw = await SalesOrder.find(filter).sort({ orderDate: -1, createdAt: -1 }).lean();
  const enriched = await Promise.all(raw.map((doc) => enrichWithCustomerLabel(req, doc)));

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'sales_order',
    recordId: 'export',
    description: `Exported ${enriched.length} sales orders in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `sales_orders_export_${nowStr}.json`,
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
    'Order Number',
    'Client / Customer Name',
    'Status',
    'Fulfillment / Delivery Status',
    'Order Date',
    'Expected Delivery Date',
    'Subtotal',
    'Tax Total',
    'Total Amount',
    'Payment Terms',
    'Reference Quotation',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const o of enriched) {
    rows.push(
      [
        o._id,
        o.orderNumber || '',
        o.customerName || o.clientName || '',
        o.status || '',
        o.deliveryStatus || '',
        o.orderDate ? new Date(o.orderDate).toISOString().slice(0, 10) : '',
        o.expectedDeliveryDate ? new Date(o.expectedDeliveryDate).toISOString().slice(0, 10) : '',
        Number(o.subtotal || 0),
        Number(o.taxTotal || 0),
        Number(o.totalAmount || o.grandTotal || 0),
        o.paymentTerms || '',
        o.quotationNumber || o.quotationNo || '',
        o.createdAt ? new Date(o.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `sales_orders_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  list,
  getById,
  create,
  createFromQuotation,
  createFromOpportunity,
  createInvoiceFromSalesOrder,
  generateInvoice: createInvoiceFromSalesOrder,
  updateStatus,
  addShipment,
  updateShipmentStatus,
  createReturn,
  updateReturnStatus,
  cancel,
  reserveStock,
  dispatch,
  confirmDelivery,
  remove,
  exportSalesOrders
};

