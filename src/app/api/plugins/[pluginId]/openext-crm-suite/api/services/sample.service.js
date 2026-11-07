'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { resolveUsernames } = require('../utils/user.util');
const AuditService = require('./audit.service');
const LeadService = require('./lead.service');
const ClientService = require('./client.service');
const { EDITABLE_SAMPLE_STATUSES } = require('../validation/sample.schema');

function getSampleModel(req) {
  const Sample = req.cms?.models.get('SampleRequest');
  if (!Sample) throw new Error('SampleRequest model is not registered');
  return Sample;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
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
  const key = String(stage || '').trim();
  const idx = OPPORTUNITY_STAGE_ORDER.findIndex(
    (s) => s.toLowerCase() === key.toLowerCase()
  );
  return idx >= 0 ? idx : -1;
}

/**
 * When a client approves an opportunity-linked sample (via feedback),
 * advance that opportunity to the Sample Approved stage.
 */
async function syncOpportunitySampleApproved(req, sample, feedbackInput = {}) {
  const opportunityId = String(sample?.opportunityId || '').trim();
  if (!opportunityId) return null;

  const rating = Number(feedbackInput.rating);
  const interested = feedbackInput.interestedInOrder;
  const requiresImprovement = Boolean(feedbackInput.requiresImprovement);

  // Client sample approval: interested in order, or solid rating without rejecting.
  const approvedByClient =
    interested === true ||
    (interested !== false && Number.isFinite(rating) && rating >= 3 && !requiresImprovement);

  if (!approvedByClient) return null;

  const Opportunity = req.cms?.models.get('Opportunity');
  if (!Opportunity) return null;

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const existing = await Opportunity.findOne({
    tenantId,
    _id: opportunityId,
    isDeleted: false
  }).lean();
  if (!existing) return null;

  const current = String(existing.stage || '').trim();
  if (/^(won|lost)$/i.test(current)) return null;
  if (existing.acceptedQuotationId || existing.generatedSalesOrderId) return null;

  const targetStage = 'Sample Approved';
  const currentRank = opportunityStageRank(current);
  const targetRank = opportunityStageRank(targetStage);
  // Do not move backwards if deal is already past Sample Approved.
  if (currentRank > targetRank) return null;
  if (currentRank === targetRank) return existing;

  const { STAGE_PROBABILITIES } = require('../validation/opportunity.schema');
  const probability = STAGE_PROBABILITIES[targetStage] ?? 55;
  const expectedRevenue = Number(existing.expectedRevenue || 0);
  const weightedRevenue = Math.round(expectedRevenue * (probability / 100) * 100) / 100;

  const updated = await Opportunity.findOneAndUpdate(
    { tenantId, _id: opportunityId, isDeleted: false },
    {
      $set: {
        stage: targetStage,
        probability,
        weightedRevenue,
        closedAt: null,
        lostReason: null,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (updated) {
    await AuditService.log(req, {
      action: 'stage_changed',
      module: 'opportunity',
      recordId: String(opportunityId),
      description: `Opportunity ${existing.opportunityNumber || opportunityId} moved to Sample Approved after client approved sample ${sample.sampleNumber || sample._id}`,
      metadata: {
        from: current,
        to: targetStage,
        sampleId: String(sample._id),
        sampleNumber: sample.sampleNumber || null,
        rating: Number.isFinite(rating) ? rating : null,
        interestedInOrder: interested
      }
    });
  }

  return updated;
}

/**
 * Generates unique sample tracking number formatted as SMP-YYYY-XXXX.
 * 
 * Usecase: Assigns human-readable identifier to sample requests.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<string>} Generated sample number
 */
async function generateSampleNumber(req) {
  const Sample = getSampleModel(req);
  const year = new Date().getFullYear();
  const prefix = `SMP-${year}-`;
  const count = await Sample.countDocuments({
    tenantId: resolveTenantId(req),
    sampleNumber: { $regex: `^${prefix}` }
  });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

/**
 * Enriches sample records with Lead, Client, and User usernames.
 * 
 * Usecase: Attaches context to sample items before returning to UI.
 * 
 * @param {Object} req Express request object
 * @param {Array} items Raw sample request items
 * @returns {Promise<Array>} Enriched sample items
 */
async function enrichSamples(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const userIds = [...new Set(items.map((i) => String(i.createdBy || '').trim()))].filter(Boolean);
  const nameMap = await resolveUsernames(req, userIds);

  const Lead = req.cms?.models.get('Lead');
  const Client = req.cms?.models.get('Client') || req.cms?.models.get('Company');
  const Opportunity = req.cms?.models.get('Opportunity');
  const leadMap = {};
  const clientMap = {};
  const opportunityMap = {};
  const tenantId = resolveTenantId(req);

  if (Lead) {
    const leadIds = [...new Set(items.map((i) => String(i.leadId || '')))].filter(Boolean);
    if (leadIds.length) {
      const leads = await Lead.find({ tenantId, _id: { $in: leadIds } })
        .select('company name contactName email phone mobile')
        .lean();
      leads.forEach((l) => { leadMap[String(l._id)] = l; });
    }
  }

  if (Client) {
    const clientIds = [...new Set(items.map((i) => String(i.clientId || '')))].filter(Boolean);
    if (clientIds.length) {
      const clients = await Client.find({ tenantId, _id: { $in: clientIds } })
        .select('name companyName contactPerson email phone mobile')
        .lean();
      clients.forEach((c) => { clientMap[String(c._id)] = c; });
    }
  }

  if (Opportunity) {
    const opportunityIds = [...new Set(items.map((i) => String(i.opportunityId || '')))].filter(Boolean);
    if (opportunityIds.length) {
      const opps = await Opportunity.find({ tenantId, _id: { $in: opportunityIds }, isDeleted: { $ne: true } })
        .select('title opportunityNumber clientId leadId contactPerson contactEmail contactMobile')
        .lean();
      opps.forEach((o) => { opportunityMap[String(o._id)] = o; });
    }
  }

  return items.map((item) => {
    const lead = leadMap[String(item.leadId || '')];
    const client = clientMap[String(item.clientId || '')];
    const opportunity = opportunityMap[String(item.opportunityId || '')];
    const opportunityLabel = opportunity
      ? `${opportunity.opportunityNumber ? `${opportunity.opportunityNumber} · ` : ''}${opportunity.title || 'Opportunity'}`
      : '';
    const linkedName = opportunityLabel
      || (lead ? `${lead.company || ''} (${lead.contactName || lead.name || ''})`.trim() : '')
      || client?.name
      || client?.companyName
      || item.recipientName
      || '—';
    const linkType = item.opportunityId
      ? 'opportunity'
      : item.clientId && !item.leadId
        ? 'client'
        : item.leadId
          ? 'lead'
          : (item.linkType || 'lead');
    return {
      ...item,
      linkType,
      linkedName,
      createdByName: nameMap[item.createdBy] || item.createdBy || 'System',
      leadCompany: lead?.company || '—',
      leadContact: lead?.contactName || lead?.name || '—',
      clientCompany: client?.name || client?.companyName || '—',
      clientContact: client?.contactPerson || client?.email || '—',
      opportunityTitle: opportunity?.title || null,
      opportunityNumber: opportunity?.opportunityNumber || null
    };
  });
}

/**
 * Lists sample requests with optional status, lead, or client filters.
 * 
 * Usecase: Provides paginated list of sample requests for management page.
 * 
 * @param {Object} req Express request object containing query parameters
 * @returns {Promise<Object>} Enriched sample request items and pagination
 */
async function list(req) {
  const Sample = getSampleModel(req);
  const { page, limit, skip } = parsePagination(req.query);
  const filter = baseFilter(req);

  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
    portalScopeFilter,
    PORTAL_UNLINKED_MESSAGE
  } = require('../utils/portal-identity.util');
  if (isClientUser(req)) {
    const identity = await resolvePortalIdentity(req);
    const scope = portalScopeFilter(identity);
    if (!scope) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: PORTAL_UNLINKED_MESSAGE
      };
    }
    Object.assign(filter, scope);
  } else if (req.query?.clientId) {
    filter.clientId = String(req.query.clientId).trim();
  }

  if (req.query?.status) filter.status = String(req.query.status).trim();
  if (req.query?.leadId) filter.leadId = String(req.query.leadId).trim();
  if (req.query?.opportunityId) filter.opportunityId = String(req.query.opportunityId).trim();
  if (req.query?.search) {
    const {
      toLiteralSearchTerm,
      findMatchingClientIds,
      findMatchingLeadIds
    } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const or = [
        { sampleNumber: { $regex: term, $options: 'i' } },
        { productName: { $regex: term, $options: 'i' } },
        { trackingNumber: { $regex: term, $options: 'i' } },
        { courier: { $regex: term, $options: 'i' } },
        { recipientName: { $regex: term, $options: 'i' } },
        { clientId: { $regex: term, $options: 'i' } },
        { leadId: { $regex: term, $options: 'i' } },
        { opportunityId: { $regex: term, $options: 'i' } }
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

  const { applySalesAgentSampleScope, assertSalesAgentSampleAccess } = require('../utils/sales-access.util');
  const finalFilter = applySalesAgentSampleScope(req, filter);

  const sort = { createdAt: -1, _id: -1 };
  const [items, total] = await Promise.all([
    Sample.find(finalFilter).sort(sort).skip(skip).limit(limit).lean(),
    Sample.countDocuments(finalFilter)
  ]);

  return {
    items: await enrichSamples(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

/**
 * Retrieves a single sample request by ID.
 * 
 * Usecase: Fetches detailed view of a sample request.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sample request ID
 * @returns {Promise<Object>} Enriched sample request object
 */
async function getById(req, id) {
  const Sample = getSampleModel(req);
  const doc = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Sample request not found', 404);
  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
    portalOwnsRecord
  } = require('../utils/portal-identity.util');
  if (isClientUser(req)) {
    const identity = await resolvePortalIdentity(req);
    const userClientId = identity.kind === 'client' ? identity.clientId : '';
    // A portal-enabled lead owns the requests raised on its own lead record.
    let isOwner = portalOwnsRecord(identity, doc);
    if (!isOwner && userClientId && doc.opportunityId) {
      const Opportunity = req.cms?.models.get('Opportunity');
      if (Opportunity) {
        const opp = await Opportunity.findOne({ ...baseFilter(req), _id: doc.opportunityId }).lean();
        if (opp && String(opp.clientId || '') === String(userClientId)) {
          isOwner = true;
        }
      }
    }
    if (!isOwner && userClientId && doc.leadId) {
      const Lead = req.cms?.models.get('Lead');
      if (Lead) {
        const lead = await Lead.findOne({ ...baseFilter(req), _id: doc.leadId }).lean();
        if (lead && String(lead.convertedClientId || '') === String(userClientId)) {
          isOwner = true;
        }
      }
    }
    if (!isOwner) {
      throw appError('Sample request not found', 404);
    }
  } else {
    const { assertSalesAgentSampleAccess } = require('../utils/sales-access.util');
    assertSalesAgentSampleAccess(req, doc, 'Sample request');
  }
  const [enriched] = await enrichSamples(req, [doc]);
  return enriched;
}

/**
 * Creates a new sample request.
 * 
 * Usecase: Initializes a sample request for a Lead or Client.
 * 
 * @param {Object} req Express request object
 * @param {Object} input Cleaned input payload
 * @returns {Promise<Object>} Created sample request document
 */
async function create(req, input) {
  const Sample = getSampleModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  let leadId = input.leadId ? String(input.leadId).trim() : '';
  let clientId = input.clientId ? String(input.clientId).trim() : '';
  let opportunityId = input.opportunityId ? String(input.opportunityId).trim() : '';
  let recipientName = String(input.recipientName || '').trim();
  let sourceCurrency = null;

  // A client portal user requests samples against their own opportunity and
  // nothing else: the lead and client links are derived, never accepted from
  // the form, and billing terms are not theirs to set.
  const { isClientUser } = require('../utils/tenant.util');
  const { resolvePortalIdentity } = require('../utils/portal-identity.util');
  const requesterIsClient = isClientUser(req);
  let portalIdentity = null;
  if (requesterIsClient) {
    portalIdentity = await resolvePortalIdentity(req);
    if (portalIdentity.kind === 'none') {
      throw appError('Your portal login is not linked to a client account yet.', 403);
    }
    if (!opportunityId) {
      throw appError('Pick one of your opportunities to request a sample against.', 400);
    }
    if (portalIdentity.kind === 'lead') {
      // A prospect's request hangs off the lead; there is no client yet.
      clientId = '';
      leadId = portalIdentity.leadIds[0];
    } else {
      leadId = '';
      clientId = String(portalIdentity.clientId);
    }
  }

  if (opportunityId) {
    const OpportunityService = require('./opportunity.service');
    const opportunity = await OpportunityService.getById(req, opportunityId);
    if (requesterIsClient) {
      const ownsDeal =
        portalIdentity.kind === 'lead'
          ? portalIdentity.leadIds.includes(String(opportunity.leadId || '')) ||
            portalIdentity.opportunityIds.includes(String(opportunityId))
          : String(opportunity.clientId || '') === clientId;
      if (!ownsDeal) {
        throw appError('That opportunity does not belong to your account.', 403);
      }
    }
    if (!leadId && opportunity.leadId) leadId = String(opportunity.leadId).trim();
    if (!clientId && opportunity.clientId) clientId = String(opportunity.clientId).trim();
    if (!recipientName) {
      recipientName = String(
        opportunity.contactPerson || opportunity.clientName || opportunity.title || ''
      ).trim();
    }
    sourceCurrency = opportunity.currency || opportunity.currencyCode || null;
  }

  if (leadId) {
    await LeadService.getById(req, leadId, { includeQuality: false });
  } else if (clientId) {
    await ClientService.getById(req, clientId);
  } else if (!opportunityId) {
    throw appError('Sample request must be linked to a lead, client, or opportunity', 400);
  }

  const sampleNumber = await generateSampleNumber(req);
  const SettingService = require('./setting.service');
  const { resolveRecordCurrency, resolveExchangeRate } = require('../utils/record-currency.util');
  const settings = await SettingService.getAll(req);
  // Billing is a commercial decision, so a portal request is never chargeable.
  const isChargeable = requesterIsClient ? false : Boolean(input.isChargeable);
  // Per-record currency: inherit opportunity when linked; else settings default for NEW records only.
  const currency = resolveRecordCurrency(input, settings, sourceCurrency);
  const exchangeRate = resolveExchangeRate(input);
  const chargeAmount = isChargeable ? Math.max(0, Number(input.chargeAmount) || 0) : 0;

  const doc = await Sample.create({
    tenantId,
    sampleNumber,
    leadId: leadId || null,
    clientId: clientId || null,
    opportunityId: opportunityId || null,
    productName: input.productName,
    quantity: input.quantity || 1,
    unit: input.unit || 'pcs',
    items: Array.isArray(input.items) ? input.items : [],
    deliveryAddress: input.deliveryAddress || '',
    urgency: input.urgency || 'Normal',
    isChargeable,
    chargeAmount,
    currency,
    exchangeRate,
    notes: input.notes || '',
    recipientName,
    status: 'Requested',
    createdBy: userId,
    updatedBy: userId
  });

  const created = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'sample_request',
    recordId: created._id.toString(),
    description: `Sample request ${sampleNumber} created for ${input.productName}`,
    metadata: {
      sampleNumber,
      productName: input.productName,
      quantity: input.quantity,
      leadId: leadId || null,
      clientId: clientId || null,
      opportunityId: opportunityId || null
    }
  });

  const [enriched] = await enrichSamples(req, [created]);
  return enriched;
}

/**
 * Edits a sample request while it is still in the warehouse's hands.
 *
 * Only what is being sent and where it goes is editable — the lead / client /
 * opportunity link and the lifecycle fields are not. The window closes at
 * dispatch, because the courier docket and the recipient's expectations are
 * fixed by then, and a rejected request is closed too: it has to be raised
 * again rather than rewritten.
 *
 * An edit after approval is allowed but recorded as such in the audit trail, so
 * a manager who approved different items can see that they changed.
 *
 * @param {Object} req Express request object
 * @param {string} id Sample request ID
 * @param {Object} input Validated edit payload
 * @returns {Promise<Object>} Updated sample request object
 */
async function update(req, id, input) {
  const { isClientUser } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    throw appError('Clients cannot edit sample requests', 403);
  }

  const Sample = getSampleModel(req);
  const userId = resolveUserId(req);
  const existing = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sample request not found', 404);

  if (!EDITABLE_SAMPLE_STATUSES.includes(existing.status)) {
    throw appError(
      existing.status === 'Rejected'
        ? 'A rejected sample request cannot be edited — raise a new request instead.'
        : `Sample request ${existing.sampleNumber} is already ${String(
            existing.status
          ).toLowerCase()}, so it can no longer be edited.`,
      400
    );
  }

  const updates = {
    productName: input.productName,
    quantity: input.quantity,
    unit: input.unit || 'pcs',
    items: Array.isArray(input.items) ? input.items : existing.items || [],
    deliveryAddress: input.deliveryAddress || '',
    urgency: input.urgency || 'Normal',
    notes: input.notes || '',
    recipientName: input.recipientName || existing.recipientName || '',
    isChargeable: Boolean(input.isChargeable),
    chargeAmount: Number(input.chargeAmount) || 0,
    updatedBy: userId
  };
  // Currency and rate hold their stored value unless the edit carried a new one.
  if (input.currency) updates.currency = input.currency;
  if (input.exchangeRate) updates.exchangeRate = input.exchangeRate;

  const changed = Object.keys(updates)
    .filter((key) => key !== 'updatedBy')
    .filter((key) => {
      if (key === 'items') {
        return JSON.stringify(normalizeItemsForDiff(updates.items)) !==
          JSON.stringify(normalizeItemsForDiff(existing.items));
      }
      const before = existing[key];
      const after = updates[key];
      if (typeof after === 'number') return Number(before || 0) !== after;
      if (typeof after === 'boolean') return Boolean(before) !== after;
      return String(before == null ? '' : before) !== String(after);
    });

  if (!changed.length) {
    const [unchanged] = await enrichSamples(req, [existing]);
    return unchanged;
  }

  const updated = await Sample.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  const afterApproval = existing.status !== 'Requested';
  await AuditService.log(req, {
    action: 'updated',
    module: 'sample_request',
    recordId: String(id),
    description: `Sample request ${existing.sampleNumber} edited${
      afterApproval ? ' after approval' : ''
    } (${changed.join(', ')})`,
    metadata: {
      sampleNumber: existing.sampleNumber,
      status: existing.status,
      editedAfterApproval: afterApproval,
      changedFields: changed
    }
  });

  const [enriched] = await enrichSamples(req, [updated]);
  return enriched;
}

/** Item rows reduced to the fields an edit can change, for change detection. */
function normalizeItemsForDiff(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    productName: String(item?.productName || '').trim(),
    quantity: Number(item?.quantity) || 1,
    unit: String(item?.unit || 'pcs').trim()
  }));
}

