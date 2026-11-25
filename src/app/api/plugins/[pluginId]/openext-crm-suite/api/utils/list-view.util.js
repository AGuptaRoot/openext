'use strict';

/**
 * CRM 3.65.2 — list views. A list page asks `?view=list`: the server reads only the fields its table shows,
 * sorts by and its row actions need. Filters and search still run on the whole record in MongoDB; only the
 * answer is smaller. Every other caller (no view=list) gets the full record, as before.
 */

/** True when this request is a list page's table (`?view=list`). */
function wantsListView(req) {
  return String((req && req.query && req.query.view) || '').trim() === 'list';
}

/**
 * Narrow a Mongoose query to `fields` for a list page (no change otherwise).
 * @param {object} req
 * @param {object} query  a Mongoose query (Model.find(...))
 * @param {string[]} fields  paths, e.g. ['name', 'status', 'totals.grandTotal']
 */
function applyListView(req, query, fields) {
  if (!wantsListView(req) || !query || typeof query.select !== 'function') return query;
  const list = (Array.isArray(fields) ? fields : []).map((f) => String(f || '').trim()).filter(Boolean);
  return list.length ? query.select(list.join(' ')) : query;
}

module.exports = { wantsListView, applyListView };
