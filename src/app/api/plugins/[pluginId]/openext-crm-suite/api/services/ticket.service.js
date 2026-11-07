'use strict';

const { resolveTenantId, resolveUserId, isClientUser, resolveClientId, resolveClientIdAsync, applyClientScope, applyClientScopeAsync } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { resolveUsernames } = require('../utils/user.util');
const AuditService = require('./audit.service');
const ClientService = require('./client.service');
const {
  applyProjectManagerTicketListScope,
  assertTicketReadAccess,
  assertTicketWriteAccess,
  assertTicketProjectInput,
  assertProjectManagerTicketAssignee
} = require('../utils/ticket-access.util');

const SLA_HOURS_MAP = {
  Urgent: 4,
  High: 24,
  Medium: 48,
  Low: 72
};

function getTicketModel(req) {
  const Ticket = req.cms?.models.get('Ticket');
  if (!Ticket) throw new Error('Ticket model is not registered');
  return Ticket;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** IDs that must never be used as support agent on client-raised tickets. */
function collectClientIdentityKeys({ clientId, requesterId, createdBy, userId } = {}) {
  return [...new Set([clientId, requesterId, createdBy, userId].filter(Boolean).map(String))];
}

function isClientIdentityAssignee(assignee, identityKeys = []) {
  const value = String(assignee || '').trim();
  if (!value || !identityKeys.length) return false;
  return identityKeys.includes(value);
}

/**
 * Client portal users must never be auto-assigned as the support agent.
 * Client account / requester IDs are also invalid assignees for client tickets.
 */
function sanitizeTicketAssignee(assignee, ctx = {}) {
  const value = assignee ? String(assignee).trim() : null;
  if (!value) return null;
  if (ctx.clientUser) return null;

  if (ctx.requesterType === 'Client') {
    const identityKeys = collectClientIdentityKeys(ctx);
    if (isClientIdentityAssignee(value, identityKeys)) return null;
  }

  return value;
}

function ticketHasInvalidClientAssignee(item) {
  if (!item?.assignedTo || item.requesterType !== 'Client') return false;
  return isClientIdentityAssignee(item.assignedTo, collectClientIdentityKeys({
    clientId: item.clientId,
    requesterId: item.requesterId,
    createdBy: item.createdBy
  }));
}

function baseFilter(req) {
  const filter = { tenantId: resolveTenantId(req), isDeleted: false };
  return applyClientScope(req, filter, 'clientId');
}

async function enforceTicketClientAccess(req, ticket) {
  if (!isClientUser(req)) return;
  const {
    resolvePortalIdentity,
    portalOwnsRecord
  } = require('../utils/portal-identity.util');
  const identity = await resolvePortalIdentity(req);
  // Covers a client account and a portal-enabled lead alike.
  if (!portalOwnsRecord(identity, ticket)) {
    throw appError('Ticket not found', 404);
  }
}

async function enforceTicketReadAccess(req, ticket) {
  await enforceTicketClientAccess(req, ticket);
  await assertTicketReadAccess(req, ticket);
}

async function enforceTicketWriteAccess(req, ticket) {
  await enforceTicketReadAccess(req, ticket);
  await assertTicketWriteAccess(req, ticket);
}

/**
 * Generates formatted unique ticket number TCK-YYYY-XXXX.
 */
async function generateTicketNumber(req) {
  const Ticket = getTicketModel(req);
  const year = new Date().getFullYear();
  const prefix = `TCK-${year}-`;
  const count = await Ticket.countDocuments({
    tenantId: resolveTenantId(req),
    ticketNumber: { $regex: `^${prefix}` }
  });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

/**
 * Enriches ticket items with Client company names, user names, watchers, and threads.
 */
async function enrichTickets(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const userIds = [
    ...new Set(
      items.flatMap((i) => [
        i.createdBy,
        i.assignedTo,
        i.updatedBy,
        i.requesterId,
        ...(Array.isArray(i.watchers) ? i.watchers : []),
        ...(Array.isArray(i.reassignmentHistory) ? i.reassignmentHistory.flatMap((r) => [r.fromUser, r.toUser, r.reallocatedBy]) : []),
        ...(Array.isArray(i.messages) ? i.messages.map((m) => m.senderId) : [])
      ]).filter(Boolean)
    )
  ];
  const nameMap = await resolveUsernames(req, userIds);

  const Client = req.cms?.models.get('Client') || req.cms?.models.get('Company');
  const clientMap = {};

  if (Client) {
    const clientIds = [...new Set(items.map((i) => String(i.clientId || i.requesterId || '')))].filter(Boolean);
    if (typeof Client.find === 'function') {
      const clients = await Client.find({ tenantId: resolveTenantId(req), _id: { $in: clientIds } }).select('name companyName contactPerson email phone mobile').lean();
      if (Array.isArray(clients)) {
        clients.forEach((c) => { clientMap[String(c._id)] = c; });
      }
    }
  }

  const Project = req.cms?.models.get('Project');
  const projectMap = {};
  if (Project) {
    const projectIds = [...new Set(items.map((i) => String(i.projectId || '')))].filter(Boolean);
    if (projectIds.length && typeof Project.find === 'function') {
      const projects = await Project.find({ tenantId: resolveTenantId(req), _id: { $in: projectIds } }).select('name').lean();
      if (Array.isArray(projects)) {
        projects.forEach((p) => { projectMap[String(p._id)] = p.name; });
      }
    }
  }

  const now = new Date();
  const { isClientUser } = require('../utils/tenant.util');
  const userIsClient = isClientUser(req);

  return items.map((item) => {
    const client = clientMap[String(item.clientId || item.requesterId)];
    const isOverdue = !['Resolved', 'Closed'].includes(item.status) && item.slaDueDate && new Date(item.slaDueDate) < now;
    const slaBreached = Boolean(item.slaBreached || isOverdue);

    const enrichedMessages = Array.isArray(item.messages)
      ? item.messages.map((m) => ({
          ...m,
          senderName: nameMap[m.senderId] || m.senderName || 'Team Member'
        }))
      : [];

    const visibleMessages = userIsClient
      ? enrichedMessages.filter((m) => !m.isInternal)
      : enrichedMessages;

    const enrichedWatchers = (Array.isArray(item.watchers) ? item.watchers : []).map((wId) => ({
      userId: String(wId),
      name: nameMap[wId] || String(wId)
    }));

    const enrichedReassignments = (Array.isArray(item.reassignmentHistory) ? item.reassignmentHistory : []).map((r) => ({
      ...r,
      fromUserName: nameMap[r.fromUser] || r.fromUser || 'Unassigned',
      toUserName: nameMap[r.toUser] || r.toUser || 'Unassigned',
      reallocatedByName: nameMap[r.reallocatedBy] || r.reallocatedBy || 'System'
    }));

    const requesterType = item.requesterType || 'Client';
    const requesterName = item.requesterName || (requesterType === 'Employee' ? (nameMap[item.requesterId] || 'Employee') : (client?.name || client?.companyName || item.contactPerson || '—'));

    const invalidClientAssignee = ticketHasInvalidClientAssignee(item);
    const effectiveAssignee = invalidClientAssignee ? null : item.assignedTo;

    return {
      ...item,
      requesterType,
      requesterName,
      requesterCompany: item.requesterCompany || client?.name || client?.companyName || '—',
      clientCompany: client?.name || client?.companyName || '—',
      contactPerson: item.contactPerson || client?.contactPerson || '—',
      projectName: projectMap[String(item.projectId)] || '',
      assignGroup: item.assignGroup || 'Technical',
      channelName: item.channelName || 'Email',
      tags: Array.isArray(item.tags) ? item.tags : [],
      assignedTo: effectiveAssignee,
      assignedToName: effectiveAssignee
        ? (nameMap[effectiveAssignee] || effectiveAssignee)
        : 'Unassigned',
      isUnassigned: !effectiveAssignee,
      createdByName: nameMap[item.createdBy] || item.createdBy || 'System',
      isOverdue,
      slaBreached,
      isArchived: Boolean(item.isArchived),
      escalationLevel: item.escalationLevel || 'Standard',
      messagesCount: visibleMessages.length,
      internalNotesCount: userIsClient ? 0 : enrichedMessages.filter((m) => m.isInternal).length,
      messages: visibleMessages,
      watchers: enrichedWatchers,
      reassignmentHistory: enrichedReassignments
    };
  });
}

/**
 * Lists tickets matching query parameters with pagination.
 */
async function list(req) {
  const Ticket = getTicketModel(req);
  const { page, limit, skip } = parsePagination(req.query);
  let filter = baseFilter(req);
  filter = await applyProjectManagerTicketListScope(req, filter);

  if (req.query?.isArchived === 'true') {
    filter.isArchived = true;
  } else if (req.query?.isArchived !== 'all') {
    filter.isArchived = { $ne: true };
  }

  if (req.query?.status) filter.status = String(req.query.status).trim();
  if (req.query?.priority) filter.priority = String(req.query.priority).trim();
  if (req.query?.type) filter.type = String(req.query.type).trim();

  const { isClientUser } = require('../utils/tenant.util');
  const {
    resolvePortalIdentity,
    portalScopeFilter,
    PORTAL_UNLINKED_MESSAGE
  } = require('../utils/portal-identity.util');
  if (isClientUser(req)) {
    const scope = portalScopeFilter(await resolvePortalIdentity(req));
    if (!scope) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: PORTAL_UNLINKED_MESSAGE
      };
    }
    Object.assign(filter, scope);
  } else {
    const queryClientId = req.query?.clientId || req.query?.client || req.query?.companyId;
    if (queryClientId) filter.clientId = String(queryClientId).trim();
  }

  if (req.query?.projectId) filter.projectId = String(req.query.projectId).trim();
  if (req.query?.assignGroup) filter.assignGroup = String(req.query.assignGroup).trim();
  if (req.query?.assignedTo) filter.assignedTo = String(req.query.assignedTo).trim();
  if (req.query?.search) {
    const s = String(req.query.search).trim();
    filter.$or = [
      { ticketNumber: { $regex: s, $options: 'i' } },
      { subject: { $regex: s, $options: 'i' } },
      { contactPerson: { $regex: s, $options: 'i' } },
      { requesterName: { $regex: s, $options: 'i' } }
    ];
  }

  const sort = { createdAt: -1, _id: -1 };
  const [items, total] = await Promise.all([
    Ticket.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Ticket.countDocuments(filter)
  ]);

  return {
    items: await enrichTickets(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

/**
 * Gets ticket by ID.
 */
async function getById(req, id) {
  const Ticket = getTicketModel(req);
  const doc = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Ticket not found', 404);
  await enforceTicketReadAccess(req, doc);
  const [enriched] = await enrichTickets(req, [doc]);
  return enriched;
}

/**
 * Creates a new support ticket.
 */
async function create(req, input) {
  const Ticket = getTicketModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const clientUser = isClientUser(req);

  if (!input.subject || !String(input.subject).trim()) {
    throw appError('Ticket Subject is required', 400);
  }
  if (!input.description || !String(input.description).trim()) {
    throw appError('Description is required', 400);
  }

  // Always attach the logged-in creator as requester.
  // Client users are forced to their linked client account.
  let requesterType = clientUser
    ? 'Client'
    : (input.requesterType === 'Client' ? 'Client' : 'Employee');
  let clientId = input.clientId ? String(input.clientId).trim() : '';
  /** Set instead of clientId when a portal-enabled lead raises the ticket. */
  let leadId = input.leadId ? String(input.leadId).trim() : '';
  let contactPerson = input.contactPerson || input.contactName || '';
  let contactEmail = input.contactEmail || '';
  let contactMobile = input.contactMobile || '';
  let requesterName = input.requesterName || '';
  let requesterCompany = input.requesterCompany || '';
  let requesterId = input.requesterId || null;

  if (clientUser) {
    const { resolvePortalIdentity } = require('../utils/portal-identity.util');
    const identity = await resolvePortalIdentity(req);
    if (identity.kind === 'none') {
      throw appError('Your client account is not linked. Please contact support.', 403);
    }
    /*
     * Support is an after-sales service, so the prospect portal does not raise
     * tickets: a lead has no contract, no account manager and no SLA. They
     * contact their sales contact instead, which the message points at.
     */
    if (identity.kind === 'lead') {
      throw appError(
        'Support tickets are available once your account is set up. Please contact your sales representative.',
        403
      );
    }
    requesterType = 'Client';
    clientId = String(identity.clientId);
    requesterId = clientId;
  } else if (requesterType === 'Employee') {
    requesterId = requesterId || userId;
    clientId = '';
  } else if (!clientId && requesterId) {
    clientId = String(requesterId);
  }

  if (requesterType === 'Client') {
    if (!clientId) throw appError('Client account is required to create this ticket', 400);
    try {
      const client = await ClientService.getById(req, clientId);
      if (client) {
        requesterId = requesterId || clientId;
        requesterName = requesterName || client.name || client.companyName || '';
        requesterCompany = requesterCompany || client.companyName || client.name || '';
        contactPerson = contactPerson || client.contactPerson || client.name || client.companyName || '';
        contactEmail = contactEmail || client.email || req.user?.email || '';
        contactMobile = contactMobile || client.phone || client.mobile || '';
      }
    } catch (err) {
      console.warn('[TicketService] Client lookup warning:', err.message);
    }
  } else {
    // Employee Requester — default to creating user
    requesterId = requesterId || userId;
    if (requesterId) {
      const nameMap = await resolveUsernames(req, [requesterId]);
      requesterName = requesterName || nameMap[requesterId] || req.user?.username || req.user?.email || 'Employee';
    }
    contactPerson = contactPerson || requesterName;
    contactEmail = contactEmail || req.user?.email || '';
    requesterCompany = requesterCompany || 'Internal Staff';
  }

  if (!requesterName) {
    requesterName = contactPerson || req.user?.username || req.user?.email || 'Requester';
  }
  if (!contactPerson) contactPerson = requesterName;

  const ticketNumber = await generateTicketNumber(req);

  const priority = input.priority || 'Medium';
  const customSla = Number(input.slaHours);
  const slaHours = Number.isFinite(customSla) && customSla > 0 ? customSla : (SLA_HOURS_MAP[priority] || 48);
  const now = new Date();
  const slaDueDate = new Date(now.getTime() + slaHours * 3600 * 1000);

  const tags = Array.isArray(input.tags)
    ? input.tags.map(String).filter(Boolean)
    : (typeof input.tags === 'string' ? input.tags.split(',').map((t) => t.trim()).filter(Boolean) : []);

  let assignedTo = null;
  if (!clientUser && input.assignedTo) {
    assertCanAssignTicketAgent(req);
    assignedTo = sanitizeTicketAssignee(String(input.assignedTo).trim(), {
      clientUser,
      requesterType,
      clientId,
      requesterId,
      createdBy: userId,
      userId
    });
  }

  const projectId = input.projectId ? String(input.projectId).trim() : null;
  await assertTicketProjectInput(req, projectId);

  if (assignedTo) {
    await assertProjectManagerTicketAssignee(req, { projectId, assigneeId: assignedTo });
  }

  const doc = await Ticket.create({
    tenantId,
    ticketNumber,
    requesterType,
    requesterId,
    requesterName,
    requesterCompany,
    clientId,
    leadId,
    contactPerson,
    contactEmail,
    contactMobile,
    assignGroup: input.assignGroup || input.group || 'Technical',
    projectId,
    channelName: input.channelName || input.channel || 'Email',
    tags,
    subject: input.subject.trim(),
    description: input.description.trim(),
    type: input.type || 'Service Request',
    priority,
    status: input.status || 'Open',
    slaHours,
    slaDueDate,
    assignedTo,
    createdBy: userId,
    updatedBy: userId
  });

  const created = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'ticket',
    recordId: created._id.toString(),
    description: `Support Ticket ${ticketNumber} (${input.subject}) created with ${priority} priority (${slaHours}h SLA)`,
    metadata: { ticketNumber, priority, slaDueDate, requesterType, requesterName, assignGroup: input.assignGroup }
  });

  const [enriched] = await enrichTickets(req, [created]);
  return enriched;
}

/**
 * Updates a ticket's status, priority, assignedTo or resolution notes.
 */
async function updateStatus(req, id, input) {
  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  if (['Resolved', 'Closed'].includes(existing.status)) {
    throw appError(`Ticket ${existing.ticketNumber} is ${existing.status} and locked from status modifications.`, 400);
  }

  if (isClientUser(req)) {
    if (input.status && input.status !== 'Resolved') {
      throw appError('Client role can only mark ticket as resolved', 403);
    }
    if (input.priority) {
      throw appError('Client role cannot modify ticket priority', 403);
    }
    if (input.assignedTo !== undefined) {
      throw appError('Client role cannot reassign tickets', 403);
    }
  }

  const updates = { updatedBy: userId };
  if (input.status) updates.status = input.status;
  if (input.priority) {
    updates.priority = input.priority;
    updates.slaHours = SLA_HOURS_MAP[input.priority] || 48;
    updates.slaDueDate = new Date(new Date(existing.createdAt).getTime() + updates.slaHours * 3600 * 1000);
  }
  if (input.assignedTo !== undefined) {
    assertCanAssignTicketAgent(req);
    updates.assignedTo = sanitizeTicketAssignee(input.assignedTo, {
      clientUser: isClientUser(req),
      requesterType: existing.requesterType,
      clientId: existing.clientId,
      requesterId: existing.requesterId,
      createdBy: existing.createdBy,
      userId
    });
    if (updates.assignedTo) {
      await assertProjectManagerTicketAssignee(req, {
        projectId: existing.projectId,
        assigneeId: updates.assignedTo
      });
    }
  }
  if (input.resolutionNotes !== undefined) updates.resolutionNotes = input.resolutionNotes;

  const now = new Date();
  if (input.status && input.status !== 'Open' && !existing.firstResponseAt) {
    updates.firstResponseAt = now;
  }

  if (['Resolved', 'Closed'].includes(input.status)) {
    updates.resolvedAt = existing.resolvedAt || now;
    const slaTarget = updates.slaDueDate || existing.slaDueDate;
    updates.slaBreached = new Date(updates.resolvedAt) > new Date(slaTarget);
  }

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'status_updated',
    module: 'ticket',
    recordId: String(id),
    description: `Support Ticket ${existing.ticketNumber} updated to "${updated.status}"`,
    metadata: { oldStatus: existing.status, newStatus: updated.status }
  });

  const [enriched] = await enrichTickets(req, [updated]);
  return enriched;
}