/**
 * Handles Sales Manager approval or rejection of a sample request.
 *
 * Usecase: Only Sales Manager (or CRM admin) can approve/reject. Clients cannot.
 *
 * @param {Object} req Express request object
 * @param {string} id Sample request ID
 * @param {Object} input Decision payload (action: 'approve'/'reject', stockLocation, rejectionReason)
 * @returns {Promise<Object>} Updated sample request object
 */
async function approve(req, id, input) {
  const { isClientUser } = require('../utils/tenant.util');
  const { isSalesManager } = require('../utils/sales-access.util');
  if (isClientUser(req)) {
    throw appError(
      'Clients cannot approve or reject sample requests. Only a Sales Manager can approve sample requests.',
      403
    );
  }
  if (!isSalesManager(req)) {
    throw appError('Only a Sales Manager can approve or reject sample requests.', 403);
  }

  const Sample = getSampleModel(req);
  const userId = resolveUserId(req);
  const existing = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sample request not found', 404);

  if (existing.status !== 'Requested') {
    throw appError(`Cannot process approval for request in status "${existing.status}"`, 400);
  }

  const isApproval = input.action === 'approve';
  const updates = {
    status: isApproval ? 'Approved' : 'Rejected',
    approvedBy: userId,
    approvedAt: new Date(),
    updatedBy: userId
  };

  if (isApproval) {
    if (input.stockLocation) updates.stockLocation = input.stockLocation;
  } else {
    updates.rejectionReason = input.rejectionReason;
  }

  const updated = await Sample.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: isApproval ? 'approved' : 'rejected',
    module: 'sample_request',
    recordId: String(id),
    description: `Sample request ${existing.sampleNumber} ${isApproval ? 'approved' : 'rejected'}`,
    metadata: { action: input.action, rejectionReason: input.rejectionReason }
  });

  const [enriched] = await enrichSamples(req, [updated]);
  return enriched;
}

