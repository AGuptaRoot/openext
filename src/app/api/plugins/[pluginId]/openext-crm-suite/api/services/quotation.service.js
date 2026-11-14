'use strict';

const { withCustomerSnapshot } = require('../utils/customer-snapshot.util');
const { resolveTenantId, resolveUserId, applyClientScope, applyClientScopeAsync } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { getNextNumber } = require('../utils/numbering.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const FinanceDocumentUtil = require('../utils/finance-document.util');
const PrintHtmlService = require('./print-html.service');
const MailService = require('./mail.service');
const { enrichWithCustomerLabel } = require('../utils/customer-label.util');
const { buildQuotationPortalUrl } = require('../utils/public-origin.util');

function getEstimateModel(req) {
  const Estimate = req.cms?.models.get('Estimate');
  if (!Estimate) throw new Error('Estimate model is not registered');
  return Estimate;
}

function getInvoiceModel(req) {
  const Invoice = req.cms?.models.get('Invoice');
  if (!Invoice) throw new Error('Invoice model is not registered');
  return Invoice;
}

function getCompanyModel(req) {
  return req.cms?.models.get('Company');
}

function getLeadModel(req) {
  return req.cms?.models.get('Lead');
}

function appError(message, status = 400, extras = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extras);
  return error;
}

const refId = (ref) => String((ref && typeof ref === 'object' ? ref._id : ref) || '').trim();

/**
 * Issue Date / Valid Till of a quotation against the general rule (Valid Till not before Issue Date) and
 * the active extension's limits (salesFlow.quotationDatesRoute, e.g. not valid after the trip starts).
 * Days are compared as "YYYY-MM-DD" (date-only, no time-zone shift). 400 INVALID_QUOTATION_DATES.
 */
async function assertCommercialDates(req, { leadId, opportunityId, recordId, clientId, issueDate, validTill, checkIssueMin, rules }) {
  const SalesFlow = require('./sales-flow.service');
  const { dayOf } = require('../utils/date-only.util');
  const limits = rules || (await SalesFlow.quotationDateRules(req, { leadId: refId(leadId), opportunityId: refId(opportunityId), recordId, clientId: refId(clientId) }));
  SalesFlow.assertQuotationDates({ issueDate: dayOf(issueDate), validTill: dayOf(validTill), rules: limits, checkIssueMin: Boolean(checkIssueMin) });
  return limits;
}

function baseFilter(req) {
  const filter = { tenantId: resolveTenantId(req), isDeleted: false };
  return applyClientScope(req, filter, 'clientId');
}

/**
 * Tenant only, without the client-portal clientId clause. Only for code that checks portal ownership
 * itself (list: portal scope clause; one record: findQuotationOrThrow → portalOwnsRecord), so a
 * quotation still on the client's lead — or a prospect's — is found. Everything else uses baseFilter.
 */
function tenantFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

/** Compute line totals — tax is percent per line with discount and taxCalculation mode */
function buildLineItems(rawItems, defaultTaxPercent = 0, discountPercent = 0, discountAmount = 0, taxCalculation = 'after_discount') {
  if (typeof defaultTaxPercent === 'object' && defaultTaxPercent !== null) {
    const opts = defaultTaxPercent;
    defaultTaxPercent = opts.defaultTaxPercent || 0;
    discountPercent = opts.discountPercent !== undefined ? opts.discountPercent : 0;
    discountAmount = opts.discountAmount !== undefined ? opts.discountAmount : 0;
    taxCalculation = opts.taxCalculation || 'after_discount';
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw appError('At least one line item is required');
  }

  let subtotal = 0;
  let taxTotal = 0;

  const validDiscountPercent = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const validDiscountAmount = Math.max(0, Number(discountAmount) || 0);

  const processedItems = rawItems.map((item, index) => {
    const name = String(item.name || item.itemName || '').trim();
    const description = String(item.description || name || '').trim();
    if (!description && !name) {
      throw appError(`Line item ${index + 1}: description or item name is required`);
    }

    const qty = Number(item.qty !== undefined ? item.qty : item.quantity);
    if (isNaN(qty) || qty <= 0) {
      throw appError(`Line item ${index + 1}: qty must be greater than 0`);
    }

    const rate = Number(item.rate !== undefined ? item.rate : item.unitPrice);
    if (isNaN(rate) || rate < 0) {
      throw appError(`Line item ${index + 1}: rate must be 0 or greater`);
    }

    const tax = item.tax !== undefined && item.tax !== null ? Number(item.tax) : defaultTaxPercent;
    if (isNaN(tax) || tax < 0 || tax > 100) {
      throw appError(`Line item ${index + 1}: tax percent must be between 0 and 100`);
    }

    const lineSubtotal = qty * rate;
    subtotal += lineSubtotal;

    return {
      name: name || description,
      description: description || name,
      qty,
      rate,
      tax,
      lineSubtotal,
      file: item.file ? String(item.file).trim() : '',
      productId: item.productId ? String(item.productId).trim() : null,
      unit: item.unit ? String(item.unit).trim().slice(0, 60) : '',
      extra: item.extra && typeof item.extra === 'object' && !Array.isArray(item.extra) ? item.extra : {},
      sourceRef: item.sourceRef && /^[A-Za-z0-9:_-]{1,64}$/.test(String(item.sourceRef)) ? String(item.sourceRef) : '',
      // Declared line group (checked against the active extension by sales-flow cleanLineExtras).
      group: item.group && /^[a-z][a-z0-9_]{0,39}$/.test(String(item.group)) ? String(item.group) : ''
    };
  });

  // Calculate discount
  let calculatedDiscount = 0;
  if (validDiscountPercent > 0) {
    calculatedDiscount = subtotal * (validDiscountPercent / 100);
  } else if (validDiscountAmount > 0) {
    calculatedDiscount = Math.min(subtotal, validDiscountAmount);
  }

  // Calculate tax on items based on taxCalculation mode
  const discountRatio = subtotal > 0 && taxCalculation === 'after_discount'
    ? Math.max(0, (subtotal - calculatedDiscount) / subtotal)
    : 1;

  const lineItems = processedItems.map((item) => {
    const taxableBase = item.lineSubtotal * discountRatio;
    const lineTax = taxableBase * (item.tax / 100);
    const amount = item.lineSubtotal + (taxCalculation === 'before_discount' ? item.lineSubtotal * (item.tax / 100) : lineTax);
    taxTotal += lineTax;

    return {
      name: item.name,
      description: item.description,
      qty: item.qty,
      rate: item.rate,
      tax: item.tax,
      amount: Math.round(amount * 100) / 100,
      file: item.file,
      productId: item.productId,
      unit: item.unit,
      extra: item.extra,
      sourceRef: item.sourceRef,
      group: item.group
    };
  });

  subtotal = Math.round(subtotal * 100) / 100;
  taxTotal = Math.round(taxTotal * 100) / 100;
  calculatedDiscount = Math.round(calculatedDiscount * 100) / 100;
  const grandTotal = Math.max(0, Math.round((subtotal - calculatedDiscount + taxTotal) * 100) / 100);

  return {
    lineItems,
    subtotal,
    discountPercent: validDiscountPercent,
    discountAmount: calculatedDiscount,
    taxTotal,
    grandTotal
  };
}

/**
 * A quotation is never allowed to total zero.
 *
 * Applies to every route in and out of this service — the quotation create
 * page, lead -> quotation, opportunity -> quotation and revisions — because a
 * \u20b90 proposal cannot be sent, accepted or invoiced for any real amount.
 */
function assertNonZeroTotal(grandTotal) {
  if (!(Number(grandTotal) > 0)) {
    throw appError(
      'A quotation cannot be created with a total of \u20b90. Add at least one line item with a price greater than zero.',
      400
    );
  }
}

function withEffectiveStatus(doc) {
  if (!doc) return doc;
  const now = new Date();

  if (doc.status === 'Draft' || doc.status === 'Sent') {
    if (doc.expiryDate && new Date(doc.expiryDate) < now) {
      return { ...doc, status: 'Expired' };
    }
  }

  return doc;
}

async function validateClient(req, clientId) {
  const Company = getCompanyModel(req);
  if (!Company) return null;
  const client = await Company.findOne({
    ...baseFilter(req),
    mergedIntoId: null,
    _id: clientId
  }).lean();
  if (!client) throw appError('Client not found', 404);
  return client;
}

async function findQuotationOrThrow(req, id) {
  const doc = await getEstimateModel(req).findOne({ ...tenantFilter(req), _id: id }).lean();
  if (!doc) throw appError('Quotation not found', 404);
  const { isClientUser } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const {
      resolvePortalIdentity,
      portalOwnsRecord
    } = require('../utils/portal-identity.util');
    const identity = await resolvePortalIdentity(req);
    if (identity.kind === 'none') throw appError('Quotation not found', 404);
    // The client's own quotations, those still on their leads (converted or their own enquiry), and
    // for a prospect the ones on their portal-enabled lead. Drafts are never shown on the portal.
    if (doc.status !== 'Draft' && portalOwnsRecord(identity, doc)) return doc;
    throw appError('Quotation not found', 404);
  } else {
    const { assertSalesAgentCreatorAccess } = require('../utils/sales-access.util');
    assertSalesAgentCreatorAccess(req, doc, 'Quotation');
  }
  return doc;
}

async function enrichQuotationsWithDeals(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const Opportunity = req.cms?.models.get('Opportunity');
  if (!Opportunity) return items;

  const dealIds = [...new Set(items.map((i) => i.opportunityId || i.dealId).filter(Boolean))];
  if (!dealIds.length) return items;

  try {
    const opps = await Opportunity.find({
      tenantId: resolveTenantId(req),
      _id: { $in: dealIds },
      isDeleted: false
    })
      .select('title opportunityNumber stage')
      .lean();

    const dealMap = Object.fromEntries(opps.map((o) => [String(o._id), o]));
    return items.map((item) => {
      const dId = String(item.opportunityId || item.dealId || '');
      const deal = dId ? dealMap[dId] : null;
      return {
        ...item,
        dealTitle: deal?.title || null,
        dealNumber: deal?.opportunityNumber || null,
        dealStage: deal?.stage || null
      };
    });
  } catch {
    return items;
  }
}

