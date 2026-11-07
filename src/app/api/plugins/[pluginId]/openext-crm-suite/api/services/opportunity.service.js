'use strict';

const { withCustomerSnapshot, snapshotOf } = require('../utils/customer-snapshot.util');
const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { resolveUsernames } = require('../utils/user.util');
const { STAGE_PROBABILITIES } = require('../validation/opportunity.schema');
const { resolveLeadBudgetRange, describeOutOfRange } = require('../utils/budget-range.util');

function isWonStage(stage, stageType) {
  if (String(stageType || '').trim().toUpperCase() === 'WON') return true;
  return String(stage || '').trim().toLowerCase() === 'won';
}

function isLostStage(stage, stageType) {
  if (String(stageType || '').trim().toUpperCase() === 'LOST') return true;
  return String(stage || '').trim().toLowerCase() === 'lost';
}

function isWonOpportunity(item) {
  return isWonStage(item?.stage, item?.stageType);
}

function isLostOpportunity(item) {
  return isLostStage(item?.stage, item?.stageType);
}

async function applyStageMeta(req, stageLabel, pipelineId) {
  try {
    const OpportunityPipelineService = require('./opportunity-pipeline.service');
    return await OpportunityPipelineService.resolveStageMeta(req, stageLabel, pipelineId);
  } catch {
    const label = normalizeOpportunityStageName(stageLabel);
    const lower = String(label || '').trim().toLowerCase();
    let type = 'OPEN';
    if (lower === 'won') type = 'WON';
    else if (lower === 'lost') type = 'LOST';
    else if (lower.includes('quotation sent')) type = 'QUOTATION_SENT';
    else if (lower.includes('negotiat') || lower.includes('commercial')) type = 'NEGOTIATION';
    return { label, type, probability: STAGE_PROBABILITIES[label] ?? 50, pipelineId: pipelineId || null };
  }
}

async function resolveStageLabelByType(req, type, pipelineId, fallback) {
  try {
    const OpportunityPipelineService = require('./opportunity-pipeline.service');
    const label = await OpportunityPipelineService.findStageLabelByType(req, type, pipelineId);
    if (label) return label;
  } catch {
    /* fall through */
  }
  return fallback;
}

function normalizeOpportunityStageName(stage) {
  const key = String(stage || '').trim();
  if (/^contract reviews?$/i.test(key)) return 'Quotation Sent';
  return key;
}

/** Pipeline order used to avoid downgrading a later opportunity stage. */
const OPPORTUNITY_STAGE_ORDER = [
  'Discovery',
  'Requirement Confirmed',
  'Product Validated',
  'Sample Approved',
  'Commercial Discussion',
  'Quotation Sent',
  'Won',
  'Negotiation',
  'Lost'
];

function opportunityStageRank(stage) {
  const key = normalizeOpportunityStageName(stage);
  const idx = OPPORTUNITY_STAGE_ORDER.findIndex(
    (s) => s.toLowerCase() === key.toLowerCase()
  );
  return idx >= 0 ? idx : -1;
}
const AuditService = require('./audit.service');
const ClientService = require('./client.service');

/** Lead model, for scoping deals by the lead their owner is assigned. */
function getLeadModel(req) {
  return req.cms?.models?.get?.('Lead') || null;
}