/**
 * Item names already used on sample requests, for the create form's picker.
 *
 * Mirrors the opportunity form's suggestion list: previously typed names,
 * newest first, so the same product is not re-spelled three different ways. A
 * portal user only ever sees names off their own account's requests — another
 * client's product names are none of their business.
 */
async function listItemSuggestions(req, query = {}) {
  const Sample = getSampleModel(req);
  const term = String(query.q || '').trim().toLowerCase();

  const filter = { ...baseFilter(req) };
  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
    portalScopeFilter
  } = require('../utils/portal-identity.util');
  if (isClientUser(req)) {
    const scope = portalScopeFilter(await resolvePortalIdentity(req));
    if (!scope) return [];
    Object.assign(filter, scope);
  }

  const docs = await Sample.find(filter)
    .select('items productName unit')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  const seen = new Map();
  const add = (rawName, rawUnit) => {
    const name = String(rawName || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    if (term && !key.includes(term)) return;
    seen.set(key, { name, unit: String(rawUnit || '').trim() });
  };

  for (const doc of docs || []) {
    for (const item of doc.items || []) {
      add(item?.productName, item?.unit);
      if (seen.size >= 50) break;
    }
    // Requests saved before multi-item support only carry the headline name.
    if (!(doc.items || []).length) add(doc.productName, doc.unit);
    if (seen.size >= 50) break;
  }

  return Array.from(seen.values());
}