/**
 * Resolves a ticket with resolution notes and optional CSAT rating.
 */
async function resolveTicket(req, id, input) {
  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const now = new Date();
  const slaBreached = now > new Date(existing.slaDueDate);

  const updates = {
    status: 'Resolved',
    resolvedAt: now,
    slaBreached,
    resolutionNotes: String(input.resolutionNotes || '').trim(),
    updatedBy: userId
  };

  if (input.satisfactionRating) {
    updates.satisfactionRating = Math.max(1, Math.min(5, Number(input.satisfactionRating) || 5));
  }

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'resolved',
    module: 'ticket',
    recordId: String(id),
    description: `Support Ticket ${existing.ticketNumber} resolved`
  });

  const [enriched] = await enrichTickets(req, [updated]);
  return enriched;
}

/**
 * Soft deletes a ticket.
 */
async function remove(req, id) {
  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const doc = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId } },
    { new: true }
  ).lean();

  if (!doc) throw appError('Ticket not found', 404);

  await AuditService.log(req, {
    action: 'deleted',
    module: 'ticket',
    recordId: String(id),
    description: `Support Ticket ${doc.ticketNumber} deleted`
  });

  return { success: true, message: 'Ticket deleted successfully' };
}

async function exportTickets(req, query = {}) {
  const Ticket = getTicketModel(req);
  let filter = baseFilter(req);
  filter = await applyProjectManagerTicketListScope(req, filter);

  if (query.status) filter.status = String(query.status).trim();
  if (query.priority) filter.priority = String(query.priority).trim();
  const { isClientUser } = require('../utils/tenant.util');
  // A client's own customer id is already in baseFilter; a query may never replace it.
  if (query.clientId && !isClientUser(req)) filter.clientId = String(query.clientId).trim();
  if (query.assignedTo) filter.assignedTo = String(query.assignedTo).trim();
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { ticketNumber: { $regex: term, $options: 'i' } },
        { subject: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const raw = await Ticket.find(filter).sort({ createdAt: -1 }).lean();
  const enriched = await enrichTickets(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'ticket',
    recordId: 'export',
    description: `Exported ${enriched.length} support tickets in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `tickets_export_${nowStr}.json`,
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
    'Ticket Number',
    'Subject',
    'Client / Company',
    'Contact Person',
    'Status',
    'Priority',
    'Department',
    'Assigned Agent',
    'SLA Due Date',
    'Resolved At',
    'Resolution Notes',
    'Rating (1-5)',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const t of enriched) {
    rows.push(
      [
        t._id,
        t.ticketNumber || '',
        t.subject || '',
        t.clientCompany || t.clientName || '',
        t.contactPerson || '',
        t.status || '',
        t.priority || '',
        t.department || '',
        t.assignedToName || t.assignedTo || '',
        t.slaDue ? new Date(t.slaDue).toISOString() : '',
        t.resolvedAt ? new Date(t.resolvedAt).toISOString() : '',
        t.resolutionNotes || '',
        t.satisfactionRating || '',
        t.createdAt ? new Date(t.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `tickets_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

function generateId() {
  try {
    const mongoose = require('mongoose');
    return new mongoose.Types.ObjectId();
  } catch {
    const crypto = require('crypto');
    return crypto.randomBytes(12).toString('hex');
  }
}

/**
 * Adds a conversation thread message or internal note to a ticket.
 */
async function addMessage(req, id, input) {
  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const msgText = String(input.message || '').trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];

  if (!msgText && !attachments.length) {
    throw appError('Message text or an attachment is required', 400);
  }

  const { isClientUser } = require('../utils/tenant.util');
  const userIsClient = isClientUser(req);
  const isInternal = userIsClient ? false : Boolean(input.isInternal);
  const senderName = req.user?.name || req.user?.username || req.user?.displayName || (userIsClient ? 'Client' : 'Agent');
  const senderRole = userIsClient ? 'Client' : (req.user?.role === 'admin' || req.user?.role === 'superadmin' || req.user?.isSuperAdmin ? 'Admin' : 'Agent');

  const messageObj = {
    _id: generateId(),
    senderId: userId,
    senderName,
    senderRole,
    isInternal,
    message: msgText,
    attachments,
    createdAt: new Date()
  };

  const updates = {
    $push: { messages: messageObj },
    $set: {
      lastReplyAt: new Date(),
      updatedBy: userId
    }
  };

  if (!isInternal && !existing.firstResponseAt) {
    updates.$set.firstResponseAt = new Date();
  }

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    updates,
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: isInternal ? 'internal_note_added' : 'message_added',
    module: 'ticket',
    recordId: String(id),
    description: isInternal
      ? `Internal note added to Ticket ${existing.ticketNumber}`
      : `Reply posted to Ticket ${existing.ticketNumber}`,
    metadata: { isInternal, hasAttachments: attachments.length > 0 }
  });

  const [enriched] = await enrichTickets(req, [updated]);
  return {
    ticket: enriched,
    message: {
      ...messageObj,
      senderName
    }
  };
}

