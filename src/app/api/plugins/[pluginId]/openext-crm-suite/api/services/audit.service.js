'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const { enrichAuditUsers, findUserIdsBySearchTerm, resolveUsername } = require('../utils/user.util');

/** Valid modules — must match AuditLog schema enum */
const MODULES = new Set([
  'lead',
  'client',
  'contact',
  'project',
  'milestone',
  'task',
  'time_log',
  'quotation',
  'quotation_template',
  'invoice',
  'invoice_template',
  'recurring_invoice',
  'credit_note',
  'payment',
  'expense',
  'lead_event',
  'follow_up',
  'lead_attachment',
  'settings',
  'tenant_security',
  'opportunity_pipeline',
  'request_type',
  // These were written by their services but missing from this whitelist, so
  // every audit entry for them was silently discarded by `log()` below.
  'opportunity',
  'sales_order',
  'sample_request',
  'contract',
  'product',
  'ticket',
  'client_note',
  'client_event',
  'marketing',
  'customer_feedback',
  'customer_success',
  'analytics_ai'
]);

function getAuditLogModel(req) {
  const AuditLog = req.cms?.models.get('AuditLog');
  if (!AuditLog) {
    throw new Error('AuditLog model is not registered');
  }
  return AuditLog;
}

/**
 * Write an immutable audit entry.
 */
function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function log(req, entry) {
  try {
    const AuditLog = getAuditLogModel(req);
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);

    if (!entry?.action || !entry?.module || !entry?.recordId) {
      console.error('[plugin:openext-crm-suite] audit log skipped: missing action, module, or recordId');
      return null;
    }

    if (!MODULES.has(entry.module)) {
      console.error(`[plugin:openext-crm-suite] audit log skipped: invalid module "${entry.module}"`);
      return null;
    }

    let username = req?.user?.username ? String(req.user.username) : null;
    if (!username && userId !== 'system') {
      username = await resolveUsername(req, userId);
      if (username === userId) username = null;
    } else if (userId === 'system') {
      username = 'System';
    }

    const metadata =
      entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
        ? { ...entry.metadata }
        : entry.metadata != null
          ? { value: entry.metadata }
          : {};

    if (username) metadata.username = username;

    const doc = await AuditLog.create({
      tenantId,
      userId,
      action: String(entry.action).trim(),
      module: entry.module,
      recordId: String(entry.recordId).trim(),
      description: entry.description ? String(entry.description).trim() : '',
      metadata: Object.keys(metadata).length ? metadata : null
    });

    return typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  } catch (error) {
    console.error('[plugin:openext-crm-suite] audit log failed (operation already succeeded):', error);
    return null;
  }
}

/**
 * Paginated audit list with optional filters.
 */
async function list(req) {
  const AuditLog = getAuditLogModel(req);
  const tenantId = resolveTenantId(req);
  const { page, limit, skip, sort } = parsePagination(req.query);

  const filter = { tenantId };

  if (req.query?.module && MODULES.has(String(req.query.module))) {
    filter.module = String(req.query.module);
  }

  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const searchClauses = [
        { description: { $regex: term, $options: 'i' } },
        { action: { $regex: term, $options: 'i' } },
        { module: { $regex: term, $options: 'i' } },
        { recordId: { $regex: term, $options: 'i' } },
        { userId: { $regex: term, $options: 'i' } }
      ];

      const matchingUserIds = await findUserIdsBySearchTerm(req, term);
      if (matchingUserIds.length) {
        searchClauses.push({ userId: { $in: matchingUserIds } });
      }

      filter.$or = searchClauses;
    }
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);

  return {
    items: await enrichAuditUsers(req, items),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
}

/**
 * Who may read one record's audit trail.
 *
 * `crm.audit.read` (managers, finance, admins) opens every module. Without it,
 * a user may still read the trail of a *lead* they are allowed to open — that
 * is what powers the Audit History tab for sales representatives, who have
 * `crm.leads.read` but deliberately not the tenant-wide audit permission.
 *
 * Any other module stays behind `crm.audit.read`; the recordId there is not a
 * lead id, so record-level ownership cannot be established from it.
 */
async function assertRecordAuditAccess(req, module, recordId) {
  const { hasPermission } = require('../utils/sales-access.util');
  if (hasPermission(req, 'crm.audit.read')) return;

  const { isClientUser } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    throw appError('Audit history is not available', 403);
  }

  if (module !== 'lead' || !hasPermission(req, 'crm.leads.read')) {
    throw appError('You do not have permission to view this audit history', 403);
  }

  // Reuse the lead read-access rules so an agent cannot read the trail of a
  // lead they could not open in the first place.
  const LeadService = require('./lead.service');
  await LeadService.getById(req, String(recordId), { includeQuality: false });
}

/** Audit trail for one record — GET /audit/:module/:recordId */
async function listByRecord(req, module, recordId) {
  const AuditLog = getAuditLogModel(req);
  const tenantId = resolveTenantId(req);

  if (!MODULES.has(module)) {
    return null;
  }

  await assertRecordAuditAccess(req, module, recordId);

  const { page, limit, skip, sort } = parsePagination(req.query);

  const filter = { tenantId, module, recordId: String(recordId).trim() };

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);

  return {
    items: await enrichAuditUsers(req, items),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
}

/** Recent entries for dashboard widget */
async function getRecent(req, limit = 10) {
  const AuditLog = getAuditLogModel(req);
  const tenantId = resolveTenantId(req);
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);

  return enrichAuditUsers(
    req,
    await AuditLog.find({ tenantId }).sort({ createdAt: -1 }).limit(safeLimit).lean()
  );
}

async function exportAudit(req, query = {}) {
  const AuditLog = getAuditLogModel(req);
  const tenantId = resolveTenantId(req);
  const filter = { tenantId };

  if (query.module && MODULES.has(String(query.module))) {
    filter.module = String(query.module);
  }

  if (query.action) {
    filter.action = String(query.action).trim();
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
      const searchClauses = [
        { description: { $regex: term, $options: 'i' } },
        { action: { $regex: term, $options: 'i' } },
        { module: { $regex: term, $options: 'i' } },
        { recordId: { $regex: term, $options: 'i' } }
      ];
      filter.$or = searchClauses;
    }
  }

  const raw = await AuditLog.find(filter).sort({ createdAt: -1 }).lean();
  const enriched = await enrichAuditUsers(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `audit_history_export_${nowStr}.json`,
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
    'User / Actor',
    'Module',
    'Action',
    'Record ID',
    'Description',
    'Timestamp'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const item of enriched) {
    rows.push(
      [
        item._id,
        item.userName || item.username || item.userId || 'System',
        item.module || '',
        item.action || '',
        item.recordId || '',
        item.description || '',
        item.createdAt ? new Date(item.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `audit_history_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  MODULES,
  log,
  list,
  listByRecord,
  getRecent,
  exportAudit
};
