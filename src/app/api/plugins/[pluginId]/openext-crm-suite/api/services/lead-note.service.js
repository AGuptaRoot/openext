'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { assertLeadWriteAccess } = require('../utils/sales-access.util');
const { resolveUsername } = require('../utils/user.util');
const AuditService = require('./audit.service');

function getModel(req) {
  const LeadNote = req.cms?.models.get('LeadNote');
  if (!LeadNote) throw new Error('LeadNote model is not registered');
  return LeadNote;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

/** Read access follows the lead's own rules. */
async function assertLeadRead(req, leadId) {
  const LeadService = require('./lead.service');
  return LeadService.getById(req, leadId, { includeQuality: false });
}

async function assertLeadWrite(req, leadId) {
  const lead = await assertLeadRead(req, leadId);
  assertLeadWriteAccess(req, lead);
  return lead;
}

/** Newest first — the Notes tab lists the latest entry at the top. */
async function listByLead(req, leadId) {
  await assertLeadRead(req, leadId);
  const LeadNote = getModel(req);
  return LeadNote.find({ ...baseFilter(req), leadId: String(leadId) })
    .sort({ createdAt: -1 })
    .lean();
}

async function create(req, leadId, input) {
  await assertLeadWrite(req, leadId);
  const LeadNote = getModel(req);
  const userId = resolveUserId(req);

  const content = String(input.content || '').trim();
  if (!content) throw appError('Note content is required');

  // Stamp the author's name now so the list stays readable after staff changes.
  let createdByName = String(req?.user?.username || '').trim();
  if (!createdByName && userId !== 'system') {
    try {
      const resolved = await resolveUsername(req, userId);
      createdByName = resolved && resolved !== userId ? resolved : '';
    } catch {
      createdByName = '';
    }
  }

  const doc = await LeadNote.create({
    tenantId: resolveTenantId(req),
    leadId: String(leadId),
    content,
    createdBy: userId,
    createdByName,
    updatedBy: userId
  });

  const result = doc.toObject();

  await AuditService.log(req, {
    action: 'created',
    module: 'lead',
    recordId: String(leadId),
    description: 'Lead note added',
    metadata: { noteId: String(result._id) }
  });

  return result;
}

async function update(req, leadId, noteId, input) {
  await assertLeadWrite(req, leadId);
  const LeadNote = getModel(req);
  const userId = resolveUserId(req);

  const content = String(input.content || '').trim();
  if (!content) throw appError('Note content is required');

  const existing = await LeadNote.findOne({
    ...baseFilter(req),
    _id: noteId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Note not found', 404);

  const doc = await LeadNote.findOneAndUpdate(
    { ...baseFilter(req), _id: noteId, leadId: String(leadId) },
    { $set: { content, updatedBy: userId, editedAt: new Date() } },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'lead',
    recordId: String(leadId),
    description: 'Lead note updated',
    metadata: { noteId: String(noteId) }
  });

  return doc;
}

async function remove(req, leadId, noteId) {
  await assertLeadWrite(req, leadId);
  const LeadNote = getModel(req);
  const userId = resolveUserId(req);

  const existing = await LeadNote.findOne({
    ...baseFilter(req),
    _id: noteId,
    leadId: String(leadId)
  }).lean();
  if (!existing) throw appError('Note not found', 404);

  await LeadNote.findOneAndUpdate(
    { ...baseFilter(req), _id: noteId },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId, updatedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'lead',
    recordId: String(leadId),
    description: 'Lead note deleted',
    metadata: { noteId: String(noteId) }
  });

  return { deleted: true, id: String(noteId) };
}

/** Count per lead — used for the Notes tab status colour. */
async function countByLead(req, leadId) {
  const LeadNote = getModel(req);
  return LeadNote.countDocuments({ ...baseFilter(req), leadId: String(leadId) });
}

module.exports = {
  listByLead,
  create,
  update,
  remove,
  countByLead
};