/**
 * Lists threaded messages for a ticket.
 */
async function listMessages(req, id) {
  const ticket = await getById(req, id);
  return ticket.messages || [];
}

const DEFAULT_CANNED_RESPONSES = [
  {
    _id: 'cr_1',
    title: 'Greeting & Investigating',
    shortcut: '/investigating',
    message: 'Hello, thank you for reaching out. We have received your ticket and our technical team is currently investigating the issue. We will update you shortly.',
    category: 'General'
  },
  {
    _id: 'cr_2',
    title: 'Request More Information / Logs',
    shortcut: '/logs',
    message: 'Hi there, could you please provide additional details, screenshots, or error logs to help us reproduce and resolve this faster?',
    category: 'Troubleshooting'
  },
  {
    _id: 'cr_3',
    title: 'Issue Resolved & Confirmation',
    shortcut: '/resolved',
    message: 'Hello, the reported issue has now been resolved. Please test on your end and let us know if everything is working as expected.',
    category: 'Resolution'
  },
  {
    _id: 'cr_4',
    title: 'Escalation Notice',
    shortcut: '/escalated',
    message: 'Your case has been escalated to our senior engineering team for priority review and troubleshooting.',
    category: 'Escalation'
  }
];

/**
 * Retrieves canned responses for the tenant.
 */
