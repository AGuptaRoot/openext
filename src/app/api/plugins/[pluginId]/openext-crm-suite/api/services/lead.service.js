'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const {
  isValidEmail,
  isValidMobile,
  isValidPan,
  normalizeMobile,
  normalizePan
} = require('../validation/common.util');
const {
  normalizeCompanyName,
  buildCompanyTokens,
  duplicateReasons
} = require('../utils/lead-duplicate.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const { scoreLead } = require('../utils/data-quality.util');
const { enrichLeadAssignees, enrichLeadAssignee } = require('../utils/user.util');
const {
  assertLeadStageChangeAllowed,
  assertLeadWriteAccess,
  assertLeadReadAccess,
  applySalesAgentLeadListScope,
  isSalesAgentScoped,
  userOwnsLead,
  hasPermission,
  resolveSelfOnlyAssignee
} = require('../utils/sales-access.util');

function getLeadModel(req) {
  const Lead = req.cms?.models.get('Lead');
  if (!Lead) throw new Error('Lead model is not registered');
  return Lead;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function getValidStages(req) {
  const stages = await SettingService.getPipelineStages(req);
  return stages.length > 0 ? stages : ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Won', 'Lost'];
}

function assertValidStage(stage, validStages) {
  if (!validStages.includes(stage)) {
    throw appError(`Invalid stage. Must be one of: ${validStages.join(', ')}`);
  }
}

function baseFilter(req) {
  return {
    tenantId: resolveTenantId(req),
    isDeleted: false,
    mergedIntoId: null
  };
}

/** True when Request Type is Product (system key, name, or product field signature). */
function isProductRequestType(requestType) {
  if (!requestType || typeof requestType !== 'object') return false;
  const key = String(requestType.key || '').trim().toLowerCase();
  const name = String(requestType.name || '').trim().toLowerCase();
  if (key === 'product' || key.startsWith('product_') || key.endsWith('_product')) return true;
  if (name === 'product') return true;
  if (name.includes('product') && !name.includes('project')) return true;
  const fields = Array.isArray(requestType.fields) ? requestType.fields : [];
  const hasProductFields = fields.some((f) => {
    const fk = String(f?.key || '').trim().toLowerCase();
    return (
      fk === 'product_name' ||
      fk === 'product' ||
      fk.startsWith('product_') ||
      fk === 'specification' ||
      fk === 'certifications' ||
      fk === 'target_price' ||
      fk === 'quantity'
    );
  });
  if (hasProductFields && key !== 'project' && name !== 'project' && !name.includes('project')) {
    return true;
  }
  return false;
}

async function findLeadOrThrow(req, id) {
  const lead = await getLeadModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!lead) throw appError('Lead not found', 404);
  assertLeadReadAccess(req, lead);
  return lead;
}

async function enrichLeadsWithAgeingAndFollowUps(req, leads) {
  if (!Array.isArray(leads) || !leads.length) return leads || [];

  const leadIds = leads.map((l) => String(l._id || l.id)).filter(Boolean);
  const tenantId = resolveTenantId(req);
  const now = Date.now();

  const FollowUp = req.cms?.models?.get?.('FollowUp');
  const openFollowUpsByLead = {};

  // Scheduled activities nobody completed by their due time, per lead.
  const LeadEvent = req.cms?.models?.get?.('LeadEvent');
  const missedActivitiesByLead = {};

  if (LeadEvent && leadIds.length) {
    try {
      const overdue = await LeadEvent.find({
        tenantId,
        leadId: { $in: leadIds },
        isDeleted: false,
        kind: 'scheduled',
        status: 'Open',
        eventDate: { $lt: new Date(now) }
      })
        .select('leadId title eventType eventDate')
        .sort({ eventDate: 1 })
        .lean();

      for (const ev of overdue) {
        const lid = String(ev.leadId);
        if (!missedActivitiesByLead[lid]) missedActivitiesByLead[lid] = [];
        missedActivitiesByLead[lid].push(ev);
      }
    } catch (err) {
      console.warn('[LeadService] missed activity lookup warning:', err.message);
    }
  }

  if (FollowUp && leadIds.length) {
    try {
      const followUps = await FollowUp.find({
        tenantId,
        leadId: { $in: leadIds },
        isDeleted: false,
        status: { $regex: /^open$/i }
      })
        .sort({ dueDate: 1 })
        .lean();

      for (const fu of followUps) {
        const lid = String(fu.leadId);
        if (!openFollowUpsByLead[lid]) openFollowUpsByLead[lid] = [];
        openFollowUpsByLead[lid].push(fu);
      }
    } catch (err) {
      console.warn('[LeadService] FollowUp lookup warning:', err.message);
    }
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  return leads.map((lead) => {
    const lid = String(lead._id || lead.id);
    const createdTime = lead.createdAt ? new Date(lead.createdAt).getTime() : now;
    const stageUpdatedTime = lead.stageUpdatedAt
      ? new Date(lead.stageUpdatedAt).getTime()
      : (lead.updatedAt ? new Date(lead.updatedAt).getTime() : createdTime);

    const totalAgeDays = Math.max(0, Math.floor((now - createdTime) / (1000 * 60 * 60 * 24)));
    const stageAgeDays = Math.max(0, Math.floor((now - stageUpdatedTime) / (1000 * 60 * 60 * 24)));

    let ageingStatus = 'Fresh';
    if (stageAgeDays > 14) ageingStatus = 'Stale';
    else if (stageAgeDays > 7) ageingStatus = 'Attention';
    else if (stageAgeDays > 3) ageingStatus = 'Active';

    const ageing = {
      totalAgeDays,
      stageAgeDays,
      status: ageingStatus,
      isStale: stageAgeDays > 14,
      isNeedsAttention: stageAgeDays > 7 && stageAgeDays <= 14,
      isFresh: stageAgeDays <= 3,
      label: `${stageAgeDays}d in stage`,
      totalLabel: `${totalAgeDays}d total`
    };

    // Missed scheduled activities summary (oldest first from the query above)
    const missedList = missedActivitiesByLead[lid] || [];
    const oldestMissed = missedList[0] || null;
    const missedActivities = {
      count: missedList.length,
      hasMissed: missedList.length > 0,
      oldestDueAt: oldestMissed?.eventDate || null,
      oldestTitle: oldestMissed ? String(oldestMissed.title || '') : '',
      label: missedList.length
        ? `${missedList.length} missed activit${missedList.length === 1 ? 'y' : 'ies'}`
        : ''
    };

    // Follow-ups summary
    const openFUs = openFollowUpsByLead[lid] || [];
    let overdueCount = 0;
    let maxOverdueDays = 0;
    let nextDue = null;

    for (const fu of openFUs) {
      if (fu.dueDate) {
        const dueTime = new Date(fu.dueDate).getTime();
        if (dueTime < todayStart.getTime()) {
          overdueCount++;
          const ovDays = Math.max(1, Math.floor((now - dueTime) / (1000 * 60 * 60 * 24)));
          if (ovDays > maxOverdueDays) maxOverdueDays = ovDays;
        } else if (!nextDue) {
          nextDue = fu;
        }
      }
    }

    let followUpStatus = 'none';
    if (overdueCount > 0) followUpStatus = 'overdue';
    else if (openFUs.some((f) => f.dueDate && new Date(f.dueDate) >= todayStart && new Date(f.dueDate) <= todayEnd)) {
      followUpStatus = 'due_today';
    } else if (openFUs.length > 0) {
      followUpStatus = 'upcoming';
    }

    const followUpSummary = {
      openCount: openFUs.length,
      overdueCount,
      overdueDays: maxOverdueDays,
      hasOverdue: overdueCount > 0,
      status: followUpStatus,
      nextDueDate: nextDue ? nextDue.dueDate : (openFUs[0]?.dueDate || null),
      nextDueTitle: nextDue ? nextDue.title : (openFUs[0]?.title || '')
    };

    return {
      ...lead,
      ageing,
      followUpSummary,
      missedActivities
    };
  });
}

/** Paginated list — optional ?stage=, ?source=, ?status=, ?tag= & ?search= */
async function list(req) {
  const Lead = getLeadModel(req);
  const view = String(req.query?.view || '').trim();
  const maxLimit = view === 'kanban' || view === 'report' ? 500 : 100;
  const { page, limit, skip, sort } = parsePagination(req.query, { maxLimit });
  const filter = baseFilter(req);

  if (req.query?.stage) {
    const s = toLiteralSearchTerm(String(req.query.stage).trim());
    if (s) filter.stage = new RegExp(`^${s}$`, 'i');
  }

  if (req.query?.source) {
    const s = toLiteralSearchTerm(String(req.query.source).trim());
    if (s) filter.source = new RegExp(`^${s}$`, 'i');
  }

  if (req.query?.status) {
    const s = toLiteralSearchTerm(String(req.query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }

  if (req.query?.tag) {
    const t = toLiteralSearchTerm(String(req.query.tag).trim());
    if (t) filter.tags = new RegExp(`^${t}$`, 'i');
  }

  // Qualification match score bands: unscored | strong | partial | weak | poor
  if (req.query?.matchScore) {
    const band = String(req.query.matchScore).trim().toLowerCase();
    if (band === 'unscored') {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $or: [
            { 'commercialRequirement.score': null },
            { 'commercialRequirement.score': { $exists: false } }
          ]
        }
      ];
    } else if (band === 'strong') {
      filter['commercialRequirement.score'] = { $gte: 80 };
    } else if (band === 'partial') {
      filter['commercialRequirement.score'] = { $gte: 55, $lt: 80 };
    } else if (band === 'weak') {
      filter['commercialRequirement.score'] = { $gte: 30, $lt: 55 };
    } else if (band === 'poor') {
      filter['commercialRequirement.score'] = { $gte: 0, $lt: 30 };
    } else if (band === 'scored') {
      filter['commercialRequirement.score'] = { $ne: null, $exists: true };
    }
  }

  // Commercial Requirement → "Lead needs sample request" checkbox
  const needsSampleRaw =
    req.query?.needsSampleRequest ?? req.query?.needsSample ?? req.query?.sampleRequired;
  if (needsSampleRaw !== undefined && needsSampleRaw !== null && String(needsSampleRaw).trim() !== '') {
    const flag = String(needsSampleRaw).trim().toLowerCase();
    const wants = flag === 'true' || flag === '1' || flag === 'yes';
    const doesnt = flag === 'false' || flag === '0' || flag === 'no';
    if (wants) {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $or: [
            { 'commercialRequirement.needsSampleRequest': true },
            { 'qualification.sampleRequired': true }
          ]
        }
      ];
    } else if (doesnt) {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $nor: [
            { 'commercialRequirement.needsSampleRequest': true },
            { 'qualification.sampleRequired': true }
          ]
        }
      ];
    }
  }

  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { company: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { pan: { $regex: term, $options: 'i' } },
        { source: { $regex: term, $options: 'i' } },
        { tags: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const { isClientUser } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    return {
      items: [],
      pagination: { page, limit, total: 0, totalPages: 0 }
    };
  }

  const scopedFilter = applySalesAgentLeadListScope(req, filter);

  const [items, total] = await Promise.all([
    Lead.find(scopedFilter).sort(sort).skip(skip).limit(limit).lean(),
    Lead.countDocuments(scopedFilter)
  ]);

  const withAssignees = await enrichLeadAssignees(req, items);
  const enriched = await enrichLeadsWithAgeingAndFollowUps(req, withAssignees);

  return {
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

/** True when a value is "empty" for merge purposes (do not overwrite real data with these). */
function isEmptyExtensionValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return !Number.isFinite(value) || value === 0;
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return true;
    return keys.every((k) => isEmptyExtensionValue(value[k]));
  }
  return false;
}