/**
 * Statuses a sample request can still be called off from.
 *
 * Dispatched is deliberately absent: once the kit is with the courier it is on
 * its way, and "cancelled" would misstate what happened to it.
 */
const CANCELLABLE_SAMPLE_STATUSES = ['Requested', 'Approved', 'Preparing'];

/**
 * Calls off a sample request.
 *
 * Allowed right up to the point the kit arrives — once it is Delivered there is
 * something physical at the client's address and cancelling would misstate what
 * happened. A client may only cancel their own account's request; staff with
 * write access may cancel on their behalf (a phone call is still the most
 * common way this is asked for).
 */
async function cancel(req, id, input = {}) {
  const Sample = getSampleModel(req);
  const userId = resolveUserId(req);
  const existing = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sample request not found', 404);

  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
    portalOwnsRecord
  } = require('../utils/portal-identity.util');
  const requesterIsClient = isClientUser(req);

  if (requesterIsClient) {
    const identity = await resolvePortalIdentity(req);
    if (!portalOwnsRecord(identity, existing)) {
      // 404 rather than 403: a portal user should not learn that another
      // account's sample request exists.
      throw appError('Sample request not found', 404);
    }
  } else {
    // Staff-side, cancelling is a manager's call. isSalesManager already covers
    // admins and CRM managers, so a sales representative or finance manager is
    // refused here even though they can otherwise write to samples.
    const { isSalesManager } = require('../utils/sales-access.util');
    if (!isSalesManager(req)) {
      throw appError(
        'Only the client, a sales manager or a CRM manager can cancel a sample request.',
        403
      );
    }
  }

  if (existing.status === 'Cancelled') {
    throw appError('This sample request is already cancelled.', 409);
  }
  if (!CANCELLABLE_SAMPLE_STATUSES.includes(existing.status)) {
    throw appError(
      `A ${existing.status.toLowerCase()} sample request can no longer be cancelled.`,
      409
    );
  }

  const reason = String(input.reason || '').trim();
  const updated = await Sample.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        status: 'Cancelled',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancellationReason: reason,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'cancelled',
    module: 'sample_request',
    recordId: String(id),
    description: `Sample request ${existing.sampleNumber || id} cancelled${reason ? `: ${reason}` : ''}`,
    metadata: {
      previousStatus: existing.status,
      reason,
      cancelledByClient: requesterIsClient
    }
  });

  const [enriched] = await enrichSamples(req, [updated]);
  return enriched;
}

