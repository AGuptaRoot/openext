'use strict';

/**
 * Dispatcher for every `/x/<extensionId>/...` request (contract §9).
 *
 *   /x/<id>/_models/<Model>[/<rowId>]   generic JSON-model API (no trust needed)
 *   /x/<id>/_settings                    extension settings values (GET, any CRM user)
 *   /x/<id>/<route.path>                 package routes from api/routes.json (trust needed)
 *
 * Order of checks for package routes: extension active → route declared →
 * permission → trust approved → backend loaded → handler with a time limit.
 */

const { requestHasPermission } = require('../utils/extension-permission.util');
const { resolveTenantId } = require('../utils/tenant.util');
const { createRepository, filterFromQuery } = require('./models');
const { createSdk } = require('./sdk');
const loader = require('./loader');
const { cloneJson, clampLimit, clampSkip, runtimeError } = require('./values');

const READ_DEFAULT = 'crm.dashboard.view';
const WRITE_DEFAULT = 'crm.settings.manage';
const ANY_READ = ['crm.dashboard.view', 'crm.leads.read', 'crm.opportunities.read', 'crm.finance.read', 'crm.tickets.read', 'crm.projects.read'];

function send(res, status, body) {
  res.status(status).json(body);
}

function fail(res, error, extensionId) {
  const status = Number(error && error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  if (status >= 500 && !(error && error.code && String(error.code).startsWith('EXTENSION_'))) {
    console.error(`[crm-ext:${extensionId}] error:`, (error && error.stack) || error);
  }
  send(res, status, {
    success: false,
    error: status >= 500 && !(error && (error.isRuntimeError || String(error.code || '').startsWith('EXTENSION_')))
      ? 'The extension failed to handle this request'
      : String((error && error.message) || 'Extension error'),
    code: (error && error.code) || (status >= 500 ? 'EXTENSION_ERROR' : 'BAD_REQUEST'),
    details: Array.isArray(error && error.details) ? error.details.slice(0, 20) : undefined
  });
}

function restSegments(params) {
  const out = [];
  for (let i = 1; i <= 8; i += 1) {
    const value = params[`p${i}`];
    if (value === undefined) break;
    out.push(String(value));
  }
  return out;
}

/** Compile `/contracts/:id` once per definition. */
const compiled = new WeakMap();
function compileRoutes(def) {
  if (compiled.has(def)) return compiled.get(def);
  const list = ((def.backend && def.backend.routes) || []).map((route) => ({
    ...route,
    segments: route.path.split('/').filter(Boolean)
  }));
  compiled.set(def, list);
  return list;
}

function matchRoute(def, method, segments) {
  for (const route of compileRoutes(def)) {
    if (route.method !== method || route.segments.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segments.length; i += 1) {
      const pattern = route.segments[i];
      if (pattern.startsWith(':')) params[pattern.slice(1)] = decodeURIComponent(segments[i]);
      else if (pattern !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(runtimeError(504, `The extension did not answer within ${ms} ms`, 'EXTENSION_TIMEOUT')), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveActive(req, extensionId) {
  const CrmExtensionService = require('../services/crm-extension.service');
  const def = await CrmExtensionService.getActive(req);
  if (!def || def.id !== extensionId || def.isInternal !== false) {
    throw runtimeError(404, `Extension "${extensionId}" is not the active extension`, 'EXTENSION_NOT_ACTIVE');
  }
  return def;
}

/* ---------------------------------------------------------- generic models */

async function handleModels(req, res, def, segments) {
  const [, modelName, rowId, extra] = segments;
  if (!modelName || extra !== undefined) throw runtimeError(404, 'Unknown model path', 'NOT_FOUND');
  const modelDef = ((def.backend && def.backend.models) || []).find((m) => m.name === modelName);
  if (!modelDef) throw runtimeError(404, `Model "${modelName}" is not declared by ${def.name}`, 'MODEL_NOT_FOUND');

  const method = String(req.method || 'GET').toUpperCase();
  const isRead = method === 'GET';
  const permission = isRead
    ? (modelDef.permissions && modelDef.permissions.read) || READ_DEFAULT
    : (modelDef.permissions && modelDef.permissions.write) || WRITE_DEFAULT;
  if (!requestHasPermission(req, permission, def)) throw runtimeError(403, `This needs the "${permission}" permission`, 'FORBIDDEN');

  const repo = createRepository(req, def.id, modelDef, {
    tenantId: resolveTenantId(req),
    userId: (req.user && (req.user.id || req.user._id) && String(req.user.id || req.user._id)) || 'system'
  });

  if (method === 'GET' && !rowId) {
    const query = req.query || {};
    const filter = filterFromQuery(query, modelDef);
    const [items, total] = await Promise.all([
      repo.find(filter, { sort: query.sort || undefined, limit: clampLimit(query.limit), skip: clampSkip(query.skip) }),
      repo.count(filter)
    ]);
    return { items, total };
  }
  if (method === 'GET') {
    const row = await repo.findById(rowId);
    if (!row) throw runtimeError(404, `${modelDef.label || modelName} not found`, 'NOT_FOUND');
    return row;
  }
  if (method === 'POST' && !rowId) return repo.create(req.body || {});
  if ((method === 'PATCH' || method === 'PUT') && rowId) {
    const row = await repo.updateById(rowId, req.body || {});
    if (!row) throw runtimeError(404, `${modelDef.label || modelName} not found`, 'NOT_FOUND');
    return row;
  }
  if (method === 'DELETE' && rowId) {
    const ok = await repo.deleteById(rowId);
    if (!ok) throw runtimeError(404, `${modelDef.label || modelName} not found`, 'NOT_FOUND');
    return { deleted: true };
  }
  throw runtimeError(405, `${method} is not supported here`, 'METHOD_NOT_ALLOWED');
}

/* ----------------------------------------------------------------- settings */

async function handleSettings(req, def, segments) {
  if (segments.length !== 1 || String(req.method).toUpperCase() !== 'GET') throw runtimeError(404, 'Unknown settings path', 'NOT_FOUND');
  if (!ANY_READ.some((p) => requestHasPermission(req, p))) throw runtimeError(403, 'Not allowed', 'FORBIDDEN');
  const SettingsService = require('../services/crm-extension-settings.service');
  const values = await SettingsService.getValues(req, def);
  const secretKeys = new Set(
    (((def.declarations && def.declarations.settings && def.declarations.settings.fields) || []).filter((f) => f.secret)).map((f) => f.key)
  );
  if (!requestHasPermission(req, 'crm.settings.manage')) {
    for (const k of secretKeys) delete values[k];
  }
  return values;
}

/* ------------------------------------------------------------ package routes */

async function handlePackageRoute(req, def, segments) {
  const method = String(req.method || 'GET').toUpperCase();
  const matched = matchRoute(def, method, segments);
  if (!matched) throw runtimeError(404, `${method} /${segments.join('/')} is not a route of ${def.name}`, 'EXTENSION_ROUTE_NOT_FOUND');
  const { route, params } = matched;

  if (!requestHasPermission(req, route.permission, def)) {
    throw runtimeError(403, `This needs the "${route.permission}" permission`, 'FORBIDDEN');
  }
  if (!loader.isApproved(def)) {
    const error = runtimeError(503, `The backend of ${def.name} is waiting for an admin's approval`, 'EXTENSION_BACKEND_NOT_APPROVED');
    throw error;
  }

  const runtime = await loader.ensureLoaded(req, def);
  const mod = runtime.require(route.handlerFile);
  const handler = mod && mod[route.handlerExport];
  if (typeof handler !== 'function') {
    throw runtimeError(500, `${route.handler} is not an exported function`, 'EXTENSION_HANDLER_MISSING');
  }

  const user = req.user || {};
  const extReq = runtime.toContext({
    method,
    path: `/${segments.join('/')}`,
    params,
    query: cloneJson(req.query || {}, 64 * 1024, 'query') || {},
    body: req.body === undefined || req.body === null ? null : cloneJson(req.body, 1024 * 1024, 'body'),
    tenantId: resolveTenantId(req),
    user: {
      id: String(user.id || user._id || ''),
      name: String(user.name || user.username || ''),
      email: String(user.email || '')
    }
  });

  const result = await withTimeout(Promise.resolve().then(() => handler(extReq, runtime.wrapHost(createSdk(req, def)))), route.timeoutMs || 10000);
  return result === undefined ? null : cloneJson(result, 2 * 1024 * 1024, 'response');
}

/* ------------------------------------------------------------------- entry */

async function handle(req, res) {
  const extensionId = String((req.params && req.params.extensionId) || '').toLowerCase();
  try {
    const segments = restSegments(req.params || {});
    if (!segments.length) throw runtimeError(404, 'Missing extension path', 'NOT_FOUND');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) throw runtimeError(400, 'Invalid path', 'BAD_REQUEST');

    const def = await resolveActive(req, extensionId);
    let data;
    if (segments[0] === '_models') data = await handleModels(req, res, def, segments);
    else if (segments[0] === '_settings') data = await handleSettings(req, def, segments);
    else if (segments[0].startsWith('_')) throw runtimeError(404, 'Unknown reserved path', 'NOT_FOUND');
    else data = await handlePackageRoute(req, def, segments);

    send(res, String(req.method).toUpperCase() === 'POST' && segments[0] === '_models' ? 201 : 200, { success: true, data });
  } catch (error) {
    // Errors thrown inside the vm context are not `instanceof Error` here;
    // only status/message/code are read, never trusted beyond that.
    const safe = error && typeof error === 'object'
      ? {
          status: Number(error.status) || 500,
          message: String(error.message || 'Extension error').slice(0, 500),
          code: error.code ? String(error.code).slice(0, 60) : undefined,
          details: Array.isArray(error.details) ? error.details.map(String) : undefined,
          isRuntimeError: Boolean(error.isRuntimeError),
          stack: error.stack
        }
      : { status: 500, message: String(error) };
    fail(res, safe, extensionId);
  }
}

/**
 * Call one of the active extension's own routes from CRM code, in-process, as the
 * current user (same permission check, approval check and time limit as over HTTP).
 * Used for contracts the extension declares in its manifest, e.g. leadWorkflow.readinessRoute.
 * @returns {Promise<{ available: boolean, data?: any }>} available = false when no uploaded extension is active
 */
async function callActiveRoute(req, method, path, body, options = {}) {
  const CrmExtensionService = require('../services/crm-extension.service');
  const def = await CrmExtensionService.getActive(req);
  if (!def || def.isInternal !== false) return { available: false };
  const segments = String(path || '').split('/').filter(Boolean);
  if (!segments.length || segments[0].startsWith('_')) throw runtimeError(400, 'Invalid extension route', 'BAD_REQUEST');
  const inner = Object.assign(Object.create(Object.getPrototypeOf(req) || Object.prototype), req, {
    method: String(method || 'GET').toUpperCase(),
    // options.query: plain string values only (report filters); nothing else of the caller's query passes.
    query: options.query && typeof options.query === 'object'
      ? Object.fromEntries(Object.entries(options.query).filter(([k, v]) => /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 200)]))
      : {},
    body: body === undefined ? null : body
  });
  if (options.system) Object.assign(inner, systemIdentity(req, def));
  return { available: true, def, data: await handlePackageRoute(inner, def, segments) };
}

/**
 * The identity a CRM-triggered hook runs as (options.system): the same tenant, no user, and only the
 * record permissions a sales hook needs plus the extension's own keys — never settings, users or
 * delete rights. Used for routes the CRM itself calls after an event the user may not have staff
 * rights for (e.g. a client accepting a quotation → salesFlow.quotationForm.acceptedRoute).
 */
const SYSTEM_HOOK_PERMISSIONS = [
  'crm.leads.read',
  'crm.leads.write',
  'crm.contacts.read',
  'crm.clients.read',
  'crm.opportunities.read',
  'crm.finance.read'
];

function systemIdentity(req, def) {
  const own = ((def && def.permissions && Array.isArray(def.permissions.defines) ? def.permissions.defines : []) || [])
    .map((d) => String((d && d.key) || ''))
    .filter(Boolean);
  const permissions = [...SYSTEM_HOOK_PERMISSIONS, ...own];
  return {
    tenantId: resolveTenantId(req),
    user: { id: 'system', _id: 'system', name: 'System', username: 'system', email: '', permissions, roles: [] },
    permissions,
    tenantMembership: null,
    resolvedClientId: null,
    clientId: null,
    // Read by sales-access isSalesAgentScoped: the workspace acting, not a scoped staff member.
    crmSystemHook: true
  };
}

module.exports = { handle, matchRoute, restSegments, callActiveRoute, SYSTEM_HOOK_PERMISSIONS };
