'use strict';

const { resolveUserId, isClientUser, resolveClientId, resolveClientIdAsync } = require('../utils/tenant.util');
const {
  isAdmin,
  isSalesAgentScoped,
  isSalesRepresentative,
  getPermissions
} = require('../utils/sales-access.util');
const { isEmployeeScoped } = require('../utils/project-access.util');
const { listAssignableUsers } = require('../utils/user.util');
const TenantService = require('./tenant.service');

/** Current user + CRM permission context for admin UI bootstrapping. */
async function getMe(req) {
  const user = req.user || {};
  const clientUser = isClientUser(req);
  const clientId = clientUser ? ((await resolveClientIdAsync(req)) || resolveClientId(req)) : null;

  /*
   * Which kind of portal login this is, so the UI offers the right things:
   *   'client' — a real client account: the full portal
   *   'lead'   — a prospect whose deal was opened to the portal: their own
   *              deal, quotations and samples, none of the account features
   *   null     — not a portal login at all
   */
  let portalKind = null;
  let portalLeadId = null;
  if (clientUser) {
    try {
      const { resolvePortalIdentity } = require('../utils/portal-identity.util');
      const identity = await resolvePortalIdentity(req);
      if (identity.kind === 'client' || identity.kind === 'lead') portalKind = identity.kind;
      if (identity.kind === 'lead') portalLeadId = identity.leadId || null;
    } catch {
      // Falls back to the clientId checks below.
    }
  }

  /*
   * Feature switches every role needs to render the right controls. Settings
   * itself is admin-only, so a sales rep or a portal user could never read
   * them — their quotation and invoice screens would hide a feature the
   * tenant had turned on.
   */
  const { getDefaultExtensionDef, toFeaturePayload } = require('../crm-extensions');
  let features = {
    proformaAdvance: false,
    quotationAutoAcceptOnPayment: false,
    defaultAdvancePercent: 30,
    modules: {
      expenses: false,
      marketing: false,
      customerSuccess: false,
      dataQuality: false
    },
    /*
     * The CRM extension that fixes the workspace mode (Settings → Extensions):
     * which core modules show, the lead Request Type and the deal pipeline.
     * Falls back to the default so a settings failure never hides a module
     * the tenant relies on.
     */
    activeExtension: toFeaturePayload(getDefaultExtensionDef())
  };
  try {
    const SettingService = require('./setting.service');
    const settings = await SettingService.getAll(req);
    const percent = Number(settings.default_advance_percent);
    const proformaAdvance = Boolean(settings.proforma_advance_enabled);
    const rawModules = settings.enabled_modules && typeof settings.enabled_modules === 'object' ? settings.enabled_modules : {};
    const modules = {
      expenses: Boolean(rawModules.expenses),
      marketing: Boolean(rawModules.marketing),
      customerSuccess: Boolean(rawModules.customer_success || rawModules.customerSuccess),
      dataQuality: Boolean(rawModules.data_quality || rawModules.dataQuality)
    };
    // Built-in or uploaded (Settings → Extensions → Upload) — the service knows both.
    const CrmExtensionService = require('./crm-extension.service');
    // Pages are sent only to the viewers they are for (client portal pages never reach staff).
    const activeExtension = require('../crm-extensions').forViewer(
      toFeaturePayload(await CrmExtensionService.resolveActiveDefinition(req, settings)),
      { isClient: require('../utils/tenant.util').isClientUser(req) }
    );
    features = {
      proformaAdvance,
      quotationAutoAcceptOnPayment:
        proformaAdvance && Boolean(settings.quotation_auto_accept_on_payment),
      defaultAdvancePercent: Number.isFinite(percent) && percent > 0 ? percent : 30,
      // Every user needs the workspace currency; only admins may read the full settings (GET /settings).
      defaultCurrency: String(settings.default_currency || '').trim().toUpperCase() || null,
      modules,
      activeExtension
    };
  } catch {
    // A settings failure must never switch a billing feature on.
  }

  return {
    userId: resolveUserId(req),
    username: user.username || user.email || null,
    email: user.email || null,
    role: user.role ?? req.tenantMembership?.role ?? (Array.isArray(req.roles) ? req.roles[0] : null) ?? null,
    roles: Array.isArray(req.roles) && req.roles.length ? req.roles : (Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : [])),
    permissions: getPermissions(req),
    isAdmin: !clientUser && isAdmin(req),
    tenant: req.tenant || null,
    tenantRole: req.tenantMembership?.role || null,
    isSalesAgentScoped: isSalesAgentScoped(req),
    isEmployeeScoped: isEmployeeScoped(req),
    isClientUser: clientUser,
    isClient: clientUser,
    clientId: clientId || null,
    portalKind,
    portalLeadId,
    features,
    // Tied to nothing at all — a lead portal is linked, so it is not "unlinked".
    unlinkedClient: Boolean(clientUser && !clientId && portalKind !== 'lead')
  };
}

function getPermissionsPayload(req) {
  return {
    permissions: getPermissions(req),
    isAdmin: isAdmin(req)
  };
}

async function getAssignableUsers(req, search) {
  if (isClientUser(req)) {
    return [];
  }

  // Sales Representative may only assign work to themselves.
  if (isSalesRepresentative(req)) {
    const userId = resolveUserId(req);
    const user = req.user || {};
    const name =
      user.username ||
      user.name ||
      user.displayName ||
      user.email ||
      'Me';
    const me = {
      id: userId,
      _id: userId,
      userId,
      name: String(name),
      displayName: String(name),
      username: user.username || null,
      email: user.email || null,
      role: 'sales-representative',
      designation: user.designation || 'Sales Representative'
    };
    const q = String(search || '').trim().toLowerCase();
    if (
      q &&
      ![me.name, me.displayName, me.username, me.email]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    ) {
      return [];
    }
    return [me];
  }

  if (req.tenantId && req.cms?.models.get('TenantMembership')) {
    return TenantService.listAssignableMembers(req, search);
  }
  return listAssignableUsers(req, search);
}

module.exports = {
  getMe,
  getPermissionsPayload,
  getAssignableUsers
};