async function list(req) {
  const Estimate = getEstimateModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query);
  const filter = tenantFilter(req);
  /** Client-portal scope, merged in last so no later clause (search) can drop it. */
  let portalClause = null;

  if (req.query?.status) filter.status = String(req.query.status).trim();

  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
    portalScopeClause,
    PORTAL_UNLINKED_MESSAGE
  } = require('../utils/portal-identity.util');
  if (isClientUser(req)) {
    const identity = await resolvePortalIdentity(req);
    if (identity.kind === 'none') {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: PORTAL_UNLINKED_MESSAGE
      };
    }
    // A prospect: the quotations on their own lead. A client: their own plus those still on their
    // leads (converted, or their new enquiry by email) — the same rule as their opportunities.
    // Drafts are the team's work in progress and are never shown on the portal.
    portalClause = { $and: [portalScopeClause(identity), { status: { $ne: 'Draft' } }] };
  } else {
    const queryClientId = req.query?.clientId || req.query?.client || req.query?.companyId;
    if (queryClientId) filter.clientId = String(queryClientId).trim();
  }

  if (req.query?.leadId) filter.leadId = String(req.query.leadId).trim();
  if (req.query?.opportunityId || req.query?.dealId) {
    const oppId = String(req.query.opportunityId || req.query.dealId).trim();
    const dealClause = { $or: [{ opportunityId: oppId }, { dealId: oppId }] };
    if (filter.$or) {
      filter.$and = [...(filter.$and || []), { $or: filter.$or }, dealClause];
      delete filter.$or;
    } else {
      filter.$or = dealClause.$or;
    }
  }

  // Handle archive filter
  if (req.query?.archived === 'true') {
    filter.isArchived = true;
  } else if (req.query?.archived !== 'all') {
    filter.isArchived = { $ne: true };
  }

  // Default to showing only latest versions unless explicitly asked for all revisions
  if (req.query?.allVersions !== 'true' && !req.query?.revisionOf) {
    filter.isLatestVersion = { $ne: false };
  }

  if (req.query?.revisionOf) {
    filter.revisionOf = String(req.query.revisionOf).trim();
  }

  if (req.query?.search) {
    const { findMatchingClientIds, findMatchingLeadIds } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const or = [
        { quotationNo: { $regex: term, $options: 'i' } },
        { number: { $regex: term, $options: 'i' } },
        { title: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } },
        { recipientNotes: { $regex: term, $options: 'i' } },
        { recipientName: { $regex: term, $options: 'i' } },
        { clientId: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { 'customerSnapshot.name': { $regex: term, $options: 'i' } },
        { leadId: { $regex: term, $options: 'i' } }
      ];
      const [clientIds, leadIds] = await Promise.all([
        findMatchingClientIds(req, req.query.search),
        findMatchingLeadIds(req, req.query.search)
      ]);
      if (clientIds.length) or.push({ clientId: { $in: clientIds } });
      if (leadIds.length) or.push({ leadId: { $in: leadIds } });
      filter.$or = or;
    }
  }

  const { applySalesAgentCreatorScope, mergeScopeIntoFilter } = require('../utils/sales-access.util');
  const finalFilter = applySalesAgentCreatorScope(req, portalClause ? mergeScopeIntoFilter(filter, portalClause) : filter);

  const [items, total] = await Promise.all([
    Estimate.find(finalFilter).sort(sort).skip(skip).limit(limit).lean(),
    Estimate.countDocuments(finalFilter)
  ]);

  const withStatus = items.map(withEffectiveStatus);
  const withCustomer = await enrichWithCustomerLabel(req, withStatus);
  const enriched = await enrichQuotationsWithDeals(req, withCustomer);

  return {
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function getById(req, id) {
  const doc = await findQuotationOrThrow(req, id);
  const withCustomer = await enrichWithCustomerLabel(req, withEffectiveStatus(doc));
  const [enriched] = await enrichQuotationsWithDeals(req, [withCustomer]);
  return enriched;
}

async function create(req, input) {
  const Estimate = getEstimateModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const settings = await SettingService.getAll(req);

  let clientId = input.clientId ? String(input.clientId).trim() : '';
  let leadId = input.leadId ? String(input.leadId).trim() : '';
  const opportunityId = input.opportunityId || input.dealId ? String(input.opportunityId || input.dealId).trim() : '';

  if (!clientId && !leadId && opportunityId) {
    try {
      const Opportunity = req.cms?.models.get('Opportunity');
      if (Opportunity) {
        let opp = null;
        if (typeof Opportunity.findOne === 'function') {
          opp = await Opportunity.findOne({ tenantId, _id: opportunityId, isDeleted: false }).lean();
        } else if (typeof Opportunity.findById === 'function') {
          opp = await Opportunity.findById(opportunityId).lean?.() || await Opportunity.findById(opportunityId);
        }
        if (opp?.leadId) leadId = String(opp.leadId).trim();
        if (opp?.clientId) clientId = String(opp.clientId).trim();
      }
    } catch {
      /* ignore opportunity lookup error */
    }
  }

  // 3.45.0: a client quotation for the client's enquiry (both named, no opportunity). The lead must be an
  // enquiry opened for that client; the extension may then skip the opportunity (clientQuotation.withoutOpportunity).
  let clientEnquiry = false;
  if (input.clientId && input.leadId && !opportunityId) {
    const Lead = req.cms?.models?.get?.('Lead');
    const q = Lead ? Lead.findOne({ tenantId, _id: leadId, isDeleted: { $ne: true } }) : null;
    const lead = q && typeof q.lean === 'function' ? await q.lean() : await q;
    const forClient = lead ? String(lead.forClientId || lead.convertedClientId || '') : '';
    if (!lead || forClient !== clientId) {
      throw appError('This enquiry does not belong to the selected client.', 400, { code: 'LEAD_CLIENT_MISMATCH' });
    }
    clientEnquiry = true;
  }
  // 3.51.0: a client quotation for the extension's own record (its client step returned { recordId }):
  // the client only — no lead and no opportunity.
  const extensionRecordId = /^[A-Za-z0-9_-]{1,64}$/.test(String(input.extensionRecordId || '').trim()) ? String(input.extensionRecordId).trim() : '';
  if (extensionRecordId && (!clientId || leadId || opportunityId)) {
    throw appError('A quotation for the extension record belongs to a client only (no lead or opportunity).', 400, { code: 'RECORD_CLIENT_ONLY' });
  }
  const clientRecord = Boolean(extensionRecordId);
  const SalesFlowRules = require('./sales-flow.service');
  const enquiryWithoutOpportunity = (clientEnquiry || clientRecord) && (await SalesFlowRules.clientQuotationWithoutOpportunity(req));

  // Settings → Lead workflow: every new quotation belongs to an opportunity (revisions are not created here).
  if (!opportunityId && !enquiryWithoutOpportunity && (await require('./lead-workflow.service').quotationNeedsOpportunity(req))) {
    throw appError('Create an opportunity first: new quotations must belong to an opportunity.', 400, { code: 'OPPORTUNITY_REQUIRED' });
  }

  if (!clientId && !leadId) throw appError('clientId or leadId is required');

  if (clientId) await validateClient(req, clientId);
  // CRM 3.44.0: a quotation for a client (not through a lead) asks the extension's client rule
  // (salesFlow.clientQuotation, e.g. Travel: the client's Travel Requirement must be complete).
  if (input.clientId && (!input.leadId || clientEnquiry)) await SalesFlowRules.assertClientQuotationEligible(req, clientId);
  if (leadId) {
    const LeadService = require('./lead.service');
    await LeadService.getById(req, leadId, { includeQuality: false });
    // Lead workflow rule: a quotation straight from a lead needs a Qualified or ready lead
    // (a quotation from an opportunity already passed it when the opportunity was created).
    if (!opportunityId && !clientEnquiry) await require('./lead-workflow.service').assertOpportunityAllowed(req, leadId, 'quotation');
    await assertLeadNotConverted(req, leadId);
  }

  if (opportunityId) {
    const OpportunityService = require('./opportunity.service');
    const opp = await OpportunityService.assertCanCreateQuotation(req, opportunityId);
    // The quotation's lead / client must be the opportunity's.
    const oppLead = opp && opp.leadId ? String(opp.leadId._id || opp.leadId) : '';
    const oppClient = opp && opp.clientId ? String(opp.clientId._id || opp.clientId) : '';
    if ((leadId && oppLead && leadId !== oppLead) || (clientId && oppClient && clientId !== oppClient)) {
      throw appError('This opportunity belongs to a different lead or client.', 400, { code: 'OPPORTUNITY_MISMATCH' });
    }
  }

  const taxCalculation = input.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount';
  const SalesFlow = require('./sales-flow.service');
  // Services carry no shipping (salesFlow.hideShipping).
  if ((await SalesFlow.recordRules(req)).hideShipping) input = { ...input, shippingCharge: 0 };
  const totals = buildLineItems(
    // Extension line columns: only the ones the active extension declares, with allowed values.
    // Fixed lines: rebuilt from the extension's records (only rate and tax from the user).
    await SalesFlow.cleanLineExtras(
      req,
      await SalesFlow.enforceFixedQuotationLines(req, input.lineItems, { leadId: input.leadId, opportunityId: input.opportunityId || input.dealId, recordId: extensionRecordId, clientId })
    ),
    Number(settings.tax_rate || 0),
    input.discountPercent,
    input.discountAmount,
    taxCalculation
  );

  // Commercial dates are date-only days. Without an issue date: today (the extension's today when it
  // gives one); without a valid till: the default validity, never past the extension's limit
  // (e.g. a travel quotation: the trip's start date).
  const DateOnly = require('../utils/date-only.util');
  const dateRules = await SalesFlow.quotationDateRules(req, { leadId, opportunityId, recordId: extensionRecordId, clientId });
  const issueDay = input.issueDate ? DateOnly.dayOf(input.issueDate) : dateRules.issueDateMin || DateOnly.localDay();
  const issueDate = input.issueDate ? new Date(input.issueDate) : DateOnly.dayToDate(issueDay);
  const validDays = Number(settings.quotation_valid_days || 30);
  let expiryDate = input.expiryDate ? new Date(input.expiryDate) : null;
  if (!expiryDate || isNaN(expiryDate.getTime())) {
    let day = DateOnly.addDays(issueDay, validDays);
    if (dateRules.validTillMax && day > dateRules.validTillMax && dateRules.validTillMax >= issueDay) day = dateRules.validTillMax;
    expiryDate = DateOnly.dayToDate(day);
  }
  await assertCommercialDates(req, { issueDate: issueDay, validTill: expiryDate, checkIssueMin: true, rules: dateRules });

  const quotationNo = await getNextNumber(req, 'quotation');

  const ShippingService = require('./shipping.service');
  const shippingState = input.shippingState ? String(input.shippingState).trim() : (settings.company_state || 'Maharashtra');
  const autoShipping = ShippingService.calculateShippingCharge({ state: shippingState, totalWeightKg: 1, subtotal: totals.subtotal });
  const shippingCharge = input.shippingCharge !== undefined ? Number(input.shippingCharge) : autoShipping.shippingCharge;
  const grandTotal = Math.max(0, Math.round((totals.grandTotal + shippingCharge) * 100) / 100);

  assertNonZeroTotal(grandTotal);

  let paymentType = 'full';
  let advanceMode = 'percent';
  let advanceValue = 0;
  if (
    input.paymentType !== undefined ||
    input.advanceMode !== undefined ||
    input.advanceValue !== undefined
  ) {
    const ProformaService = require('./proforma.service');
    if (await ProformaService.isProformaEnabled(req)) {
      if (input.paymentType) paymentType = input.paymentType;
      if (input.advanceMode) advanceMode = input.advanceMode;
      if (input.advanceValue !== undefined) {
        advanceValue = Math.max(0, Number(input.advanceValue) || 0);
      }
    }
  }

  const doc = await Estimate.create(await withCustomerSnapshot(req, {
    tenantId,
    clientId,
    leadId,
    opportunityId,
    dealId: opportunityId,
    extensionRecordId,
    quotationNo,
    title: input.title ? String(input.title).trim() : '',
    description: input.description ? String(input.description).trim() : '',
    issueDate,
    expiryDate,
    status: 'Draft',
    currency: input.currency ? String(input.currency).trim().toUpperCase() : (settings.default_currency || 'INR'),
    taxCalculation,
    paymentType,
    advanceMode,
    advanceValue,
    lineItems: totals.lineItems,
    subtotal: totals.subtotal,
    discountPercent: totals.discountPercent,
    discountAmount: totals.discountAmount,
    taxTotal: totals.taxTotal,
    shippingCharge,
    shippingState,
    grandTotal,
    notes: input.notes ? String(input.notes).trim() : '',
    recipientNotes: input.recipientNotes ? String(input.recipientNotes).trim() : '',
    sections: Array.isArray(input.sections) ? input.sections : [],
    createdBy: userId,
    updatedBy: userId
  }));

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'quotation',
    recordId: result._id.toString(),
    description: `Quotation created: ${quotationNo}`,
    metadata: {
      clientId: result.clientId || '',
      leadId: result.leadId || '',
      opportunityId: result.opportunityId || '',
      grandTotal: result.grandTotal
    }
  });

  if (opportunityId && !input._skipOpportunitySync) {
    try {
      const OpportunityService = require('./opportunity.service');
      await OpportunityService.syncOpportunityQuotationNegotiation(req, result, 'quotation_created');
    } catch (err) {
      console.warn(
        '[plugin:openext-crm-suite] opportunity Negotiation sync on quotation create failed:',
        err?.message || err
      );
    }
  }

  return result;
}