/**
 * Deep-merge Lead.extension bags keyed by extension id then section/fields.
 * Prefer incoming non-empty values; keep previous when incoming is empty shell.
 */
function mergeLeadExtensionBags(prev, next) {
  const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  const incoming = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
  const out = { ...base };

  for (const [extId, nextBag] of Object.entries(incoming)) {
    const prevBag =
      base[extId] && typeof base[extId] === 'object' && !Array.isArray(base[extId])
        ? base[extId]
        : {};

    // Skip replacing a filled bag with a completely empty shell.
    if (isEmptyExtensionValue(nextBag) && !isEmptyExtensionValue(prevBag)) {
      out[extId] = prevBag;
      continue;
    }

    if (!nextBag || typeof nextBag !== 'object' || Array.isArray(nextBag)) {
      if (!isEmptyExtensionValue(nextBag)) out[extId] = nextBag;
      continue;
    }

    const mergedBag = { ...prevBag };
    for (const [sectionKey, sectionVal] of Object.entries(nextBag)) {
      const prevSection = prevBag[sectionKey];
      if (
        sectionVal &&
        typeof sectionVal === 'object' &&
        !Array.isArray(sectionVal) &&
        prevSection &&
        typeof prevSection === 'object' &&
        !Array.isArray(prevSection)
      ) {
        const fieldOut = { ...prevSection };
        for (const [fk, fv] of Object.entries(sectionVal)) {
          if (!isEmptyExtensionValue(fv)) fieldOut[fk] = fv;
          else if (fieldOut[fk] === undefined) fieldOut[fk] = fv;
        }
        mergedBag[sectionKey] = fieldOut;
      } else if (!isEmptyExtensionValue(sectionVal) || prevSection === undefined) {
        mergedBag[sectionKey] = sectionVal;
      }
    }
    out[extId] = mergedBag;
  }

  return out;
}

function normalizeLeadExtensionField(lead) {
  if (!lead || typeof lead !== 'object') return lead;
  let extension = lead.extension;
  if (extension == null) {
    return { ...lead, extension: {} };
  }
  // Mongoose Map / odd Mixed shapes → plain JSON object for the admin UI.
  if (typeof extension === 'string') {
    try {
      extension = JSON.parse(extension);
    } catch {
      extension = {};
    }
  }
  if (extension && typeof extension.toObject === 'function') {
    try {
      extension = extension.toObject();
    } catch {
      /* keep */
    }
  }
  if (extension instanceof Map) {
    extension = Object.fromEntries(extension.entries());
  }
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
    extension = {};
  } else {
    try {
      extension = JSON.parse(JSON.stringify(extension));
    } catch {
      extension = { ...extension };
    }
  }
  return { ...lead, extension };
}

async function getById(req, id, options = {}) {
  const lead = await findLeadOrThrow(req, id);
  const withAssignee = await enrichLeadAssignee(req, lead);
  const [enriched] = await enrichLeadsWithAgeingAndFollowUps(req, [withAssignee]);
  const withExtension = normalizeLeadExtensionField(enriched);
  if (options.includeQuality === false || !hasPermission(req, 'crm.dataQuality.read')) {
    return withExtension;
  }
  const duplicates = await findDuplicates(req, lead, { excludeId: id });
  return {
    ...withExtension,
    dataQuality: scoreLead(lead, {
      hasDuplicate: duplicates.hasExactDuplicate || duplicates.hasSimilarCompany
    })
  };
}

function normalizeDuplicateInput(input) {
  return {
    email: String(input?.email || '').trim().toLowerCase(),
    phone: normalizeMobile(input?.phone) || '',
    pan: normalizePan(input?.pan) || '',
    company: String(input?.company || '').trim()
  };
}

function duplicateProjection(req, lead, result) {
  const visible = !isSalesAgentScoped(req) || userOwnsLead(req, lead);
  return {
    id: visible ? String(lead._id) : null,
    name: visible ? lead.name : 'Existing lead',
    company: visible ? lead.company : 'Restricted lead',
    stage: visible ? lead.stage : null,
    createdAt: visible ? lead.createdAt : null,
    reasons: result.reasons,
    companySimilarity: Number(result.companySimilarity.toFixed(3)),
    restricted: !visible
  };
}

async function findDuplicates(req, input, options = {}) {
  const Lead = getLeadModel(req);
  const normalized = normalizeDuplicateInput(input);
  const filter = baseFilter(req);
  const excludeId = String(options.excludeId || input?.excludeId || '').trim();
  if (excludeId) filter._id = { $ne: excludeId };

  const exactClauses = [];
  if (normalized.email) exactClauses.push({ email: normalized.email });
  if (normalized.phone) exactClauses.push({ phone: normalized.phone });
  if (normalized.pan) exactClauses.push({ pan: normalized.pan });

  const companyTokens = buildCompanyTokens(normalized.company);
  const projection = '_id name company companyKey email phone pan stage assignedTo createdBy createdAt';
  const [exactRows, companyRows] = await Promise.all([
    exactClauses.length
      ? Lead.find({ ...filter, $or: exactClauses }).select(projection).limit(50).lean()
      : [],
    companyTokens.length
      ? Lead.find({ ...filter, companyTokens: { $in: companyTokens } })
          .select(projection)
          .limit(100)
          .lean()
      : []
  ]);

  const candidates = new Map();
  for (const lead of [...exactRows, ...companyRows]) candidates.set(String(lead._id), lead);

  const matches = [];
  for (const lead of candidates.values()) {
    const result = duplicateReasons(normalized, lead);
    if (!result.reasons.length) continue;
    matches.push(duplicateProjection(req, lead, result));
  }
  matches.sort((left, right) => {
    const leftExact = left.reasons.some((reason) => reason !== 'company');
    const rightExact = right.reasons.some((reason) => reason !== 'company');
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    return right.companySimilarity - left.companySimilarity;
  });

  return {
    hasExactDuplicate: matches.some((match) => match.reasons.some((reason) => reason !== 'company')),
    hasSimilarCompany: matches.some((match) => match.reasons.includes('company')),
    matches: matches.slice(0, 20)
  };
}

function duplicateConflict(req, result, allowSimilarCompany, allowExactDuplicate) {
  if (result.hasExactDuplicate) {
    // Explicit allow (reuse existing contact / create another lead for same person),
    // or users with crm.leads.duplicate.override.
    if (
      allowExactDuplicate === true ||
      hasPermission(req, 'crm.leads.duplicate.override')
    ) {
      return;
    }
    const error = appError('A lead with the same email, mobile number, or PAN already exists', 409);
    error.code = 'LEAD_DUPLICATE_EXACT';
    error.details = result.matches;
    throw error;
  }
  if (result.hasSimilarCompany && allowSimilarCompany !== true) {
    const error = appError('A lead with a similar company name already exists', 409);
    error.code = 'LEAD_DUPLICATE_COMPANY';
    error.details = result.matches;
    throw error;
  }
}

