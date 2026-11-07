'use strict';

/**
 * Record actions: buttons an extension adds to core detail pages (json/actions.json), e.g.
 * "Create Booking" on an accepted quotation. The CRM checks permission and the record's state
 * (`when`) on the server, then calls the extension's POST route with { recordId, recordType }.
 */

const ID_RE = /^[a-f0-9]{24}$/i;

const PAGE_RECORDS = {
  leadDetail: { type: 'lead', load: (req, id) => require('./lead.service').getById(req, id, { includeQuality: false }) },
  opportunityDetail: { type: 'opportunity', load: (req, id) => require('./opportunity.service').getById(req, id) },
  quotationDetail: { type: 'quotation', load: (req, id) => require('./quotation.service').getById(req, id) },
  contactDetail: { type: 'contact', load: (req, id) => require('./person-contact.service').getById(req, id) },
  invoiceDetail: { type: 'invoice', load: (req, id) => require('./invoice.service').getById(req, id) }
};

function appError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function hasPermission(req, key, def) {
  if (!key) return true;
  const { requestHasPermission } = require('../utils/extension-permission.util');
  return requestHasPermission(req, key, def);
}

/** Does the record's state allow the action? Every listed key must match one of its values. */
function matchesWhen(when, record) {
  for (const [key, values] of Object.entries(when || {})) {
    const actual = String((record && record[key]) || '').toLowerCase();
    if (!values.some((v) => String(v).toLowerCase() === actual)) return false;
  }
  return true;
}

async function activeActions(req) {
  const CrmExtensionService = require('./crm-extension.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  if (!def || def.isInternal !== false) return { def: null, actions: [] };
  const actions = (def.declarations && def.declarations.actions && def.declarations.actions.actions) || [];
  return { def, actions: Array.isArray(actions) ? actions : [] };
}

/** POST /extension-actions/:actionId { recordId } → { message, navigate } */
async function run(req, actionId, body = {}) {
  const { def, actions } = await activeActions(req);
  const action = actions.find((a) => a.id === String(actionId || ''));
  if (!def || !action) throw appError('This action is not available', 404, 'ACTION_NOT_FOUND');
  if (action.kind !== 'route') throw appError('This action opens on the page', 400, 'ACTION_NOT_ROUTE');
  if (!hasPermission(req, action.permission, def)) throw appError('You do not have permission for this action', 403, 'FORBIDDEN');
  const recordId = String(body.recordId || '');
  if (!ID_RE.test(recordId)) throw appError('recordId is required', 400, 'INVALID_INPUT');
  const page = PAGE_RECORDS[action.page];
  if (!page) throw appError('This action is not available', 404, 'ACTION_NOT_FOUND');
  const record = await page.load(req, recordId); // tenant + permission scoped; 404 when missing
  if (!matchesWhen(action.when, record)) throw appError('This action is not available for this record now', 409, 'ACTION_NOT_ALLOWED');

  const { callActiveRoute } = require('../extension-runtime/runtime');
  const res = await callActiveRoute(req, 'POST', action.route, { recordId, recordType: page.type });
  if (!res || res.available === false) throw appError('The extension did not answer', 503, 'EXTENSION_UNAVAILABLE');
  const data = res.data && typeof res.data === 'object' ? res.data : {};
  const navigate = String(data.navigate || '');
  // Only pages of this extension (or core record pages) may be opened after an action.
  const safeNavigate =
    navigate && (navigate.startsWith(`/ext/${def.id}/`) || /^\/(leads|opportunities|quotations|contacts|invoices)\/[a-f0-9]{24}$/i.test(navigate)) && !navigate.includes('//')
      ? navigate.slice(0, 300)
      : '';
  return { message: String(data.message || '').slice(0, 300), navigate: safeNavigate };
}

module.exports = { run, matchesWhen, PAGE_RECORDS };