function getOpportunityModel(req) {
  const Opportunity = req.cms?.models.get('Opportunity');
  if (!Opportunity) throw new Error('Opportunity model is not registered');
  return Opportunity;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

/**
 * The stage a new opportunity opens in under the active extension (salesFlow.opportunityForm.startStage);
 * { locked: false } without that contract or when it cannot be read.
 */
async function opportunityStartStage(req, leadId) {
  try {
    return await require('./sales-flow.service').opportunityStartStage(req, leadId);
  } catch {
    return { locked: false };
  }
}

/** Link types the active extension allows for a new opportunity (["lead", "client"] without a form). */
async function opportunityLinkTypes(req) {
  try {
    return await require('./sales-flow.service').opportunityLinkTypes(req);
  } catch {
    return ['lead', 'client'];
  }
}

/**
 * Generates unique opportunity tracking number formatted as OPP-YYYY-XXXX.
 * 
 * Usecase: Assigns human-readable deal identifier.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<string>} Generated opportunity number
 */
async function generateOpportunityNumber(req) {
  const Opportunity = getOpportunityModel(req);
  const year = new Date().getFullYear();
  const prefix = `OPP-${year}-`;
  const count = await Opportunity.countDocuments({
    tenantId: resolveTenantId(req),
    opportunityNumber: { $regex: `^${prefix}` }
  });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

/**
 * Enriches opportunity items with Client company names and user names.
 * 
 * Usecase: Enriches deal records with Account details for UI display.
 * 
 * @param {Object} req Express request object
 * @param {Array} items Raw opportunity records
 * @returns {Promise<Array>} Enriched opportunity records
 */
/**
 * The tax invoices of some opportunities: raised from the deal (invoice.opportunityId) or from one of
 * its quotations. Proformas and cancelled invoices do not count.
 * @returns {Promise<Record<string, { count, invoices: Array<{ _id, invoiceNo, status }>, paidInvoice, openInvoice }>>}
 */
async function opportunityInvoiceMap(req, opportunityIds) {
  const ids = [...new Set((opportunityIds || []).map(String).filter(Boolean))];
  const out = {};
  const Invoice = req.cms?.models.get('Invoice');
  const Estimate = req.cms?.models.get('Estimate');
  if (!ids.length || !Invoice) return out;
  const tenantId = resolveTenantId(req);
  const quoteToOpp = {};
  if (Estimate) {
    const quotes = await Estimate.find({
      tenantId,
      isDeleted: { $ne: true },
      $or: [{ opportunityId: { $in: ids } }, { dealId: { $in: ids } }]
    })
      .select('_id opportunityId dealId')
      .lean();
    for (const q of quotes || []) {
      const opp = String(q.opportunityId || q.dealId || '');
      if (ids.includes(opp)) quoteToOpp[String(q._id)] = opp;
    }
  }
  const quoteIds = Object.keys(quoteToOpp);
  const or = [{ opportunityId: { $in: ids } }];
  if (quoteIds.length) or.push({ quotationId: { $in: quoteIds } }, { convertedQuotationId: { $in: quoteIds } });
  const invoices = await Invoice.find({
    tenantId,
    isDeleted: { $ne: true },
    documentType: { $ne: 'proforma' },
    status: { $nin: ['Cancelled'] },
    $or: or
  })
    .select('_id invoiceNo status opportunityId quotationId convertedQuotationId createdAt')
    .sort({ createdAt: -1 })
    .lean();
  for (const inv of invoices || []) {
    const opp =
      (inv.opportunityId && ids.includes(String(inv.opportunityId)) && String(inv.opportunityId)) ||
      quoteToOpp[String(inv.convertedQuotationId || '')] ||
      quoteToOpp[String(inv.quotationId || '')];
    if (!opp) continue;
    const entry = (out[opp] = out[opp] || { count: 0, invoices: [], paidInvoice: null, openInvoice: null });
    if (entry.invoices.some((i) => i._id === String(inv._id))) continue;
    const row = { _id: String(inv._id), invoiceNo: inv.invoiceNo || '', status: inv.status || '' };
    entry.invoices.push(row);
    entry.count += 1;
    if (row.status === 'Paid') entry.paidInvoice = entry.paidInvoice || row;
    else entry.openInvoice = entry.openInvoice || row;
  }
  return out;
}

/** Strict rule: an opportunity is invoiced once; a second invoice is refused (409 OPPORTUNITY_INVOICED). */
async function assertOpportunityNotInvoiced(req, opportunityId) {
  const id = String(opportunityId || '').trim();
  if (!id) return;
  const entry = (await opportunityInvoiceMap(req, [id]))[id];
  if (entry && entry.count) {
    const first = entry.paidInvoice || entry.openInvoice;
    const error = appError(`This opportunity is already invoiced${first && first.invoiceNo ? ` (${first.invoiceNo})` : ''}. Open that invoice instead.`, 409);
    error.code = 'OPPORTUNITY_INVOICED';
    error.invoiceId = first ? first._id : null;
    throw error;
  }
}

async function enrichOpportunities(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];
  let invoiceMap = {};
  try {
    invoiceMap = await opportunityInvoiceMap(req, items.map((i) => i._id));
  } catch {
    invoiceMap = {};
  }

  const userIds = [
    ...new Set(
      items.flatMap((i) => [i.createdBy, i.salesOwner]).filter(Boolean)
    )
  ];
  const nameMap = await resolveUsernames(req, userIds);

  const Client = req.cms?.models.get('Client') || req.cms?.models.get('Company');
  const Lead = req.cms?.models.get('Lead');
  const clientMap = {};
  const leadMap = {};
  const tenantId = resolveTenantId(req);

  if (Client) {
    const clientIds = [...new Set(items.map((i) => String(i.clientId || '')))].filter(Boolean);
    if (clientIds.length) {
      const clients = await Client.find({ tenantId, _id: { $in: clientIds } })
        .select('name companyName contactPerson email phone mobile')
        .lean();
      clients.forEach((c) => { clientMap[String(c._id)] = c; });
    }
  }

  if (Lead) {
    const leadIds = [...new Set(items.map((i) => String(i.leadId || '')))].filter(Boolean);
    if (leadIds.length) {
      const leads = await Lead.find({ tenantId, _id: { $in: leadIds }, isDeleted: { $ne: true } })
        .select('name company contactName email phone isPortal')
        .lean();
      leads.forEach((l) => { leadMap[String(l._id)] = l; });
    }
  }

  // Resolve linked sales orders by opportunityId (1:1) for Open Sales Order UI.
  const soMap = {};
  try {
    const SalesOrder = req.cms?.models.get('SalesOrder');
    const oppIds = [...new Set(items.map((i) => String(i._id || '')).filter(Boolean))];
    if (SalesOrder && oppIds.length) {
      const orders = await SalesOrder.find({
        tenantId,
        isDeleted: { $ne: true },
        opportunityId: { $in: oppIds },
      })
        .select('_id opportunityId orderNumber status issueDate createdAt grandTotal currency')
        .sort({ createdAt: -1 })
        .lean();
      for (const order of orders) {
        const key = String(order.opportunityId || '');
        if (key && !soMap[key]) {
          soMap[key] = order;
        }
      }
    }
  } catch {
    // Sales order lookup is best-effort for opportunity → SO navigation.
  }

  return items.map((item) => {
    const client = clientMap[String(item.clientId || '')];
    const lead = leadMap[String(item.leadId || '')];
    const snap = snapshotOf(item);
    const leadLabel = lead
      ? (lead.company || lead.contactName || lead.name || 'Lead')
      : '';
    // The deal's own snapshot (3.35.0) wins over the current client / lead.
    const clientName = (snap && snap.name) || client?.name || client?.companyName || leadLabel || '—';
    const linkedSo = soMap[String(item._id || '')];
    const generatedSalesOrderId =
      item.generatedSalesOrderId ||
      (linkedSo ? String(linkedSo._id) : null);
    const generatedSalesOrderNo =
      item.generatedSalesOrderNo ||
      (linkedSo ? linkedSo.orderNumber : null) ||
      null;
    const issueDate = linkedSo?.issueDate || linkedSo?.createdAt || null;
    return {
      ...item,
      stage: normalizeOpportunityStageName(item.stage),
      generatedSalesOrderId,
      generatedSalesOrderNo,
      generatedSalesOrderStatus: linkedSo?.status || item.generatedSalesOrderStatus || null,
      generatedSalesOrderDate: issueDate
        ? new Date(issueDate).toISOString()
        : item.generatedSalesOrderDate || null,
      generatedSalesOrderAmount:
        linkedSo?.grandTotal != null
          ? Number(linkedSo.grandTotal)
          : item.generatedSalesOrderAmount ?? null,
      generatedSalesOrderCurrency:
        linkedSo?.currency || item.generatedSalesOrderCurrency || null,
      // Invoices of this deal: Create Invoice only while there are none (strict rule).
      invoiceSummary: invoiceMap[String(item._id || '')] || { count: 0, invoices: [], paidInvoice: null, openInvoice: null },
      clientCompany: clientName,
      clientName,
      customerLabel: clientName,
      customerName: clientName,
      leadName: leadLabel || item.leadName || null,
      contactPerson: item.contactPerson || client?.contactPerson || lead?.contactName || lead?.name || '—',
      isPortal: Boolean(item.isPortal || lead?.isPortal),
      leadIsPortal: Boolean(lead?.isPortal),
      salesOwnerName: nameMap[item.salesOwner] || item.salesOwner || 'Unassigned',
      createdByName: nameMap[item.createdBy] || item.createdBy || 'System',
      // Canonical UI field (aliases expectedRevenue / value).
      estimatedDealValue:
        item.estimatedDealValue != null
          ? Number(item.estimatedDealValue)
          : item.expectedRevenue != null
            ? Number(item.expectedRevenue)
            : item.value != null
              ? Number(item.value)
              : null,
    };
  });
}

/**
 * Lists opportunities matching filter criteria.
 * 
 * Usecase: Retrieves paginated opportunity pipeline records.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<Object>} Enriched opportunities and pagination
 */
async function list(req) {
  const Opportunity = getOpportunityModel(req);
  const { page, limit, skip } = parsePagination(req.query);
  const filter = baseFilter(req);
  /** Client-portal scope, merged in last so no later clause can drop it. */
  let clientScopeClause = null;

  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
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

    if (identity.kind === 'lead') {
      // A portal-enabled lead sees the deals on its own lead record.
      clientScopeClause =
        identity.leadIds.length === 1
          ? { leadId: identity.leadIds[0] }
          : { leadId: { $in: identity.leadIds } };
    } else {
      const userClientId = identity.clientId;
      const ownLeadIds = Array.isArray(identity.leadIds) ? identity.leadIds : [];
      // Their client's deals plus the deals still hanging off their own lead.
      // Held aside rather than written onto `filter` directly: the search block
      // below assigns `filter.$or`, which would otherwise replace this scope and
      // show the portal user the whole tenant's deals.
      clientScopeClause = ownLeadIds.length
        ? { $or: [{ clientId: userClientId }, { leadId: { $in: ownLeadIds } }] }
        : { clientId: userClientId };
    }
  } else if (req.query?.clientId) {
    filter.clientId = String(req.query.clientId).trim();
  }

  if (req.query?.leadId) {
    filter.leadId = String(req.query.leadId).trim();
  }

  if (req.query?.pipelineId) {
    filter.pipelineId = String(req.query.pipelineId).trim();
  }

  if (req.query?.stage) filter.stage = String(req.query.stage).trim();
  if (req.query?.salesOwner) filter.salesOwner = String(req.query.salesOwner).trim();
  if (req.query?.search) {
    const { toLiteralSearchTerm, findMatchingClientIds } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const or = [
        { opportunityNumber: { $regex: term, $options: 'i' } },
        { title: { $regex: term, $options: 'i' } },
        { clientId: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { salesOwner: { $regex: term, $options: 'i' } },
        { contactPerson: { $regex: term, $options: 'i' } },
        { contactEmail: { $regex: term, $options: 'i' } }
      ];
      const clientIds = await findMatchingClientIds(req, req.query.search);
      if (clientIds.length) or.push({ clientId: { $in: clientIds } });
      filter.$or = or;
    }
  }

  const { applySalesAgentOpportunityListScope, mergeScopeIntoFilter } = require('../utils/sales-access.util');
  const scopedFilter = clientScopeClause
    ? mergeScopeIntoFilter(filter, clientScopeClause)
    : filter;
  const finalFilter = await applySalesAgentOpportunityListScope(req, scopedFilter, getLeadModel);

  const sort = { createdAt: -1, _id: -1 };
  const [items, total] = await Promise.all([
    Opportunity.find(finalFilter).sort(sort).skip(skip).limit(limit).lean(),
    Opportunity.countDocuments(finalFilter)
  ]);

  return {
    items: await enrichOpportunities(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

/**
 * Computes pipeline summary metrics (Total Revenue, Weighted Forecast, Win Rate %).
 * 
 * Usecase: Renders header KPI metric cards on Opportunities page.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<Object>} Summary metrics object
 */
async function getSummary(req) {
  const Opportunity = getOpportunityModel(req);
  const filter = baseFilter(req);

  const { isClientUser } = require('../utils/tenant.util');
  const { resolvePortalIdentity, portalScopeFilter } = require('../utils/portal-identity.util');
  if (isClientUser(req)) {
    const identity = await resolvePortalIdentity(req);
    const portalScope = portalScopeFilter(identity);
    if (!portalScope) {
      return {
        totalOpportunities: 0,
        totalPipelineRevenue: 0,
        totalWeightedForecast: 0,
        totalDeals: 0,
        pipelineValue: 0,
        weightedForecast: 0,
        wonRevenue: 0,
        winRate: 0,
        openDeals: 0,
        wonDeals: 0,
        lostDeals: 0,
        unlinkedClient: true
      };
    }
    Object.assign(filter, portalScope);
  }

  const { applySalesAgentOpportunityListScope } = require('../utils/sales-access.util');
  const finalFilter = await applySalesAgentOpportunityListScope(req, filter, getLeadModel);

  const all = await Opportunity.find(finalFilter)
    .select('expectedRevenue probability weightedRevenue stage stageType')
    .lean();

  let totalPipelineRevenue = 0;
  let totalWeightedForecast = 0;
  let wonRevenue = 0;
  let wonCount = 0;
  let lostCount = 0;
  let openDeals = 0;

  all.forEach((item) => {
    const revenue = Number(item.expectedRevenue || 0);
    const isClosed = isWonOpportunity(item) || isLostOpportunity(item);

    // Active pipeline only (exclude Won/Lost) — matches KPI reference.
    if (!isClosed) {
      openDeals += 1;
      totalPipelineRevenue += revenue;
      const weighted =
        item.weightedRevenue != null
          ? Number(item.weightedRevenue)
          : revenue * ((Number(item.probability) || 0) / 100);
      totalWeightedForecast += weighted;
    }

    if (isWonOpportunity(item)) {
      wonRevenue += revenue;
      wonCount++;
    } else if (isLostOpportunity(item)) {
      lostCount++;
    }
  });

  const closedTotal = wonCount + lostCount;
  const winRate = closedTotal > 0 ? Math.round((wonCount / closedTotal) * 1000) / 10 : 0;
  const pipelineValue = Math.round(totalPipelineRevenue * 100) / 100;
  const weightedForecast = Math.round(totalWeightedForecast * 100) / 100;
  const wonRevenueRounded = Math.round(wonRevenue * 100) / 100;

  return {
    // Legacy API keys
    totalOpportunities: all.length,
    totalPipelineRevenue: pipelineValue,
    totalWeightedForecast: weightedForecast,
    // Frontend KPI keys
    totalDeals: all.length,
    pipelineValue,
    weightedForecast,
    wonRevenue: wonRevenueRounded,
    winRate,
    openDeals,
    wonDeals: wonCount,
    lostDeals: lostCount
  };
}

/**
 * Gets opportunity details by ID.
 * 
 * Usecase: Loads a single opportunity record.
 * 
 * @param {Object} req Express request object
 * @param {string} id Opportunity ID
 * @returns {Promise<Object>} Enriched opportunity record
 */
async function getById(req, id) {
  const Opportunity = getOpportunityModel(req);
  const doc = await Opportunity.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Opportunity not found', 404);
  const { isClientUser } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const { resolvePortalIdentity, portalOwnsRecord } = require('../utils/portal-identity.util');
    const identity = await resolvePortalIdentity(req);
    // 404 rather than 403: a portal user should not learn the deal exists.
    if (!portalOwnsRecord(identity, doc)) throw appError('Opportunity not found', 404);
  } else {
    const { assertSalesAgentOpportunityAccessAsync } = require('../utils/sales-access.util');
    await assertSalesAgentOpportunityAccessAsync(req, doc, getLeadModel);
  }
  const [enriched] = await enrichOpportunities(req, [doc]);
  return enriched;
}

/**
 * Creates a new Opportunity record.
 * 
 * Usecase: Initializes a new deal in the sales pipeline.
 * 
 * @param {Object} req Express request object
 * @param {Object} input Cleaned input payload
 * @returns {Promise<Object>} Created opportunity record
 */
/**
 * The pipeline a deal on this lead belongs to: the one asked for, else null so
 * the tenant's active pipeline applies (an extension's pipeline is activated
 * generically when the extension is enabled).
 *
 * Exported because the lead-side "Interested" conversion needs the same answer
 * before it can pick a stage that exists inside that pipeline.
 */
async function resolvePipelineIdForLead(req, leadId, explicitPipelineId) {
  const chosen = explicitPipelineId ? String(explicitPipelineId) : '';
  return chosen || null;
}

/**
 * Refuses an expected close date before today. "Today" is the earliest calendar date in use anywhere
 * (UTC-12), so a user whose own day is still yesterday in UTC terms is never refused for a valid date.
 */
function assertCloseDateNotPast(raw) {
  if (raw === undefined || raw === null || raw === '') return;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw appError('Expected close date is not a valid date', 400);
  const day = /^\d{4}-\d{2}-\d{2}/.test(String(raw)) ? String(raw).slice(0, 10) : date.toISOString().slice(0, 10);
  const earliestToday = new Date(Date.now() - 12 * 3600000).toISOString().slice(0, 10);
  if (day < earliestToday) {
    throw appError('Expected close date cannot be in the past — choose today or a later date', 400);
  }
}

async function create(req, input, options = {}) {
  const noShipping = (await require('./sales-flow.service').recordRules(req)).hideShipping;
  const Opportunity = getOpportunityModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const SettingService = require('./setting.service');
  const {
    resolveRecordCurrency,
    resolveExchangeRate,
    withCurrencyCode,
  } = require('../utils/record-currency.util');

  const clientId = String(input.clientId || '').trim();
  const leadId = String(input.leadId || '').trim() || null;
  if (!clientId && !leadId) {
    throw appError('Select a client account or an inbound lead', 400);
  }
  // Active extension contract (salesFlow.opportunityForm): opportunities may have to start from a lead.
  if (!leadId && !(await opportunityLinkTypes(req)).includes('client')) {
    const error = appError('Opportunities in this workspace start from a lead', 400);
    error.code = 'OPPORTUNITY_NEEDS_LEAD';
    throw error;
  }
  // A new opportunity cannot be expected to close in the past (create only; existing deals keep their dates).
  // Converting a recorded lead activity keeps the date the activity already holds.
  if (!options.keepCloseDate) assertCloseDateNotPast(input.expectedCloseDate);
  if (clientId) {
    await ClientService.getById(req, clientId);
  }
  let leadDoc = null;
  if (leadId) {
    const LeadService = require('./lead.service');
    leadDoc = await LeadService.getById(req, leadId, { includeQuality: false });
    // A lead converted into a client is closed: no new opportunity is created from it.
    if (leadDoc && leadDoc.convertedClientId) {
      const error = appError('This lead is already a client — a new opportunity cannot be created from it', 409);
      error.code = 'LEAD_CONVERTED';
      throw error;
    }
    // salesFlow.lockWonLead: no new opportunity from a Won lead.
    await require('../utils/lead-lock.util').assertEditable(req, leadId);
    // Lead workflow rule (Settings → Qualification Match): only Qualified or ready leads.
    await require('./lead-workflow.service').assertOpportunityAllowed(req, leadId);
  }
  // salesFlow.opportunityForm.startStage: the CRM sets the stage (and pipeline) of a new opportunity.
  // A different stage asked for by the user (options.requestedStage) is refused; a stage chosen by
  // another CRM flow is simply replaced.
  const startStage = await opportunityStartStage(req, leadId);
  if (startStage.locked) {
    const asked = String(options.requestedStage || '').trim();
    if (asked && asked.toLowerCase() !== String(startStage.stage).toLowerCase()) {
      const error = appError(
        `The stage of a new opportunity is set automatically ("${startStage.stage}") — it cannot be chosen when creating it`,
        400
      );
      error.code = 'OPPORTUNITY_STAGE_LOCKED';
      throw error;
    }
  }
  const chosenPipelineId = startStage.locked && startStage.pipelineId
    ? startStage.pipelineId
    : await resolvePipelineIdForLead(req, leadId, input.pipelineId, leadDoc);

  const opportunityNumber = await generateOpportunityNumber(req);
  const stageMeta = await applyStageMeta(
    req,
    startStage.locked ? startStage.stage : input.stage || 'Discovery',
    chosenPipelineId
  );
  // Under startStage the probability is the stage's own; a client value is ignored.
  const probability =
    !startStage.locked && input.probability !== undefined && input.probability !== null
      ? Number(input.probability)
      : Number(stageMeta.probability) || 50;
  // estimatedDealValue is the UI canonical name; expectedRevenue/value remain API aliases.
  const expectedRevenue = Number(
    input.estimatedDealValue != null ? input.estimatedDealValue : input.expectedRevenue
  ) || Number(input.value) || 0;

  // Enforce commercial requirement budget bounds when opportunity is linked to a lead
  if (leadDoc && (expectedRevenue > 0 || input.estimatedDealValue != null)) {
    const range = await resolveLeadBudgetRange(req, leadDoc);
    const problem = describeOutOfRange(range, expectedRevenue);
    if (problem) throw appError(problem, 400);
  }

  const weightedRevenue =
    !startStage.locked && input.weightedRevenue !== undefined && input.weightedRevenue !== null
      ? Number(input.weightedRevenue)
      : Math.round(expectedRevenue * (probability / 100) * 100) / 100;

  const { resolveSelfOnlyAssignee } = require('../utils/sales-access.util');
  const salesOwner =
    resolveSelfOnlyAssignee(req, input.salesOwner || userId, {
      fieldLabel: 'Sales owner',
      allowEmpty: false,
      forceSelf: true
    }) || userId;

  const settings = await SettingService.getAll(req);
  const currency = resolveRecordCurrency(input, settings);
  const exchangeRate = resolveExchangeRate(input);

  const doc = await Opportunity.create(await withCustomerSnapshot(req, {
    tenantId,
    opportunityNumber,
    title: input.title,
    leadId,
    clientId,
    contactPerson: input.contactPerson || '',
    contactEmail: input.contactEmail || '',
    contactMobile: input.contactMobile || '',
    contactId: input.contactId || null,
    products: input.products || [],
    expectedRevenue,
    currency,
    exchangeRate,
    shippingState: input.shippingState || '',
    // Services carry no shipping (salesFlow.hideShipping).
    shippingCharge: noShipping ? 0 : Math.max(0, Number(input.shippingCharge) || 0),
    probability,
    weightedRevenue,
    stage: stageMeta.label || (startStage.locked ? startStage.stage : input.stage) || 'Discovery',
    stageType: stageMeta.type || 'OPEN',
    pipelineId: startStage.locked
      ? stageMeta.pipelineId || chosenPipelineId || null
      : stageMeta.pipelineId || chosenPipelineId || input.pipelineId || null,
    isPortal: Boolean(input.isPortal ?? leadDoc?.isPortal ?? false),
    salesOwner,
    expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
    closedAt: input.closedAt ? new Date(input.closedAt) : null,
    lostReason: startStage.locked ? null : input.lostReason || null,
    createdBy: userId,
    updatedBy: userId
  }));

  const created = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'opportunity',
    recordId: created._id.toString(),
    description: `Opportunity ${opportunityNumber} (${input.title}) created`,
    metadata: { opportunityNumber, expectedRevenue: input.expectedRevenue, stage: created.stage || input.stage }
  });

  const [enriched] = await enrichOpportunities(req, [created]);
  return withCurrencyCode(enriched);
}