async function getCannedResponses(req) {
  const Setting = req.cms?.models.get('Setting');
  let custom = [];
  if (Setting) {
    const doc = await Setting.findOne({ tenantId: resolveTenantId(req), key: 'canned_responses' }).lean();
    if (doc?.value && Array.isArray(doc.value)) {
      custom = doc.value;
    }
  }
  return [...DEFAULT_CANNED_RESPONSES, ...custom];
}

/**
 * Creates a custom canned response.
 */
async function createCannedResponse(req, input) {
  const title = String(input.title || '').trim();
  const message = String(input.message || '').trim();
  if (!title || !message) throw appError('Title and message are required', 400);

  const Setting = req.cms?.models.get('Setting');
  if (!Setting) throw appError('Setting model not registered', 500);

  const tenantId = resolveTenantId(req);
  const newResponse = {
    _id: `cr_custom_${Date.now()}`,
    title,
    shortcut: String(input.shortcut || `/${title.toLowerCase().replace(/\\s+/g, '_')}`).trim(),
    message,
    category: String(input.category || 'General').trim(),
    createdAt: new Date()
  };

  const doc = await Setting.findOne({ tenantId, key: 'canned_responses' });
  if (doc) {
    const list = Array.isArray(doc.value) ? doc.value : [];
    list.push(newResponse);
    doc.value = list;
    await doc.save();
  } else {
    await Setting.create({
      tenantId,
      key: 'canned_responses',
      value: [newResponse]
    });
  }

  return newResponse;
}