async function update(req, id, input) {
  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);
  const existing = await findQuotationOrThrow(req, id);

  if (existing.status !== 'Draft') {
    throw appError(`Only quotations in Draft status can be edited. Current status is "${existing.status}". Please create a revision instead.`, 409);
  }

  const settings = await SettingService.getAll(req);
  const updates = { updatedBy: userId };

  if (input.clientId !== undefined) {
    if (input.clientId) await validateClient(req, input.clientId);
    updates.clientId = String(input.clientId || '');
  }
  if (input.leadId !== undefined) {
    updates.leadId = String(input.leadId || '');
  }
  if (input.opportunityId !== undefined || input.dealId !== undefined) {
    updates.opportunityId = String(input.opportunityId || input.dealId || '');
    updates.dealId = updates.opportunityId;
  }
  if (input.title !== undefined) updates.title = String(input.title).trim();
  if (input.description !== undefined) updates.description = String(input.description).trim();
  if (input.currency !== undefined) updates.currency = String(input.currency).trim().toUpperCase();
  if (input.taxCalculation !== undefined) {
    updates.taxCalculation = input.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount';
  }
  /*
   * Payment terms are only honoured while proforma & advance payment is on, so
   * a value left over from when the feature was enabled cannot quietly start
   * asking clients for advances again.
   */
  if (
    input.paymentType !== undefined ||
    input.advanceMode !== undefined ||
    input.advanceValue !== undefined
  ) {
    const ProformaService = require('./proforma.service');
    if (await ProformaService.isProformaEnabled(req)) {
      if (input.paymentType !== undefined) updates.paymentType = input.paymentType;
      if (input.advanceMode !== undefined) updates.advanceMode = input.advanceMode;
      if (input.advanceValue !== undefined) {
        updates.advanceValue = Math.max(0, Number(input.advanceValue) || 0);
      }
    }
  }
  if (input.notes !== undefined) updates.notes = String(input.notes).trim();
  if (input.recipientNotes !== undefined) updates.recipientNotes = String(input.recipientNotes).trim();
  if (input.sections !== undefined) updates.sections = Array.isArray(input.sections) ? input.sections : [];
  if (input.issueDate !== undefined) updates.issueDate = new Date(input.issueDate);
  if (input.expiryDate !== undefined) updates.expiryDate = new Date(input.expiryDate);
  if (input.shippingState !== undefined) updates.shippingState = String(input.shippingState).trim();
  if (input.shippingCharge !== undefined) updates.shippingCharge = Math.max(0, Number(input.shippingCharge) || 0);
  if (updates.shippingCharge && (await require('./sales-flow.service').recordRules(req)).hideShipping) updates.shippingCharge = 0;

  const rawItems = input.lineItems !== undefined
    ? await require('./sales-flow.service').cleanLineExtras(
        req,
        await require('./sales-flow.service').enforceFixedQuotationLines(req, input.lineItems, {
          leadId: existing.leadId,
          opportunityId: existing.opportunityId || existing.dealId,
          recordId: existing.extensionRecordId,
          clientId: existing.clientId
        })
      )
    : existing.lineItems;
  const taxCalculation = updates.taxCalculation || existing.taxCalculation || 'after_discount';
  const discPercent = input.discountPercent !== undefined ? input.discountPercent : existing.discountPercent;
  const discAmount = input.discountAmount !== undefined ? input.discountAmount : existing.discountAmount;

  if (input.lineItems !== undefined || input.discountPercent !== undefined || input.discountAmount !== undefined || input.taxCalculation !== undefined || input.shippingCharge !== undefined) {
    const totals = buildLineItems(rawItems, Number(settings.tax_rate || 0), discPercent, discAmount, taxCalculation);
    updates.lineItems = totals.lineItems;
    updates.subtotal = totals.subtotal;
    updates.discountPercent = totals.discountPercent;
    updates.discountAmount = totals.discountAmount;
    updates.taxTotal = totals.taxTotal;

    const shipCharge = updates.shippingCharge !== undefined ? updates.shippingCharge : (existing.shippingCharge || 0);
    updates.grandTotal = Math.max(0, Math.round((totals.grandTotal + shipCharge) * 100) / 100);
  }

  if (updates.issueDate && !input.expiryDate && !existing.expiryDate) {
    const issueDate = updates.issueDate;
    const validDays = Number(settings.quotation_valid_days || 30);
    const expiryDate = new Date(issueDate);
    expiryDate.setDate(expiryDate.getDate() + validDays);
    updates.expiryDate = expiryDate;
  }

  // Commercial dates (3.32.0): the same rules as a new quotation; an issue date in the past is only refused
  // when it is changed.
  {
    const { dayOf } = require('../utils/date-only.util');
    const issueDay = dayOf(updates.issueDate !== undefined ? updates.issueDate : existing.issueDate);
    await assertCommercialDates(req, {
      leadId: updates.leadId !== undefined ? updates.leadId : existing.leadId,
      opportunityId: updates.opportunityId !== undefined ? updates.opportunityId : existing.opportunityId || existing.dealId,
      recordId: existing.extensionRecordId,
      clientId: existing.clientId,
      issueDate: issueDay,
      validTill: updates.expiryDate !== undefined ? updates.expiryDate : existing.expiryDate,
      checkIssueMin: input.issueDate !== undefined && issueDay !== dayOf(existing.issueDate)
    });
  }

  const doc = await Estimate.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'quotation',
    recordId: id,
    description: `Quotation updated: ${doc.quotationNo}`
  });

  if (doc && (doc.status === 'Sent' || updates.status === 'Sent')) {
    try {
      await syncLeadQuotationSent(req, doc);
    } catch {
      /* non-blocking */
    }
    try {
      const OpportunityService = require('./opportunity.service');
      await OpportunityService.syncOpportunityQuotationSent(req, doc);
    } catch {
      /* non-blocking */
    }
  }

  return doc;
}