async function create(req, input) {
  const Lead = getLeadModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const validStages = await getValidStages(req);

  if (!input.name) throw appError('Name is required');
  if (!input.email) throw appError('Email is required');
  if (!isValidEmail(input.email)) throw appError('Email is invalid');
  if (!input.phone) throw appError('Mobile number is required');
  if (!isValidMobile(normalizeMobile(input.phone))) throw appError('Mobile number is invalid');
  if (!input.company) throw appError('Company name is required');
  if (input.pan && !isValidPan(normalizePan(input.pan))) throw appError('PAN number is invalid');

  if (!input.confirmDifferentCompany && !input.allowExactDuplicate && !input.allowDuplicate) {
    const PersonContactService = require('./person-contact.service');
    if (typeof PersonContactService.checkDiscrepancy === 'function') {
      const disc = await PersonContactService.checkDiscrepancy(req, {
        name: input.name,
        email: input.email,
        phone: input.phone,
        companyName: input.company,
        entityType: 'lead'
      });
      if (disc?.hasDiscrepancy) {
        const error = appError('Possible duplicate contact found under another company', 409);
        error.code = 'COMPANY_DISCREPANCY';
        error.discrepancy = disc.discrepancy;
        throw error;
      }
    }
  }

  const duplicateResult = await findDuplicates(req, input);
  // Linking an existing contact (or explicit allow) can create another lead for the same person.
  const allowExactDuplicate =
    input.allowExactDuplicate === true ||
    input.confirmDifferentCompany === true ||
    Boolean(String(input.contactId || '').trim());
  duplicateConflict(
    req,
    duplicateResult,
    input.allowSimilarCompany === true || input.confirmDifferentCompany === true || allowExactDuplicate,
    allowExactDuplicate
  );
  const stage = input.stage || validStages[0];
  assertValidStage(stage, validStages);

  /*
   * The active CRM extension (Settings → Extensions) fixes the Request Type.
   * A lead created without one — an import, a quick capture, an older client —
   * gets the extension's type so its commercial requirement form and
   * qualification check line up with the rest of the workspace.
   */
  if (!String(input.requestTypeId || '').trim() && !String(input.requestType || '').trim()) {
    try {
      const CrmExtensionService = require('./crm-extension.service');
      const RequestTypeService = require('./request-type.service');
      const active = await CrmExtensionService.getActive(req);
      const fixed = await RequestTypeService.getByKeyOrId(req, active.requestTypeKey);
      if (fixed) {
        input.requestType = fixed.name;
        input.requestTypeId = String(fixed._id);
      } else {
        input.requestType = active.requestTypeName;
      }
    } catch {
      /* request type stays empty when the registry is unavailable */
    }
  }

  const lead = await Lead.create({
    tenantId,
    title: input.title ? String(input.title).trim() : '',
    name: input.name,
    salutation: input.salutation || '',
    jobTitle: input.jobTitle || '',
    gender: input.gender || '',
    leadType: input.leadType || '',
    requestType: input.requestType || '',
    requestTypeId: input.requestTypeId ? String(input.requestTypeId).trim() : null,
    priority: input.priority ? String(input.priority).trim() : '',
    nextFollowUp: input.nextFollowUp ? new Date(input.nextFollowUp) : null,
    contactId: input.contactId ? String(input.contactId).trim() : '',
    email: input.email || '',
    phone: normalizeMobile(input.phone),
    company: input.company,
    companyKey: normalizeCompanyName(input.company),
    companyTokens: buildCompanyTokens(input.company),
    pan: normalizePan(input.pan) || '',
    stage,
    source: input.source || '',
    tags: Array.isArray(input.tags) ? input.tags : (input.tags ? [String(input.tags).trim()] : []),
    customFields: input.customFields && typeof input.customFields === 'object' ? input.customFields : {},
    extension:
      input.extension && typeof input.extension === 'object' && !Array.isArray(input.extension)
        ? input.extension
        : {},
    // Assignment is optional for managers; sales representatives may only assign themselves
    assignedTo: resolveSelfOnlyAssignee(
      req,
      input.assignedTo !== undefined ? String(input.assignedTo).trim() : '',
      { fieldLabel: 'Lead owner', allowEmpty: true, forceSelf: true }
    ),
    notes: input.notes || '',
    value: input.value !== undefined && input.value !== null && input.value !== '' ? Number(input.value) : null,
    currency: input.currency ? String(input.currency).trim().toUpperCase() : '',
    photoUrl: input.photoUrl || '',
    latitude: input.latitude != null && input.latitude !== '' ? Number(input.latitude) : null,
    longitude: input.longitude != null && input.longitude !== '' ? Number(input.longitude) : null,
    address: input.address || input.formattedAddress || '',
    city: input.city || '',
    state: input.state || '',
    country: input.country || '',
    postalCode: input.postalCode || '',
    placeId: input.placeId || '',
    locationCapturedAt: input.locationCapturedAt ? new Date(input.locationCapturedAt) : null,
    status: input.status ? String(input.status).trim() : 'Hot',
    createdBy: userId,
    updatedBy: userId
  });

  // Mixed JSON: ensure Mongoose persists extension even when nested/empty.
  if (typeof lead.markModified === 'function') {
    lead.markModified('extension');
    lead.markModified('customFields');
    if (typeof lead.save === 'function') {
      await lead.save();
    }
  }

  const doc = lead.toObject();
  if (doc.extension === undefined) {
    doc.extension =
      input.extension && typeof input.extension === 'object' && !Array.isArray(input.extension)
        ? input.extension
        : {};
  }

  if (doc.contactId) {
    try {
      const PersonContactService = require('./person-contact.service');
      await PersonContactService.linkLead(req, doc.contactId, doc._id.toString());
      const leadCompany = String(doc.company || input.company || '').trim();
      if (leadCompany) {
        const PersonContact = req.cms?.models.get('PersonContact');
        if (PersonContact) {
          await PersonContact.updateOne(
            { _id: doc.contactId },
            { $set: { companyName: leadCompany } }
          );
        }
      }
    } catch (err) {
      console.error('[lead] Failed to link contact:', err?.message || err);
    }
  }

  await AuditService.log(req, {
    action: 'created',
    module: 'lead',
    recordId: doc._id.toString(),
    description: `Lead created: ${doc.title || doc.name}`,
    metadata: {
      stage: doc.stage,
      assignedTo: doc.assignedTo || null,
      contactId: doc.contactId || null,
      similarCompanyOverride: input.allowSimilarCompany === true,
      exactDuplicateOverride: input.allowExactDuplicate === true
    }
  });

  return enrichLeadAssignee(req, doc);
}

async function update(req, id, input) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  if (existing.convertedClientId) {
    throw appError('Cannot update a lead that has already been converted', 409);
  }

  const validStages = await getValidStages(req);
  const updates = { updatedBy: userId };

  if (input.name !== undefined) {
    if (!String(input.name).trim()) throw appError('Name is required');
    updates.name = String(input.name).trim();
  }
  if (input.email !== undefined) {
    const email = String(input.email).trim().toLowerCase();
    if (!email) throw appError('Email is required');
    if (!isValidEmail(email)) throw appError('Email is invalid');
    updates.email = email;
  }
  if (input.phone !== undefined) {
    const phone = normalizeMobile(input.phone);
    if (!phone) throw appError('Mobile number is required');
    if (!isValidMobile(phone)) throw appError('Mobile number is invalid');
    updates.phone = phone;
  }
  if (input.company !== undefined) {
    const company = String(input.company).trim();
    if (!company) throw appError('Company name is required');
    updates.company = company;
  }
  if (input.pan !== undefined) {
    const pan = normalizePan(input.pan);
    if (pan && !isValidPan(pan)) throw appError('PAN number is invalid');
    updates.pan = pan;
  }
  if (input.source !== undefined) updates.source = String(input.source).trim();
  if (input.value !== undefined) updates.value = input.value === null || input.value === '' ? null : Number(input.value);
  if (input.currency !== undefined) updates.currency = String(input.currency || '').trim().toUpperCase();
  if (input.tags !== undefined) {
    updates.tags = Array.isArray(input.tags) ? input.tags : (input.tags ? [String(input.tags).trim()] : []);
  }
  if (input.customFields !== undefined && typeof input.customFields === 'object') {
    updates.customFields = input.customFields;
  }
  if (input.extension !== undefined && typeof input.extension === 'object' && !Array.isArray(input.extension)) {
    // Deep-merge per extension id/section so an empty shell cannot wipe filled fields.
    const prev =
      existing.extension && typeof existing.extension === 'object' && !Array.isArray(existing.extension)
        ? existing.extension
        : {};
    updates.extension = mergeLeadExtensionBags(prev, input.extension);
  }
  if (input.status !== undefined) {
    updates.status = String(input.status).trim() || 'active';
  }
  if (input.notes !== undefined) updates.notes = String(input.notes).trim();
  if (input.assignedTo !== undefined) {
    updates.assignedTo = resolveSelfOnlyAssignee(req, String(input.assignedTo).trim(), {
      fieldLabel: 'Lead owner',
      allowEmpty: true,
      forceSelf: false
    });
  }
  if (input.salutation !== undefined) updates.salutation = String(input.salutation).trim();
  if (input.jobTitle !== undefined) updates.jobTitle = String(input.jobTitle).trim();
  if (input.gender !== undefined) updates.gender = String(input.gender).trim();
  if (input.leadType !== undefined) updates.leadType = String(input.leadType).trim();
  if (input.requestType !== undefined) updates.requestType = String(input.requestType).trim();
  if (input.requestTypeId !== undefined) {
    updates.requestTypeId = input.requestTypeId ? String(input.requestTypeId).trim() : null;
  }
  if (input.title !== undefined) updates.title = String(input.title || '').trim();
  if (input.priority !== undefined) updates.priority = String(input.priority || '').trim();
  if (input.nextFollowUp !== undefined) {
    updates.nextFollowUp = input.nextFollowUp ? new Date(input.nextFollowUp) : null;
  }
  if (input.contactId !== undefined) updates.contactId = String(input.contactId || '').trim();
  if (input.photoUrl !== undefined) updates.photoUrl = String(input.photoUrl).trim();
  if (input.address !== undefined) updates.address = String(input.address).trim();
  if (input.formattedAddress !== undefined && input.address === undefined) {
    updates.address = String(input.formattedAddress || '').trim();
  }
  if (input.city !== undefined) updates.city = String(input.city || '').trim();
  if (input.state !== undefined) updates.state = String(input.state || '').trim();
  if (input.country !== undefined) updates.country = String(input.country || '').trim();
  if (input.postalCode !== undefined) updates.postalCode = String(input.postalCode || '').trim();
  if (input.placeId !== undefined) updates.placeId = String(input.placeId || '').trim();
  if (input.latitude !== undefined) {
    updates.latitude =
      input.latitude === null || input.latitude === '' ? null : Number(input.latitude);
  }
  if (input.longitude !== undefined) {
    updates.longitude =
      input.longitude === null || input.longitude === '' ? null : Number(input.longitude);
  }
  if (input.locationCapturedAt !== undefined) {
    updates.locationCapturedAt = input.locationCapturedAt
      ? new Date(input.locationCapturedAt)
      : null;
  }
  if (input.stage !== undefined) {
    const nextStage = String(input.stage).trim();
    assertValidStage(nextStage, validStages);
    // Editing the lead is not a way around the stage rule.
    if (nextStage !== existing.stage) assertLeadStageChangeAllowed(req);
    updates.stage = nextStage;
    if (nextStage !== existing.stage) {
      updates.stageUpdatedAt = new Date();
    }
  }

  if (['email', 'phone', 'pan', 'company'].some((field) => input[field] !== undefined)) {
    const effectiveIdentity = {
      email: updates.email !== undefined ? updates.email : existing.email,
      phone: updates.phone !== undefined ? updates.phone : existing.phone,
      pan: updates.pan !== undefined ? updates.pan : existing.pan,
      company: updates.company !== undefined ? updates.company : existing.company
    };
    const duplicateResult = await findDuplicates(req, effectiveIdentity, { excludeId: id });
    duplicateConflict(req, duplicateResult, input.allowSimilarCompany, input.allowExactDuplicate);
  }

  if (updates.company !== undefined) {
    updates.companyKey = normalizeCompanyName(updates.company);
    updates.companyTokens = buildCompanyTokens(updates.company);
  }

  const fieldCount = Object.keys(updates).filter((k) => k !== 'updatedBy').length;
  if (!fieldCount) {
    throw appError('No valid fields to update', 400);
  }

  const lead = await Lead.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  if (!lead) {
    throw appError('Lead not found or could not be updated', 404);
  }

  await AuditService.log(req, {
    action: 'updated',
    module: 'lead',
    recordId: id,
    description: `Lead updated: ${lead.name}`,
    metadata: {
      fields: Object.keys(updates).filter((k) => k !== 'updatedBy'),
      similarCompanyOverride: input.allowSimilarCompany === true,
      exactDuplicateOverride: input.allowExactDuplicate === true
    }
  });

  return enrichLeadAssignee(req, lead);
}