/**
 * Deletes a custom canned response.
 */
async function deleteCannedResponse(req, id) {
  const Setting = req.cms?.models.get('Setting');
  if (!Setting) return { success: true };

  const tenantId = resolveTenantId(req);
  const doc = await Setting.findOne({ tenantId, key: 'canned_responses' });
  if (doc && Array.isArray(doc.value)) {
    doc.value = doc.value.filter((cr) => cr._id !== id);
    await doc.save();
  }
  return { success: true, message: 'Canned response deleted' };
}

/**
 * Adds a watcher to a ticket.
 */
async function addWatcher(req, id, input) {
  if (isClientUser(req)) {
    throw appError('Client role cannot manage ticket watchers', 403);
  }

  const Ticket = getTicketModel(req);
  const targetUserId = String(input.userId || resolveUserId(req)).trim();

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $addToSet: { watchers: targetUserId }, $set: { updatedBy: resolveUserId(req) } },
    { new: true }
  ).lean();

  if (!updated) throw appError('Ticket not found', 404);

  await AuditService.log(req, {
    action: 'watcher_added',
    module: 'ticket',
    recordId: String(id),
    description: `Watcher added to Ticket ${updated.ticketNumber}`,
    metadata: { watcherUserId: targetUserId }
  });

  const [enriched] = await enrichTickets(req, [updated]);
  return enriched;
}

