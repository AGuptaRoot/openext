'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const AuditService = require('./audit.service');
const ClientService = require('./client.service');

function getFeedbackModel(req) {
  const CustomerFeedback = req.cms?.models.get('CustomerFeedback');
  if (!CustomerFeedback) throw new Error('CustomerFeedback model is not registered');
  return CustomerFeedback;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req) };
}

/**
 * Enriches feedback reviews with Client company names, emails, and avatars.
 */
async function enrichFeedbacks(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const Company = req.cms?.models.get('Company') || req.cms?.models.get('Client');
  const clientMap = {};

  if (Company) {
    const clientIds = [...new Set(items.map((i) => String(i.clientId || '')))].filter(Boolean);
    const clients = await Company.find({
      tenantId: resolveTenantId(req),
      isDeleted: { $ne: true },
      _id: { $in: clientIds }
    })
      .select('name companyName email phone mobile avatarUrl status category')
      .lean();
    clients.forEach((c) => { clientMap[String(c._id)] = c; });
  }

  return items.map((item) => {
    const client = clientMap[String(item.clientId)];
    return {
      ...item,
      clientCompany: client?.name || client?.companyName || '—',
      clientName: client?.name || client?.companyName || '—',
      clientEmail: client?.email || '',
      clientPhone: client?.phone || client?.mobile || '',
      clientAvatarUrl: client?.avatarUrl || '',
      clientStatus: client?.status || 'Active',
      clientCategory: client?.category || ''
    };
  });
}

/**
 * Lists feedback records with pagination.
 */
async function list(req) {
  const CustomerFeedback = getFeedbackModel(req);
  const { page, limit, skip } = parsePagination(req.query);
  const filter = baseFilter(req);

  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: 'Client email ID not found in CRM records'
      };
    }
    filter.clientId = userClientId;
  } else if (req.query?.clientId) {
    filter.clientId = String(req.query.clientId).trim();
  }

  if (req.query?.category) filter.category = String(req.query.category).trim();
  if (req.query?.rating) filter.rating = Number(req.query.rating);

  const sort = { submittedAt: -1, _id: -1 };
  const [items, total] = await Promise.all([
    CustomerFeedback.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    CustomerFeedback.countDocuments(filter)
  ]);

  return {
    items: await enrichFeedbacks(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

/**
 * Submits CSAT rating & feedback review.
 */
async function create(req, input) {
  const CustomerFeedback = getFeedbackModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const { isClientUser } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const { resolvePortalIdentity } = require('../utils/portal-identity.util');
    const identity = await resolvePortalIdentity(req);
    /*
     * A satisfaction review is about delivered work, so it belongs to a client
     * account. A prospect portal has nothing to review yet.
     */
    if (identity.kind === 'lead') {
      throw appError(
        'A satisfaction review can be left once your account is set up.',
        403
      );
    }
    if (identity.kind !== 'client') {
      throw appError('Client email ID not found in CRM records', 403);
    }
    input.clientId = identity.clientId;
  }

  await ClientService.getById(req, input.clientId);

  const rating = Math.max(1, Math.min(5, Number(input.rating) || 5));

  const taskIds = Array.isArray(input.taskIds)
    ? input.taskIds.map((id) => String(id || '').trim()).filter(Boolean)
    : input.taskId
      ? [String(input.taskId).trim()].filter(Boolean)
      : [];
  const taskName = String(
    input.taskName ||
      (Array.isArray(input.taskNames) ? input.taskNames.filter(Boolean).join(', ') : '') ||
      ''
  )
    .trim()
    .slice(0, 500);
  const taskId = taskIds[0] || (input.taskId ? String(input.taskId).trim() : null) || null;

  const doc = await CustomerFeedback.create({
    tenantId,
    clientId: input.clientId,
    orderId: input.orderId || null,
    sampleId: input.sampleId || null,
    ticketId: input.ticketId || null,
    taskId,
    taskIds,
    taskName,
    rating,
    category: input.category || 'General',
    comments: String(input.comments || '').trim(),
    submittedBy: input.submittedBy || userId,
    createdBy: userId
  });

  const created = doc.toObject();
  await AuditService.log(req, {
    action: 'submitted',
    module: 'customer_feedback',
    recordId: created._id.toString(),
    description: `CSAT feedback review submitted (${rating} stars - ${input.category || 'General'}${
      taskName ? ` — task: ${taskName}` : ''
    })`,
    metadata: { rating, category: input.category, taskId, taskIds, taskName }
  });

  const [enriched] = await enrichFeedbacks(req, [created]);
  return enriched;
}

/**
 * Computes feedback summary metrics (average rating, distribution, CSAT %).
 */
async function getSummary(req) {
  const CustomerFeedback = getFeedbackModel(req);
  const filter = baseFilter(req);

  const all = await CustomerFeedback.find(filter).select('rating category').lean();

  let totalRating = 0;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const categoryCounts = {};

  all.forEach((fb) => {
    const r = Math.max(1, Math.min(5, Math.round(fb.rating || 5)));
    distribution[r] = (distribution[r] || 0) + 1;
    totalRating += fb.rating || 5;

    const cat = fb.category || 'General';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  const totalReviews = all.length;
  const averageRating = totalReviews > 0 ? Math.round((totalRating / totalReviews) * 10) / 10 : 5.0;
  const satisfiedCount = (distribution[4] || 0) + (distribution[5] || 0);
  const csatPercent = totalReviews > 0 ? Math.round((satisfiedCount / totalReviews) * 100) : 100;

  return {
    totalReviews,
    averageRating,
    csatPercent,
    distribution,
    categoryCounts
  };
}

module.exports = {
  list,
  create,
  getSummary
};
