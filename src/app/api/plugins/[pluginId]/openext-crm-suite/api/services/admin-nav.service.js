'use strict';

/**
 * CRM 3.50.0 — the CMS sidebar for the CRM, built on the server for the signed-in user:
 *
 *   Sidebar = Active CRM Extension + CRM role + role permissions
 *
 * The CMS asks GET /api/plugins/openext-crm-suite/admin-nav together with the dashboard (first login, a
 * direct URL, a refresh — on any page, before any CRM page is opened) and renders the answer natively
 * (lib/plugins/dynamicNav.ts):
 *   hide  manifest adminNav ids to leave out: the active extension's hidden modules, optional modules
 *         switched off (Settings → Modules), Dashboard for portal logins, Expenses for employees, and the
 *         internal "extension" route entry
 *   add   the active extension's sidebar pages (json/navigation.json) this user may open: its audience
 *         (staff / portal / all) and its permission, the same rule as the CRM UI (useActiveExtension)
 * The CMS still applies each role's page access on top. Nothing here is Travel-specific: every extension
 * declares its own pages and hidden modules. No record data is sent.
 */

const { isClientUser } = require('../utils/tenant.util');
const { hasPermission } = require('../utils/sales-access.util');

/** Always hidden: the route entry that only lets the CMS open extension-page URLs. */
const ALWAYS_HIDDEN = Object.freeze(['extension']);
const EXTENSION_KEY_RE = /^x\.[a-z0-9][a-z0-9_-]{0,40}\.[a-z0-9][a-z0-9_.-]{0,60}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Optional modules (Settings → Modules) → their sidebar ids. Off unless switched on. */
const OPTIONAL_MODULE_ROUTES = Object.freeze({
  expenses: 'expenses',
  marketing: 'marketing',
  customerSuccess: 'customer-success',
  dataQuality: 'data-quality'
});
const EMPLOYEE_ROLES = new Set(['crm-employee', 'employee', 'freelancer', '104', '106', '107']);

function roleValues(req) {
  const user = req?.user || {};
  const values = [user.role, req?.tenantMembership?.role, ...(Array.isArray(req?.roles) ? req.roles : []), ...(Array.isArray(user.roles) ? user.roles : [])];
  return values
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => String(typeof v === 'object' ? v.id || v.name || '' : v).trim().toLowerCase().replace(/[\s_]+/g, '-'));
}

/** The CRM UI's employee rule (Layout): crm-employee / employee / freelancer roles do not see Expenses. */
function isEmployeeRole(req) {
  return roleValues(req).some((r) => EMPLOYEE_ROLES.has(r));
}

/**
 * Same permission rule as the UI's canUse() and the API routes: extension keys come with Settings or their
 * grantedWith. CRM 3.50.1: a client-portal login holds the portal permissions the routes grant every client
 * (permission.middleware CLIENT_PORTAL_PERMISSIONS, e.g. crm.finance.read) even though its role lists none —
 * without this the portal's own pages (Bookings: crm.finance.read) were left out of its menu.
 */
function canUse(req, def, key) {
  const wanted = String(key || '').trim();
  if (!wanted) return true;
  if (hasPermission(req, wanted)) return true;
  if (isClientUser(req)) {
    const { CLIENT_PORTAL_PERMISSIONS } = require('../middleware/permission.middleware');
    if (CLIENT_PORTAL_PERMISSIONS && CLIENT_PORTAL_PERMISSIONS.has(wanted)) return true;
  }
  if (!EXTENSION_KEY_RE.test(wanted)) return false;
  if (hasPermission(req, 'crm.settings.manage')) return true;
  const defines = (def && def.permissions && Array.isArray(def.permissions.defines) ? def.permissions.defines : []) || [];
  const grant = (defines.find((p) => p && p.key === wanted) || {}).grantedWith;
  return Boolean(grant && hasPermission(req, grant));
}

/**
 * The sidebar for this request → { add: [{ id, label, icon, path }], hide: [ids] }.
 * Any failure falls back to the manifest menu minus the internal entry (never an error to the CMS).
 */
