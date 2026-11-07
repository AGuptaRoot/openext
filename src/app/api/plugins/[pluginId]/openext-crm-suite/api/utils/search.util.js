'use strict';

const { resolveTenantId } = require('./tenant.util');

const DEFAULT_MAX_SEARCH_LENGTH = 100;

/**
 * Convert user-entered search text into a bounded literal MongoDB regex value.
 * Escaping prevents regex operators from changing query meaning or causing
 * expensive backtracking patterns.
 */
function toLiteralSearchTerm(value, maxLength = DEFAULT_MAX_SEARCH_LENGTH) {
  const limit = Number.isInteger(maxLength) && maxLength > 0
    ? maxLength
    : DEFAULT_MAX_SEARCH_LENGTH;
  const term = String(value || '').trim().slice(0, limit);
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find client (Company) IDs whose name/email/taxId match the search term.
 * Used by list APIs so free-text search covers client name (e.g. "AR").
 */
async function findMatchingClientIds(req, searchValue, options = {}) {
  const term = toLiteralSearchTerm(searchValue);
  if (!term) return [];

  const Company =
    req.cms?.models?.get?.('Company') ||
    req.cms?.models?.get?.('Client');
  if (!Company) return [];

  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const tenantId = resolveTenantId(req);
  const filter = {
    tenantId,
    isDeleted: false,
    $or: [
      { name: { $regex: term, $options: 'i' } },
      { companyName: { $regex: term, $options: 'i' } },
      { email: { $regex: term, $options: 'i' } },
      { officialEmail: { $regex: term, $options: 'i' } },
      { taxId: { $regex: term, $options: 'i' } }
    ]
  };
  if (options.excludeMerged !== false) {
    filter.mergedIntoId = null;
  }

  const rows = await Company.find(filter).select('_id').limit(limit).lean();
  return rows.map((row) => String(row._id)).filter(Boolean);
}

/**
 * Find lead IDs matching name/company for sample/quotation search.
 */
async function findMatchingLeadIds(req, searchValue, options = {}) {
  const term = toLiteralSearchTerm(searchValue);
  if (!term) return [];

  const Lead = req.cms?.models?.get?.('Lead');
  if (!Lead) return [];

  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const rows = await Lead.find({
    tenantId: resolveTenantId(req),
    isDeleted: false,
    $or: [
      { name: { $regex: term, $options: 'i' } },
      { company: { $regex: term, $options: 'i' } },
      { email: { $regex: term, $options: 'i' } },
      { phone: { $regex: term, $options: 'i' } }
    ]
  })
    .select('_id')
    .limit(limit)
    .lean();

  return rows.map((row) => String(row._id)).filter(Boolean);
}

/**
 * Merge a search $or into an existing filter without wiping project/client scopes.
 */
function mergeSearchOr(filter, orClauses) {
  if (!Array.isArray(orClauses) || !orClauses.length) return filter;
  if (filter.$or) {
    filter.$and = [...(filter.$and || []), { $or: filter.$or }, { $or: orClauses }];
    delete filter.$or;
  } else {
    filter.$or = orClauses;
  }
  return filter;
}

module.exports = {
  DEFAULT_MAX_SEARCH_LENGTH,
  toLiteralSearchTerm,
  findMatchingClientIds,
  findMatchingLeadIds,
  mergeSearchOr
};
