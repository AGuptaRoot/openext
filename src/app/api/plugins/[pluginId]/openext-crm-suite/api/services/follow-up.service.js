'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const LeadService = require('./lead.service');

function getModel(req) {
  const FollowUp = req.cms?.models.get('FollowUp');
  if (!FollowUp) throw new Error('FollowUp model is not registered');
  return FollowUp;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

async function assertLeadAccess(req, leadId) {
  await LeadService.getById(req, leadId, { includeQuality: false });
}

async function listByLead(req, leadId) {
  await assertLeadAccess(req, leadId);
  const FollowUp = getModel(req);
  return FollowUp.find({ ...baseFilter(req), leadId: String(leadId) })
    .sort({ dueDate: 1 })
    .lean();
}

async function create(req, leadId, input) {
  await assertLeadAccess(req, leadId);
  const FollowUp = getModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const title = String(input.title || 'Follow up').trim();
  if (!title) throw appError('Title is required');

  const dueDate = input.dueDate ? new Date(input.dueDate) : null;
  if (!dueDate || Number.isNaN(dueDate.getTime())) {
    throw appError('Due date is required');
  }

  const doc = await FollowUp.create({
    tenantId,
    leadId: String(leadId),
    title,
    dueDate,
    status: 'Open',
    notes: input.notes ? String(input.notes).trim() : '',
    createdBy: userId,
    updatedBy: userId
  });

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'follow_up',
    recordId: result._id.toString(),
    description: `Follow-up scheduled: ${title}`,
    metadata: { leadId: String(leadId), dueDate: dueDate.toISOString() }
  });

  return result;
}

async function update(req, leadId, followUpId, input) {
  await assertLeadAccess(req, leadId);
  const FollowUp = getModel(req);
  const userId = resolveUserId(req);

  const existing = await FollowUp.findOne({
    ...baseFilter(req),
    _id: followUpId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Follow-up not found', 404);

  const updates = { updatedBy: userId };
  if (input.title !== undefined) {
    const title = String(input.title).trim();
    if (!title) throw appError('Title is required');
    updates.title = title;
  }
  if (input.dueDate !== undefined) {
    const dueDate = new Date(input.dueDate);
    if (Number.isNaN(dueDate.getTime())) throw appError('Invalid due date');
    updates.dueDate = dueDate;
  }
  if (input.notes !== undefined) updates.notes = String(input.notes || '').trim();
  if (input.status !== undefined) {
    const status = String(input.status).trim();
    const { FOLLOW_UP_STATUSES } = require('../models/FollowUp');
    if (!FOLLOW_UP_STATUSES.includes(status)) {
      throw appError(`Invalid status. Allowed: ${FOLLOW_UP_STATUSES.join(', ')}`);
    }
    updates.status = status;
  }

  const doc = await FollowUp.findOneAndUpdate(
    { ...baseFilter(req), _id: followUpId, leadId: String(leadId) },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'follow_up',
    recordId: followUpId,
    description: `Follow-up updated: ${doc.title}`,
    metadata: { leadId: String(leadId) }
  });

  return doc;
}

async function complete(req, leadId, followUpId) {
  return update(req, leadId, followUpId, { status: 'Completed' });
}

async function remove(req, leadId, followUpId) {
  await assertLeadAccess(req, leadId);
  const FollowUp = getModel(req);
  const userId = resolveUserId(req);

  const existing = await FollowUp.findOne({
    ...baseFilter(req),
    _id: followUpId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Follow-up not found', 404);

  await FollowUp.findOneAndUpdate(
    { ...baseFilter(req), _id: followUpId },
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
    module: 'follow_up',
    recordId: followUpId,
    description: `Follow-up deleted: ${existing.title}`,
    metadata: { leadId: String(leadId) }
  });

  return { deleted: true, id: followUpId };
}

module.exports = {
  listByLead,
  create,
  update,
  complete,
  remove
};