async function changeStage(req, id, stage, options = {}) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  // `system: true` marks a move the CRM made itself — a quotation being
  // accepted, for instance — which is allowed whoever triggered it.
  if (!options.system) assertLeadStageChangeAllowed(req);

  if (existing.convertedClientId) {
    throw appError('Cannot change stage of a converted lead', 409);
  }

  const validStages = await getValidStages(req);
  const nextStage = String(stage || '').trim();
  assertValidStage(nextStage, validStages);

  const lead = await Lead.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { stage: nextStage, stageUpdatedAt: new Date(), updatedBy: userId } },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'lead',
    recordId: id,
    description: `Lead stage changed: ${existing.stage} → ${nextStage}`,
    metadata: { from: existing.stage, to: nextStage }
  });

  return enrichLeadAssignee(req, lead);
}

/** Soft delete */
async function remove(req, id) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  const lead = await Lead.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'deleted',
    module: 'lead',
    recordId: id,
    description: `Lead deleted: ${existing.name}`
  });

  return lead;
}

/**
 * Convert Won lead → client via ClientService.
  });

  return enrichLeadAssignee(req, lead);
}

async function changeStage(req, id, stage) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  if (existing.convertedClientId) {
    throw appError('Cannot change stage of a converted lead', 409);
  }

  const validStages = await getValidStages(req);
  const nextStage = String(stage || '').trim();
  assertValidStage(nextStage, validStages);

  const lead = await Lead.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { stage: nextStage, stageUpdatedAt: new Date(), updatedBy: userId } },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'stage_changed',
    module: 'lead',
    recordId: id,
    description: `Lead stage changed: ${existing.stage} → ${nextStage}`,
    metadata: { from: existing.stage, to: nextStage }
  });

  return enrichLeadAssignee(req, lead);
}

/** Soft delete */
async function remove(req, id) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  const lead = await Lead.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'deleted',
    module: 'lead',
    recordId: id,
    description: `Lead deleted: ${existing.name}`
  });

  return lead;
}

/**
 * Convert Won lead → client via ClientService.
 */
async function convert(req, id) {
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  const ClientService = require('./client.service');
  return ClientService.convertFromLead(req, id);
}

async function updateQualification(req, id, input) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  if (existing.convertedClientId) {
    throw appError('Cannot update qualification of a lead that has already been converted', 409);
  }

  const currentQual = existing.qualification || {};
  const qualification = {
    status: input.status !== undefined ? input.status : (currentQual.status || 'Not Started'),
    industry: input.industry !== undefined ? input.industry : (currentQual.industry || ''),
    customerType: input.customerType !== undefined ? input.customerType : (currentQual.customerType || ''),
    businessPotential: input.businessPotential !== undefined ? input.businessPotential : (currentQual.businessPotential || ''),
    annualRequirement: input.annualRequirement !== undefined ? input.annualRequirement : (currentQual.annualRequirement || ''),
    geographicCoverage: input.geographicCoverage !== undefined ? input.geographicCoverage : (currentQual.geographicCoverage || ''),
    expectedRevenue: input.expectedRevenue !== undefined ? input.expectedRevenue : (currentQual.expectedRevenue ?? null),
    targetPrice: input.targetPrice !== undefined ? input.targetPrice : (currentQual.targetPrice || ''),
    paymentTerms: input.paymentTerms !== undefined ? input.paymentTerms : (currentQual.paymentTerms || ''),
    technicalFeasibility: input.technicalFeasibility !== undefined ? input.technicalFeasibility : (currentQual.technicalFeasibility || ''),
    sampleRequired: input.sampleRequired !== undefined ? Boolean(input.sampleRequired) : Boolean(currentQual.sampleRequired),
    qualityApproved: input.qualityApproved !== undefined ? Boolean(input.qualityApproved) : Boolean(currentQual.qualityApproved),
    qualificationNotes: input.qualificationNotes !== undefined ? input.qualificationNotes : (currentQual.qualificationNotes || ''),
    rejectionReason: input.rejectionReason !== undefined ? input.rejectionReason : (currentQual.rejectionReason || ''),
    updatedAt: new Date(),
    updatedBy: userId
  };

  const updated = await Lead.findOneAndUpdate(
    { _id: id, ...baseFilter(req) },
    { $set: { qualification, updatedBy: userId } },
    { new: true }
  ).lean();

  if (!updated) throw appError('Lead update failed', 404);

  await AuditService.log(req, {
    action: 'qualification_updated',
    module: 'lead',
    recordId: String(updated._id),
    description: `Lead qualification updated: status ${qualification.status}`,
    metadata: {
      qualificationStatus: qualification.status,
      industry: qualification.industry,
      expectedRevenue: qualification.expectedRevenue,
      rejectionReason: qualification.rejectionReason || undefined
    }
  });

  return enrichLeadAssignee(req, updated);
}

/**
 * Mirror a commercial-requirement save onto the lead's Activity tab, so the rep
 * sees it in the interaction history and can act on it ("Interested" →
 * opportunity).
 *
 * One open row is kept per lead rather than one per save: re-saving the form
 * refreshes the existing row instead of stacking duplicate rows (and duplicate
 * Interested buttons) for the same requirement. Once a row has been converted,
 * a later save starts a fresh row, because a requirement changed after
 * conversion is genuinely new information.
 *
 * Written with the model directly — LeadEventService depends on this module, so
 * requiring it here would close a cycle. Failures never fail the save.
 */
async function recordCommercialRequirementActivity(req, lead, { score, userId }) {
  try {
    const LeadEvent = req.cms?.models?.get?.('LeadEvent');
    if (!LeadEvent) return null;

    const tenantId = resolveTenantId(req);
    const leadId = String(lead._id);
    const requestTypeLabel = String(lead.requestType || '').trim();
    const title = requestTypeLabel
      ? `Commercial requirement captured — ${requestTypeLabel}`
      : 'Commercial requirement captured';
    const description =
      score == null
        ? 'Commercial requirement form saved.'
        : `Commercial requirement form saved — match score ${score}%.`;

    const existing = await LeadEvent.findOne({
      tenantId,
      leadId,
      isDeleted: false,
      source: 'commercial_requirement',
      $or: [{ convertedOpportunityId: '' }, { convertedOpportunityId: null }, { convertedOpportunityId: { $exists: false } }]
    })
      .sort({ createdAt: -1 })
      .lean();

    if (existing) {
      return LeadEvent.findOneAndUpdate(
        { _id: existing._id, tenantId },
        { $set: { title, description, eventDate: new Date(), updatedBy: userId } },
        { new: true }
      ).lean();
    }

    const doc = await LeadEvent.create({
      tenantId,
      leadId,
      title,
      eventType: 'Other',
      eventDate: new Date(),
      status: 'Completed',
      kind: 'logged',
      source: 'commercial_requirement',
      description,
      assignedTo: lead.assignedTo || '',
      completedAt: new Date(),
      completedBy: userId,
      createdBy: userId,
      updatedBy: userId
    });
    return doc.toObject();
  } catch (error) {
    console.error(
      '[plugin:openext-crm-suite] commercial requirement activity log failed (save already succeeded):',
      error
    );
    return null;
  }
}