/**
 * CRM 3.50.2: GET /admin-nav is registered before the CRM's own middleware (requireTenantContext), so it
 * may run without the workspace or the CRM role's permissions. Set both up here, the same way every other
 * CRM route gets them (tenant middleware + permission middleware), instead of answering for no workspace.
 */
async function ensureRequestContext(req) {
  const TenantService = require('./tenant.service');
  if (!req.tenantMembership) {
    await TenantService.attachTenantContext(req);
  }
  try {
    const resolved = await TenantService.resolvePermissionsForMembership(req);
    if (Array.isArray(resolved) && resolved.length) {
      const current = Array.isArray(req.permissions) ? req.permissions : [];
      req.permissions = [...new Set([...current, ...resolved])];
    }
  } catch {
    // keep what the CMS gave
  }
}

async function buildAdminNav(req) {
  const hide = new Set(ALWAYS_HIDDEN);
  const add = [];
  try {
    await ensureRequestContext(req);
    const client = isClientUser(req);
    if (client) hide.add('dashboard');
    if (isEmployeeRole(req)) hide.add('expenses');

    const SettingService = require('./setting.service');
    const CrmExtensionService = require('./crm-extension.service');
    const settings = await SettingService.getAll(req);
    const raw = settings && settings.enabled_modules && typeof settings.enabled_modules === 'object' ? settings.enabled_modules : {};
    const modules = {
      expenses: Boolean(raw.expenses),
      marketing: Boolean(raw.marketing),
      customerSuccess: Boolean(raw.customer_success || raw.customerSuccess),
      dataQuality: Boolean(raw.data_quality || raw.dataQuality)
    };
    for (const [key, routeId] of Object.entries(OPTIONAL_MODULE_ROUTES)) if (!modules[key]) hide.add(routeId);

    const def = await CrmExtensionService.resolveActiveDefinition(req, settings);
    for (const routeId of (def && def.hiddenModules) || []) hide.add(String(routeId));

    // Product and Project are built-in modes without pages of their own.
    const extensionId = String((def && def.id) || '');
    const builtinMode = extensionId === 'product' || extensionId === 'project';
    const pages = (def && def.declarations && def.declarations.navigation && def.declarations.navigation.pages) || [];
    if (!builtinMode && SAFE_SEGMENT.test(extensionId)) {
      for (const page of Array.isArray(pages) ? pages : []) {
        if (!page || page.showInSidebar === false || !SAFE_SEGMENT.test(String(page.id || ''))) continue;
        const audience = String(page.audience || 'all');
        if (audience === 'portal' && !client) continue;
        if (audience === 'staff' && client) continue;
        if (!canUse(req, def, page.permission)) continue;
        add.push({
          id: `ext-${extensionId}-${page.id}`.slice(0, 80),
          label: String(page.label || page.id).slice(0, 80),
          ...(page.icon ? { icon: String(page.icon).slice(0, 40) } : {}),
          path: `extension/${extensionId}/${page.id}`
        });
      }
    }
  } catch {
    // Settings / extension unreadable: keep the manifest menu (minus the internal entry).
  }
  return { add, hide: [...hide] };
}

/**
 * GET /admin-nav. CRM 3.50.4: the CMS plugin response has setHeader() only — res.set() threw, so this route
 * always answered 500 and the CMS kept its default menu. Never fails: the manifest menu is the fallback.
 */
async function adminNavRoute(req, res, fallbackHide = [...ALWAYS_HIDDEN]) {
  try {
    if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
    else if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');
  } catch {
    // a header is never worth failing the menu
  }
  let data = { add: [], hide: fallbackHide };
  try {
    data = await buildAdminNav(req);
  } catch {
    // keep the manifest menu
  }
  res.json({ success: true, data });
}

module.exports = { ALWAYS_HIDDEN, adminNavRoute, buildAdminNav, ensureRequestContext, isEmployeeRole };