/**
 * Updates stock address for an approved or preparing sample request.
 */
async function updateStockAddress(req, id, stockLocation) {
  const Sample = getSampleModel(req);
  const userId = req.user?.id || 'system';
  const existing = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sample request not found', 404);

  const updated = await Sample.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { stockLocation: String(stockLocation || '').trim(), updatedBy: userId } },
    { new: true }
  ).lean();

  const [enriched] = await enrichSamples(req, [updated]);
  return enriched;
}

/**
 * Dispatches sample request and records shipment tracking details.
 * 
 * Usecase: Updates status to Dispatched and attaches courier and AWB tracking number.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sample request ID
 * @param {Object} input Dispatch details (courierName, trackingNumber, dates)
 * @returns {Promise<Object>} Dispatched sample request object
 */
async function dispatch(req, id, input) {
  const Sample = getSampleModel(req);
  const userId = resolveUserId(req);
  const existing = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sample request not found', 404);

  if (!['Approved', 'Preparing'].includes(existing.status)) {
    throw appError('Sample request must be Approved before dispatch', 400);
  }

  const updates = {
    status: 'Dispatched',
    courierName: input.courierName,
    trackingNumber: input.trackingNumber,
    dispatchDate: input.dispatchDate ? new Date(input.dispatchDate) : new Date(),
    estimatedDeliveryDate: input.estimatedDeliveryDate ? new Date(input.estimatedDeliveryDate) : null,
    updatedBy: userId
  };

  const updated = await Sample.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'dispatched',
    module: 'sample_request',
    recordId: String(id),
    description: `Sample ${existing.sampleNumber} dispatched via ${input.courierName} (${input.trackingNumber})`,
    metadata: { courierName: input.courierName, trackingNumber: input.trackingNumber }
  });

  const [enriched] = await enrichSamples(req, [updated]);
  return enriched;
}

