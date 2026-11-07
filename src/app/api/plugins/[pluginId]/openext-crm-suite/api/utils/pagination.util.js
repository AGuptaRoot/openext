'use strict';

/**
 * Shared pagination parser for list APIs (Phase 1 plan Section 7.3).
 */
function parsePagination(query, options = {}) {
  const maxLimit = options.maxLimit || 100;
  const defaultLimit = options.defaultLimit || 10;

  let page = parseInt(query?.page, 10);
  let limit = parseInt(query?.limit, 10);

  page = Number.isFinite(page) && page > 0 ? page : 1;
  limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, maxLimit) : defaultLimit;

  const sortField = (() => {
    const raw = query?.sort || query?.sortBy;
    if (typeof raw === 'string' && /^[a-zA-Z0-9_.]+$/.test(raw.trim())) {
      return raw.trim();
    }
    return options.sortField || 'createdAt';
  })();
  const orderRaw = String(query?.order || query?.sortDir || '').toLowerCase();
  const order = orderRaw === 'asc' || orderRaw === '1' ? 1 : -1;

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    sort: { [sortField]: order }
  };
}

module.exports = {
  parsePagination
};