async function remove(req, id) {
  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);
  const existing = await findQuotationOrThrow(req, id);

  if (existing.status !== 'Draft') {
    throw appError('Only draft quotations can be deleted', 409);
  }

  await Estimate.findOneAndUpdate(
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
    module: 'quotation',
    recordId: id,
    description: `Quotation deleted: ${existing.quotationNo}`
  });

  return { deleted: true, id };
}

/**
 * Proforma & advance payment on (Settings → General): payment replaces the Accept button.
 * The first verified payment accepts the quotation; a quotation with nothing to pay can still be accepted.
 */
async function assertPaymentNotRequired(req, doc) {
  const ProformaService = require('./proforma.service');
  if (!(await ProformaService.isProformaEnabled(req))) return;
  if (!(Number(doc?.grandTotal) > 0)) return;
  const error = appError('Pay the quotation to accept it: the payment confirms your acceptance.', 409);
  error.code = 'PAYMENT_REQUIRED';
  throw error;
}

/**
 * salesFlow.lockConvertedLead: a lead converted into a client is history for sales — new quotations
 * start from the client (a new enquiry) instead. 409 LEAD_CONVERTED.
 */
async function assertLeadNotConverted(req, leadId) {
  if (!leadId) return;
  const rules = await require('./sales-flow.service').recordRules(req);
  if (!rules.lockConvertedLead) return;
  const Lead = req.cms?.models?.get?.('Lead');
  if (!Lead) return;
  const found = Lead.findOne({ tenantId: resolveTenantId(req), _id: String(leadId), isDeleted: { $ne: true } });
  const lead = found && typeof found.lean === 'function' ? await found.lean() : await found;
  if (lead && lead.convertedClientId) {
    throw appError('This lead is already a client — start a new quotation from the client instead.', 409, { code: 'LEAD_CONVERTED' });
  }
  // salesFlow.lockWonLead: a Won lead (not converted yet) is locked as well.
  await require('../utils/lead-lock.util').assertEditable(req, leadId);
}

async function assertNotExpired(doc) {
  const effective = withEffectiveStatus(doc);
  if (effective.status === 'Expired') {
    throw appError('Quotation has expired', 409);
  }
}

async function send(req, id) {
  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);
  const existing = await findQuotationOrThrow(req, id);

  if (['Cancelled', 'Accepted', 'Rejected', 'Closed', 'Converted'].includes(existing.status)) {
    throw appError(`Quotations in status "${existing.status}" cannot be sent`, 409);
  }
  // A Draft is checked once more before it goes out (its lead's dates may have moved since it was saved).
  if (existing.status === 'Draft') {
    await assertCommercialDates(req, {
      leadId: existing.leadId,
      opportunityId: existing.opportunityId || existing.dealId,
      recordId: existing.extensionRecordId,
      clientId: existing.clientId,
      issueDate: existing.issueDate,
      validTill: existing.expiryDate
    });
  }

  const portalLink = await generatePortalToken(req, id);
  const emailDelivery = await MailService.sendFinanceDocumentEmail(req, 'quotation', existing, {
    portalUrl: portalLink.portalUrl,
    payUrl: portalLink.portalUrl
  });

  const nextStatus = existing.status === 'Draft' ? 'Sent' : existing.status;
  const doc = await Estimate.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { status: nextStatus, portalToken: portalLink.portalToken, sentAt: new Date(), updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'sent',
    module: 'quotation',
    recordId: id,
    description: emailDelivery.sent
      ? `Quotation sent by email: ${doc.quotationNo} → ${emailDelivery.to}`
      : `Quotation marked as sent: ${doc.quotationNo}`,
    metadata: emailDelivery.sent ? { emailTo: emailDelivery.to } : undefined
  });

  try {
    const OpportunityService = require('./opportunity.service');
    await OpportunityService.syncOpportunityQuotationSent(req, doc || existing);
  } catch (err) {
    console.warn(
      '[plugin:openext-crm-suite] opportunity Quotation Sent sync failed:',
      err?.message || err
    );
  }

  try {
    await syncLeadQuotationSent(req, doc || existing);
  } catch (err) {
    console.warn(
      '[plugin:openext-crm-suite] lead Proposal Sent sync failed:',
      err?.message || err
    );
  }

  return { doc, emailDelivery };
}

/**
 * Automatically converts the linked Lead's stage into "Proposal Sent" when a quotation is sent.
 * Resolves lead directly from quotation.leadId or via linked opportunity.
 * Protects already Won or Lost leads from regression.
 */
async function syncLeadQuotationSent(req, quotation, explicitLeadId = null) {
  if (!quotation && !explicitLeadId) return null;
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  let leadId = String(explicitLeadId || quotation?.leadId || '').trim();
  if (!leadId) {
    const oppId = String(quotation?.opportunityId || quotation?.dealId || '').trim();
    if (oppId) {
      try {
        const Opportunity = req.cms?.models.get('Opportunity');
        if (Opportunity) {
          let opp = null;
          if (typeof Opportunity.findOne === 'function') {
            const query = Opportunity.findOne({ tenantId, _id: oppId, isDeleted: false });
            opp = typeof query?.select === 'function' ? await query.select('leadId').lean() : await query;
          } else if (typeof Opportunity.findById === 'function') {
            opp = await Opportunity.findById(oppId).lean?.() || await Opportunity.findById(oppId);
          }
          if (opp?.leadId) {
            leadId = String(opp.leadId).trim();
          }
        }
      } catch {
        /* ignore opp lookup */
      }
    }
  }

  if (!leadId) return null;

  try {
    const Lead = getLeadModel(req);
    if (!Lead) return null;

    let lead = null;
    if (typeof Lead.findOne === 'function') {
      const res = Lead.findOne({ tenantId, _id: leadId, isDeleted: { $ne: true } });
      lead = typeof res?.lean === 'function' ? await res.lean() : await res;
    } else if (typeof Lead.findById === 'function') {
      const res = Lead.findById(leadId);
      lead = typeof res?.lean === 'function' ? await res.lean() : await res;
    }
    if (!lead) return null;

    // Do not regress leads that have already closed (Won or Lost) or already converted to client
    const curStage = String(lead.stage || '').trim().toLowerCase();
    if (curStage === 'won' || curStage === 'lost' || lead.convertedClientId) {
      return lead;
    }

    // Resolve tenant's pipeline stages to match "Proposal Sent" or fallback to default
    const stages = await SettingService.getPipelineStages(req).catch(() => []);
    const validStages = Array.isArray(stages) && stages.length > 0
      ? stages.map((s) => String(s).trim()).filter(Boolean)
      : ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Won', 'Lost'];

    let targetStage = validStages.find((s) => s.toLowerCase() === 'proposal sent' || s.toLowerCase() === 'proposal')
      || validStages.find((s) => /proposal/i.test(s))
      || 'Proposal Sent';

    if (curStage === targetStage.toLowerCase()) {
      return lead;
    }

    const previousStage = lead.stage;
    const now = new Date();

    if (typeof Lead.findOneAndUpdate === 'function') {
      await Lead.findOneAndUpdate(
        { tenantId, _id: leadId },
        {
          $set: {
            stage: targetStage,
            stageUpdatedAt: now,
            updatedBy: userId || 'system'
          }
        }
      );
    } else if (typeof Lead.updateOne === 'function') {
      await Lead.updateOne(
        { tenantId, _id: leadId },
        {
          $set: {
            stage: targetStage,
            stageUpdatedAt: now,
            updatedBy: userId || 'system'
          }
        }
      );
    }

    try {
      await AuditService.log(req, {
        action: 'stage_changed',
        module: 'lead',
        recordId: leadId,
        description: `Lead stage automatically converted to "${targetStage}" upon sending quotation ${quotation?.quotationNo || ''}`.trim(),
        metadata: {
          previousStage,
          newStage: targetStage,
          quotationId: String(quotation?._id || quotation?.id || ''),
          quotationNo: quotation?.quotationNo || ''
        }
      });
    } catch {
      /* audit logging non-blocking */
    }

    return { ...lead, stage: targetStage, stageUpdatedAt: now };
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] lead Proposal Sent sync failed:', err?.message || err);
    return null;
  }
}

/**
 * Whether accepting a quotation may raise a sales order: not while the active workspace extension
 * switches sales orders off (crm-extension.json conversions.salesOrder: false).
 */
async function salesOrdersAllowed(req) {
  try {
    const def = await require('./crm-extension.service').getActive(req);
    return !(def && def.conversions && def.conversions.salesOrder === false);
  } catch {
    return true;
  }
}

/**
 * After any acceptance (client, portal link or a payment): tell the active extension
 * (salesFlow.quotationForm.acceptedRoute) and raise the tax invoice when the quotation is already
 * paid in full. Never throws — the acceptance stands.
 */
async function afterAccepted(req, quotation) {
  if (!quotation) return;
  const id = String(quotation._id || '');
  try {
    await require('./sales-flow.service').quotationAccepted(req, quotation);
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] quotation accepted hook failed:', err?.message || err);
  }
  await require('./proforma.service').maybeAutoInvoicePaidQuotation(req, id);
}