/**
 * Removes a watcher from a ticket.
 */
async function removeWatcher(req, id, input) {
  if (isClientUser(req)) {
    throw appError('Client role cannot manage ticket watchers', 403);
  }

  const Ticket = getTicketModel(req);
  const targetUserId = String(input.userId || resolveUserId(req)).trim();

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $pull: { watchers: targetUserId }, $set: { updatedBy: resolveUserId(req) } },
    { new: true }
  ).lean();

  if (!updated) throw appError('Ticket not found', 404);

  const [enriched] = await enrichTickets(req, [updated]);
  return enriched;
}

/**
 * Super Admin / CRM Manager / Project Manager may assign or reassign tickets.
 */
function assertCanAssignTicketAgent(req) {
  const { isAdmin } = require('../utils/sales-access.util');
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    throw appError('Only Super Admin, CRM Manager, or Project Manager can assign tickets', 403);
  }

  const roles = [
    req.user?.role,
    req.tenantMembership?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : []),
    ...(Array.isArray(req.roles) ? req.roles : []),
    ...(Array.isArray(req.tenantMembership?.roles) ? req.tenantMembership.roles : [])
  ]
    .map((r) => String(r || '').trim().toLowerCase().replace(/[\s_]+/g, '-'))
    .filter(Boolean);

  const allowed = new Set([
    'superadmin',
    'super-admin',
    'admin',
    '0',
    '1',
    '100',
    '103',
    'crm-manager',
    'crmmanager',
    'project-manager',
    'projectmanager',
    'tenant-admin',
    'tenantadmin'
  ]);

  if (!roles.some((role) => allowed.has(role))) {
    throw appError('Only Super Admin, CRM Manager, or Project Manager can assign tickets', 403);
  }
}