/**
 * Reassigns opportunity sales ownership to another sales representative.
 *
 * Usecase: Admin / sales manager moves a lead-linked (or direct) deal to another sales rep.
 *
 * @param {Object} req Express request object
 * @param {string} id Opportunity ID
 * @param {Object} input ({ salesOwner })
 * @returns {Promise<Object>} Updated opportunity record
 */
/**
 * Edit an existing deal: line items, shipping, currency and contact details.
 *
 * Totals are always recomputed from the line items, shipping charge and
 * probability, so expectedRevenue can never drift from the lines that justify
 * it. Commercial edits are refused once the deal has been executed into a
 * sales order — the order is already priced off these numbers. Contact edits
 * stay allowed, and are mirrored onto the linked Contacts record.
 */
/** Same commercial value (a full-form save resends what the record already holds). */
function sameCommercialValue(key, next, current) {
  if (key !== 'products') {
    const a = next === null || next === undefined ? '' : String(next).trim();
    const b = current === null || current === undefined ? '' : String(current).trim();
    return a === b || (a !== '' && b !== '' && Number(a) === Number(b));
  }
  const shape = (rows) =>
    JSON.stringify(
      (Array.isArray(rows) ? rows : []).map((l) => [
        String((l && (l.productId || l.name || l.description)) || ''),
        Number(l && l.quantity) || 0,
        Number(l && l.unitPrice) || 0,
        Number(l && l.tax) || 0,
        Number(l && l.discount) || 0
      ])
    );
  return shape(next) === shape(current);
}

