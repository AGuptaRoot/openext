'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const {
  assertLeadWriteAccess,
  resolveSelfOnlyAssignee,
  isSalesAgentScoped,
  isAdmin
} = require('../utils/sales-access.util');
const { enrichLeadAssignee } = require('../utils/user.util');
const AuditService = require('./audit.service');
const SettingService = require('./setting.service');
const {
  EVENT_KINDS,
  EVENT_SOURCES,
  EVENT_STATUSES,
  isMissedActivity
} = require('../utils/lead-event.constants');
const LeadService = require('./lead.service');

/** How far back a missed activity still counts as a reminder rather than noise. */
const MISSED_LOOKBACK_DAYS = 14;

function getModel(req) {
  const LeadEvent = req.cms?.models.get('LeadEvent');
  if (!LeadEvent) throw new Error('LeadEvent model is not registered');
  return LeadEvent;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

async function assertLeadRead(req, leadId) {
  return LeadService.getById(req, leadId, { includeQuality: false });
}

async function assertLeadWrite(req, leadId) {
  const lead = await LeadService.getById(req, leadId, { includeQuality: false });
  assertLeadWriteAccess(req, lead);
  return lead;
}

/**
 * Assignees must come from /users/assignable (employees / sales — never clients).
 */
async function normalizeAssignee(req, assignedTo) {
  const id = resolveSelfOnlyAssignee(
    req,
    assignedTo === undefined || assignedTo === null ? '' : String(assignedTo).trim(),
    { fieldLabel: 'Activity assignee', allowEmpty: true, forceSelf: false }
  );
  if (!id) return '';

  const ContextService = require('./context.service');
  const members = await ContextService.getAssignableUsers(req, '');
  const match = (members || []).find(
    (m) => String(m.id || m._id || m.userId || '') === id
  );
  if (!match) {
    throw appError(
      'Activity can only be assigned to an employee or sales representative (not a client)',
      400
    );
  }
  return id;
}

async function enrichEvents(req, items) {
  if (!items || !items.length) return items || [];
  const enriched = await enrichLeadAssignee(req, items);
  const hasCoords = (loc) => Boolean(loc && loc.latitude != null && loc.longitude != null && !isNaN(Number(loc.latitude)) && !isNaN(Number(loc.longitude)));
  return (enriched || []).map((ev) => {
    const startingLocation = hasCoords(ev.acceptedLocation)
      ? ev.acceptedLocation
      : (hasCoords(ev.createdLocation)
          ? ev.createdLocation
          : (ev.acceptedLocation || ev.createdLocation || null));
    return {
      ...ev,
      startingLocation
    };
  });
}

/**
 * Activity types come from the tenant's settings, so a type added in
 * Settings → Leads & Funnels is accepted immediately. Matching is
 * case-insensitive but the configured spelling is what gets stored.
 */
async function resolveEventType(req, rawType) {
  const requested = String(rawType || '').trim();
  const allowed = await SettingService.getActivityTypes(req);
  if (!requested) return allowed[0] || 'Other';
  const match = allowed.find((t) => t.toLowerCase() === requested.toLowerCase());
  if (!match) {
    throw appError(`Invalid activity type. Allowed: ${allowed.join(', ')}`);
  }
  return match;
}

/**
 * Normalise a browser geolocation reading into the stored sub-document.
 * A reading the browser could not supply is still recorded, with the reason,
 * so the Activity Location report can distinguish "denied" from "never asked".
 */
function normalizeLocation(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Number(null) is 0, so an explicitly null reading would otherwise be stored
  // as the coordinate 0,0 rather than as "no fix".
  const lat = raw.latitude == null || raw.latitude === '' ? NaN : Number(raw.latitude);
  const lng = raw.longitude == null || raw.longitude === '' ? NaN : Number(raw.longitude);
  const hasCoords =
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  const reason = String(raw.unavailableReason || '').trim().slice(0, 200);
  if (!hasCoords && !reason) return null;

  const accuracy = Number(raw.accuracy);
  const capturedAt = raw.capturedAt ? new Date(raw.capturedAt) : new Date();

  return {
    latitude: hasCoords ? Math.round(lat * 1e6) / 1e6 : null,
    longitude: hasCoords ? Math.round(lng * 1e6) / 1e6 : null,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null,
    address: String(raw.address || '').trim().slice(0, 400),
    capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
    unavailableReason: hasCoords ? '' : reason
  };
}

async function listByLead(req, leadId) {
  await assertLeadRead(req, leadId);
  const LeadEvent = getModel(req);
  const items = await LeadEvent.find({ ...baseFilter(req), leadId: String(leadId) })
    .sort({ eventDate: -1 })
    .lean();
  return enrichEvents(req, items);
}

async function create(req, leadId, input) {
  const lead = await assertLeadWrite(req, leadId);
  const LeadEvent = getModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const title = String(input.title || '').trim();
  if (!title) throw appError('Title is required');

  const eventDate = input.eventDate ? new Date(input.eventDate) : null;
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    throw appError('Event date is required');
  }

  const eventType = await resolveEventType(req, input.eventType);

  const kind = EVENT_KINDS.includes(String(input.kind || '').trim())
    ? String(input.kind).trim()
    : 'logged';
  const source = EVENT_SOURCES.includes(String(input.source || '').trim())
    ? String(input.source).trim()
    : 'manual';

  const rawCreatedLocation = normalizeLocation(input.createdLocation || input.location);
  const rawGoal = input.goalLocation !== undefined
    ? input.goalLocation
    : (input.goalLatitude !== undefined || input.goalLongitude !== undefined || input.goalAddress !== undefined)
      ? { latitude: input.goalLatitude, longitude: input.goalLongitude, address: input.goalAddress }
      : null;
  const goalLocation = normalizeLocation(rawGoal);

  // Default activity owner to the lead's sales rep when assignee is omitted.
  // Explicit empty string means intentionally unassigned.
  const hasAssigneeKey = Object.prototype.hasOwnProperty.call(input || {}, 'assignedTo');
  let assignedTo = '';
  if (hasAssigneeKey) {
    assignedTo = await normalizeAssignee(req, input.assignedTo);
  } else if (lead.assignedTo) {
    try {
      assignedTo = await normalizeAssignee(req, lead.assignedTo);
    } catch {
      assignedTo = '';
    }
  }

  let status;
  let createdLocation = null;
  let acceptedLocation = null;
  let acceptedAt = null;
  let acceptedBy = '';
  let completedLocation = null;
  let completedAt = null;
  let completedBy = '';

  const isAssignedToOther = Boolean(assignedTo && assignedTo !== userId);
  if (isAssignedToOther) {
    // If assigned to another user: do NOT capture creator device location, set status = 'Assigned'
    status = 'Assigned';
    createdLocation = null;
  } else {
    // If self-created or assignedTo === userId: Auto-accept
    createdLocation = rawCreatedLocation;
    status = kind === 'scheduled' ? 'Accepted' : 'Completed';
    acceptedLocation = normalizeLocation(input.acceptedLocation) || createdLocation;
    acceptedAt = new Date();
    acceptedBy = userId;
    if (status === 'Completed') {
      completedLocation = createdLocation;
      completedAt = new Date();
      completedBy = userId;
    }
  }

  if (input.status && EVENT_STATUSES.includes(input.status)) {
    status = input.status;
  }

  const doc = await LeadEvent.create({
    tenantId,
    leadId: String(leadId),
    title,
    eventType,
    eventDate,
    status,
    kind,
    source,
    description: input.description ? String(input.description).trim() : '',
    assignedTo,
    createdLocation,
    acceptedLocation,
    acceptedAt,
    acceptedBy,
    goalLocation,
    completedLocation,
    completedAt,
    completedBy,
    createdBy: userId,
    updatedBy: userId
  });

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'lead_event',
    recordId: result._id.toString(),
    description: `Lead ${kind === 'scheduled' ? 'activity scheduled' : 'activity logged'}: ${title}${
      assignedTo ? ` (assigned to ${assignedTo})` : ''
    }`,
    metadata: {
      leadId: String(leadId),
      eventType,
      kind,
      source,
      assignedTo: assignedTo || null,
      latitude: createdLocation?.latitude ?? null,
      longitude: createdLocation?.longitude ?? null
    }
  });

  const [enriched] = await enrichEvents(req, [result]);
  return enriched;
}