async function accept(req, id, options = {}) {
  const { isClientUser } = require('../utils/tenant.util');
  if (!options?.system && !isClientUser(req)) {
    throw appError('Only clients can accept quotations. Administrators and staff cannot accept on behalf of the client.', 403);
  }

  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);
  const existing = await findQuotationOrThrow(req, id);
  if (!options?.system) await assertPaymentNotRequired(req, existing);
  // A verified payment accepts even when the validity date has since passed: the client paid in time.
  if (!options?.paymentVerified) await assertNotExpired(existing);

  if (options?.system ? !['Sent', 'Draft'].includes(existing.status) : existing.status !== 'Sent') {
    if (options?.system && ['Accepted', 'Converted'].includes(existing.status)) return existing;
    throw appError('Only sent quotations can be accepted', 409);
  }

  const opportunityId = String(existing.opportunityId || existing.dealId || '').trim();
  if (opportunityId) {
    const otherAccepted = await Estimate.findOne({
      ...tenantFilter(req),
      _id: { $ne: id },
      status: { $in: ['Accepted', 'Converted'] },
      $or: [{ opportunityId }, { dealId: opportunityId }]
    })
      .select('_id quotationNo')
      .lean();
    if (otherAccepted) {
      throw appError(
        `Only one quotation can be accepted per opportunity. ${otherAccepted.quotationNo || 'Another quotation'} is already accepted.`,
        409
      );
    }
  }

  const clientId = await resolveQuotationClientId(req, existing, { convertLead: true });

  // Only the call that moves it from its current status accepts it (a repeated payment confirmation
  // or a double click finds it already accepted and runs nothing twice).
  const doc = await Estimate.findOneAndUpdate(
    { ...tenantFilter(req), _id: id, status: existing.status },
    { $set: { status: 'Accepted', clientId, updatedBy: userId } },
    { new: true }
  ).lean();
  if (!doc) {
    const now = await Estimate.findOne({ ...tenantFilter(req), _id: id }).lean();
    if (options?.system && now && ['Accepted', 'Converted'].includes(now.status)) return now;
    throw appError('This quotation was already accepted', 409);
  }

  if (await salesOrdersAllowed(req)) {
    try {
      const SalesOrderService = require('./sales-order.service');
      await SalesOrderService.createFromQuotation(req, id);
    } catch {
      // If sales order creation fails or already converted, continue gracefully
    }
  }

  await AuditService.log(req, {
    action: 'accepted',
    module: 'quotation',
    recordId: id,
    description: `Quotation accepted: ${doc.quotationNo}${existing.leadId ? ' — lead converted to client' : ''}`,
    metadata: { leadId: existing.leadId || '', clientId }
  });

  try {
    const OpportunityService = require('./opportunity.service');
    await OpportunityService.syncOpportunityQuotationAccepted(req, doc || existing);
  } catch (err) {
    console.warn(
      '[plugin:openext-crm-suite] opportunity Won sync on quotation accept failed:',
      err?.message || err
    );
    if (err?.status === 409) throw err;
  }

  await closeOtherOpportunityQuotations(req, doc || existing);
  await afterAccepted(req, doc || existing);

  return doc;
}

/**
 * salesFlow.lockOpportunityOnAccept: once one quotation of an opportunity is accepted, its other open
 * quotations (Draft / Sent) are Closed — kept as history, never sent, accepted or revised again.
 * Each is audited. Never throws: the acceptance stands.
 */
async function closeOtherOpportunityQuotations(req, accepted) {
  try {
    const opportunityId = String(accepted?.opportunityId || accepted?.dealId || '').trim();
    const acceptedId = String(accepted?._id || '').trim();
    if (!opportunityId || !acceptedId) return [];
    const rules = await require('./sales-flow.service').recordRules(req);
    if (!rules.lockOpportunityOnAccept) return [];
    const Estimate = getEstimateModel(req);
    const others = await Estimate.find({
      ...tenantFilter(req),
      _id: { $ne: acceptedId },
      status: { $in: ['Draft', 'Sent'] },
      $or: [{ opportunityId }, { dealId: opportunityId }]
    })
      .select('_id quotationNo status')
      .lean();
    const closed = [];
    for (const other of others || []) {
      const row = await Estimate.findOneAndUpdate(
        { ...tenantFilter(req), _id: other._id, status: other.status },
        {
          $set: {
            status: 'Closed',
            closedAt: new Date(),
            closedReason: 'Another quotation of this opportunity was accepted',
            closedByQuotationId: acceptedId,
            updatedBy: resolveUserId(req) || 'system'
          }
        },
        { new: true }
      ).lean();
      if (!row) continue;
      closed.push(String(other._id));
      await AuditService.log(req, {
        action: 'closed',
        module: 'quotation',
        recordId: String(other._id),
        description: `Quotation ${other.quotationNo || other._id} closed: quotation ${accepted.quotationNo || acceptedId} of the same opportunity was accepted`,
        metadata: { previousStatus: other.status, acceptedQuotationId: acceptedId, opportunityId }
      });
    }
    return closed;
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] closing other quotations of the opportunity failed:', err?.message || err);
    return [];
  }
}

async function reject(req, id) {
  const { isClientUser } = require('../utils/tenant.util');
  if (!isClientUser(req)) {
    throw appError('Only clients can reject quotations. Administrators and staff cannot reject on behalf of the client.', 403);
  }

  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);
  const existing = await findQuotationOrThrow(req, id);
  await assertNotExpired(existing);

  if (existing.status !== 'Sent') {
    throw appError('Only sent quotations can be rejected', 409);
  }

  const doc = await Estimate.findOneAndUpdate(
    { ...tenantFilter(req), _id: id },
    { $set: { status: 'Rejected', updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'rejected',
    module: 'quotation',
    recordId: id,
    description: `Quotation rejected: ${doc.quotationNo}`
  });

  try {
    const OpportunityService = require('./opportunity.service');
    await OpportunityService.syncOpportunityQuotationNegotiation(req, doc || existing, 'quotation_rejected');
  } catch (err) {
    console.warn(
      '[plugin:openext-crm-suite] opportunity Negotiation sync on quotation reject failed:',
      err?.message || err
    );
  }

  return doc;
}

/** Marks an open enquiry opened for this client as Won and converted to it (never another client's lead). */
async function closeClientEnquiry(req, leadId, clientId) {
  const Lead = req.cms?.models?.get?.('Lead');
  if (!Lead) return;
  const tenantId = resolveTenantId(req);
  const q = Lead.findOne({ tenantId, _id: leadId, isDeleted: { $ne: true } });
  const lead = q && typeof q.lean === 'function' ? await q.lean() : await q;
  if (!lead || lead.convertedClientId || String(lead.forClientId || '') !== String(clientId)) return;
  const stages = await SettingService.getPipelineStages(req);
  const wonStage = SettingService.resolveWonStage(stages);
  await Lead.updateOne(
    { tenantId, _id: leadId, convertedClientId: null },
    { $set: { stage: wonStage, stageUpdatedAt: new Date(), convertedClientId: String(clientId), convertedAt: new Date(), updatedBy: resolveUserId(req) } }
  );
  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'lead',
    recordId: String(leadId),
    description: `Client enquiry closed: ${lead.stage} -> ${wonStage} (quotation accepted)`,
    metadata: { from: lead.stage, to: wonStage, clientId: String(clientId) }
  }).catch(() => null);
}

async function resolveQuotationClientId(req, quotation, options = {}) {
  const convertLead = options.convertLead !== false;
  let clientId = quotation?.clientId ? String(quotation.clientId).trim() : '';
  const leadId = quotation?.leadId ? String(quotation.leadId).trim() : '';

  // 3.45.0: accepting a client's quotation closes the client's enquiry it was made for (Won, linked to
  // that client; no new client is created).
  if (clientId && leadId && convertLead) await closeClientEnquiry(req, leadId, clientId);

  if (!clientId && leadId) {
    const LeadService = require('./lead.service');
    const ClientService = require('./client.service');
    const lead = await LeadService.getById(req, leadId, { includeQuality: false });

    if (lead.convertedClientId) {
      clientId = String(lead.convertedClientId);
    } else if (convertLead) {
      const stages = await SettingService.getPipelineStages(req);
      const wonStage = SettingService.resolveWonStage(stages);
      if (lead.stage !== wonStage) {
        // Driven by the accepted quotation, not by whoever clicked accept.
        await LeadService.changeStage(req, leadId, wonStage, { system: true });
      }
      // An accepted quotation never fails because the customer already exists (a returning customer,
      // or the client who accepts on the portal): the lead is linked to that customer instead.
      const converted = await ClientService.convertFromLead(req, leadId, {
        linkExisting: true,
        allowSimilarCompany: true,
        exceptOpportunityId: String(quotation.opportunityId || quotation.dealId || '').trim()
      });
      clientId = converted.clientId;
    }
  }

  if (!clientId) {
    throw appError(
      'Quotation has no customer linked. Assign a client or accept the quotation from a lead first.',
      409
    );
  }

  await validateClient(req, clientId);
  return String(clientId);
}