async function update(req, id, input) {
  const Opportunity = getOpportunityModel(req);
  const userId = resolveUserId(req);
  const { withCurrencyCode } = require('../utils/record-currency.util');

  const existing = await Opportunity.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Opportunity not found', 404);

  const { assertSalesAgentOpportunityAccessAsync } = require('../utils/sales-access.util');
  await assertSalesAgentOpportunityAccessAsync(req, existing, getLeadModel);

  const COMMERCIAL_FIELDS = [
    'products',
    'shippingState',
    'shippingCharge',
    'probability',
    'currency',
    'currencyCode',
    'exchangeRate'
  ];
  const touchesCommercials = COMMERCIAL_FIELDS.some((key) => input[key] !== undefined);
  if (touchesCommercials && existing.generatedSalesOrderId) {
    throw appError(
      'This deal has been converted to a sales order — products, shipping and currency can no longer be changed',
      409
    );
  }

  // Extension rules (salesFlow): services carry no shipping; the primary contact is fixed after creation.
  const rules = await require('./sales-flow.service').recordRules(req);
  // salesFlow.lockOpportunityOnAccept: an accepted quotation fixes the deal's commercials. Values sent
  // unchanged (a full form save) are dropped; a real change is refused.
  if (rules.lockOpportunityOnAccept && existing.acceptedQuotationId) {
    const changed = COMMERCIAL_FIELDS.filter((key) => input[key] !== undefined && !sameCommercialValue(key, input[key], existing[key]));
    if (changed.length) {
      const error = appError('A quotation of this opportunity has been accepted — its services and prices can no longer be changed.', 409);
      error.code = 'OPPORTUNITY_LOCKED';
      throw error;
    }
    input = Object.fromEntries(Object.entries(input).filter(([key]) => !COMMERCIAL_FIELDS.includes(key)));
  }
  if (rules.hideShipping) {
    if (input.shippingCharge !== undefined) input = { ...input, shippingCharge: 0 };
  }
  if (rules.lockOpportunityContact) {
    const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
    const changed = ['contactId', 'contactPerson', 'contactEmail', 'contactMobile'].filter(
      (key) => input[key] !== undefined && !same(input[key], existing[key])
    );
    if (changed.length) {
      const error = appError(
        'The primary contact is fixed once the opportunity is created. An admin or manager can correct it, with a reason.',
        409
      );
      error.code = 'CONTACT_LOCKED';
      throw error;
    }
  }

  // Fixed lines (extension records are the source): only price and tax can change.
  if (input.products !== undefined) {
    input = { ...input, products: await require('./sales-flow.service').enforceFixedOpportunityLines(req, existing, input.products) };
  }

  const updates = { updatedBy: userId };
  if (input.title !== undefined) updates.title = input.title;
  if (input.products !== undefined) updates.products = input.products;
  if (input.shippingState !== undefined) updates.shippingState = input.shippingState;
  if (input.shippingCharge !== undefined) updates.shippingCharge = input.shippingCharge;
  if (input.probability !== undefined) updates.probability = input.probability;
  if (input.currency !== undefined) updates.currency = input.currency;
  if (input.exchangeRate !== undefined) updates.exchangeRate = input.exchangeRate;
  if (input.contactPerson !== undefined) updates.contactPerson = input.contactPerson;
  if (input.contactEmail !== undefined) updates.contactEmail = input.contactEmail;
  if (input.contactMobile !== undefined) updates.contactMobile = input.contactMobile;

  // Recompute money from whatever the record will hold after this edit.
  const nextProducts = input.products !== undefined ? input.products : existing.products || [];
  const nextShipping =
    input.shippingCharge !== undefined
      ? input.shippingCharge
      : Number(existing.shippingCharge) || 0;
  const nextProbability =
    input.probability !== undefined ? input.probability : Number(existing.probability) || 0;

  if (
    input.products !== undefined ||
    input.shippingCharge !== undefined ||
    input.probability !== undefined
  ) {
    const lineTotal = nextProducts.reduce((sum, line) => {
      const base = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
      return sum + base + (base * (Number(line.tax) || 0)) / 100;
    }, 0);
    const expectedRevenue = Math.round((lineTotal + (Number(nextShipping) || 0)) * 100) / 100;
    updates.expectedRevenue = expectedRevenue;
    updates.weightedRevenue =
      Math.round(expectedRevenue * (Number(nextProbability) / 100) * 100) / 100;
  }

  const doc = await Opportunity.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();
  if (!doc) throw appError('Opportunity update failed', 404);

  // Push contact changes onto the Contacts module record, when one is linked.
  let contactSynced = false;
  const contactTouched =
    input.contactPerson !== undefined ||
    input.contactEmail !== undefined ||
    input.contactMobile !== undefined;
  const wantsSync = input.syncContactRecord === undefined ? true : input.syncContactRecord;
  if (contactTouched && wantsSync && existing.contactId) {
    try {
      const PersonContactService = require('./person-contact.service');
      const patch = {};
      if (input.contactPerson !== undefined && input.contactPerson) {
        patch.name = input.contactPerson;
      }
      if (input.contactEmail !== undefined) patch.email = input.contactEmail;
      if (input.contactMobile !== undefined) patch.phone = input.contactMobile;
      if (Object.keys(patch).length) {
        await PersonContactService.update(req, String(existing.contactId), patch);
        contactSynced = true;
      }
    } catch (error) {
      // The deal is already saved; surface the contact failure without undoing it.
      console.error(
        '[plugin:openext-crm-suite] opportunity contact sync failed (deal already saved):',
        error
      );
    }
  }

  await AuditService.log(req, {
    action: 'updated',
    module: 'opportunity',
    recordId: String(doc._id),
    description: `Opportunity ${doc.opportunityNumber || doc._id} updated`,
    metadata: {
      fields: Object.keys(updates).filter((k) => k !== 'updatedBy'),
      contactSynced,
      expectedRevenue: updates.expectedRevenue ?? existing.expectedRevenue
    }
  });

  const [enriched] = await enrichOpportunities(req, [doc]);
  return { ...withCurrencyCode(enriched), contactSynced };
}