/**
 * Marks a sample request as delivered to the customer.
 * 
 * Usecase: Updates status to Delivered and sets deliveredAt timestamp.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sample request ID
 * @returns {Promise<Object>} Delivered sample request object
 */
async function deliver(req, id) {
  const Sample = getSampleModel(req);
  const userId = resolveUserId(req);
  const existing = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sample request not found', 404);

  if (existing.status !== 'Dispatched') {
    throw appError('Sample request must be Dispatched before marking Delivered', 400);
  }

  const updated = await Sample.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { status: 'Delivered', deliveredAt: new Date(), updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'delivered',
    module: 'sample_request',
    recordId: String(id),
    description: `Sample ${existing.sampleNumber} delivered to customer`
  });

  const [enriched] = await enrichSamples(req, [updated]);
  return enriched;
}

/**
 * Records customer feedback for a delivered sample and handles improvement request routing.
 * 
 * Usecase: Captures rating 1-5, comments, order interest, and routes improvement requests
 * to technical/quality teams by creating an actionable CRM Task when needed.
 * 
 * @param {Object} req Express request object
 * @param {string} id Sample request ID
 * @param {Object} input Feedback payload (rating, comments, interestedInOrder, requiresImprovement, routedDepartment, improvementNotes)
 * @returns {Promise<Object>} Completed sample request document
 */