async function updateCommercialRequirement(req, id, input) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  if (existing.convertedClientId) {
    throw appError('Cannot update commercial requirement of a converted lead', 409);
  }

  const {
    normalizeCommercialInput,
    computeScore,
    normalizeCatalog,
    computeDynamicScore,
    normalizeDynamicValues,
    legacyValuesFromCommercial
  } = require('../utils/qualification-match.util');

  const RequestTypeService = require('./request-type.service');
  const requestTypeId =
    String(input.requestTypeId || existing.requestTypeId || existing.commercialRequirement?.requestTypeId || '').trim() ||
    null;
  const requestTypeNameHint = String(
    input.requestType || existing.requestType || ''
  ).trim();

  let requestType = null;
  if (requestTypeId || requestTypeNameHint) {
    requestType = await RequestTypeService.getByKeyOrId(
      req,
      requestTypeId || requestTypeNameHint
    );
  }

  let commercialRequirement;
  let score = null;
  let breakdown = [];

  if (requestType) {
    let valuesInput =
      input.values && typeof input.values === 'object'
        ? input.values
        : existing.commercialRequirement?.values;
    if (!valuesInput || !Object.keys(valuesInput).length) {
      valuesInput = legacyValuesFromCommercial(
        normalizeCommercialInput(input, existing.requestType)
      );
    }

    // Enforce budget limits and required field rules defined on the Request Type
    // (Bypassed when adding options or saving drafts)
    if (!input.isOptionOnly && !input.partial) {
      for (const field of requestType.fields || []) {
        const isBudget = field.key === 'budget' || String(field.label || '').trim().toLowerCase() === 'budget';
        const effMin = field.minAmount ?? field.matchNumberMin ?? (isBudget ? requestType.minBudget : null);
        const effMax = field.maxAmount ?? field.matchNumberMax ?? (isBudget ? requestType.maxBudget : null);

        const rawVal = valuesInput ? valuesInput[field.key] : undefined;
        const empty = rawVal === '' || rawVal === undefined || rawVal === null;

        if (field.required && empty) {
          throw appError(`"${field.label}" is required for ${requestType.name}`, 400);
        }

        if (field.type === 'number' && !empty) {
          const num = Number(rawVal);
          if (!Number.isFinite(num)) {
            throw appError(`"${field.label}" must be a valid number`, 400);
          }
          if (effMin != null && num < effMin) {
            throw appError(
              `"${field.label}" must be at least ₹${Number(effMin).toLocaleString()} for ${requestType.name}`,
              400
            );
          }
          if (effMax != null && num > effMax) {
            throw appError(
              `"${field.label}" cannot exceed ₹${Number(effMax).toLocaleString()} for ${requestType.name}`,
              400
            );
          }
        }
      }
    }

    const customOptions =
      input.customOptions && typeof input.customOptions === 'object'
        ? input.customOptions
        : existing.commercialRequirement?.customOptions &&
            typeof existing.commercialRequirement.customOptions === 'object'
          ? existing.commercialRequirement.customOptions
          : {};
    const scored = computeDynamicScore(requestType, valuesInput, { customOptions });
    score = scored.score;
    breakdown = scored.breakdown;
    const isProductType = isProductRequestType(requestType);
    const needsSampleRequest = isProductType
      ? input.needsSampleRequest !== undefined
        ? Boolean(input.needsSampleRequest)
        : Boolean(existing.commercialRequirement?.needsSampleRequest)
      : false;
    commercialRequirement = {
      kind: 'dynamic',
      requestTypeId: String(requestType._id),
      requestTypeKey: requestType.key,
      values: scored.values || normalizeDynamicValues(requestType.fields, valuesInput),
      customOptions,
      needsSampleRequest,
      matchedRequirements: scored.matched || [],
      unmatchedRequirements: scored.unmatched || [],
      missingRequirements: scored.missing || [],
      project: existing.commercialRequirement?.project || {},
      product: existing.commercialRequirement?.product || {},
      score,
      scoreBreakdown: breakdown,
      scoredAt: new Date(),
      updatedAt: new Date(),
      updatedBy: userId
    };
  } else {
    const commercial = normalizeCommercialInput(input, existing.requestType);
    const settings = await SettingService.getAll(req);
    const catalog = normalizeCatalog(settings.qualification_match);
    const result = computeScore(commercial, catalog);
    score = result.score;
    breakdown = result.breakdown;
    const requestTypeName = String(existing.requestType || '');
    const isProductKind =
      commercial.kind === 'product' ||
      (/\bproduct\b/i.test(requestTypeName) && !/\bproject\b/i.test(requestTypeName));
    const needsSampleRequest = isProductKind
      ? input.needsSampleRequest !== undefined
        ? Boolean(input.needsSampleRequest)
        : Boolean(existing.commercialRequirement?.needsSampleRequest)
      : false;
    commercialRequirement = {
      ...commercial,
      requestTypeId: null,
      requestTypeKey: '',
      values: {},
      customOptions: {},
      needsSampleRequest,
      matchedRequirements: [],
      unmatchedRequirements: [],
      missingRequirements: [],
      score,
      scoreBreakdown: breakdown,
      scoredAt: new Date(),
      updatedAt: new Date(),
      updatedBy: userId
    };
  }

  const leadPatch = {
    commercialRequirement,
    updatedBy: userId,
    // Keep qualification.sampleRequired in sync for sample workflows.
    'qualification.sampleRequired': Boolean(commercialRequirement.needsSampleRequest),
    'qualification.updatedAt': new Date(),
    'qualification.updatedBy': userId
  };
  if (requestType) {
    leadPatch.requestTypeId = String(requestType._id);
    leadPatch.requestType = requestType.name;
  }

  // Filling the commercial requirement form means the lead has been worked, so
  // move it on to the "Contacted" stage. Forward-only: a lead already further
  // along the pipeline (Qualified, Proposal, Won, Lost…) is never pulled back,
  // and nothing happens when the tenant's pipeline has no "Contacted" stage.
  let stageAdvancedTo = null;
  const validStages = await getValidStages(req);
  const contactedIndex = validStages.findIndex(
    (stage) => String(stage || '').trim().toLowerCase() === 'contacted'
  );
  if (contactedIndex >= 0) {
    const currentIndex = validStages.indexOf(String(existing.stage || '').trim());
    if (currentIndex >= 0 && currentIndex < contactedIndex) {
      stageAdvancedTo = validStages[contactedIndex];
      leadPatch.stage = stageAdvancedTo;
      leadPatch.stageUpdatedAt = new Date();
    }
  }

  const updated = await Lead.findOneAndUpdate(
    { _id: id, ...baseFilter(req) },
    { $set: leadPatch },
    { new: true }
  ).lean();

  if (!updated) throw appError('Lead update failed', 404);

  await recordCommercialRequirementActivity(req, updated, { score, userId });

  if (stageAdvancedTo) {
    await AuditService.log(req, {
      action: 'stage_changed',
      module: 'lead',
      recordId: String(updated._id),
      description: `Lead stage changed: ${existing.stage} → ${stageAdvancedTo} (commercial requirement filled)`,
      metadata: { from: existing.stage, to: stageAdvancedTo, reason: 'commercial_requirement_updated' }
    });
  }

  await AuditService.log(req, {
    action: 'commercial_requirement_updated',
    module: 'lead',
    recordId: String(updated._id),
    description: `Commercial requirement updated (${
      commercialRequirement.kind || 'none'
    }) — match score ${score == null ? 'n/a' : `${score}%`}`,
    metadata: {
      kind: commercialRequirement.kind,
      score,
      requestTypeId: commercialRequirement.requestTypeId || null,
      requestType: updated.requestType || ''
    }
  });

  return enrichLeadAssignee(req, updated);
}

async function getValidSources(req) {
  return SettingService.getLeadSources(req);
}

async function getValidStatuses(req) {
  return SettingService.getLeadStatuses(req);
}

async function getValidTags(req) {
  return SettingService.getLeadTags(req);
}

async function getCustomFields(req) {
  return SettingService.getLeadCustomFields(req);
}

async function previewImport(req, { rows = [], options = {} }) {
  const { parseTags, parseCustomFields } = require('../validation/lead.schema');
  const validStages = await getValidStages(req);
  const currentUserId = resolveUserId(req);

  const defaultStage = options.defaultStage || validStages[0] || 'New';
  const defaultStatus = options.defaultStatus || 'New';
  const defaultSource = options.defaultSource || 'Website';
  const defaultAssignedTo = options.defaultAssignedTo || currentUserId || '';
  const defaultRequestType = options.defaultRequestType || options.defaultRequiredType || '';

  const results = [];
  const inBatchEmails = new Map();
  const inBatchPhones = new Map();
  const inBatchPans = new Map();

  let validCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;

  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index] || {};
    const rowIndex = index + 1;
    const errors = [];
    const warnings = [];
    const duplicates = [];

    // Extract normalized fields
    const name = String(raw.name || raw['Name'] || raw['Full Name'] || raw['Lead Name'] || '').trim();
    const company = String(raw.company || raw['Company'] || raw['Company Name'] || raw['Organization'] || '').trim();
    const email = String(raw.email || raw['Email'] || raw['Email Address'] || '').trim().toLowerCase();
    const rawPhone = String(raw.phone || raw['Phone'] || raw['Mobile'] || raw['Phone Number'] || raw['Contact'] || '').trim();
    const phone = rawPhone ? normalizeMobile(rawPhone) : '';
    const rawPan = String(raw.pan || raw['PAN'] || raw['PAN Number'] || raw['Tax ID'] || '').trim();
    const pan = rawPan ? normalizePan(rawPan) : '';
    const salutation = String(raw.salutation || raw['Salutation'] || '').trim();
    const jobTitle = String(raw.jobTitle || raw['Job Title'] || raw['Title'] || raw['Designation'] || '').trim();
    const stage = String(raw.stage || raw['Stage'] || raw['Pipeline Stage'] || defaultStage).trim();
    const source = String(raw.source || raw['Source'] || raw['Lead Source'] || defaultSource).trim();
    const status = String(raw.status || raw['Status'] || raw['Lead Status'] || defaultStatus).trim();
    const requestType = String(
      raw.requestType ||
      raw['Request Type'] ||
      raw['Required Type'] ||
      raw['request_type'] ||
      raw['required_type'] ||
      raw['RequestType'] ||
      raw['RequiredType'] ||
      raw['Requirement Type'] ||
      raw.leadType ||
      raw['Lead Type'] ||
      defaultRequestType
    ).trim();
    const assignedTo = resolveSelfOnlyAssignee(
      req,
      String(raw.assignedTo || raw['Assigned To'] || raw['Owner'] || defaultAssignedTo).trim(),
      { fieldLabel: 'Lead owner', allowEmpty: true, forceSelf: true }
    );
    const rawValue = raw.value ?? raw['Value'] ?? raw['Budget'] ?? raw['Amount'] ?? 0;
    const value = Number(rawValue) || 0;
    const city = String(raw.city || raw['City'] || '').trim();
    const state = String(raw.state || raw['State'] || '').trim();
    const country = String(raw.country || raw['Country'] || '').trim();
    const address = String(raw.address || raw['Address'] || '').trim();
    const notes = String(raw.notes || raw['Notes'] || raw['Description'] || '').trim();
    const tags = parseTags(raw.tags || raw['Tags'] || raw['Labels']);
    const customFields = parseCustomFields(raw.customFields || raw['custom_fields']);

    // Field-level Validation
    if (!name) errors.push('Name is required');
    if (!company) errors.push('Company name is required');
    if (!email) {
      errors.push('Email is required');
    } else if (!isValidEmail(email)) {
      errors.push(`Invalid email format: "${email}"`);
    }
    if (!phone) {
      errors.push('Mobile/phone number is required');
    } else if (!isValidMobile(phone)) {
      errors.push(`Invalid mobile number format: "${rawPhone}"`);
    }
    if (pan && !isValidPan(pan)) {
      errors.push(`Invalid PAN format: "${rawPan}"`);
    }
    if (!requestType) {
      errors.push('Required Type is required');
    }

    const compNorm = normalizeCompanyName(company);

    // In-batch duplicate detection (if company name is changed, import as separate contacts)
    if (email) {
      if (inBatchEmails.has(email)) {
        const prev = inBatchEmails.get(email);
        if (prev && prev.company === compNorm) {
          warnings.push(`Duplicate email in this file (matches row ${prev.rowIndex})`);
          duplicateCount++;
        }
      } else {
        inBatchEmails.set(email, { rowIndex, company: compNorm });
      }
    }
    if (phone) {
      if (inBatchPhones.has(phone)) {
        const prev = inBatchPhones.get(phone);
        if (prev && prev.company === compNorm) {
          warnings.push(`Duplicate mobile in this file (matches row ${prev.rowIndex})`);
          duplicateCount++;
        }
      } else {
        inBatchPhones.set(phone, { rowIndex, company: compNorm });
      }
    }
    if (pan) {
      if (inBatchPans.has(pan)) {
        const prev = inBatchPans.get(pan);
        if (prev && prev.company === compNorm) {
          warnings.push(`Duplicate PAN in this file (matches row ${prev.rowIndex})`);
          duplicateCount++;
        }
      } else {
        inBatchPans.set(pan, { rowIndex, company: compNorm });
      }
    }

    // Database duplicate detection
    if (email || phone || pan || company) {
      try {
        const dupResult = await findDuplicates(req, {
          email,
          phone,
          pan,
          company,
          name
        });
        const sameCompanyMatches = (dupResult.matches || []).filter((m) => {
          return m.reasons.includes('company') || normalizeCompanyName(m.company) === compNorm;
        });

        if (sameCompanyMatches.some((m) => m.reasons.some((reason) => reason !== 'company'))) {
          const matchDescs = sameCompanyMatches.map((m) => `${m.name} (${m.email || m.phone || 'duplicate'}) [${m.reasons.join(', ')}]`);
          warnings.push(`Exact duplicate found in CRM database: ${matchDescs.join('; ')}`);
          duplicates.push(...sameCompanyMatches);
          duplicateCount++;
        } else if (sameCompanyMatches.some((m) => m.reasons.includes('company'))) {
          warnings.push(`Similar company exists in CRM: ${sameCompanyMatches.map((m) => m.company).join(', ')}`);
          duplicates.push(...sameCompanyMatches);
        }
      } catch (err) {
        // Skip dup search error
      }
    }

    let rowStatus = 'valid';
    if (errors.length) {
      rowStatus = 'error';
      errorCount++;
    } else if (warnings.length) {
      rowStatus = 'warning';
      warningCount++;
    } else {
      validCount++;
    }

    results.push({
      rowIndex,
      status: rowStatus,
      errors,
      warnings,
      duplicates,
      data: {
        name,
        company,
        email,
        phone,
        pan,
        requestType,
        salutation,
        jobTitle,
        stage: validStages.includes(stage) ? stage : defaultStage,
        source: source || defaultSource,
        status: status || defaultStatus,
        assignedTo: assignedTo || defaultAssignedTo,
        value,
        city,
        state,
        country,
        address,
        notes,
        tags,
        customFields
      }
    });
  }

  return {
    totalRows: rows.length,
    validCount,
    warningCount,
    errorCount,
    duplicateCount,
    rows: results
  };
}