async function convertToInvoice(req, id) {
  const { isSalesRepresentative, isAdmin, isSalesManager } = require('../utils/sales-access.util');
  if (isSalesRepresentative(req) && !isAdmin(req) && !isSalesManager(req)) {
    throw appError('Sales representatives cannot convert quotations to invoices', 403);
  }

  const Estimate = getEstimateModel(req);
  const Invoice = getInvoiceModel(req);
  const userId = resolveUserId(req);
  const settings = await SettingService.getAll(req);
  const existing = await findQuotationOrThrow(req, id);

  if (existing.convertedInvoiceId) {
    throw appError('Quotation has already been converted to an invoice', 409);
  }
  // Strict rule: the deal behind it may not already be invoiced (from another quotation or directly).
  await require('./opportunity.service').assertOpportunityNotInvoiced(req, existing.opportunityId || existing.dealId);
  if (existing.status !== 'Accepted' && !(existing.status === 'Converted' && !existing.convertedInvoiceId)) {
    throw appError('Only Accepted quotations can be converted to an invoice', 400);
  }

  // A tax invoice already made from this quotation (its payment requests carry the same link: not them).
  const duplicateInvoice = await Invoice.findOne({
    ...baseFilter(req),
    convertedQuotationId: id,
    documentType: { $ne: 'proforma' }
  }).lean();
  if (duplicateInvoice) {
    await Estimate.updateOne(
      { ...baseFilter(req), _id: id },
      { $set: { status: 'Converted', convertedInvoiceId: duplicateInvoice._id.toString(), updatedBy: userId } }
    );
    return {
      converted: true,
      invoice: duplicateInvoice,
      quotation: existing
    };
  }

  const clientId = await resolveQuotationClientId(req, existing, { convertLead: true });

  const ProformaService = require('./proforma.service');
  // Payment requests (advance and balance): one tax invoice for the full value carries all their payments.
  if (await ProformaService.hasPaymentRequests(req, existing)) {
    // The customer the invoice is billed to (a lead is converted first), then one invoice for everything paid.
    if (clientId) await Estimate.updateOne({ ...baseFilter(req), _id: id }, { $set: { clientId, updatedBy: userId } });
    const result = await ProformaService.invoiceQuotationWithPayments(req, id, { requireFullPayment: false });
    if (!result.invoiced) throw appError('Quotation has already been converted to an invoice', 409);
    const oppIdC = existing.opportunityId || existing.dealId;
    if (oppIdC) {
      try {
        const OpportunityService = require('./opportunity.service');
        await OpportunityService.syncOpportunityQuotationAccepted(req, existing);
      } catch (err) {
        console.warn('[plugin:openext-crm-suite] opportunity Won sync on invoice convert failed:', err?.message || err);
      }
    }
    return { converted: true, invoice: result.invoice, quotation: { ...existing, status: 'Converted', convertedInvoiceId: result.invoiceId } };
  }
  const openProforma = await ProformaService.openProformaForQuotation(req, existing);
  if (openProforma) {
    const converted = await ProformaService.convertProformaToTaxInvoice(req, openProforma._id, { skipFeatureCheck: true });
    const fromProforma = converted.invoice;
    await Estimate.updateOne(
      { ...baseFilter(req), _id: id },
      { $set: { status: 'Converted', clientId, convertedInvoiceId: String(fromProforma._id), updatedBy: userId } }
    );
    const oppIdP = existing.opportunityId || existing.dealId;
    if (oppIdP) {
      try {
        const OpportunityService = require('./opportunity.service');
        await OpportunityService.syncOpportunityQuotationAccepted(req, existing);
      } catch (err) {
        console.warn('[plugin:openext-crm-suite] opportunity Won sync on invoice convert failed:', err?.message || err);
      }
    }
    await AuditService.log(req, {
      action: 'converted',
      module: 'quotation',
      recordId: id,
      description: `Quotation ${existing.quotationNo || id} invoiced as ${fromProforma.invoiceNo} from proforma ${openProforma.invoiceNo || ''} (payments carried over)`.trim(),
      metadata: { invoiceId: String(fromProforma._id), proformaId: String(openProforma._id), movedPayments: converted.movedPayments }
    });
    return { converted: true, invoice: fromProforma, quotation: { ...existing, status: 'Converted', convertedInvoiceId: String(fromProforma._id) } };
  }

  const invoiceNo = await getNextNumber(req, 'invoice');

  const rawIssueDate = existing.issueDate ? new Date(existing.issueDate) : new Date();
  const issueDate = isNaN(rawIssueDate.getTime()) ? new Date() : rawIssueDate;
  const paymentDays = Number(settings.invoice_payment_days || 30);
  const dueDate = new Date(issueDate);
  dueDate.setDate(dueDate.getDate() + paymentDays);

  const subtotal = Number(existing.subtotal) || 0;
  const taxTotal = Number(existing.taxTotal) || 0;
  const grandTotal = Number(existing.grandTotal) || 0;

  const invoice = await Invoice.create(await withCustomerSnapshot(req, {
    tenantId: existing.tenantId,
    clientId,
    leadId: existing.leadId || null,
    convertedQuotationId: id,
    invoiceNo,
    issueDate,
    dueDate,
    status: 'Draft',
    currency: existing.currency || settings.default_currency || 'INR',
    lineItems: Array.isArray(existing.lineItems) ? existing.lineItems : [],
    subtotal,
    discountPercent: Number(existing.discountPercent) || 0,
    discountAmount: Number(existing.discountAmount) || 0,
    taxCalculation: existing.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount',
    taxTotal,
    grandTotal,
    amountPaid: 0,
    balanceDue: grandTotal,
    notes: existing.notes ? String(existing.notes).trim() : '',
    createdBy: userId,
    updatedBy: userId
  }));

  const invoiceDoc = invoice.toObject();

  await Estimate.updateOne(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        status: 'Converted',
        clientId,
        convertedInvoiceId: invoiceDoc._id.toString(),
        updatedBy: userId
      }
    }
  );

  const oppId = existing.opportunityId || existing.dealId;
  if (oppId) {
    const Opportunity = req.cms?.models?.get ? req.cms.models.get('Opportunity') : null;
    if (Opportunity && typeof Opportunity.updateOne === 'function') {
      try {
        await Opportunity.updateOne(
          { ...baseFilter(req), _id: oppId },
          {
            $set: {
              stage: 'Won',
              stageType: 'WON',
              closedAt: new Date(),
              acceptedQuotationId: String(id),
              updatedBy: userId
            }
          }
        );
      } catch (oppErr) {
        console.warn('[plugin:openext-crm-suite] Opportunity direct update failed:', oppErr?.message || oppErr);
      }
    }
    try {
      const OpportunityService = require('./opportunity.service');
      await OpportunityService.syncOpportunityQuotationAccepted(req, existing);
    } catch (err) {
      console.warn('[plugin:openext-crm-suite] opportunity Won sync on invoice convert failed:', err?.message || err);
    }
  }

  await AuditService.log(req, {
    action: 'converted_to_invoice',
    module: 'quotation',
    recordId: id,
    description: `Quotation ${existing.quotationNo} converted to Invoice ${invoiceNo}`,
    metadata: {
      quotationId: id,
      invoiceId: invoiceDoc._id.toString(),
      invoiceNo,
      clientId,
      grandTotal
    }
  });

  return {
    converted: true,
    invoice: invoiceDoc,
    quotation: {
      ...existing,
      status: 'Converted',
      convertedInvoiceId: invoiceDoc._id.toString()
    }
  };
}

async function listByLead(req, leadId) {
  const Estimate = getEstimateModel(req);
  const filter = {
    ...baseFilter(req),
    leadId: String(leadId).trim()
  };

  const items = await Estimate.find(filter).sort({ createdAt: -1 }).lean();
  const withStatus = items.map(withEffectiveStatus);
  return enrichWithCustomerLabel(req, withStatus);
}

async function listByClient(req, clientId) {
  const Estimate = getEstimateModel(req);
  // Also the ones made before the client existed: on its leads or their opportunities (never copied).
  const { leadIds, opportunityIds } = await require('./client.service').clientSalesOrigins(req, clientId);
  const or = [{ clientId: String(clientId).trim() }];
  if (leadIds.length) or.push({ leadId: { $in: leadIds } });
  if (opportunityIds.length) or.push({ opportunityId: { $in: opportunityIds } }, { dealId: { $in: opportunityIds } });
  const filter = {
    ...baseFilter(req),
    $or: or
  };

  const items = await Estimate.find(filter).sort({ createdAt: -1 }).lean();
  const withStatus = items.map(withEffectiveStatus);
  return enrichWithCustomerLabel(req, withStatus);
}

async function createForLead(req, leadId, input = {}) {
  const payload = {
    ...input,
    leadId: String(leadId).trim()
  };

  const created = await create(req, payload);
  if (input.send) {
    const sendResult = await send(req, created._id);
    return {
      doc: sendResult.doc || created,
      emailDelivery: sendResult.emailDelivery
    };
  }
  if (created?.status === 'Sent' || input.status === 'Sent') {
    await syncLeadQuotationSent(req, created, leadId);
    try {
      const OpportunityService = require('./opportunity.service');
      await OpportunityService.syncOpportunityQuotationSent(req, created);
    } catch {
      /* non-blocking */
    }
  }
  return { doc: created };
}