/**
 * Assigns or reassigns a ticket to an agent (with handoff history).
 * First assignment of an unassigned ticket does not require a handoff reason.
 */
async function reassign(req, id, input) {
  assertCanAssignTicketAgent(req);

  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);
  const newAssignee = String(input.assignedTo || '').trim();

  if (!newAssignee) throw appError('New assignee is required', 400);

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const sanitizedAssignee = sanitizeTicketAssignee(newAssignee, {
    requesterType: existing.requesterType,
    clientId: existing.clientId,
    requesterId: existing.requesterId,
    createdBy: existing.createdBy
  });
  if (!sanitizedAssignee) {
    throw appError('The client account cannot be assigned as the support agent on this ticket', 400);
  }

  await assertProjectManagerTicketAssignee(req, {
    projectId: existing.projectId,
    assigneeId: sanitizedAssignee
  });

  const isFirstAssign = !existing.assignedTo || ticketHasInvalidClientAssignee(existing);
  const reason = String(input.reason || '').trim() || (isFirstAssign ? 'Initial assignment' : '');
  if (!isFirstAssign && !reason) {
    throw appError('Handoff reason is required when reassigning', 400);
  }

  const reallocEntry = {
    _id: generateId(),
    fromUser: existing.assignedTo || 'Unassigned',
    toUser: sanitizedAssignee,
    reason,
    reallocatedAt: new Date(),
    reallocatedBy: userId
  };

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: { assignedTo: sanitizedAssignee, updatedBy: userId },
      $push: { reassignmentHistory: reallocEntry }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: isFirstAssign ? 'assigned' : 'reassigned',
    module: 'ticket',
    recordId: String(id),
    description: isFirstAssign
      ? `Ticket ${existing.ticketNumber} assigned to ${sanitizedAssignee}`
      : `Ticket ${existing.ticketNumber} reassigned to ${sanitizedAssignee}`,
    metadata: { from: existing.assignedTo || null, to: sanitizedAssignee, reason, isFirstAssign }
  });

  const [enriched] = await enrichTickets(req, [updated]);
  return enriched;
}