async function assignOwner(req, id, input) {
  const { isSalesManager, assertSalesAgentOpportunityAccess } = require('../utils/sales-access.util');
  if (!isSalesManager(req)) {
    throw appError(
      'Only admins and sales managers can reassign opportunity ownership',
      403
    );
  }

  const Opportunity = getOpportunityModel(req);
  const userId = resolveUserId(req);
  const existing = await Opportunity.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Opportunity not found', 404);
  assertSalesAgentOpportunityAccess(req, existing);

  const salesOwner = String(input.salesOwner || '').trim();
  if (!salesOwner) throw appError('Sales owner is required', 400);

  if (String(existing.salesOwner || '') === salesOwner) {
    const [enriched] = await enrichOpportunities(req, [existing]);
    return enriched;
  }

  const updated = await Opportunity.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { salesOwner, updatedBy: userId } },
    { new: true }
  ).lean();

  if (!updated) throw appError('Opportunity not found', 404);

  await AuditService.log(req, {
    action: 'updated',
    module: 'opportunity',
    recordId: String(updated._id),
    description: `Opportunity ${existing.opportunityNumber || id} reassigned to ${salesOwner}`,
    metadata: {
      previousOwner: existing.salesOwner || null,
      salesOwner,
      leadId: existing.leadId || null
    }
  });

  const [enriched] = await enrichOpportunities(req, [updated]);
  return enriched;
}

/**
 * Usecase: Advances opportunity across pipeline stages (Discovery ➔ Quotation Sent ➔ Won/Lost).
 * 
 * @param {Object} req Express request object
 * @param {string} id Opportunity ID
 * @param {Object} input Stage payload ({ stage, probability, lostReason })
 * @returns {Promise<Object>} Updated opportunity record
 */
async function changeStage(req, id, input, options = {}) {
  const Opportunity = getOpportunityModel(req);
  const userId = resolveUserId(req);
  const existing = await Opportunity.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Opportunity not found', 404);

  // Moving a deal along the board is a manager's call, as with a lead. The
  // stage changes the CRM makes itself — a quotation sent or accepted, a sales
  // order raised — write through their own sync helpers, not this function, so
  // a representative's own work still advances the board automatically.
  const { assertOpportunityStageChangeAllowed } = require('../utils/sales-access.util');
  if (!options.system) assertOpportunityStageChangeAllowed(req);

  const stageMeta = await applyStageMeta(
    req,
    input.stage,
    existing.pipelineId || input.pipelineId || null
  );
  const stage = stageMeta.label || normalizeOpportunityStageName(input.stage);

  // Lock stage only after an accepted quotation or sales order — multiple draft/sent quotes are allowed.
  if (
    existing.stage !== stage &&
    (existing.acceptedQuotationId || existing.generatedSalesOrderId)
  ) {
    const docType = existing.generatedSalesOrderId ? 'Sales Order' : 'accepted Quotation';
    throw appError(
      `Opportunity stage is locked because a ${docType} has already been generated from this deal.`,
      400
    );
  }

  const probability =
    input.probability !== undefined
      ? input.probability
      : Number(stageMeta.probability) || STAGE_PROBABILITIES[stage] || 50;
  const weightedRevenue = Math.round(existing.expectedRevenue * (probability / 100) * 100) / 100;

  const updates = {
    stage,
    stageType: stageMeta.type || 'OPEN',
    pipelineId: stageMeta.pipelineId || existing.pipelineId || null,
    probability,
    weightedRevenue,
    updatedBy: userId
  };

  if (isWonStage(stage, stageMeta.type)) {
    updates.closedAt = new Date();
    updates.lostReason = null;
  } else if (isLostStage(stage, stageMeta.type)) {
    updates.closedAt = new Date();
    updates.lostReason = input.lostReason;
  } else {
    updates.closedAt = null;
    updates.lostReason = null;
  }

  const updated = await Opportunity.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'opportunity',
    recordId: String(id),
    description: `Opportunity ${existing.opportunityNumber} stage moved from "${existing.stage}" to "${stage}" (${probability}%)`,
    metadata: { oldStage: existing.stage, newStage: stage, probability, lostReason: input.lostReason }
  });

  const [enriched] = await enrichOpportunities(req, [updated]);
  return enriched;
}

/**
 * When a quotation linked to an opportunity is sent, advance that deal to Quotation Sent.
 * Skips Won/Lost and never moves the deal backwards.
 */