async function createRevision(req, id, options = {}) {
  const Estimate = getEstimateModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const existing = await findQuotationOrThrow(req, id);
  if (existing.status === 'Accepted' || existing.status === 'Converted') {
    throw appError('Accepted quotations are permanently locked and cannot be revised.', 409);
  }
  if (existing.status === 'Closed') {
    throw appError('This quotation was closed because another quotation of the opportunity was accepted.', 409);
  }
  if (existing.status === 'Draft') {
    throw appError('Draft quotations can be edited directly and cannot be revised.', 409);
  }

  const rootId = existing.revisionOf || existing._id.toString();

  const query = Estimate.find({
    tenantId,
    $or: [{ _id: rootId }, { revisionOf: rootId }],
    isDeleted: false
  });
  const allTree = typeof query?.select === 'function'
    ? await query.select('version quotationNo').lean()
    : (typeof query?.lean === 'function' ? await query.lean() : await query);

  const maxVersion = Math.max(
    Number(existing.version) || 1,
    ...(allTree || []).map((r) => Number(r.version) || 1)
  );
  const nextVersion = maxVersion + 1;
  const baseNo = String(existing.quotationNo || '').replace(/-R\d+$/i, '');
  const revisionQuotationNo = `${baseNo}-R${nextVersion - 1}`;

  // Commercial dates of the new Draft (checked before anything is changed): issued today; its valid till
  // is the one asked for, or the old one kept inside the extension's limit (e.g. the trip's start).
  const DateOnly = require('../utils/date-only.util');
  const revisionRules = await require('./sales-flow.service').quotationDateRules(req, {
    leadId: refId(existing.leadId),
    opportunityId: refId(existing.opportunityId || existing.dealId),
    recordId: existing.extensionRecordId,
    clientId: refId(existing.clientId)
  });
  const revisionIssueDay = revisionRules.issueDateMin || DateOnly.localDay();
  let revisionExpiry = options.expiryDate ? new Date(options.expiryDate) : existing.expiryDate;
  if (options.expiryDate) {
    await assertCommercialDates(req, { issueDate: revisionIssueDay, validTill: options.expiryDate, rules: revisionRules });
  } else if (revisionRules.validTillMax && DateOnly.dayOf(revisionExpiry) > revisionRules.validTillMax && revisionRules.validTillMax >= revisionIssueDay) {
    revisionExpiry = DateOnly.dayToDate(revisionRules.validTillMax);
  }

  // Mark all existing revisions in this branch as not the latest version
  await Estimate.updateMany(
    { tenantId, $or: [{ _id: rootId }, { revisionOf: rootId }], isDeleted: false },
    { $set: { isLatestVersion: false, updatedBy: userId } }
  );

  const effectiveLineItems = options.lineItems
    ? await require('./sales-flow.service').cleanLineExtras(req, options.lineItems)
    : existing.lineItems || [];
  const effectiveDiscountPercent = options.discountPercent !== undefined
    ? Number(options.discountPercent)
    : (existing.discountPercent || 0);
  // A fixed-amount discount carries over unless the revision sets a percent.
  const effectiveDiscountAmount = options.discountAmount !== undefined
    ? Number(options.discountAmount) || 0
    : (effectiveDiscountPercent > 0 ? 0 : Number(existing.discountAmount) || 0);
  const effectiveShippingState = options.shippingState || existing.shippingState || '';
  const effectiveTaxMode = options.taxCalculation || existing.taxCalculation || 'after_discount';

  const {
    lineItems,
    subtotal,
    discountAmount,
    taxTotal,
    grandTotal
  } = buildLineItems(effectiveLineItems, {
    discountPercent: effectiveDiscountPercent,
    discountAmount: effectiveDiscountAmount,
    shippingCharge: existing.shippingCharge || 0,
    shippingState: effectiveShippingState,
    taxCalculation: effectiveTaxMode
  });

  const revisionShipping = Number(existing.shippingCharge || 0);
  const revisionGrandTotal = Math.max(
    0,
    Math.round((grandTotal + revisionShipping) * 100) / 100
  );
  assertNonZeroTotal(revisionGrandTotal);

  const revisionDoc = await Estimate.create(await withCustomerSnapshot(req, {
    tenantId,
    clientId: existing.clientId || '',
    leadId: existing.leadId || '',
    opportunityId: existing.opportunityId || existing.dealId || '',
    dealId: existing.dealId || existing.opportunityId || '',
    // 3.51.0: a revision stays on the same extension record.
    extensionRecordId: existing.extensionRecordId || '',
    quotationNo: revisionQuotationNo,
    title: existing.title || '',
    description: existing.description || '',
    issueDate: DateOnly.dayToDate(revisionIssueDay),
    expiryDate: revisionExpiry,
    status: 'Draft',
    currency: existing.currency || 'INR',
    taxCalculation: effectiveTaxMode,
    paymentType: existing.paymentType || 'full',
    advanceMode: existing.advanceMode || 'percent',
    advanceValue: existing.advanceValue || 0,
    lineItems,
    subtotal,
    discountPercent: effectiveDiscountPercent,
    discountAmount,
    discountApproval: {
      status: 'NotRequired',
      requestedPercent: 0,
      approvedBy: null,
      approvedAt: null,
      rejectionReason: ''
    },
    taxTotal,
    shippingCharge: revisionShipping,
    shippingState: effectiveShippingState,
    grandTotal: revisionGrandTotal,
    notes: existing.notes || '',
    recipientNotes: options.recipientNotes !== undefined ? options.recipientNotes : existing.recipientNotes,
    terms: options.terms !== undefined ? options.terms : (existing.terms || ''),
    sections: Array.isArray(existing.sections) ? existing.sections : [],
    version: nextVersion,
    revisionOf: rootId,
    isLatestVersion: true,
    revisionNotes: String(options.revisionNotes || options.reason || '').trim(),
    createdBy: userId,
    updatedBy: userId
  }));

  const doc = revisionDoc.toObject ? revisionDoc.toObject() : revisionDoc;

  // The new version starts with the old version's declared extension values (record "quotation").
  await require('./sales-flow.service').copyQuotationValues(req, existing, doc);

  await AuditService.log(req, {
    action: 'created_revision',
    module: 'quotation',
    recordId: doc._id.toString(),
    description: `Created revision v${nextVersion} (${revisionQuotationNo}) of quotation ${existing.quotationNo}`,
    metadata: { parentId: existing._id.toString(), version: nextVersion, quotationNo: revisionQuotationNo }
  });

  return getById(req, doc._id);
}

async function getRevisionHistory(req, id) {
  const Estimate = getEstimateModel(req);
  const tenantId = resolveTenantId(req);

  const quote = await findQuotationOrThrow(req, id);
  const rootId = quote.revisionOf || quote._id.toString();

  const revisions = await Estimate.find({
    tenantId,
    $or: [{ _id: rootId }, { revisionOf: rootId }],
    isDeleted: false
  })
    .sort({ version: 1, createdAt: 1 })
    .lean();

  const withStatus = revisions.map(withEffectiveStatus);
  const withCustomer = await enrichWithCustomerLabel(req, withStatus);
  return enrichQuotationsWithDeals(req, withCustomer);
}

async function archiveQuotation(req, id) {
  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);

  const existing = await findQuotationOrThrow(req, id);
  if (existing.isArchived) return existing;

  const query = Estimate.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isArchived: true, archivedAt: new Date(), archivedBy: userId, updatedBy: userId } },
    { new: true }
  );
  const doc = typeof query?.lean === 'function' ? await query.lean() : await query;

  await AuditService.log(req, {
    action: 'archived',
    module: 'quotation',
    recordId: String(id),
    description: `Archived quotation ${doc.quotationNo}`
  });

  return doc;
}

async function restoreQuotation(req, id) {
  const Estimate = getEstimateModel(req);
  const userId = resolveUserId(req);

  const existing = await findQuotationOrThrow(req, id);
  if (!existing.isArchived) return existing;

  const query = Estimate.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isArchived: false, archivedAt: null, archivedBy: null, updatedBy: userId } },
    { new: true }
  );
  const doc = typeof query?.lean === 'function' ? await query.lean() : await query;

  await AuditService.log(req, {
    action: 'restored',
    module: 'quotation',
    recordId: String(id),
    description: `Restored quotation ${doc.quotationNo}`
  });

  return doc;
}

async function generatePortalToken(req, id) {
  const Estimate = getEstimateModel(req);
  const existing = await findQuotationOrThrow(req, id);

  if (existing.portalToken) {
    return {
      portalToken: existing.portalToken,
      portalUrl: buildQuotationPortalUrl(req, existing.portalToken)
    };
  }

  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');

  await Estimate.updateOne(
    { ...baseFilter(req), _id: id },
    { $set: { portalToken: token } }
  );

  return {
    portalToken: token,
    portalUrl: buildQuotationPortalUrl(req, token)
  };
}

async function getPublicPortalQuotation(req, token) {
  const Estimate = getEstimateModel(req);
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw appError('Portal token is required', 400);

  const quote = await Estimate.findOne({ portalToken: cleanToken, isDeleted: false }).lean();
  if (!quote) throw appError('Quotation proposal link is invalid or expired', 404);

  const { attachTenantFromRecord } = require('../utils/portal.util');
  attachTenantFromRecord(req, quote);

  if (!quote.portalViewedAt) {
    await Estimate.updateOne(
      { _id: quote._id },
      { $set: { portalViewedAt: new Date() } }
    );
  }

  const settings = await SettingService.getAll(req).catch(() => ({}));
  const withStatus = withEffectiveStatus(quote);
  const [withCustomer] = await enrichWithCustomerLabel(req, [withStatus]);

  const RazorpayGatewayService = require('./razorpay-gateway.service');
  const razorpay = await RazorpayGatewayService.getStatus(req).catch(() => ({ configured: false, available: false }));

  const ProformaService = require('./proforma.service');
  const Invoice = req.cms?.models.get('Invoice');
  let proforma = null;
  if (quote.proformaInvoiceId && Invoice) {
    proforma = await Invoice.findOne({ _id: quote.proformaInvoiceId, isDeleted: false }).lean();
  }
  if (!proforma && Invoice) {
    proforma = await Invoice.findOne({ quotationId: String(quote._id), isDeleted: false }).lean();
  }

  let payable;
  try {
    payable = ProformaService.computePayableAmount(quote, settings);
  } catch {
    payable = { amount: quote.grandTotal, isAdvance: false, total: quote.grandTotal };
  }

  // Paid / balance from the verified payment records of every payment request (advance + balance).
  const state = await ProformaService.quotationPaymentState(req, quote, { settings });
  const next = state.nextPayment;
  const paymentTerms = {
    paymentType: quote.paymentType || (payable.isAdvance ? 'advance' : 'full'),
    isAdvance: next ? next.kind === 'advance' : Boolean(payable.isAdvance),
    isBalance: Boolean(next && (next.kind === 'balance' || next.kind === 'invoice')),
    payableAmount: next ? next.amount : 0,
    total: state.total,
    isPaid: state.status === 'Paid',
    paymentStatus: state.status,
    // Due on the current payment request (the advance, or the balance after it).
    balanceDue: next ? next.amount : 0,
    // Still owed on the whole quotation (the contract amount left after everything paid).
    remainingBalance: state.balance,
    paidAmount: state.paid,
    // Advance workflow: the quotation asks for the advance only; after it the rest is the tax invoice's.
    stage: state.stage,
    isAdvanceFlow: state.isAdvanceFlow,
    advanceRequired: state.advanceRequired,
    advancePaid: state.advancePaid,
    advanceSatisfied: state.advanceSatisfied,
    invoiceNo: state.invoiceNo || null,
    invoiceTotal: state.invoiceTotal,
    invoiceBalance: state.invoiceBalance,
    canPay: state.canPay && !quote.convertedInvoiceId,
    // Proforma & advance payment on: paying is the acceptance (no Accept & E-Sign).
    paymentAccepts: Boolean(settings.proforma_advance_enabled) && Number(quote.grandTotal) > 0,
    proformaId: proforma ? String(proforma._id) : null,
    proformaNo: proforma ? proforma.invoiceNo : null
  };

  return {
    quotation: await require('./sales-flow.service').publicQuotation(req, withCustomer),
    company: {
      name: settings.company_name || 'Root CRM',
      email: settings.company_email || '',
      phone: settings.company_phone || '',
      address: settings.company_address || '',
      gstin: settings.company_gstin || ''
    },
    razorpay,
    paymentTerms
  };
}