async function submitFeedback(req, id, input) {
  const Sample = getSampleModel(req);
  const userId = resolveUserId(req);
  const existing = await Sample.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Sample request not found', 404);

  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
    portalOwnsRecord
  } = require('../utils/portal-identity.util');
  if (isClientUser(req)) {
    const identity = await resolvePortalIdentity(req);
    if (identity.kind === 'none') throw appError('Sample request not found', 404);
    const userClientId = identity.kind === 'client' ? identity.clientId : '';

    let allowed = portalOwnsRecord(identity, existing);
    if (!allowed && existing.opportunityId) {
      try {
        const Opportunity = req.cms?.models.get('Opportunity');
        if (Opportunity) {
          const opp = await Opportunity.findOne({
            tenantId: resolveTenantId(req),
            _id: String(existing.opportunityId),
            isDeleted: false
          })
            .select('clientId')
            .lean();
          if (opp && String(opp.clientId || '') === String(userClientId)) {
            allowed = true;
          }
        }
      } catch {
        /* keep denied */
      }
    }
    if (!allowed) throw appError('Sample request not found', 404);

    if (existing.status !== 'Delivered' && existing.status !== 'Completed') {
      throw appError('Sample review is only available when the sample is delivered and Client Review is Pending', 400);
    }
  }

  if (!['Delivered', 'Completed'].includes(existing.status)) {
    throw appError('Sample request must be Delivered before recording feedback', 400);
  }

  let routedTaskId = existing.feedback?.routedTaskId || null;
  const requiresImprovement = Boolean(input.requiresImprovement);
  const routedDepartment = requiresImprovement ? (input.routedDepartment || 'R&D / Technical') : 'None';

  // Auto-create Improvement Task in Task Manager if improvement is required
  if (requiresImprovement && !routedTaskId) {
    const Task = req.cms?.models.get('Task');
    if (Task) {
      const taskDoc = await Task.create({
        tenantId: resolveTenantId(req),
        projectId: existing.projectId || 'sample_improvement',
        title: `[Sample Improvement] ${existing.sampleNumber}: ${existing.productName}`,
        description: `Routed to ${routedDepartment}.\nRating: ${input.rating}/5 stars.\nFeedback: ${input.comments || '—'}\nImprovement Details: ${input.improvementNotes || '—'}`,
        status: 'Todo',
        priority: 'High',
        assignedTo: routedDepartment,
        createdBy: userId,
        updatedBy: userId
      }).catch(() => null);

      if (taskDoc) {
        routedTaskId = taskDoc._id.toString();
      }
    }
  }

  const updates = {
    status: 'Completed',
    feedback: {
      rating: input.rating,
      comments: input.comments || '',
      interestedInOrder: input.interestedInOrder,
      requiresImprovement,
      routedDepartment,
      improvementNotes: input.improvementNotes || '',
      routedTaskId,
      feedbackDate: new Date(),
      submittedBy: userId
    },
    updatedBy: userId
  };

  const updated = await Sample.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'feedback_submitted',
    module: 'sample_request',
    recordId: String(id),
    description: `Customer feedback submitted for sample ${existing.sampleNumber}: ${input.rating}/5 stars${requiresImprovement ? ` (Routed to ${routedDepartment})` : ''}`,
    metadata: { rating: input.rating, interestedInOrder: input.interestedInOrder, requiresImprovement, routedDepartment }
  });

  // Opportunity-linked samples: client approval advances deal to Sample Approved.
  try {
    await syncOpportunitySampleApproved(req, existing, input);
  } catch (err) {
    console.error('[plugin:openext-crm-suite] sample→opportunity stage sync failed:', err?.message || err);
  }

  const [enriched] = await enrichSamples(req, [updated]);
  return enriched;
}