async function syncOpportunityQuotationSent(req, quotation) {
  const opportunityId = String(quotation?.opportunityId || quotation?.dealId || '').trim();
  if (!opportunityId) return null;

  const Opportunity = getOpportunityModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const existing = await Opportunity.findOne({
    tenantId,
    _id: opportunityId,
    isDeleted: false
  }).lean();
  if (!existing) return null;
  if (existing.acceptedQuotationId) return existing;

  if (isWonStage(existing.stage, existing.stageType) || isLostStage(existing.stage, existing.stageType)) {
    return null;
  }

  const targetMeta = await applyStageMeta(
    req,
    await resolveStageLabelByType(req, 'QUOTATION_SENT', existing.pipelineId, 'Quotation Sent'),
    existing.pipelineId
  );
  const targetStage = targetMeta.label || 'Quotation Sent';
  if (String(existing.stageType || '').toUpperCase() === 'QUOTATION_SENT') return existing;
  if (normalizeOpportunityStageName(existing.stage).toLowerCase() === targetStage.toLowerCase()) {
    return existing;
  }

  let currentRank = opportunityStageRank(existing.stage);
  let targetRank = opportunityStageRank(targetStage);
  if (existing.pipelineId) {
    try {
      const OpportunityPipelineService = require('./opportunity-pipeline.service');
      const pipeline = await OpportunityPipelineService.getById(req, existing.pipelineId).catch(() => null);
      if (pipeline && Array.isArray(pipeline.stages)) {
        const curIdx = pipeline.stages.findIndex((s) => String(s.label || '').toLowerCase() === String(existing.stage || '').toLowerCase());
        const tgtIdx = pipeline.stages.findIndex((s) => String(s.label || '').toLowerCase() === String(targetStage || '').toLowerCase());
        if (curIdx >= 0 && tgtIdx >= 0) {
          currentRank = curIdx;
          targetRank = tgtIdx;
        }
      }
    } catch {
      /* fallback to standard order */
    }
  }
  if (currentRank > targetRank && currentRank >= 0 && targetRank >= 0) return null;

  const probability = Number(targetMeta.probability) || STAGE_PROBABILITIES[targetStage] || 95;
  const expectedRevenue = Number(existing.expectedRevenue || existing.value || 0);
  const weightedRevenue = Math.round(expectedRevenue * (probability / 100) * 100) / 100;

  const updated = await Opportunity.findOneAndUpdate(
    { tenantId, _id: opportunityId, isDeleted: false },
    {
      $set: {
        stage: targetStage,
        stageType: 'QUOTATION_SENT',
        pipelineId: targetMeta.pipelineId || existing.pipelineId || null,
        probability,
        weightedRevenue,
        closedAt: null,
        lostReason: null,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'opportunity',
    recordId: String(opportunityId),
    description: `Opportunity ${existing.opportunityNumber || opportunityId} moved to "${targetStage}" because quotation ${quotation.quotationNo || quotation._id || ''} was sent`,
    metadata: {
      oldStage: existing.stage,
      newStage: targetStage,
      stageType: 'QUOTATION_SENT',
      quotationId: String(quotation._id || ''),
      quotationNo: quotation.quotationNo || null
    }
  });

  if (existing.leadId) {
    try {
      const QuotationService = require('./quotation.service');
      if (typeof QuotationService.syncLeadQuotationSent === 'function') {
        await QuotationService.syncLeadQuotationSent(req, quotation, existing.leadId);
      }
    } catch (err) {
      console.warn('[plugin:openext-crm-suite] opportunity -> lead Proposal Sent sync failed:', err?.message || err);
    }
  }

  return updated;
}

/**
 * Move opportunity to Negotiation when a quotation is created or not accepted
 * (rejected / declined). Does not reopen Won/Lost or accepted deals.
 */
async function syncOpportunityQuotationNegotiation(req, quotation, reason = 'quotation_cycle') {
  const opportunityId = String(quotation?.opportunityId || quotation?.dealId || '').trim();
  if (!opportunityId) return null;

  const Opportunity = getOpportunityModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const existing = await Opportunity.findOne({
    tenantId,
    _id: opportunityId,
    isDeleted: false
  }).lean();
  if (!existing) return null;
  if (existing.acceptedQuotationId) return existing;

  if (isWonStage(existing.stage, existing.stageType) || isLostStage(existing.stage, existing.stageType)) {
    return null;
  }

  const targetMeta = await applyStageMeta(
    req,
    await resolveStageLabelByType(req, 'NEGOTIATION', existing.pipelineId, 'Negotiation'),
    existing.pipelineId
  );
  const targetStage = targetMeta.label || 'Negotiation';
  if (
    String(existing.stageType || '').toUpperCase() === 'NEGOTIATION' ||
    normalizeOpportunityStageName(existing.stage).toLowerCase() === targetStage.toLowerCase()
  ) {
    // Still refresh latest quotation pointer when provided.
    if (quotation?._id) {
      await Opportunity.updateOne(
        { tenantId, _id: opportunityId, isDeleted: false },
        {
          $set: {
            generatedQuotationId: String(quotation._id),
            updatedBy: userId || existing.updatedBy || 'system'
          }
        }
      );
    }
    return existing;
  }

  const probability = Number(targetMeta.probability) || STAGE_PROBABILITIES[targetStage] || 85;
  const expectedRevenue = Number(existing.expectedRevenue || existing.value || 0);
  const weightedRevenue = Math.round(expectedRevenue * (probability / 100) * 100) / 100;
  const updates = {
    stage: targetStage,
    stageType: 'NEGOTIATION',
    pipelineId: targetMeta.pipelineId || existing.pipelineId || null,
    probability,
    weightedRevenue,
    closedAt: null,
    lostReason: null,
    updatedBy: userId || 'system'
  };
  if (quotation?._id) updates.generatedQuotationId = String(quotation._id);

  const updated = await Opportunity.findOneAndUpdate(
    { tenantId, _id: opportunityId, isDeleted: false },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'opportunity',
    recordId: String(opportunityId),
    description: `Opportunity ${existing.opportunityNumber || opportunityId} moved to "${targetStage}" (${reason})`,
    metadata: {
      oldStage: existing.stage,
      newStage: targetStage,
      quotationId: quotation?._id ? String(quotation._id) : null,
      quotationNo: quotation?.quotationNo || null,
      reason
    }
  });

  return updated;
}

/**
 * When a quotation linked to an opportunity is accepted (staff or client portal),
 * mark that deal as Won and store the accepted quotation as final.
 * Skips Lost deals and is a no-op if already Won with the same accepted quote.
 */
async function syncOpportunityQuotationAccepted(req, quotation) {
  const opportunityId = String(quotation?.opportunityId || quotation?.dealId || '').trim();
  if (!opportunityId) return null;

  const Opportunity = getOpportunityModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const existing = await Opportunity.findOne({
    tenantId,
    _id: opportunityId,
    isDeleted: false
  }).lean();
  if (!existing) return null;

  if (isLostStage(existing.stage, existing.stageType)) return null;

  const quotationId = String(quotation?._id || '').trim();
  if (
    existing.acceptedQuotationId &&
    quotationId &&
    String(existing.acceptedQuotationId) !== quotationId
  ) {
    throw appError(
      'This opportunity already has an accepted quotation. Only one quotation can be accepted per opportunity.',
      409
    );
  }

  if (isWonStage(existing.stage, existing.stageType) && existing.acceptedQuotationId) {
    return existing;
  }

  const targetMeta = await applyStageMeta(
    req,
    await resolveStageLabelByType(req, 'WON', existing.pipelineId, 'Won'),
    existing.pipelineId
  );
  const targetStage = targetMeta.label || 'Won';
  const probability = Number(targetMeta.probability) || STAGE_PROBABILITIES[targetStage] || 100;
  const expectedRevenue = Number(existing.expectedRevenue || existing.value || 0);
  const weightedRevenue = Math.round(expectedRevenue * (probability / 100) * 100) / 100;

  const updated = await Opportunity.findOneAndUpdate(
    { tenantId, _id: opportunityId, isDeleted: false },
    {
      $set: {
        stage: targetStage,
        stageType: 'WON',
        pipelineId: targetMeta.pipelineId || existing.pipelineId || null,
        probability,
        weightedRevenue,
        closedAt: new Date(),
        lostReason: null,
        acceptedQuotationId: quotationId || existing.acceptedQuotationId || null,
        generatedQuotationId: quotationId || existing.generatedQuotationId || null,
        updatedBy: userId || 'system'
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'opportunity',
    recordId: String(opportunityId),
    description: `Opportunity ${existing.opportunityNumber || opportunityId} moved to "${targetStage}" because quotation ${quotation.quotationNo || quotation._id || ''} was accepted`,
    metadata: {
      oldStage: existing.stage,
      newStage: targetStage,
      stageType: 'WON',
      quotationId: quotationId || null,
      quotationNo: quotation.quotationNo || null,
      acceptedQuotationId: quotationId || null
    }
  });

  return updated;
}

/**
 * salesFlow.completeOpportunitiesOnConversion: when a lead becomes a client, its other open opportunities
 * are completed — moved to the pipeline's Won stage, each audited. History is kept. Never throws.
 * @param {{ exceptOpportunityId?: string }} options  the deal whose quotation was just accepted (synced by itself)
 */
async function completeOpenOpportunitiesForLead(req, leadId, options = {}) {
  try {
    const id = String(leadId || '').trim();
    if (!id) return [];
    const rules = await require('./sales-flow.service').recordRules(req);
    if (!rules.completeOpportunitiesOnConversion) return [];
    const Opportunity = getOpportunityModel(req);
    const tenantId = resolveTenantId(req);
    const except = String(options.exceptOpportunityId || '').trim();
    const rows = await Opportunity.find({ tenantId, leadId: id, isDeleted: false }).lean();
    const done = [];
    for (const row of rows || []) {
      if (String(row._id) === except) continue;
      if (isWonStage(row.stage, row.stageType) || isLostStage(row.stage, row.stageType)) continue;
      const meta = await applyStageMeta(req, await resolveStageLabelByType(req, 'WON', row.pipelineId, 'Won'), row.pipelineId);
      const stage = meta.label || 'Won';
      const probability = Number(meta.probability) || STAGE_PROBABILITIES[stage] || 100;
      const revenue = Number(row.expectedRevenue || row.value || 0);
      const updated = await Opportunity.findOneAndUpdate(
        { tenantId, _id: row._id, isDeleted: false, stage: row.stage },
        {
          $set: {
            stage,
            stageType: 'WON',
            pipelineId: meta.pipelineId || row.pipelineId || null,
            probability,
            weightedRevenue: Math.round(revenue * (probability / 100) * 100) / 100,
            closedAt: new Date(),
            lostReason: null,
            closedReason: 'lead_converted',
            updatedBy: resolveUserId(req) || 'system'
          }
        },
        { new: true }
      ).lean();
      if (!updated) continue;
      done.push(String(row._id));
      await AuditService.log(req, {
        action: 'stage_changed',
        module: 'opportunity',
        recordId: String(row._id),
        description: `Opportunity ${row.opportunityNumber || row._id} moved to "${stage}": its lead was converted to a client`,
        metadata: { oldStage: row.stage, newStage: stage, stageType: 'WON', leadId: id, reason: 'lead_converted' }
      });
    }
    return done;
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] completing opportunities after lead conversion failed:', err?.message || err);
    return [];
  }
}

/**
 * sdk.workflow.opportunityStage: the active extension moves a deal of its pipeline forward to one of its
 * own open stages (manifest pipelineStages id). Never backwards, never to / from Won or Lost, never
 * once a quotation is accepted. Audited. → { moved, stage }
 */
