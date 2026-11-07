'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const ClientService = require('./client.service');

function getModel(req) {
  const ClientNote = req.cms?.models?.get('ClientNote');
  if (ClientNote) return ClientNote;
  try {
    return require('../models/ClientNote').schema
      ? require('mongoose').model('ClientNote')
      : null;
  } catch (_e) {
    return null;
  }
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

async function listByClient(req, clientId) {
  await assertClientAccess(req, clientId);
  const ClientNote = getModel(req);
  if (!ClientNote) return [];

  const items = await ClientNote.find({
    ...baseFilter(req),
    clientId: String(clientId)
  })
    .sort({ isPinned: -1, createdAt: -1 })
    .lean();

  return items;
}

async function create(req, clientId, input) {
  const client = await assertClientAccess(req, clientId);
  const ClientNote = getModel(req);
  if (!ClientNote) throw appError('ClientNote model is not registered', 500);

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const userName = req.user?.name || req.user?.username || req.user?.email || 'User';

  const doc = await ClientNote.create({
    tenantId,
    clientId: String(clientId),
    title: input.title,
    content: input.content,
    category: input.category || 'General',
    color: input.color || 'blue',
    isPinned: Boolean(input.isPinned),
    isPrivate: Boolean(input.isPrivate),
    createdBy: userId,
    createdByName: userName,
    updatedBy: userId
  });

  const result = doc.toObject ? doc.toObject() : doc;

  await AuditService.log(req, {
    action: 'created',
    module: 'client_note',
    recordId: String(result._id),
    description: `Note created for client ${client.name}: "${input.title}"`,
    metadata: { clientId: String(clientId), category: input.category, isPinned: input.isPinned }
  });

  return result;
}

async function update(req, clientId, noteId, input) {
  const client = await assertClientAccess(req, clientId);
  const ClientNote = getModel(req);
  if (!ClientNote) throw appError('ClientNote model is not registered', 500);

  const userId = resolveUserId(req);

  const existing = await ClientNote.findOne({
    ...baseFilter(req),
    _id: noteId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Note not found', 404);

  const updates = { ...input, updatedBy: userId };

  const updated = await ClientNote.findOneAndUpdate(
    { _id: noteId, tenantId: resolveTenantId(req) },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'client_note',
    recordId: String(noteId),
    description: `Note updated for client ${client.name}: "${updated.title}"`,
    metadata: { clientId: String(clientId) }
  });

  return updated;
}

async function togglePin(req, clientId, noteId) {
  const client = await assertClientAccess(req, clientId);
  const ClientNote = getModel(req);
  if (!ClientNote) throw appError('ClientNote model is not registered', 500);

  const existing = await ClientNote.findOne({
    ...baseFilter(req),
    _id: noteId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Note not found', 404);

  const isPinned = !existing.isPinned;
  const updated = await ClientNote.findOneAndUpdate(
    { _id: noteId, tenantId: resolveTenantId(req) },
    { $set: { isPinned, updatedBy: resolveUserId(req) } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'client_note',
    recordId: String(noteId),
    description: `Note ${isPinned ? 'pinned' : 'unpinned'} for client ${client.name}: "${updated.title}"`,
    metadata: { clientId: String(clientId), isPinned }
  });

  return updated;
}

async function remove(req, clientId, noteId) {
  const client = await assertClientAccess(req, clientId);
  const ClientNote = getModel(req);
  if (!ClientNote) throw appError('ClientNote model is not registered', 500);

  const userId = resolveUserId(req);

  const existing = await ClientNote.findOne({
    ...baseFilter(req),
    _id: noteId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Note not found', 404);

  await ClientNote.findOneAndUpdate(
    { _id: noteId, tenantId: resolveTenantId(req) },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'client_note',
    recordId: String(noteId),
    description: `Note deleted for client ${client.name}: "${existing.title}"`,
    metadata: { clientId: String(clientId) }
  });

  return { success: true, message: 'Note deleted successfully' };
}

module.exports = {
  listByClient,
  create,
  update,
  togglePin,
  remove
};
