'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const ClientService = require('./client.service');

function getModel(req, modelName) {
  const model = req.cms?.models?.get(modelName);
  if (model) return model;
  try {
    return require('mongoose').model(modelName);
  } catch (_e) {
    try {
      const def = require(`../models/${modelName}.js`);
      if (def?.schema) {
        return require('mongoose').model(modelName, def.schema);
      }
    } catch (_e2) {
      return null;
    }
  }
  return null;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

async function assertClientAccess(req, clientId) {
  return await ClientService.getById(req, clientId);
}

// ---------------------------------------------------------------------------
// Client Events CRUD
// ---------------------------------------------------------------------------

async function listEvents(req, clientId) {
  await assertClientAccess(req, clientId);
  const ClientEvent = getModel(req, 'ClientEvent');
  if (!ClientEvent) return [];

  return await ClientEvent.find({
    ...baseFilter(req),
    clientId: String(clientId)
  })
    .sort({ eventDate: -1 })
    .lean();
}

async function createEvent(req, clientId, input) {
  const client = await assertClientAccess(req, clientId);
  const ClientEvent = getModel(req, 'ClientEvent');
  if (!ClientEvent) throw appError('ClientEvent model is not registered', 500);

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const userName = req.user?.name || req.user?.username || req.user?.email || 'User';

  const doc = await ClientEvent.create({
    tenantId,
    clientId: String(clientId),
    title: input.title,
    eventType: input.eventType || 'Other',
    eventDate: input.eventDate,
    durationMinutes: input.durationMinutes || 0,
    status: input.status || 'Open',
    description: input.description || '',
    attendees: input.attendees || [],
    nextAction: input.nextAction || '',
    createdBy: userId,
    createdByName: userName,
    updatedBy: userId
  });

  const result = doc.toObject ? doc.toObject() : doc;

  await AuditService.log(req, {
    action: 'created',
    module: 'client_event',
    recordId: String(result._id),
    description: `Activity logged for client ${client.name}: [${input.eventType}] ${input.title}`,
    metadata: { clientId: String(clientId), eventType: input.eventType }
  });

  return result;
}

async function updateEvent(req, clientId, eventId, input) {
  const client = await assertClientAccess(req, clientId);
  const ClientEvent = getModel(req, 'ClientEvent');
  if (!ClientEvent) throw appError('ClientEvent model is not registered', 500);

  const existing = await ClientEvent.findOne({
    ...baseFilter(req),
    _id: eventId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Event not found', 404);

  const updates = { ...input, updatedBy: resolveUserId(req) };

  const updated = await ClientEvent.findOneAndUpdate(
    { _id: eventId, tenantId: resolveTenantId(req) },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'client_event',
    recordId: String(eventId),
    description: `Activity updated for client ${client.name}: [${updated.eventType}] ${updated.title}`,
    metadata: { clientId: String(clientId) }
  });

  return updated;
}

async function completeEvent(req, clientId, eventId) {
  const client = await assertClientAccess(req, clientId);
  const ClientEvent = getModel(req, 'ClientEvent');
  if (!ClientEvent) throw appError('ClientEvent model is not registered', 500);

  const updated = await ClientEvent.findOneAndUpdate(
    { _id: eventId, tenantId: resolveTenantId(req), clientId: String(clientId) },
    { $set: { status: 'Completed', updatedBy: resolveUserId(req) } },
    { new: true }
  ).lean();

  if (!updated) throw appError('Event not found', 404);

  await AuditService.log(req, {
    action: 'updated',
    module: 'client_event',
    recordId: String(eventId),
    description: `Activity marked completed for client ${client.name}: [${updated.eventType}] ${updated.title}`,
    metadata: { clientId: String(clientId), status: 'Completed' }
  });

  return updated;
}

async function removeEvent(req, clientId, eventId) {
  const client = await assertClientAccess(req, clientId);
  const ClientEvent = getModel(req, 'ClientEvent');
  if (!ClientEvent) throw appError('ClientEvent model is not registered', 500);

  const existing = await ClientEvent.findOne({
    ...baseFilter(req),
    _id: eventId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Event not found', 404);

  await ClientEvent.findOneAndUpdate(
    { _id: eventId, tenantId: resolveTenantId(req) },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: resolveUserId(req)
      }
    }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'client_event',
    recordId: String(eventId),
    description: `Activity deleted for client ${client.name}: "${existing.title}"`,
    metadata: { clientId: String(clientId) }
  });

  return { success: true, message: 'Event deleted successfully' };
}

// ---------------------------------------------------------------------------
// Account-Level Unified Activity Timeline Aggregator
// ---------------------------------------------------------------------------

async function getAccountTimeline(req, clientId, options = {}) {
  const client = await assertClientAccess(req, clientId);
  const tenantId = resolveTenantId(req);
  const strClientId = String(clientId);
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 100));
  const categoryFilter = options.category ? String(options.category).trim().toLowerCase() : 'all';

  const timeline = [];

  // Helper safe fetch
  const safeFind = async (modelName, query, limitNum = 50) => {
    try {
      const M = getModel(req, modelName);
      if (!M) return [];
      return await M.find({ tenantId, isDeleted: { $ne: true }, ...query })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limitNum)
        .lean();
    } catch (_e) {
      return [];
    }
  };

  // 1. Client Events (Calls, Meetings, Emails, Demos, Follow-ups)
  if (['all', 'events', 'calls', 'meetings'].includes(categoryFilter)) {
    const events = await safeFind('ClientEvent', { clientId: strClientId }, 50);
    for (const ev of events) {
      timeline.push({
        id: `event_${ev._id}`,
        type: 'event',
        category: ev.eventType || 'Event',
        title: ev.title,
        description: ev.description || '',
        status: ev.status,
        timestamp: ev.eventDate || ev.createdAt,
        author: ev.createdByName || 'User',
        metadata: {
          durationMinutes: ev.durationMinutes,
          attendees: ev.attendees,
          nextAction: ev.nextAction,
          eventId: ev._id
        },
        badgeColor: ev.eventType === 'Call' ? 'blue' : ev.eventType === 'Meeting' ? 'purple' : 'indigo'
      });
    }
  }

  // 2. Client Notes
  if (['all', 'notes'].includes(categoryFilter)) {
    const notes = await safeFind('ClientNote', { clientId: strClientId }, 50);
    for (const note of notes) {
      timeline.push({
        id: `note_${note._id}`,
        type: 'note',
        category: 'Note',
        title: note.title,
        description: note.content,
        timestamp: note.createdAt,
        author: note.createdByName || 'User',
        metadata: {
          noteId: note._id,
          category: note.category,
          color: note.color,
          isPinned: note.isPinned
        },
        badgeColor: note.color || 'blue'
      });
    }
  }

  // 3. Quotations / Proposals
  if (['all', 'deals', 'finance', 'quotes'].includes(categoryFilter)) {
    const quotes = await safeFind('Estimate', { clientId: strClientId }, 30);
    for (const q of quotes) {
      timeline.push({
        id: `quote_${q._id}`,
        type: 'quotation',
        category: 'Quotation',
        title: `Proposal ${q.estimateNumber || q.quotationNo || ''}`,
        description: `Status: ${q.status} • Total: ${q.totalFormatted || (q.currency || 'USD') + ' ' + (q.total || 0)}`,
        status: q.status,
        timestamp: q.createdAt,
        metadata: { quotationId: q._id, total: q.total, validUntil: q.validUntil },
        badgeColor: q.status === 'Accepted' ? 'emerald' : q.status === 'Sent' ? 'sky' : 'amber'
      });
    }
  }

  // 4. Sales Orders
  if (['all', 'deals', 'orders'].includes(categoryFilter)) {
    const orders = await safeFind('SalesOrder', { clientId: strClientId }, 30);
    for (const ord of orders) {
      timeline.push({
        id: `order_${ord._id}`,
        type: 'order',
        category: 'Sales Order',
        title: `Order ${ord.orderNumber || ''}`,
        description: `Status: ${ord.status} • Courier: ${ord.courier || 'Standard'} • Total: ${ord.total || 0}`,
        status: ord.status,
        timestamp: ord.createdAt,
        metadata: { orderId: ord._id, trackingNumber: ord.trackingNumber },
        badgeColor: ord.status === 'Delivered' ? 'emerald' : ord.status === 'Dispatched' ? 'purple' : 'blue'
      });
    }
  }

  // 5. Invoices
  if (['all', 'finance', 'invoices'].includes(categoryFilter)) {
    const invoices = await safeFind('Invoice', { clientId: strClientId }, 30);
    for (const inv of invoices) {
      timeline.push({
        id: `inv_${inv._id}`,
        type: 'invoice',
        category: 'Invoice',
        title: `Invoice ${inv.invoiceNumber || ''}`,
        description: `Status: ${inv.status} • Total: ${inv.total || 0} • Due: ${inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : 'N/A'}`,
        status: inv.status,
        timestamp: inv.createdAt,
        metadata: { invoiceId: inv._id, amountDue: inv.amountDue, total: inv.total },
        badgeColor: inv.status === 'Paid' ? 'emerald' : inv.status === 'Overdue' ? 'rose' : 'amber'
      });
    }
  }

  // 6. Payments
  if (['all', 'finance', 'payments'].includes(categoryFilter)) {
    const payments = await safeFind('Payment', { clientId: strClientId }, 30);
    for (const p of payments) {
      timeline.push({
        id: `pmt_${p._id}`,
        type: 'payment',
        category: 'Payment',
        title: `Payment Received (${p.paymentMethod || 'Direct'})`,
        description: `Amount: ${p.amount || 0} • Ref: ${p.reference || 'N/A'}`,
        status: 'Completed',
        timestamp: p.paymentDate || p.createdAt,
        metadata: { paymentId: p._id, amount: p.amount },
        badgeColor: 'emerald'
      });
    }
  }

  // 7. Projects
  if (['all', 'projects'].includes(categoryFilter)) {
    const projects = await safeFind('Project', { client: strClientId }, 20);
    for (const prj of projects) {
      timeline.push({
        id: `prj_${prj._id}`,
        type: 'project',
        category: 'Project',
        title: `Project: ${prj.name}`,
        description: `Status: ${prj.status} • Progress: ${prj.progress || 0}% • Budget: ${prj.budget || 0}`,
        status: prj.status,
        timestamp: prj.createdAt,
        metadata: { projectId: prj._id, progress: prj.progress },
        badgeColor: prj.status === 'Completed' ? 'emerald' : 'indigo'
      });
    }
  }

  // 8. Support Tickets
  if (['all', 'tickets'].includes(categoryFilter)) {
    const tickets = await safeFind('Ticket', { clientId: strClientId }, 20);
    for (const t of tickets) {
      timeline.push({
        id: `tkt_${t._id}`,
        type: 'ticket',
        category: 'Support Ticket',
        title: `Ticket: ${t.subject || t.title || 'Support Request'}`,
        description: `Priority: ${t.priority} • Status: ${t.status}`,
        status: t.status,
        timestamp: t.createdAt,
        metadata: { ticketId: t._id, priority: t.priority },
        badgeColor: t.status === 'Resolved' || t.status === 'Closed' ? 'emerald' : t.priority === 'High' || t.priority === 'Urgent' ? 'rose' : 'sky'
      });
    }
  }

  // 9. Client Audit Logs (Creation, Updates, Address changes)
  if (['all', 'audit'].includes(categoryFilter)) {
    try {
      const AuditLog = getModel(req, 'AuditLog');
      if (AuditLog) {
        const audits = await AuditLog.find({
          tenantId,
          $or: [
            { recordId: strClientId },
            { 'metadata.clientId': strClientId }
          ]
        })
          .sort({ createdAt: -1 })
          .limit(30)
          .lean();

        for (const a of audits) {
          timeline.push({
            id: `audit_${a._id}`,
            type: 'audit',
            category: 'System Activity',
            title: a.description || `Client ${a.action}`,
            description: a.module ? `Module: ${a.module}` : '',
            timestamp: a.createdAt,
            author: a.userName || a.userId || 'System',
            metadata: { action: a.action, module: a.module },
            badgeColor: 'slate'
          });
        }
      }
    } catch (_e) {
      // ignore
    }
  }

  // Sort descending by timestamp
  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    client: {
      id: client._id,
      name: client.name,
      email: client.email,
      phone: client.phone
    },
    totalActivities: timeline.length,
    items: timeline.slice(0, limit)
  };
}

module.exports = {
  listEvents,
  createEvent,
  updateEvent,
  completeEvent,
  removeEvent,
  getAccountTimeline
};