async function advanceToExtensionStage(req, opportunityId, { extensionId, stageId, reason } = {}) {
  const Opportunity = getOpportunityModel(req);
  const tenantId = resolveTenantId(req);
  const existing = await Opportunity.findOne({ tenantId, _id: String(opportunityId), isDeleted: false }).lean();
  if (!existing) return { moved: false, stage: '', reason: 'not_found' };
  if (existing.acceptedQuotationId || isWonStage(existing.stage, existing.stageType) || isLostStage(existing.stage, existing.stageType)) {
    return { moved: false, stage: existing.stage, reason: 'closed' };
  }
  const PipelineService = require('./opportunity-pipeline.service');
  const pipeline = existing.pipelineId ? await PipelineService.getById(req, existing.pipelineId).catch(() => null) : null;
  const ownPipeline =
    pipeline && (String(pipeline.extensionId || '') === `crm:${extensionId}` || String(pipeline.extensionId || '') === String(extensionId));
  if (!ownPipeline || !Array.isArray(pipeline.stages)) return { moved: false, stage: existing.stage, reason: 'other_pipeline' };
  const stages = pipeline.stages;
  const target = stages.find((s) => String(s.id) === String(stageId));
  if (!target || ['WON', 'LOST'].includes(String(target.type || '').toUpperCase())) {
    return { moved: false, stage: existing.stage, reason: 'unknown_stage' };
  }
  const lower = (v) => String(v || '').trim().toLowerCase();
  const cur = stages.findIndex((s) => lower(s.label) === lower(existing.stage));
  const tgt = stages.indexOf(target);
  if (cur >= tgt) return { moved: false, stage: existing.stage, reason: 'already_there' };
  const probability = Number(target.probability) || 50;
  const revenue = Number(existing.expectedRevenue || existing.value || 0);
  const updated = await Opportunity.findOneAndUpdate(
    { tenantId, _id: existing._id, isDeleted: false, stage: existing.stage },
    {
      $set: {
        stage: target.label,
        stageType: String(target.type || 'OPEN').toUpperCase(),
        probability,
        weightedRevenue: Math.round(revenue * (probability / 100) * 100) / 100,
        updatedBy: resolveUserId(req) || 'system'
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { moved: false, stage: existing.stage, reason: 'changed' };
  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'opportunity',
    recordId: String(existing._id),
    description: `Opportunity ${existing.opportunityNumber || existing._id} moved from "${existing.stage}" to "${target.label}"${reason ? ` (${String(reason).slice(0, 120)})` : ''}`,
    metadata: { oldStage: existing.stage, newStage: target.label, extensionId, stageId: String(stageId) }
  });
  return { moved: true, stage: target.label };
}

async function assertCanCreateQuotation(req, opportunityId) {
  const id = String(opportunityId || '').trim();
  if (!id) return null;
  const Opportunity = getOpportunityModel(req);
  let existing = null;
  if (typeof Opportunity.findOne === 'function') {
    existing = await Opportunity.findOne({ ...baseFilter(req), _id: id }).lean();
  } else if (typeof Opportunity.findById === 'function') {
    existing = await Opportunity.findById(id).lean();
  } else if (typeof Opportunity.find === 'function') {
    const res = Opportunity.find({ ...baseFilter(req), _id: id });
    const selectRes = typeof res?.select === 'function' ? res.select() : res;
    const list = typeof selectRes?.lean === 'function' ? await selectRes.lean() : await selectRes;
    existing = Array.isArray(list) ? list[0] : list;
  }
  if (!existing) throw appError('Opportunity not found', 404);

  if (existing.acceptedQuotationId) {
    throw appError(
      'A quotation has already been accepted for this opportunity. New quotations cannot be created — use a controlled revision/cancellation workflow instead.',
      409
    );
  }
  if (isWonStage(existing.stage, existing.stageType)) {
    throw appError(
      'This opportunity is Won. New quotations cannot be created for a closed-won deal.',
      409
    );
  }
  if (isLostStage(existing.stage, existing.stageType)) {
    throw appError('Quotations cannot be created for a Lost opportunity.', 409);
  }
  if (existing.generatedSalesOrderId) {
    throw appError(
      'A sales order already exists for this opportunity. New quotations cannot be created.',
      409
    );
  }

  await assertQuotableAmount(req, existing);

  return existing;
}

/**
 * A quotation may only be raised for a deal that carries a real, in-budget amount.
 *
 * Zero is refused outright — a ₹0 quotation is never a document anybody wants
 * sent to a client, and it silently produces ₹0 sales orders and invoices
 * downstream. When the deal came from a lead, the Request Type's budget range
 * is enforced too, with the same wording the convert-to-opportunity modal uses.
 */
async function assertQuotableAmount(req, opportunity) {
  const label = opportunity.opportunityNumber || opportunity.title || 'This opportunity';
  const amount =
    Number(
      opportunity.estimatedDealValue != null
        ? opportunity.estimatedDealValue
        : opportunity.expectedRevenue
    ) || Number(opportunity.value) || 0;

  if (!(amount > 0)) {
    throw appError(
      `${label} has an amount of \u20b90, so no quotation can be created. Add prices to the products (or set the estimated deal value) first.`,
      409
    );
  }

  const leadId = String(opportunity.leadId || '').trim();
  if (!leadId) return;

  let leadDoc = null;
  try {
    const LeadService = require('./lead.service');
    leadDoc = await LeadService.getById(req, leadId, { includeQuality: false });
  } catch {
    // An unreadable lead must not block the quotation; the zero rule still held.
    return;
  }

  const range = await resolveLeadBudgetRange(req, leadDoc);
  const problem = describeOutOfRange(range, amount);
  if (problem) {
    throw appError(`${problem}. Update the deal amount before creating a quotation.`, 409);
  }
}

/**
 * Creates a quotation linked to an opportunity (multi-quote cycle until one is accepted).
 */
async function convertToQuotation(req, id) {
  const Opportunity = getOpportunityModel(req);
  const QuotationService = require('./quotation.service');
  const LeadService = require('./lead.service');
  const userId = resolveUserId(req);

  const existing = await assertCanCreateQuotation(req, id);

  let clientId = String(existing.clientId || '').trim();
  const leadId = String(existing.leadId || '').trim();
  if (!clientId && !leadId) {
    throw appError('Link a client or lead before creating a quotation for this opportunity', 400);
  }

  let lead = null;
  if (leadId) {
    try {
      lead = await LeadService.getById(req, leadId, { includeQuality: false });
    } catch {
      lead = null;
    }
  }

  if (!clientId && lead?.convertedClientId) {
    clientId = String(lead.convertedClientId).trim();
  }

  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req);
  const defaultTax = Number(settings.tax_rate ?? 18);

  const lineItems = (existing.products || []).map((p) => ({
    description: p.productName || existing.title,
    qty: p.quantity || 1,
    rate: p.unitPrice || 0,
    tax: p.tax !== undefined && p.tax !== null ? Number(p.tax) : defaultTax
  }));

  if (!lineItems.length) {
    lineItems.push({
      description: existing.title,
      qty: 1,
      rate: existing.expectedRevenue,
      tax: defaultTax
    });
  }

  const leadLabel = lead
    ? (lead.company || lead.contactName || lead.name || '')
    : '';
  const contactBits = [
    existing.contactPerson || lead?.name || '',
    existing.contactEmail || lead?.email || '',
    existing.contactMobile || lead?.phone || ''
  ].filter(Boolean);

  const quotation = await QuotationService.create(req, {
    clientId: clientId || undefined,
    leadId: leadId || undefined,
    opportunityId: String(id),
    dealId: String(id),
    title: existing.title || '',
    // Inherit deal currency — do not replace with global default.
    currency: existing.currency || existing.currencyCode || undefined,
    exchangeRate: existing.exchangeRate,
    shippingState: existing.shippingState || undefined,
    shippingCharge: existing.shippingCharge !== undefined ? existing.shippingCharge : undefined,
    issueDate: new Date().toISOString().slice(0, 10),
    lineItems,
    notes: `Generated from Opportunity ${existing.opportunityNumber || id}: ${existing.title}`,
    recipientNotes: [
      leadId ? `Lead: ${leadLabel || leadId}` : '',
      contactBits.length ? `Contact: ${contactBits.join(' · ')}` : ''
    ]
      .filter(Boolean)
      .join('\n'),
    // create() already syncs Negotiation — skip double sync via flag
    _skipOpportunitySync: true
  });

  await Opportunity.updateOne(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        generatedQuotationId: quotation._id.toString(),
        updatedBy: userId
      }
    }
  );

  await syncOpportunityQuotationNegotiation(req, quotation, 'quotation_created');

  await AuditService.log(req, {
    action: 'converted_to_quotation',
    module: 'opportunity',
    recordId: String(id),
    description: `Opportunity ${existing.opportunityNumber} quotation created: ${quotation.quotationNo || quotation.number || ''}`,
    metadata: {
      quotationId: String(quotation._id),
      leadId: leadId || null,
      clientId: clientId || null
    }
  });

  return quotation;
}