async function executeImport(req, { rows = [], options = {} }) {
  const { parseTags, parseCustomFields } = require('../validation/lead.schema');
  const Lead = getLeadModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const validStages = await getValidStages(req);

  const skipDuplicates = options.skipDuplicates !== false;
  const allowSimilarCompany = options.allowSimilarCompany !== false;
  const allowExactDuplicate = Boolean(options.allowExactDuplicate);
  const defaultStage = options.defaultStage || validStages[0] || 'New';
  const defaultStatus = options.defaultStatus || 'New';
  const defaultSource = options.defaultSource || 'Website';
  const defaultAssignedTo = options.defaultAssignedTo || userId || '';
  const defaultRequestType = options.defaultRequestType || options.defaultRequiredType || '';

  const results = [];
  let createdCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index] || {};
    const rowIndex = index + 1;

    try {
      const name = String(raw.name || raw['Name'] || raw['Full Name'] || raw['Lead Name'] || '').trim();
      const company = String(raw.company || raw['Company'] || raw['Company Name'] || raw['Organization'] || '').trim();
      const email = String(raw.email || raw['Email'] || raw['Email Address'] || '').trim().toLowerCase();
      const rawPhone = String(raw.phone || raw['Phone'] || raw['Mobile'] || raw['Phone Number'] || raw['Contact'] || '').trim();
      const phone = rawPhone ? normalizeMobile(rawPhone) : '';
      const rawPan = String(raw.pan || raw['PAN'] || raw['PAN Number'] || raw['Tax ID'] || '').trim();
      const pan = rawPan ? normalizePan(rawPan) : '';
      const requestType = String(
        raw.requestType ||
        raw['Request Type'] ||
        raw['Required Type'] ||
        raw['request_type'] ||
        raw['required_type'] ||
        raw['RequestType'] ||
        raw['RequiredType'] ||
        raw['Requirement Type'] ||
        raw.leadType ||
        raw['Lead Type'] ||
        defaultRequestType
      ).trim();

      if (!name || !company || !email || !phone || !requestType) {
        skippedCount++;
        results.push({
          rowIndex,
          success: false,
          reason: 'Skipped: Missing required fields (name, company, email, phone, or required type)'
        });
        continue;
      }

      if (!isValidEmail(email) || !isValidMobile(phone)) {
        skippedCount++;
        results.push({
          rowIndex,
          success: false,
          reason: 'Skipped: Invalid email or phone format'
        });
        continue;
      }

      const compNorm = normalizeCompanyName(company);

      // Check duplicates (if company name is changed, import as separate contacts)
      const dupResult = await findDuplicates(req, { email, phone, pan, company, name });
      const sameCompanyMatches = (dupResult.matches || []).filter((m) => {
        return m.reasons.includes('company') || normalizeCompanyName(m.company) === compNorm;
      });

      const hasSameCompanyExact = sameCompanyMatches.some((m) => m.reasons.some((reason) => reason !== 'company'));
      if (hasSameCompanyExact) {
        if (skipDuplicates && !allowExactDuplicate) {
          skippedCount++;
          results.push({
            rowIndex,
            success: false,
            reason: `Skipped: Exact duplicate lead found in database (${sameCompanyMatches.map((m) => m.name + ' - ' + m.reasons.join(', ')).join('; ')})`
          });
          continue;
        }
      }

      const hasSameCompanySimilar = sameCompanyMatches.some((m) => m.reasons.includes('company'));
      if (hasSameCompanySimilar && !allowSimilarCompany) {
        skippedCount++;
        results.push({
          rowIndex,
          success: false,
          reason: `Skipped: Similar company exists in database (${sameCompanyMatches.map((m) => m.company).join(', ')})`
        });
        continue;
      }

      // Resolve or create PersonContact
      // Rule: if company name is changed but email, phone number, person name are same then import as separate contacts.
      const PersonContact = req.cms?.models.get('PersonContact');
      const PersonContactService = require('./person-contact.service');
      let contactId = '';

      if (PersonContact) {
        try {
          const contactOr = [];
          if (email) contactOr.push({ email });
          if (phone) {
            const variants = typeof PersonContactService.phoneMatchVariants === 'function'
              ? PersonContactService.phoneMatchVariants(phone)
              : [phone];
            for (const v of variants) contactOr.push({ phone: v });
          }
          if (pan) contactOr.push({ pan });

          const existingContacts = contactOr.length && typeof PersonContact.find === 'function'
            ? await PersonContact.find({ tenantId, isDeleted: false, $or: contactOr }).lean()
            : [];

          // Only reuse contact if existing contact has the SAME company name
          const sameCompanyContact = Array.isArray(existingContacts)
            ? existingContacts.find((c) => {
                const cComp = normalizeCompanyName(c.companyName || '');
                return cComp && cComp === compNorm;
              })
            : null;

          if (sameCompanyContact) {
            contactId = String(sameCompanyContact._id);
          } else {
            // Company name is changed (or no contact exists): import as a separate contact!
            const newContact = await PersonContact.create({
              tenantId,
              salutation: String(raw.salutation || raw['Salutation'] || '').trim(),
              name,
              email,
              phone,
              pan: pan || '',
              jobTitle: String(raw.jobTitle || raw['Job Title'] || raw['Title'] || raw['Designation'] || '').trim(),
              companyName: company,
              leadIds: [],
              leadsCount: 0,
              clientIds: [],
              clientsCount: 0,
              createdBy: userId,
              updatedBy: userId
            });
            contactId = String(newContact._id || newContact.id);
          }
        } catch (contactErr) {
          // Non-fatal contact error
        }
      }

      // Resolve requestTypeId if RequestType model exists
      const RequestType = req.cms?.models.get('RequestType');
      let requestTypeId = null;
      if (RequestType && requestType && typeof RequestType.findOne === 'function') {
        try {
          const rt = await RequestType.findOne({
            tenantId,
            $or: [
              { name: new RegExp(`^${requestType.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'i') },
              { key: requestType.toLowerCase().replace(/[^a-z0-9]+/g, '_') }
            ]
          }).lean();
          if (rt) requestTypeId = String(rt._id);
        } catch (rtErr) {
          // ignore
        }
      }

      const stage = String(raw.stage || raw['Stage'] || raw['Pipeline Stage'] || defaultStage).trim();
      const leadData = {
        tenantId,
        name,
        company,
        companyKey: compNorm,
        companyTokens: buildCompanyTokens(company),
        contactId: contactId || undefined,
        requestType,
        requestTypeId,
        leadType: requestType,
        email,
        phone,
        pan: pan || undefined,
        salutation: String(raw.salutation || raw['Salutation'] || '').trim(),
        jobTitle: String(raw.jobTitle || raw['Job Title'] || raw['Title'] || raw['Designation'] || '').trim(),
        stage: validStages.includes(stage) ? stage : defaultStage,
        source: String(raw.source || raw['Source'] || raw['Lead Source'] || defaultSource).trim(),
        status: String(raw.status || raw['Status'] || raw['Lead Status'] || defaultStatus).trim(),
        assignedTo: resolveSelfOnlyAssignee(
          req,
          String(raw.assignedTo || raw['Assigned To'] || raw['Owner'] || defaultAssignedTo).trim() || userId,
          { fieldLabel: 'Lead owner', allowEmpty: false, forceSelf: true }
        ),
        value: Number(raw.value ?? raw['Value'] ?? raw['Budget'] ?? 0) || 0,
        city: String(raw.city || raw['City'] || '').trim(),
        state: String(raw.state || raw['State'] || '').trim(),
        country: String(raw.country || raw['Country'] || '').trim(),
        address: String(raw.address || raw['Address'] || '').trim(),
        notes: String(raw.notes || raw['Notes'] || raw['Description'] || '').trim(),
        tags: parseTags(raw.tags || raw['Tags'] || raw['Labels']),
        customFields: parseCustomFields(raw.customFields || raw['custom_fields']),
        createdBy: userId
      };

      const lead = await Lead.create(leadData);
      createdCount++;

      if (contactId && typeof PersonContactService.linkLead === 'function') {
        try {
          await PersonContactService.linkLead(req, contactId, String(lead._id || lead.id));
        } catch (linkErr) {
          // non-fatal
        }
      }

      results.push({
        rowIndex,
        success: true,
        leadId: String(lead._id || lead.id),
        name: lead.name,
        company: lead.company
      });

      // Audit log
      AuditService.log(req, {
        action: 'created',
        module: 'lead',
        recordId: String(lead._id || lead.id),
        description: `Lead imported via bulk import: "${lead.name}" (${lead.company})`,
        metadata: {
          leadId: String(lead._id || lead.id),
          name: lead.name,
          email: lead.email,
          company: lead.company,
          source: 'Bulk Import'
        }
      });
    } catch (err) {
      failedCount++;
      results.push({
        rowIndex,
        success: false,
        reason: err.message
      });
    }
  }

  return {
    totalProcessed: rows.length,
    createdCount,
    skippedCount,
    failedCount,
    results
  };
}

async function exportLeads(req, query = {}) {
  const Lead = getLeadModel(req);
  const filter = baseFilter(req);

  if (query.stage) {
    const s = toLiteralSearchTerm(String(query.stage).trim());
    if (s) filter.stage = new RegExp(`^${s}$`, 'i');
  }
  if (query.status) {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  if (query.source) {
    const s = toLiteralSearchTerm(String(query.source).trim());
    if (s) filter.source = new RegExp(`^${s}$`, 'i');
  }
  if (query.tag) {
    const t = toLiteralSearchTerm(String(query.tag).trim());
    if (t) filter.tags = new RegExp(`^${t}$`, 'i');
  }
  if (query.matchScore) {
    const band = String(query.matchScore).trim().toLowerCase();
    if (band === 'unscored') {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $or: [
            { 'commercialRequirement.score': null },
            { 'commercialRequirement.score': { $exists: false } }
          ]
        }
      ];
    } else if (band === 'strong') {
      filter['commercialRequirement.score'] = { $gte: 80 };
    } else if (band === 'partial') {
      filter['commercialRequirement.score'] = { $gte: 55, $lt: 80 };
    } else if (band === 'weak') {
      filter['commercialRequirement.score'] = { $gte: 30, $lt: 55 };
    } else if (band === 'poor') {
      filter['commercialRequirement.score'] = { $gte: 0, $lt: 30 };
    } else if (band === 'scored') {
      filter['commercialRequirement.score'] = { $ne: null, $exists: true };
    }
  }
  const exportNeedsSample =
    query.needsSampleRequest ?? query.needsSample ?? query.sampleRequired;
  if (exportNeedsSample !== undefined && exportNeedsSample !== null && String(exportNeedsSample).trim() !== '') {
    const flag = String(exportNeedsSample).trim().toLowerCase();
    const wants = flag === 'true' || flag === '1' || flag === 'yes';
    const doesnt = flag === 'false' || flag === '0' || flag === 'no';
    if (wants) {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $or: [
            { 'commercialRequirement.needsSampleRequest': true },
            { 'qualification.sampleRequired': true }
          ]
        }
      ];
    } else if (doesnt) {
      filter.$and = [
        ...(Array.isArray(filter.$and) ? filter.$and : []),
        {
          $nor: [
            { 'commercialRequirement.needsSampleRequest': true },
            { 'qualification.sampleRequired': true }
          ]
        }
      ];
    }
  }
  if (query.assignedTo) {
    filter.assignedTo = String(query.assignedTo).trim();
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = toDate;
    }
  }
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { company: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { pan: { $regex: term, $options: 'i' } },
        { source: { $regex: term, $options: 'i' } },
        { tags: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const scopedFilter = applySalesAgentLeadListScope(req, filter);
  const rawLeads = await Lead.find(scopedFilter).sort({ createdAt: -1 }).lean();
  const leads = await enrichLeadAssignees(req, rawLeads);

  const format = String(query.format || query.type || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().split('T')[0];

  // Audit log
  await AuditService.log(req, {
    action: 'exported',
    module: 'lead',
    recordId: 'export',
    description: `Exported ${leads.length} leads in ${format.toUpperCase()} format`,
    metadata: {
      count: leads.length,
      format,
      filters: query
    }
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `leads_export_${nowStr}.json`,
      content: JSON.stringify(leads, null, 2),
      data: leads,
      count: leads.length
    };
  }

  // Flatten custom fields
  const customFieldsHeaderSet = new Set();
  leads.forEach((lead) => {
    if (lead.customFields && typeof lead.customFields === 'object') {
      Object.keys(lead.customFields).forEach((key) => customFieldsHeaderSet.add(key));
    }
  });
  const customFieldKeys = Array.from(customFieldsHeaderSet);

  const baseHeaders = [
    'ID',
    'Name',
    'Salutation',
    'Job Title',
    'Gender',
    'Lead Type',
    'Request Type',
    'Email',
    'Phone',
    'Company',
    'PAN',
    'Stage',
    'Status',
    'Source',
    'Tags',
    'Assigned To (Name)',
    'Assigned To (Email)',
    'Expected Revenue',
    'Qualification Status',
    'Industry',
    'Customer Type',
    'Business Potential',
    'Annual Requirement',
    'Notes',
    'Address',
    'Created At',
    'Updated At'
  ];

  const allHeaders = [...baseHeaders, ...customFieldKeys.map((k) => `Custom: ${k}`)];

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = [allHeaders.map(escapeCsv).join(',')];

  for (const lead of leads) {
    const row = [
      lead._id || lead.id || '',
      lead.name || '',
      lead.salutation || '',
      lead.jobTitle || '',
      lead.gender || '',
      lead.leadType || '',
      lead.requestType || '',
      lead.email || '',
      lead.phone || '',
      lead.company || '',
      lead.pan || '',
      lead.stage || '',
      lead.status || '',
      lead.source || '',
      Array.isArray(lead.tags) ? lead.tags.join('; ') : '',
      lead.assignee?.name || lead.assignedTo || '',
      lead.assignee?.email || '',
      lead.qualification?.expectedRevenue !== null && lead.qualification?.expectedRevenue !== undefined
        ? lead.qualification.expectedRevenue
        : '',
      lead.qualification?.status || '',
      lead.qualification?.industry || '',
      lead.qualification?.customerType || '',
      lead.qualification?.businessPotential || '',
      lead.qualification?.annualRequirement || '',
      lead.notes || '',
      lead.address || '',
      lead.createdAt ? new Date(lead.createdAt).toISOString() : '',
      lead.updatedAt ? new Date(lead.updatedAt).toISOString() : ''
    ];

    for (const cfKey of customFieldKeys) {
      const val = lead.customFields ? lead.customFields[cfKey] : '';
      row.push(val !== undefined && val !== null ? val : '');
    }

    rows.push(row.map(escapeCsv).join(','));
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `leads_export_${nowStr}.csv`,
    content: csvContent,
    csv: csvContent,
    data: leads,
    count: leads.length
  };
}

async function bulkAssign(req, input) {
  const { leadIds = [] } = input;
  const Lead = getLeadModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const assignedTo = resolveSelfOnlyAssignee(req, input.assignedTo, {
    fieldLabel: 'Lead owner',
    allowEmpty: true,
    forceSelf: true
  });

  const filter = {
    _id: { $in: leadIds },
    tenantId,
    isDeleted: false
  };

  const scopedFilter = applySalesAgentLeadListScope(req, filter);
  const leadsToUpdate = await Lead.find(scopedFilter).select('_id').lean();
  const matchingIds = leadsToUpdate.map((l) => l._id);

  if (matchingIds.length > 0) {
    await Lead.updateMany(
      { _id: { $in: matchingIds } },
      { $set: { assignedTo, updatedBy: userId } }
    );
  }

  await AuditService.log(req, {
    action: 'bulk_assigned',
    module: 'lead',
    recordId: 'bulk',
    description: `Bulk assigned ${matchingIds.length} leads to: ${assignedTo || 'Unassigned'}`,
    metadata: {
      leadIds: matchingIds.map(String),
      assignedTo,
      updatedCount: matchingIds.length
    }
  });

  return {
    updatedCount: matchingIds.length,
    totalRequested: leadIds.length,
    assignedTo
  };
}

async function bulkChangeStage(req, input) {
  // Moving many leads at once is the same manager decision, taken in bulk.
  assertLeadStageChangeAllowed(req);
  const { leadIds = [], stage: nextStage } = input;
  const Lead = getLeadModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const validStages = await getValidStages(req);
  assertValidStage(nextStage, validStages);

  const filter = {
    _id: { $in: leadIds },
    tenantId,
    isDeleted: false,
    convertedClientId: null
  };

  const scopedFilter = applySalesAgentLeadListScope(req, filter);
  const leadsToUpdate = await Lead.find(scopedFilter).select('_id').lean();
  const matchingIds = leadsToUpdate.map((l) => l._id);

  if (matchingIds.length > 0) {
    await Lead.updateMany(
      { _id: { $in: matchingIds } },
      { $set: { stage: nextStage, stageUpdatedAt: new Date(), updatedBy: userId } }
    );
  }

  await AuditService.log(req, {
    action: 'bulk_stage_changed',
    module: 'lead',
    recordId: 'bulk',
    description: `Bulk changed stage of ${matchingIds.length} leads to: ${nextStage}`,
    metadata: {
      leadIds: matchingIds.map(String),
      stage: nextStage,
      updatedCount: matchingIds.length
    }
  });

  return {
    updatedCount: matchingIds.length,
    totalRequested: leadIds.length,
    stage: nextStage
  };
}

async function getSavedFilters(req) {
  const currentUserId = resolveUserId(req);
  const isAdmin = Boolean(req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin');
  const allSettings = await SettingService.getAll(req);
  const rawFilters = Array.isArray(allSettings.saved_lead_filters) ? allSettings.saved_lead_filters : [];

  const visible = rawFilters.filter((f) => {
    if (!f || typeof f !== 'object') return false;
    if (isAdmin) return true;
    if (f.isShared === true) return true;
    if (!f.userId || String(f.userId) === String(currentUserId)) return true;
    return false;
  });

  return visible;
}

async function createSavedFilter(req, input) {
  const currentUserId = resolveUserId(req);
  const userName = req.user?.name || req.user?.displayName || req.user?.username || 'User';
  const allSettings = await SettingService.getAll(req);
  const rawFilters = Array.isArray(allSettings.saved_lead_filters) ? [...allSettings.saved_lead_filters] : [];

  const id = 'slf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const isDefault = Boolean(input.isDefault);

  let updatedList = rawFilters;
  if (isDefault) {
    updatedList = updatedList.map((f) => {
      if (String(f.userId) === String(currentUserId)) {
        return { ...f, isDefault: false };
      }
      return f;
    });
  }

  const newFilter = {
    id,
    name: input.name,
    filters: input.filters || {},
    isShared: Boolean(input.isShared),
    isDefault,
    userId: currentUserId,
    userName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  updatedList.unshift(newFilter);

  await SettingService.updateMany(req, {
    saved_lead_filters: updatedList
  });

  await AuditService.log(req, {
    action: 'created',
    module: 'lead',
    recordId: id,
    description: `Created saved lead filter "${input.name}"`,
    metadata: {
      filterId: id,
      name: input.name,
      isShared: newFilter.isShared,
      isDefault: newFilter.isDefault
    }
  });

  return newFilter;
}

async function updateSavedFilter(req, id, input) {
  const currentUserId = resolveUserId(req);
  const isAdmin = Boolean(req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin');
  const allSettings = await SettingService.getAll(req);
  const rawFilters = Array.isArray(allSettings.saved_lead_filters) ? [...allSettings.saved_lead_filters] : [];

  const index = rawFilters.findIndex((f) => String(f.id) === String(id));
  if (index === -1) {
    throw appError('Saved filter not found', 404);
  }

  const existing = rawFilters[index];
  const isCreator = !existing.userId || String(existing.userId) === String(currentUserId);
  const canWrite = hasPermission(req, 'crm.leads.write');
  if (!isAdmin && !isCreator && !canWrite) {
    throw appError('You do not have permission to modify this saved filter', 403);
  }

  let updatedList = rawFilters;
  if (input.isDefault === true) {
    updatedList = updatedList.map((f) => {
      if (String(f.userId) === String(currentUserId)) {
        return { ...f, isDefault: false };
      }
      return f;
    });
  }

  const updatedFilter = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.filters !== undefined ? { filters: input.filters } : {}),
    ...(input.isShared !== undefined ? { isShared: input.isShared } : {}),
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    updatedAt: new Date().toISOString()
  };

  updatedList[index] = updatedFilter;

  await SettingService.updateMany(req, {
    saved_lead_filters: updatedList
  });

  await AuditService.log(req, {
    action: 'updated',
    module: 'lead',
    recordId: id,
    description: `Updated saved lead filter "${updatedFilter.name}"`,
    metadata: {
      filterId: id,
      name: updatedFilter.name,
      isShared: updatedFilter.isShared,
      isDefault: updatedFilter.isDefault
    }
  });

  return updatedFilter;
}

async function deleteSavedFilter(req, id) {
  const currentUserId = resolveUserId(req);
  const isAdmin = Boolean(req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin');
  const allSettings = await SettingService.getAll(req);
  const rawFilters = Array.isArray(allSettings.saved_lead_filters) ? [...allSettings.saved_lead_filters] : [];

  const target = rawFilters.find((f) => String(f.id) === String(id));
  if (!target) {
    return { success: true, id };
  }

  const isCreator = !target.userId || String(target.userId) === String(currentUserId);
  const canWrite = hasPermission(req, 'crm.leads.write');
  if (!isAdmin && !isCreator && !canWrite) {
    throw appError('You do not have permission to delete this saved filter', 403);
  }

  const updatedList = rawFilters.filter((f) => String(f.id) !== String(id));

  await SettingService.updateMany(req, {
    saved_lead_filters: updatedList
  });

  await AuditService.log(req, {
    action: 'deleted',
    module: 'lead',
    recordId: id,
    description: `Deleted saved lead filter "${target.name}"`,
    metadata: { filterId: id, name: target.name }
  });

  return { success: true, id };
}

/**
 * Add a product from catalogue (or custom specification) to a Lead
 */
async function addLeadProduct(req, id, input) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  let productDetails = {
    productId: input.productId ? String(input.productId).trim() : '',
    sku: input.sku ? String(input.sku).trim().toUpperCase() : '',
    productName: String(input.productName || input.name || 'Catalogue Product').trim(),
    category: input.category ? String(input.category).trim() : 'General',
    unitPrice: Math.max(0, Number(input.unitPrice) || 0),
    quantity: Math.max(1, Number(input.quantity) || 1),
    notes: input.notes ? String(input.notes).trim() : ''
  };

  if (productDetails.productId) {
    try {
      const Product = req.cms?.models.get('Product');
      if (Product) {
        const prod = await Product.findOne({ tenantId: resolveTenantId(req), _id: productDetails.productId, isDeleted: false }).lean();
        if (prod) {
          productDetails.sku = prod.sku || productDetails.sku;
          productDetails.productName = prod.name || productDetails.productName;
          productDetails.category = prod.category || productDetails.category;
          if (productDetails.unitPrice === 0 && prod.unitPrice) {
            productDetails.unitPrice = prod.unitPrice;
          }
        }
      }
    } catch {}
  }

  productDetails.totalValue = productDetails.unitPrice * productDetails.quantity;

  const currentProducts = Array.isArray(existing.interestedProducts) ? existing.interestedProducts : [];
  const updatedProducts = [...currentProducts, productDetails];
  const totalProductsValue = updatedProducts.reduce((sum, p) => sum + (Number(p.totalValue) || 0), 0);

  const updates = {
    interestedProducts: updatedProducts,
    updatedBy: userId
  };

  // If qualification expected revenue is empty, auto-update with catalogue total
  if (!existing.qualification?.expectedRevenue && totalProductsValue > 0) {
    updates['qualification.expectedRevenue'] = totalProductsValue;
  }

  const updated = await Lead.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'product_linked',
    module: 'lead',
    recordId: id,
    description: `Product "${productDetails.productName}" added to lead catalogue interests`,
    metadata: { leadId: id, product: productDetails }
  });

  return enrichLeadAssignee(req, updated);
}

/**
 * Remove an interested product from a Lead
 */
async function removeLeadProduct(req, id, productIdOrIndex) {
  const Lead = getLeadModel(req);
  const userId = resolveUserId(req);
  const existing = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, existing);

  const currentProducts = Array.isArray(existing.interestedProducts) ? existing.interestedProducts : [];
  const updatedProducts = currentProducts.filter(
    (p, idx) => String(p._id || '') !== String(productIdOrIndex) && String(p.productId || '') !== String(productIdOrIndex) && String(idx) !== String(productIdOrIndex)
  );

  const updated = await Lead.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { interestedProducts: updatedProducts, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'product_unlinked',
    module: 'lead',
    recordId: id,
    description: `Product removed from lead catalogue interests`
  });

  return enrichLeadAssignee(req, updated);
}

/**
 * Fetch all contracts associated with a Lead
 */
async function getLeadContracts(req, id) {
  const lead = await findLeadOrThrow(req, id);
  assertLeadReadAccess(req, lead);

  const Contract = req.cms?.models.get('Contract');
  if (!Contract) return [];

  const tenantId = resolveTenantId(req);
  const query = {
    tenantId,
    isDeleted: false,
    $or: [{ leadId: id }]
  };

  if (lead.convertedClientId) {
    query.$or.push({ clientId: String(lead.convertedClientId) });
  }

  return Contract.find(query).sort({ createdAt: -1 }).lean();
}

/**
 * Create a draft contract directly from a qualified Lead
 */
async function createContractFromLead(req, id, input = {}) {
  const lead = await findLeadOrThrow(req, id);
  assertLeadWriteAccess(req, lead);

  const ContractService = require('./contract.service');
  return ContractService.createFromLead(req, id, input);
}

module.exports = {
  list,
  getById,
  findDuplicates,
  create,
  update,
  updateQualification,
  updateCommercialRequirement,
  changeStage,
  remove,
  convert,
  getValidStages,
  getValidSources,
  getValidStatuses,
  getValidTags,
  getCustomFields,
  previewImport,
  executeImport,
  exportLeads,
  bulkAssign,
  bulkChangeStage,
  getSavedFilters,
  createSavedFilter,
  updateSavedFilter,
  deleteSavedFilter,
  enrichLeadsWithAgeingAndFollowUps,
  addLeadProduct,
  removeLeadProduct,
  getLeadContracts,
  createContractFromLead
};
