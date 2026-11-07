'use strict';

/**
 * In-app notifications (CRM 3.33.0): a bell in the CRM header lists the signed-in user's alerts.
 *
 *   notify(req, { userIds, title, message, link, linkLabel, key, source })
 *       → { sent, skipped }  each user gets the alert once per `key` (a repeat is skipped);
 *         users must belong to this tenant and be active; links stay inside the CRM.
 *   list(req)                → { items (newest 30), unread }   the signed-in staff user's own
 *   markRead(req, id) / markAllRead(req)
 *
 * Extensions call it through sdk.notify (their links: /ext/<id>/… or core record pages).
 */

const { resolveTenantId, resolveUserId, isClientUser } = require('../utils/tenant.util');

const ID_RE = /^[a-f0-9]{24}$/i;
const MAX_USERS = 20;
const LIST_LIMIT = 30;
const text = (v, max) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);

function model(req) {
  const Model = req && req.cms && req.cms.models && typeof req.cms.models.get === 'function' ? req.cms.models.get('CrmNotification') : null;
  if (!Model) {
    const error = new Error('Notifications are not available');
    error.status = 503;
    throw error;
  }
  return Model;
}

const settle = async (q) => (q && typeof q.lean === 'function' ? q.lean() : q);

/** A CRM page link: /ext/<extension>/… for an extension, or a core record page; '' otherwise. */
function safeLink(link, extensionId) {
  const value = text(link, 300);
  if (!value || !value.startsWith('/') || value.includes('//') || /[\s<>"'`\\]/.test(value)) return '';
  if (extensionId && value.startsWith(`/ext/${extensionId}/`)) return value;
  return /^\/(leads|opportunities|quotations|invoices|clients|contacts|payments|tasks|tickets|projects)(\/[a-f0-9]{24})?(\?[\w=&%.,:+-]*)?$/i.test(value) ? value : '';
}

/** Users of this tenant who may get the alert (exist, active). */
async function activeUsers(req, ids) {
  const { findCmsUserById } = require('../utils/user.util');
  const tenantId = resolveTenantId(req);
  const out = [];
  for (const id of ids) {
    const user = await findCmsUserById(req, id);
    if (!user || user.active === false) continue;
    if (user.tenantId && String(user.tenantId) !== String(tenantId)) continue;
    out.push(id);
  }
  return out;
}

async function notify(req, input = {}, { extensionId = '' } = {}) {
  const Model = model(req);
  const tenantId = resolveTenantId(req);
  const title = text(input.title, 120);
  const key = text(input.key, 160);
  if (!title || !key) {
    const error = new Error('notify: title and key are required');
    error.status = 400;
    error.code = 'INVALID_NOTIFICATION';
    throw error;
  }
  const ids = [...new Set([].concat(input.userIds || input.userId || []).map((v) => text(v, 24)).filter((v) => ID_RE.test(v)))].slice(0, MAX_USERS);
  const users = await activeUsers(req, ids);
  const source = extensionId ? `ext:${extensionId}` : 'crm';
  const dedupeKey = `${source}:${key}`;
  const link = safeLink(input.link, extensionId);
  let sent = 0;
  let skipped = 0;
  for (const userId of users) {
    const existing = await settle(Model.findOne({ tenantId, userId, dedupeKey }));
    if (existing) {
      skipped += 1;
      continue;
    }
    try {
      await Model.create({
        tenantId,
        userId,
        title,
        message: text(input.message, 500),
        link,
        linkLabel: link ? text(input.linkLabel, 40) || 'Open' : '',
        source,
        dedupeKey
      });
      sent += 1;
    } catch (error) {
      // Two sweeps at once: the unique index keeps one.
      if (error && (error.code === 11000 || /duplicate/i.test(String(error.message)))) skipped += 1;
      else throw error;
    }
  }
  return { sent, skipped, users: users.length };
}

function present(row) {
  return {
    id: String(row._id),
    title: text(row.title, 120),
    message: text(row.message, 500),
    link: text(row.link, 300),
    linkLabel: text(row.linkLabel, 40),
    source: text(row.source, 80),
    read: Boolean(row.readAt),
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
  };
}

async function list(req) {
  if (isClientUser(req)) return { items: [], unread: 0 };
  const Model = model(req);
  const scope = { tenantId: resolveTenantId(req), userId: String(resolveUserId(req) || '') };
  if (!scope.userId) return { items: [], unread: 0 };
  let q = Model.find(scope);
  if (q && typeof q.sort === 'function') q = q.sort({ createdAt: -1 });
  if (q && typeof q.limit === 'function') q = q.limit(LIST_LIMIT);
  const rows = (await settle(q)) || [];
  const unread = typeof Model.countDocuments === 'function' ? await Model.countDocuments({ ...scope, readAt: null }) : rows.filter((r) => !r.readAt).length;
  return { items: rows.map(present), unread };
}

async function markRead(req, id) {
  const value = text(id, 24);
  if (!ID_RE.test(value)) {
    const error = new Error('Notification not found');
    error.status = 404;
    throw error;
  }
  const Model = model(req);
  await Model.updateOne({ _id: value, tenantId: resolveTenantId(req), userId: String(resolveUserId(req) || '') }, { $set: { readAt: new Date() } });
  return { ok: true };
}

async function markAllRead(req) {
  const Model = model(req);
  await Model.updateMany({ tenantId: resolveTenantId(req), userId: String(resolveUserId(req) || ''), readAt: null }, { $set: { readAt: new Date() } });
  return { ok: true };
}

module.exports = { notify, list, markRead, markAllRead, safeLink };