/**
 * Soft deletes an opportunity record.
 * 
 * Usecase: Deletes an opportunity that has not been closed into real business.
 *
 * A deal becomes a financial record the moment it is won: the quotation the
 * customer accepted, the sales order raised from it and the won-revenue figures
 * in every report all point back at it. Deleting it then would leave those
 * documents orphaned and quietly change past revenue, so each closed state is
 * refused here. The same states already block a new quotation in
 * `assertCanCreateQuotation`.
 * 
 * @param {Object} req Express request object
 * @param {string} id Opportunity ID
 * @returns {Promise<Object>} Deletion result
 */
async function remove(req, id) {
  const Opportunity = getOpportunityModel(req);
  const userId = resolveUserId(req);

  const existing = await Opportunity.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Opportunity not found', 404);

  const label = existing.opportunityNumber || id;
  if (existing.generatedSalesOrderId) {
    throw appError(
      `Opportunity ${label} cannot be deleted because a sales order has been generated from it. Cancel the sales order first.`,
      409
    );
  }
  if (existing.acceptedQuotationId) {
    throw appError(
      `Opportunity ${label} cannot be deleted because a quotation has been accepted on it.`,
      409
    );
  }
  if (isWonOpportunity(existing)) {
    throw appError(
      `Opportunity ${label} is Won and cannot be deleted. Move it to another stage first if it was closed by mistake.`,
      409
    );
  }

  const doc = await Opportunity.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId } },
    { new: true }
  ).lean();

  if (!doc) throw appError('Opportunity not found', 404);

  await AuditService.log(req, {
    action: 'deleted',
    module: 'opportunity',
    recordId: String(id),
    description: `Opportunity ${doc.opportunityNumber} deleted`
  });

  return { success: true, message: 'Opportunity deleted successfully' };
}

/**
 * Exports opportunities as CSV or JSON.
 *
 * Carries exactly the visibility rules of the list screen: a client portal user
 * gets their own account's deals, a sales agent gets the deals they created, own
 * or that hang off their leads, and everyone else gets the tenant. Without this
 * the export was a way around the list scope — one click handed a sales
 * representative every deal in the tenant with its revenue and owner.
 */
async function exportOpportunities(req, query = {}) {
  const Opportunity = getOpportunityModel(req);
  const filter = baseFilter(req);

  const { isClientUser } = require('../utils/tenant.util');
  const { resolvePortalIdentity, portalScopeFilter } = require('../utils/portal-identity.util');
  const clientUser = isClientUser(req);
  if (clientUser) {
    const identity = await resolvePortalIdentity(req);
    const portalScope = portalScopeFilter(identity);
    // An unresolved portal login owns no deals; match nothing rather than the tenant.
    Object.assign(filter, portalScope || { clientId: '__UNLINKED_CLIENT_NO_MATCH__' });
  }

  if (query.stage) filter.stage = String(query.stage).trim();
  // A portal user's own account always wins over a clientId asked for in the query.
  if (query.clientId && !clientUser) {
    filter.clientId = String(query.clientId).trim();
  }
  if (query.salesOwner) filter.salesOwner = String(query.salesOwner).trim();
  if (query.search) {
    const s = String(query.search).trim();
    filter.$or = [
      { name: new RegExp(s, 'i') },
      { title: new RegExp(s, 'i') },
      { opportunityNumber: new RegExp(s, 'i') }
    ];
  }

  const { applySalesAgentOpportunityListScope } = require('../utils/sales-access.util');
  const finalFilter = await applySalesAgentOpportunityListScope(req, filter, getLeadModel);

  const raw = await Opportunity.find(finalFilter).sort({ createdAt: -1 }).lean();
  const enriched = await enrichOpportunities(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'opportunity',
    recordId: 'export',
    description: `Exported ${enriched.length} opportunities in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `opportunities_export_${nowStr}.json`,
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
    'Opportunity Number',
    'Title',
    'Client / Company',
    'Contact Person',
    'Stage',
    'Amount',
    'Probability (%)',
    'Weighted Value',
    'Expected Close Date',
    'Sales Owner',
    'Source',
    'Created At',
    'Updated At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const item of enriched) {
    const amount = Number(item.amount || item.value || 0);
    const prob = Number(item.probability || 0);
    const weighted = Math.round((amount * prob) / 100);
    rows.push(
      [
        item._id,
        item.opportunityNumber || '',
        item.title || item.name || '',
        item.clientCompany || '',
        item.contactPerson || '',
        item.stage || '',
        amount,
        prob,
        weighted,
        item.expectedCloseDate ? new Date(item.expectedCloseDate).toISOString().slice(0, 10) : '',
        item.salesOwnerName || item.salesOwner || '',
        item.source || '',
        item.createdAt ? new Date(item.createdAt).toISOString() : '',
        item.updatedAt ? new Date(item.updatedAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `opportunities_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

/**
 * Correct a locked primary contact (salesFlow.lockOpportunityContact): admins and sales managers only,
 * with a reason, on the opportunity's own contact details. The link to the lead / contact record stays.
 * Audited with the fields changed and the reason (not the old or new personal details).
 */
async function correctContact(req, id, input = {}) {
  const { isAdmin, isSalesManager } = require('../utils/sales-access.util');
  if (!isAdmin(req) && !isSalesManager(req)) {
    throw appError('Only an admin or a sales manager can correct the primary contact', 403);
  }
  const Opportunity = getOpportunityModel(req);
  const existing = await Opportunity.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Opportunity not found', 404);
  const reason = String(input.reason || '').trim();
  if (reason.length < 10 || reason.length > 500) throw appError('Give a reason for the correction (10–500 characters)', 400);
  if (input.confirm !== true) throw appError('Confirm the correction', 400);

  const updates = {};
  for (const key of ['contactPerson', 'contactEmail', 'contactMobile']) {
    if (input[key] === undefined) continue;
    const value = String(input[key] || '').trim().slice(0, 200);
    if (value !== String(existing[key] || '').trim()) updates[key] = value;
  }
  if (updates.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.contactEmail)) throw appError('Enter a valid email', 400);
  if (updates.contactPerson === '') throw appError('The contact name cannot be empty', 400);
  if (!Object.keys(updates).length) throw appError('Nothing to correct', 400);

  const userId = resolveUserId(req);
  const doc = await Opportunity.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { ...updates, updatedBy: userId } },
    { new: true }
  ).lean();
  await AuditService.log(req, {
    action: 'contact_corrected',
    module: 'opportunity',
    recordId: String(id),
    description: `Primary contact corrected (${Object.keys(updates).join(', ')})`,
    metadata: { fields: Object.keys(updates), reason, contactId: existing.contactId || null }
  });
  return doc;
}

/**
 * GET /opportunities/start-stage?leadId= — the stage a new opportunity for this lead opens in
 * (salesFlow.opportunityForm.startStage). { locked: false } without that contract.
 */
async function getStartStage(req, leadId) {
  const id = String(leadId || '').trim();
  if (id && !/^[a-f0-9]{24}$/i.test(id)) throw appError('leadId is not valid', 400);
  // The lead must be one this user may see (tenant and sales access), before its readiness is told.
  if (id) await require('./lead.service').getById(req, id, { includeQuality: false });
  const start = await opportunityStartStage(req, id || null);
  if (!start.locked) return { locked: false };
  return {
    locked: true,
    stage: start.stage,
    probability: start.probability,
    startStage: start.startStage,
    readyStage: start.readyStage,
    ready: start.ready,
    reasons: start.reasons
  };
}

module.exports = {
  getStartStage,
  advanceToExtensionStage,
  completeOpenOpportunitiesForLead,
  opportunityInvoiceMap,
  assertOpportunityNotInvoiced,
  correctContact,
  list,
  update,
  resolvePipelineIdForLead,
  getSummary,
  getById,
  create,
  assignOwner,
  changeStage,
  convertToQuotation,
  assertCanCreateQuotation,
  assertQuotableAmount,
  syncOpportunityQuotationSent,
  syncOpportunityQuotationNegotiation,
  syncOpportunityQuotationAccepted,
  remove,
  exportOpportunities
};