/**
 * The samples an export may contain: a portal login gets exactly its own (same rule as the sample list),
 * an unlinked login none, staff their usual scope. Merged last, so search can never widen it.
 */
async function scopeSampleExport(req, filter) {
  const { isClientUser } = require('../utils/tenant.util');
  const { mergeScopeIntoFilter, applySalesAgentSampleScope } = require('../utils/sales-access.util');
  if (!isClientUser(req)) return applySalesAgentSampleScope(req, filter);
  const { resolvePortalIdentity, portalScopeFilter } = require('../utils/portal-identity.util');
  const scope = portalScopeFilter(await resolvePortalIdentity(req));
  return mergeScopeIntoFilter(filter, scope || { _id: '__UNLINKED_CLIENT_NO_MATCH__' });
}

async function exportSamples(req, query = {}) {
  const Sample = getSampleModel(req);
  let filter = baseFilter(req);
  const { isClientUser } = require('../utils/tenant.util');
  const portal = isClientUser(req);

  if (query.status) {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  // These narrow a list; for a portal login they can never reach past their own samples (scope below).
  if (query.clientId && !portal) filter.clientId = String(query.clientId).trim();
  if (query.leadId) filter.leadId = String(query.leadId).trim();
  if (query.opportunityId) filter.opportunityId = String(query.opportunityId).trim();
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { sampleNumber: { $regex: term, $options: 'i' } },
        { productName: { $regex: term, $options: 'i' } },
        { recipientName: { $regex: term, $options: 'i' } },
        { courierName: { $regex: term, $options: 'i' } },
        { trackingNumber: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const raw = await Sample.find(await scopeSampleExport(req, filter)).sort({ createdAt: -1 }).lean();
  const enriched = await enrichSamples(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'sample_request',
    recordId: 'export',
    description: `Exported ${enriched.length} sample requests in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `samples_export_${nowStr}.json`,
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
    'Sample Number',
    'Product / Item',
    'Quantity',
    'Unit',
    'Status',
    'Client / Recipient',
    'Contact Person',
    'Dispatch Date',
    'Delivery Date',
    'Courier Name',
    'Tracking Number',
    'Rating (1-5)',
    'Feedback Comments',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const s of enriched) {
    rows.push(
      [
        s._id,
        s.sampleNumber || '',
        s.productName || s.item || '',
        Number(s.quantity || 1),
        s.unit || 'pcs',
        s.status || '',
        s.clientCompany || s.clientName || s.recipientName || '',
        s.contactPerson || '',
        s.dispatchDate ? new Date(s.dispatchDate).toISOString().slice(0, 10) : '',
        s.deliveryDate ? new Date(s.deliveryDate).toISOString().slice(0, 10) : '',
        s.courierName || s.dispatchDetails?.courierName || '',
        s.trackingNumber || s.dispatchDetails?.trackingNumber || '',
        s.feedback?.rating || '',
        s.feedback?.comments || '',
        s.createdAt ? new Date(s.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `samples_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  list,
  getById,
  create,
  update,
  approve,
  cancel,
  listItemSuggestions,
  CANCELLABLE_SAMPLE_STATUSES,
  updateStockAddress,
  dispatch,
  deliver,
  submitFeedback,
  exportSamples
};