async function clientPortalAccept(req, token, payload = {}) {
  const Estimate = getEstimateModel(req);
  const cleanToken = String(token || '').trim();
  const quote = await Estimate.findOne({ portalToken: cleanToken, isDeleted: false }).lean();
  if (!quote) throw appError('Quotation proposal link is invalid or expired', 404);

  if (['Accepted', 'Converted'].includes(quote.status)) {
    throw appError('This quotation has already been accepted', 409);
  }
  if (quote.status === 'Rejected') {
    throw appError('This quotation was previously marked as rejected', 409);
  }
  // The portal link carries no session tenant: take it from the quotation (L6), then check the setting.
  require('../utils/portal.util').attachTenantFromRecord(req, quote);
  await assertPaymentNotRequired(req, quote);

  const opportunityId = String(quote.opportunityId || quote.dealId || '').trim();
  if (opportunityId) {
    const otherAccepted = await Estimate.findOne({
      tenantId: quote.tenantId,
      isDeleted: false,
      _id: { $ne: quote._id },
      status: 'Accepted',
      $or: [{ opportunityId }, { dealId: opportunityId }]
    })
      .select('_id quotationNo')
      .lean();
    if (otherAccepted) {
      throw appError(
        `Only one quotation can be accepted per opportunity. ${otherAccepted.quotationNo || 'Another quotation'} is already accepted.`,
        409
      );
    }
  }

  // Lead-linked quotations: mark lead Won + convert to client (same rule as admin accept).
  let clientId = quote.clientId ? String(quote.clientId).trim() : '';
  let leadConverted = false;
  if (!clientId && quote.leadId) {
    clientId = await resolveQuotationClientId(req, quote, { convertLead: true });
    leadConverted = true;
  }

  const acceptedMetadata = {
    acceptedBy: payload.name || 'Client Contact',
    acceptedEmail: payload.email || '',
    acceptedIp: req.ip || req.connection?.remoteAddress || '127.0.0.1',
    signature: payload.signature || `Signed electronically by ${payload.name || 'Client'}`,
    acceptedAt: new Date(),
    comments: payload.comments || ''
  };

  const acceptedSnapshot = {
    quotationNo: quote.quotationNo,
    title: quote.title,
    lineItems: quote.lineItems,
    subtotal: quote.subtotal,
    discountPercent: quote.discountPercent,
    discountAmount: quote.discountAmount,
    taxTotal: quote.taxTotal,
    grandTotal: quote.grandTotal,
    currency: quote.currency,
    recipientNotes: quote.recipientNotes,
    terms: quote.terms,
    acceptedAt: new Date()
  };

  const setFields = {
    status: 'Accepted',
    acceptedMetadata,
    acceptedSnapshot,
    updatedBy: 'client_portal'
  };
  if (clientId) setFields.clientId = clientId;

  const query = Estimate.findOneAndUpdate(
    { _id: quote._id },
    { $set: setFields },
    { new: true }
  );
  const updated = typeof query?.lean === 'function' ? await query.lean() : await query;

  if (await salesOrdersAllowed(req)) {
    try {
      const SalesOrderService = require('./sales-order.service');
      await SalesOrderService.createFromQuotation(req, String(quote._id));
    } catch {
      // Sales order creation is best-effort; acceptance must still succeed.
    }
  }

  await AuditService.log(req, {
    action: 'client_accepted',
    module: 'quotation',
    recordId: String(quote._id),
    description: `Quotation ${quote.quotationNo} accepted via Client Portal by ${acceptedMetadata.acceptedBy}${
      leadConverted ? ' — lead marked Won and converted to client' : ''
    }`,
    metadata: {
      acceptedMetadata,
      leadId: quote.leadId || '',
      clientId: clientId || '',
      leadConverted
    }
  });

  try {
    const OpportunityService = require('./opportunity.service');
    await OpportunityService.syncOpportunityQuotationAccepted(req, updated || quote);
  } catch (err) {
    console.warn(
      '[plugin:openext-crm-suite] opportunity Won sync on portal accept failed:',
      err?.message || err
    );
  }

  await afterAccepted(req, updated || { ...quote, ...setFields });

  return updated;
}

async function clientPortalReject(req, token, payload = {}) {
  const Estimate = getEstimateModel(req);
  const cleanToken = String(token || '').trim();
  const quote = await Estimate.findOne({ portalToken: cleanToken, isDeleted: false }).lean();
  if (!quote) throw appError('Quotation proposal link is invalid or expired', 404);

  if (['Accepted', 'Converted'].includes(quote.status)) {
    throw appError('This quotation has already been accepted and cannot be rejected', 409);
  }

  const rejectedMetadata = {
    rejectedBy: payload.name || 'Client Contact',
    rejectedEmail: payload.email || '',
    rejectedIp: req.ip || req.connection?.remoteAddress || '127.0.0.1',
    rejectedAt: new Date(),
    reason: String(payload.reason || 'Requested changes or declined').trim()
  };

  const query = Estimate.findOneAndUpdate(
    { _id: quote._id },
    {
      $set: {
        status: 'Rejected',
        rejectedMetadata,
        updatedBy: 'client_portal'
      }
    },
    { new: true }
  );
  const updated = typeof query?.lean === 'function' ? await query.lean() : await query;

  await AuditService.log(req, {
    action: 'client_rejected',
    module: 'quotation',
    recordId: String(quote._id),
    description: `Quotation ${quote.quotationNo} rejected via Client Portal by ${rejectedMetadata.rejectedBy}: ${rejectedMetadata.reason}`,
    metadata: { rejectedMetadata }
  });

  try {
    const OpportunityService = require('./opportunity.service');
    await OpportunityService.syncOpportunityQuotationNegotiation(
      req,
      updated || quote,
      'quotation_rejected_portal'
    );
  } catch (err) {
    console.warn(
      '[plugin:openext-crm-suite] opportunity Negotiation sync on portal reject failed:',
      err?.message || err
    );
  }

  return updated;
}

async function buildQuotationPrintHtml(req, id) {
  const doc = withEffectiveStatus(await findQuotationOrThrow(req, id));
  const payload = await FinanceDocumentUtil.buildQuotationPayload(req, doc);
  const html = PrintHtmlService.renderFinancePrintHtml(payload);
  return { doc, html };
}

async function exportPrintHtml(req, id) {
  const { doc, html } = await buildQuotationPrintHtml(req, id);

  await AuditService.log(req, {
    action: 'print_opened',
    module: 'quotation',
    recordId: String(id),
    description: `Print view opened: ${doc.quotationNo}`,
    metadata: { documentNo: doc.quotationNo }
  });

  return { html, title: doc.quotationNo || 'quotation' };
}

async function generatePrintHtml(req, id) {
  const { html } = await buildQuotationPrintHtml(req, id);
  return html;
}

async function getPrintDocument(req, id) {
  const doc = withEffectiveStatus(await findQuotationOrThrow(req, id));
  return FinanceDocumentUtil.buildQuotationPayload(req, doc);
}

async function exportQuotations(req, query = {}) {
  const Estimate = getEstimateModel(req);
  const { isClientUser } = require('../utils/tenant.util');
  const portal = isClientUser(req);
  // A client exports exactly what their quotation list shows (never another customer, never a draft).
  let filter = portal ? tenantFilter(req) : baseFilter(req);

  if (query.status) {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  if (query.clientId && !portal) filter.clientId = String(query.clientId).trim();
  if (query.leadId && !portal) filter.leadId = String(query.leadId).trim();
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { quotationNo: { $regex: term, $options: 'i' } },
        { number: { $regex: term, $options: 'i' } },
        { subject: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const { mergeScopeIntoFilter } = require('../utils/sales-access.util');
  if (portal) {
    const { resolvePortalIdentity, portalScopeClause } = require('../utils/portal-identity.util');
    const identity = await resolvePortalIdentity(req);
    const clause = identity.kind === 'none' ? { _id: '__UNLINKED_CLIENT_NO_MATCH__' } : portalScopeClause(identity);
    filter = mergeScopeIntoFilter(filter, { $and: [clause, { status: { $ne: 'Draft' } }] });
  } else {
    const { applySalesAgentCreatorScope } = require('../utils/sales-access.util');
    filter = applySalesAgentCreatorScope(req, filter);
  }

  const raw = await Estimate.find(filter).sort({ issueDate: -1, createdAt: -1 }).lean();
  const enriched = await enrichQuotations(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'quotation',
    recordId: 'export',
    description: `Exported ${enriched.length} quotations in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `quotations_export_${nowStr}.json`,
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
    'Quotation Number',
    'Subject',
    'Client / Lead Name',
    'Status',
    'Issue Date',
    'Valid Until',
    'Subtotal',
    'Tax Total',
    'Discount Total',
    'Total Amount',
    'Currency',
    'Terms & Conditions',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const q of enriched) {
    rows.push(
      [
        q._id,
        q.quotationNo || q.number || '',
        q.subject || '',
        q.clientName || q.leadName || '',
        q.status || '',
        q.issueDate ? new Date(q.issueDate).toISOString().slice(0, 10) : '',
        q.validUntil ? new Date(q.validUntil).toISOString().slice(0, 10) : '',
        Number(q.subtotal || 0),
        Number(q.taxTotal || 0),
        Number(q.discountTotal || 0),
        Number(q.total || 0),
        q.currency || 'INR',
        q.terms || '',
        q.createdAt ? new Date(q.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `quotations_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  closeOtherOpportunityQuotations,
  assertLeadNotConverted,
  buildLineItems,
  withEffectiveStatus,
  list,
  listByLead,
  listByClient,
  getById,
  create,
  createForLead,
  createRevision,
  getRevisionHistory,
  archiveQuotation,
  restoreQuotation,
  generatePortalToken,
  getPublicPortalQuotation,
  clientPortalAccept,
  clientPortalReject,
  update,
  remove,
  send,
  syncLeadQuotationSent,
  accept,
  reject,
  resolveQuotationClientId,
  convertToInvoice,
  getPrintDocument,
  generatePrintHtml,
  exportPrintHtml,
  exportQuotations
};