/**
 * Escalates a ticket to higher tier/supervisor with SLA priority escalation.
 */
async function escalate(req, id, input) {
  if (isClientUser(req)) {
    throw appError('Client role cannot escalate tickets', 403);
  }

  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);
  const escalationLevel = input.escalationLevel || 'Level 2';
  const reason = String(input.reason || '').trim();
  const escalateTo = input.escalateTo ? String(input.escalateTo).trim() : undefined;

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const escalationEntry = {
    _id: generateId(),
    level: escalationLevel,
    reason,
    escalatedBy: userId,
    escalatedTo: escalateTo || existing.assignedTo,
    escalatedAt: new Date()
  };

  const updates = {
    escalationLevel,
    priority: 'Urgent',
    slaHours: SLA_HOURS_MAP.Urgent || 4,
    slaDueDate: new Date(Date.now() + (SLA_HOURS_MAP.Urgent || 4) * 3600 * 1000),
    updatedBy: userId
  };
  if (escalateTo) updates.assignedTo = escalateTo;

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: updates,
      $push: { escalationHistory: escalationEntry }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'escalated',
    module: 'ticket',
    recordId: String(id),
    description: `Ticket ${existing.ticketNumber} escalated to ${escalationLevel}`,
    metadata: { escalationLevel, reason, escalateTo }
  });

  const [enriched] = await enrichTickets(req, [updated]);
  return enriched;
}

/**
 * Archives a resolved/closed or inactive ticket.
 */
async function archiveTicket(req, id, input = {}) {
  if (isClientUser(req)) {
    throw appError('Client role cannot archive tickets', 403);
  }

  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const updated = await Ticket.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isArchived: true,
        archivedAt: new Date(),
        archivedBy: userId,
        archiveReason: String(input.reason || '').trim()
      }
    },
    { new: true }
  ).lean();

  if (!updated) throw appError('Ticket not found', 404);

  await AuditService.log(req, {
    action: 'archived',
    module: 'ticket',
    recordId: String(id),
    description: `Ticket ${updated.ticketNumber} archived`
  });

  return { success: true, message: 'Ticket archived successfully' };
}

/**
 * Restores an archived ticket to active listing.
 */
async function restoreTicket(req, id) {
  if (isClientUser(req)) {
    throw appError('Client role cannot restore tickets', 403);
  }

  const Ticket = getTicketModel(req);
  const userId = resolveUserId(req);

  const existing = await Ticket.findOne({ ...baseFilter(req), _id: id, isDeleted: false }).lean();
  if (!existing) throw appError('Ticket not found', 404);
  await enforceTicketWriteAccess(req, existing);

  const updated = await Ticket.findOneAndUpdate(
    { tenantId: resolveTenantId(req), _id: id },
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

  if (!updated) throw appError('Ticket not found', 404);

  await AuditService.log(req, {
    action: 'restored',
    module: 'ticket',
    recordId: String(id),
    description: `Ticket ${updated.ticketNumber} restored from archive`
  });

  return { success: true, message: 'Ticket restored successfully' };
}

module.exports = {
  list,
  getById,
  create,
  updateStatus,
  resolveTicket,
  remove,
  exportTickets,
  addMessage,
  listMessages,
  getCannedResponses,
  createCannedResponse,
  deleteCannedResponse,
  addWatcher,
  removeWatcher,
  reassign,
  escalate,
  archiveTicket,
  restoreTicket
};