async function update(req, leadId, eventId, input) {
  const LeadEvent = getModel(req);
  const userId = resolveUserId(req);
  const admin = isAdmin(req);

  const existing = await LeadEvent.findOne({
    ...baseFilter(req),
    _id: eventId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Event not found', 404);

  if (!admin && (!existing.assignedTo || existing.assignedTo !== userId)) {
    await assertLeadWrite(req, leadId);
  }

  const updates = { updatedBy: userId };
  if (input.title !== undefined) {
    const title = String(input.title).trim();
    if (!title) throw appError('Title is required');
    updates.title = title;
  }
  if (input.eventType !== undefined) {
    updates.eventType = await resolveEventType(req, input.eventType);
  }
  if (input.eventDate !== undefined) {
    const eventDate = new Date(input.eventDate);
    if (Number.isNaN(eventDate.getTime())) throw appError('Invalid event date');
    updates.eventDate = eventDate;
  }
  if (input.description !== undefined) updates.description = String(input.description || '').trim();
  if (input.acceptedLocation !== undefined) {
    updates.acceptedLocation = normalizeLocation(input.acceptedLocation);
  }
  if (input.status !== undefined) {
    const status = String(input.status).trim();
    if (!EVENT_STATUSES.includes(status)) {
      throw appError(`Invalid status. Allowed: ${EVENT_STATUSES.join(', ')}`);
    }
    if (status === 'Completed' && existing.assignedTo && existing.assignedTo !== userId && !admin) {
      throw appError('Only the assigned sales representative can complete this activity', 403);
    }
    updates.status = status;
    if (status === 'Completed') {
      // Stamp where the rep was when they closed it out — this, not the
      // creation reading, is what evidences the client visit.
      if (!existing.completedAt) {
        updates.completedAt = new Date();
        updates.completedBy = userId;
      }
      const completedLocation = normalizeLocation(input.completedLocation || input.location);
      if (completedLocation) updates.completedLocation = completedLocation;
    } else if (status === 'Accepted') {
      if (!existing.acceptedAt) {
        updates.acceptedAt = new Date();
        updates.acceptedBy = userId;
      }
      const acceptedLocation = normalizeLocation(input.acceptedLocation || input.location);
      if (acceptedLocation) updates.acceptedLocation = acceptedLocation;
    } else {
      updates.completedAt = null;
      updates.completedBy = '';
      updates.completedLocation = null;
    }
  }
  if (input.goalLocation !== undefined || input.goalLatitude !== undefined || input.goalLongitude !== undefined || input.goalAddress !== undefined) {
    const rawGoal = input.goalLocation !== undefined
      ? input.goalLocation
      : { latitude: input.goalLatitude, longitude: input.goalLongitude, address: input.goalAddress };
    updates.goalLocation = normalizeLocation(rawGoal);
  }
  if (input.reachedGoalArea !== undefined) updates.reachedGoalArea = Boolean(input.reachedGoalArea);
  if (input.reachedGoalAt !== undefined) updates.reachedGoalAt = input.reachedGoalAt ? new Date(input.reachedGoalAt) : null;
  if (input.latestDistanceFromGoal !== undefined) updates.latestDistanceFromGoal = input.latestDistanceFromGoal != null ? Number(input.latestDistanceFromGoal) : null;
  if (input.latestUserLocation !== undefined) updates.latestUserLocation = normalizeLocation(input.latestUserLocation);
  if (input.assignedTo !== undefined) {
    updates.assignedTo = await normalizeAssignee(req, input.assignedTo);
  }

  const doc = await LeadEvent.findOneAndUpdate(
    { ...baseFilter(req), _id: eventId, leadId: String(leadId) },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'lead_event',
    recordId: eventId,
    description: `Lead event updated: ${doc.title}`,
    metadata: {
      leadId: String(leadId),
      assignedTo: doc.assignedTo || null
    }
  });

  const [enriched] = await enrichEvents(req, [doc]);
  return enriched;
}

async function complete(req, leadId, eventId, input = {}) {
  const LeadEvent = getModel(req);
  const userId = resolveUserId(req);
  const admin = isAdmin(req);

  const existing = await LeadEvent.findOne({
    ...baseFilter(req),
    _id: eventId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Event not found', 404);

  if (existing.assignedTo && existing.assignedTo !== userId && !admin) {
    throw appError('Only the assigned sales representative can complete this activity', 403);
  }

  return update(req, leadId, eventId, {
    status: 'Completed',
    completedLocation: input.completedLocation || input.location || null
  });
}
const completeEvent = complete;

async function acceptEvent(req, leadId, eventId, payload = {}) {
  const LeadEvent = getModel(req);
  const userId = resolveUserId(req);
  const admin = isAdmin(req);

  const query = LeadEvent.findOne({
    ...baseFilter(req),
    _id: eventId,
    leadId: String(leadId)
  });
  const event =
    query && typeof query.then === 'function'
      ? await query
      : query && typeof query.lean === 'function'
        ? await query.lean()
        : query;
  if (!event) throw appError('Event not found', 404);

  if (event.assignedTo && event.assignedTo !== userId && !admin) {
    throw appError('Only the assigned sales representative can accept this activity', 403);
  }
  if (event.status === 'Completed') {
    throw appError('Completed activities cannot be accepted', 400);
  }

  const acceptedLocation = payload && (payload.acceptedLocation || payload.location || (payload.latitude != null ? payload : null))
    ? normalizeLocation(payload.acceptedLocation || payload.location || payload)
    : null;
  event.status = 'Accepted';
  event.acceptedLocation = acceptedLocation;
  event.acceptedAt = new Date();
  event.acceptedBy = userId;
  event.updatedBy = userId;

  if (typeof event.save === 'function') {
    await event.save();
  } else {
    await LeadEvent.findOneAndUpdate(
      { ...baseFilter(req), _id: eventId, leadId: String(leadId) },
      {
        $set: {
          status: 'Accepted',
          acceptedLocation,
          acceptedAt: event.acceptedAt,
          acceptedBy: userId,
          updatedBy: userId
        }
      }
    );
  }

  await AuditService.log(req, {
    action: 'updated',
    module: 'lead_event',
    recordId: eventId,
    description: `Lead event accepted: ${event.title}`,
    metadata: {
      leadId: String(leadId),
      assignedTo: event.assignedTo || null,
      acceptedBy: userId,
      latitude: acceptedLocation?.latitude ?? null,
      longitude: acceptedLocation?.longitude ?? null
    }
  });

  const raw = typeof event.toObject === 'function' ? event.toObject() : event;
  const [enriched] = await enrichEvents(req, [raw]);
  return enriched;
}
const accept = acceptEvent;

/**
 * The budget the rep entered on the commercial requirement, with the limits the
 * lead's request type puts on it.
 *
 * The deal value is checked against this same range, so a figure that was legal
 * on the requirement form cannot be rejected here and a figure that was never
 * allowed there cannot sneak in through the conversion. Resolution order matches
 * the requirement form exactly (`lead.service.updateCommercialRequirement` and
 * `CommercialRequirementTab`), so all three agree on the numbers.
 *
 * Everything here is best effort: a missing or broken request type leaves the
 * limits open rather than blocking the conversion.
 */
async function resolveBudgetContext(req, lead) {
  const empty = { value: null, min: null, max: null, requestTypeName: '' };
  try {
    const commercial = lead?.commercialRequirement || {};
    const requestTypeRef =
      String(commercial.requestTypeId || lead?.requestTypeId || '').trim() ||
      String(lead?.requestType || '').trim();

    const rawValue =
      commercial.values && commercial.values.budget !== undefined
        ? commercial.values.budget
        : commercial.project?.budget;
    const parsed = Number(rawValue);
    const value = Number.isFinite(parsed) ? parsed : null;

    if (!requestTypeRef) return { ...empty, value };

    const RequestTypeService = require('./request-type.service');
    const requestType = await RequestTypeService.getByKeyOrId(req, requestTypeRef);
    if (!requestType) return { ...empty, value };

    const budgetField = (requestType.fields || []).find(
      (field) =>
        String(field?.key || '').trim().toLowerCase() === 'budget' ||
        String(field?.label || '').trim().toLowerCase() === 'budget'
    );
    const pick = (...candidates) => {
      for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null && Number.isFinite(Number(candidate))) {
          return Number(candidate);
        }
      }
      return null;
    };

    return {
      value,
      min: pick(budgetField?.minAmount, budgetField?.matchNumberMin, requestType.minBudget),
      max: pick(budgetField?.maxAmount, budgetField?.matchNumberMax, requestType.maxBudget),
      requestTypeName: String(requestType.name || '').trim()
    };
  } catch {
    return empty;
  }
}

/**
 * "Interested" on a commercial-requirement activity row → create the deal.
 *
 * Items carry a name and a description only (no quantity or price), so the
 * deal's expected revenue falls back to the lead's qualified figure rather than
 * being summed from line items.
 *
 * The deal opens on the "requirement confirmed" stage of its own pipeline —
 * the requirement is, by definition, confirmed at this point — rather than on
 * the pipeline's entry stage. Everything else takes the pipeline defaults and
 * can be refined on the opportunity afterwards.
 */
async function convertToOpportunity(req, leadId, eventId, input = {}) {
  const lead = await assertLeadWrite(req, leadId);
  const LeadEvent = getModel(req);
  const userId = resolveUserId(req);

  const existing = await LeadEvent.findOne({
    ...baseFilter(req),
    _id: eventId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Activity not found', 404);
  if (existing.convertedOpportunityId) {
    throw appError('This activity has already been converted to an opportunity', 409);
  }
  if (lead.convertedClientId) {
    throw appError('Lead is already converted to a client', 409);
  }

  const items = Array.isArray(input.items) ? input.items : [];
  const products = items
    .map((item) => ({
      productName: String(item?.name || item?.productName || '').trim(),
      description: String(item?.description || '').trim()
    }))
    .filter((item) => item.productName);
  if (!products.length) {
    throw appError('Add at least one item for the opportunity', 400);
  }

  const { validateOpportunityCreate } = require('../validation/opportunity.schema');
  const OpportunityService = require('./opportunity.service');
  const OpportunityPipelineService = require('./opportunity-pipeline.service');

  // Resolve the pipeline first so the stage we ask for is one that pipeline has.
  // Best effort: the deal is what matters here, so a pipeline lookup that fails
  // leaves the stage to OpportunityService.create rather than failing the
  // conversion.
  let pipelineId = null;
  let requirementStage = null;
  try {
    pipelineId = await OpportunityService.resolvePipelineIdForLead(req, leadId, null, lead);
    requirementStage = await OpportunityPipelineService.resolveRequirementConfirmedStage(
      req,
      pipelineId
    );
  } catch {
    pipelineId = null;
    requirementStage = null;
  }

  const leadName = String(lead.name || '').trim();
  const companyName = String(lead.company || '').trim();
  const title =
    String(input.title || '').trim() ||
    `${companyName || leadName || 'Lead'} — ${String(lead.requestType || 'Opportunity').trim()}`;

  // Deal value: what the rep typed, else the budget on the requirement, else the
  // figure qualification arrived at.
  const budget = await resolveBudgetContext(req, lead);
  const qualifiedRevenue = Number(lead.qualification?.expectedRevenue);
  let expectedRevenue = 0;
  if (input.estimatedDealValue !== undefined && input.estimatedDealValue !== null) {
    expectedRevenue = Number(input.estimatedDealValue);
  } else if (Number.isFinite(budget.value) && budget.value > 0) {
    expectedRevenue = budget.value;
  } else if (Number.isFinite(qualifiedRevenue) && qualifiedRevenue > 0) {
    expectedRevenue = qualifiedRevenue;
  }

  // Enforce the request type's budget range. A deal with no value at all is left
  // alone, so a legacy lead that never captured a budget can still be converted.
  const suppliedValue = input.estimatedDealValue !== undefined && input.estimatedDealValue !== null;
  if (suppliedValue || expectedRevenue > 0) {
    const forType = budget.requestTypeName ? ` for ${budget.requestTypeName}` : '';
    if (budget.min != null && expectedRevenue < budget.min) {
      throw appError(
        `Estimated deal value must be at least ${budget.min.toLocaleString()}${forType}`,
        400
      );
    }
    if (budget.max != null && expectedRevenue > budget.max) {
      throw appError(
        `Estimated deal value cannot exceed ${budget.max.toLocaleString()}${forType}`,
        400
      );
    }
  }

  const validated = validateOpportunityCreate({
    title: title.slice(0, 200),
    leadId: String(leadId),
    contactPerson: leadName,
    contactEmail: String(lead.email || '').trim(),
    contactMobile: String(lead.phone || '').trim(),
    products,
    expectedRevenue: Number.isFinite(expectedRevenue) && expectedRevenue > 0 ? expectedRevenue : 0,
    expectedCloseDate: input.expectedCloseDate || undefined,
    closedAt: input.closedAt || undefined,
    salesOwner: lead.assignedTo || '',
    // Omitted when the pipeline models no such stage, which leaves the deal on
    // the pipeline's entry stage instead of one its board cannot show.
    ...(requirementStage
      ? { stage: requirementStage.label, probability: requirementStage.probability }
      : {})
  });
  if (!validated.ok) {
    throw appError(validated.errors.join('; '), 400);
  }

  const opportunity = await OpportunityService.create(
    req,
    { ...validated.value, pipelineId: pipelineId || undefined },
    { keepCloseDate: true }
  );

  const opportunityId = String(opportunity?._id || opportunity?.id || '');
  const updatedEvent = await LeadEvent.findOneAndUpdate(
    { ...baseFilter(req), _id: eventId, leadId: String(leadId) },
    { $set: { convertedOpportunityId: opportunityId, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'converted',
    module: 'lead_event',
    recordId: String(eventId),
    description: `Commercial requirement marked Interested → opportunity ${
      opportunity?.opportunityNumber || opportunityId
    }${opportunity?.stage ? ` at stage "${opportunity.stage}"` : ''}`,
    metadata: {
      leadId: String(leadId),
      opportunityId,
      itemCount: products.length,
      stage: opportunity?.stage || null,
      expectedRevenue,
      budgetRange: budget.min != null || budget.max != null
        ? { min: budget.min, max: budget.max }
        : null
    }
  });

  const [enrichedEvent] = await enrichEvents(req, [updatedEvent]);
  return { opportunity, event: enrichedEvent };
}

/**
 * Distinct item names and descriptions already used on this tenant's
 * opportunities, for the type-ahead in the Interested modal.
 */
/** Lead display names for the reminder rows, best effort. */
async function resolveLeadNames(req, leadIds) {
  const map = new Map();
  if (!leadIds.length) return map;
  try {
    const Lead = req.cms?.models.get('Lead');
    if (!Lead) return map;
    const leads = await Lead.find({
      ...baseFilter(req),
      _id: { $in: leadIds }
    }).lean();
    for (const lead of leads || []) {
      const name = lead.company
        ? `${lead.name || lead.contactName || 'Lead'} (${lead.company})`
        : lead.name || lead.contactName || 'Lead';
      map.set(String(lead._id), name);
    }
  } catch {
    // A name is a nicety; the reminder still works without it.
  }
  return map;
}

/**
 * Scheduled activities the signed-in user has to act on right now.
 *
 * Two buckets, because the dashboard treats them differently: `missed` is a
 * scheduled activity whose time passed with nobody marking it Completed, and
 * `dueSoon` is one starting inside the reminder window.
 *
 * A sales representative only ever sees rows assigned to them (plus their own
 * unassigned ones, which nobody else would chase). Managers and admins may ask
 * for `scope: 'team'`, which is what the dashboard alert strip requests.
 */
async function listReminders(req, options = {}) {
  const LeadEvent = getModel(req);
  const userId = resolveUserId(req);
  const windowMinutes = Math.min(1440, Math.max(5, Number(options.windowMinutes) || 60));
  const isManagerOrAdmin = !isSalesAgentScoped(req);
  const requestedScope = String(options.scope || '').toLowerCase();
  const scope =
    isManagerOrAdmin && (requestedScope === 'team' || requestedScope === 'all')
      ? 'team'
      : 'mine';

  const now = new Date();
  const until = new Date(now.getTime() + windowMinutes * 60 * 1000);
  const since = new Date(now.getTime() - MISSED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const filter = {
    ...baseFilter(req),
    kind: 'scheduled',
    status: 'Open',
    eventDate: { $gte: since, $lte: until }
  };
  if (scope === 'mine') {
    // An activity I created but never assigned is still mine to chase.
    filter.$or = [{ assignedTo: userId }, { assignedTo: '', createdBy: userId }];
  }

  const rows = await LeadEvent.find(filter).sort({ eventDate: 1 }).lean();
  const enriched = await enrichEvents(req, rows || []);
  const leadNames = await resolveLeadNames(
    req,
    [...new Set((enriched || []).map((row) => String(row.leadId || '')).filter(Boolean))]
  );

  const nowMs = now.getTime();
  const missed = [];
  const dueSoon = [];

  for (const row of enriched || []) {
    const at = row.eventDate ? new Date(row.eventDate) : null;
    const atMs = at ? at.getTime() : NaN;
    if (!Number.isFinite(atMs)) continue;

    const hasGoal = Boolean(row.goalLocation && (row.goalLocation.latitude || row.goalLocation.address));
    const reachedGoalArea = Boolean(row.reachedGoalArea);

    const item = {
      id: String(row._id || ''),
      leadId: String(row.leadId || ''),
      leadName: leadNames.get(String(row.leadId || '')) || '',
      title: row.title || 'Scheduled activity',
      eventType: row.eventType || 'Activity',
      eventDate: at.toISOString(),
      assignedTo: row.assignedTo || '',
      assignedToLabel: row.assignedToLabel || row.assignedToName || '',
      isMine: String(row.assignedTo || '') === userId || (!row.assignedTo && row.createdBy === userId),
      hasGoal,
      reachedGoalArea,
      goalLocation: row.goalLocation || null,
      notReachedGoal: hasGoal && !reachedGoalArea
    };

    if (isMissedActivity(row, nowMs)) {
      missed.push({ ...item, minutesLate: Math.max(1, Math.round((nowMs - atMs) / 60000)) });
    } else {
      dueSoon.push({ ...item, minutesUntil: Math.max(0, Math.round((atMs - nowMs) / 60000)) });
    }
  }

  return {
    scope,
    windowMinutes,
    now: now.toISOString(),
    missed,
    dueSoon
  };
}

async function listItemSuggestions(req, query = {}) {
  const Opportunity = req.cms?.models?.get?.('Opportunity');
  if (!Opportunity) return [];

  const term = String(query.q || '').trim().toLowerCase();
  const docs = await Opportunity.find({ tenantId: resolveTenantId(req), isDeleted: false })
    .select('products')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  const seen = new Map();
  for (const doc of docs) {
    for (const product of doc.products || []) {
      const name = String(product?.productName || '').trim();
      if (!name) continue;
      const description = String(product?.description || '').trim();
      const key = `${name.toLowerCase()}|${description.toLowerCase()}`;
      if (seen.has(key)) continue;
      if (term && !name.toLowerCase().includes(term) && !description.toLowerCase().includes(term)) {
        continue;
      }
      seen.set(key, { name, description });
      if (seen.size >= 50) break;
    }
    if (seen.size >= 50) break;
  }

  return Array.from(seen.values());
}

async function remove(req, leadId, eventId) {
  await assertLeadWrite(req, leadId);
  const LeadEvent = getModel(req);
  const userId = resolveUserId(req);

  const existing = await LeadEvent.findOne({
    ...baseFilter(req),
    _id: eventId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Event not found', 404);

  await LeadEvent.findOneAndUpdate(
    { ...baseFilter(req), _id: eventId },
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
    module: 'lead_event',
    recordId: eventId,
    description: `Lead event deleted: ${existing.title}`,
    metadata: { leadId: String(leadId) }
  });

  return { deleted: true, id: eventId };
}

module.exports = {
  resolveBudgetContext,
  listByLead,
  create,
  createEvent: create,
  update,
  updateEvent: update,
  complete,
  completeEvent: complete,
  accept,
  acceptEvent: accept,
  getActivityById: (req, activityId) => require('./activity-location-log.service').getActivityById(req, activityId),
  convertToOpportunity,
  listItemSuggestions,
  listReminders,
  remove
};
