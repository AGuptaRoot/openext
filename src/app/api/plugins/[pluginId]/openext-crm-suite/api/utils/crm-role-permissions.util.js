'use strict';

/**
 * CMS platform role → CRM permission mapping.
 *
 * Editor → Sales Manager + Project Manager (sales, projects, tasks, audit)
 * Author → Sales Agent + Employee (scoped sales, projects read, tasks write)
 */

/**
 * Use case: Tenant Role Management UI / Permission resolution — Master list of all CRM permission keys
 * used to validate role assignments and filter out unknown permissions.
 * Input args: (none — static constant)
 * Return value: Array<string> — All valid CRM permission identifiers in the form crm.{entity}.{action}
 */
const CRM_MANIFEST_PERMISSIONS = [
  'crm.dashboard.view',
  'crm.leads.read',
  'crm.leads.write',
  'crm.leads.delete',
  'crm.leads.convert',
  'crm.leads.export',
  'crm.leads.duplicate.override',
  'crm.contacts.read',
  'crm.contacts.write',
  'crm.contacts.delete',
  'crm.clients.read',
  'crm.clients.write',
  'crm.clients.delete',
  'crm.clients.duplicate.override',
  'crm.dataQuality.read',
  'crm.dataQuality.manage',
  'crm.projects.read',
  'crm.projects.write',
  'crm.projects.delete',
  'crm.tasks.read',
  'crm.tasks.write',
  'crm.tasks.delete',
  'crm.time.read',
  'crm.time.write',
  'crm.time.delete',
  'crm.expenses.read',
  'crm.expenses.write',
  'crm.expenses.delete',
  'crm.expenses.approve',
  'crm.finance.read',
  'crm.finance.write',
  'crm.finance.delete',
  'crm.contracts.read',
  'crm.contracts.write',
  'crm.contracts.delete',
  'crm.samples.read',
  'crm.samples.write',
  'crm.samples.approve',
  'crm.samples.feedback',
  'crm.samples.export',
  'crm.opportunities.read',
  'crm.opportunities.write',
  'crm.opportunities.delete',
  'crm.opportunities.export',
  'crm.quotes.approveDiscount',
  'crm.orders.read',
  'crm.orders.write',
  'crm.orders.delete',
  'crm.tickets.read',
  'crm.tickets.write',
  'crm.tickets.delete',
  'crm.tickets.resolve',
  'crm.customerSuccess.read',
  'crm.customerSuccess.manage',
  'crm.marketing.read',
  'crm.marketing.write',
  'crm.marketing.delete',
  'crm.analytics.read',
  'crm.ai.read',
  'crm.ai.write',
  'crm.audit.read',
  'crm.reports.read',
  'crm.reports.export',
  'crm.settings.manage',
  'crm.users.manage'
];

/**
 * Use case: Permission resolution on login / role bootstrap — Default permission set for CMS Editor role
 * mapped to Sales Manager persona: full sales, projects, tasks, expenses approve, audit, reports.
 * Input args: (none — static constant)
 * Return value: Array<string> — Permission subset for Editor/Sales Manager (no admin-level settings/users manage)
 */
const EDITOR_SALES_MANAGER = [
  'crm.dashboard.view',
  'crm.leads.read',
  'crm.leads.write',
  'crm.leads.delete',
  'crm.leads.convert',
  'crm.leads.export',
  'crm.leads.duplicate.override',
  'crm.contacts.read',
  'crm.contacts.write',
  'crm.contacts.delete',
  'crm.clients.read',
  'crm.clients.write',
  'crm.clients.delete',
  'crm.clients.duplicate.override',
  'crm.dataQuality.read',
  'crm.dataQuality.manage',
  'crm.projects.read',
  'crm.projects.write',
  'crm.projects.delete',
  'crm.tasks.read',
  'crm.tasks.write',
  'crm.tasks.delete',
  'crm.time.read',
  'crm.time.write',
  'crm.time.delete',
  'crm.expenses.read',
  'crm.expenses.write',
  'crm.expenses.delete',
  'crm.expenses.approve',
  'crm.finance.read',
  'crm.finance.write',
  'crm.contracts.read',
  'crm.contracts.write',
  'crm.samples.read',
  'crm.samples.write',
  'crm.opportunities.read',
  'crm.opportunities.write',
  'crm.reports.read',
  'crm.reports.export',
  'crm.orders.read',
  'crm.orders.write',
  'crm.orders.delete',
  'crm.tickets.read',
  'crm.marketing.read',
  'crm.marketing.write',
  'crm.audit.read'
];

/**
 * Use case: Permission resolution on login / role bootstrap — Default permission set for CMS Author role
 * mapped to Sales Agent persona: scoped leads/clients, projects read-only, tasks/time write, expenses submit.
 * Input args: (none — static constant)
 * Return value: Array<string> — Permission subset for Author/Sales Agent (no delete, no approve, no admin)
 */
const AUTHOR_SALES_AGENT = [
  'crm.dashboard.view',
  'crm.leads.read',
  'crm.leads.write',
  'crm.leads.convert',
  'crm.leads.export',
  'crm.contacts.read',
  'crm.contacts.write',
  'crm.clients.read',
  'crm.clients.write',
  'crm.projects.read',
  'crm.tasks.read',
  'crm.tasks.write',
  'crm.time.read',
  'crm.time.write',
  'crm.expenses.read',
  'crm.expenses.write',
  'crm.finance.read',
  'crm.finance.write',
  'crm.contracts.read',
  'crm.samples.read',
  'crm.samples.write',
  'crm.opportunities.read',
  'crm.opportunities.write',
  'crm.orders.read',
  'crm.orders.write',
  'crm.tickets.read',
  'crm.tickets.write'
];

/**
 * Use case: Permission resolution filter — Ensures custom role permissions only include keys that exist
 * in the registered CRM manifest, preventing stale or invalid permissions from leaking scope.
 * Input args:
 *   allPermissions — Array<string> of valid permission keys from CRM_MANIFEST_PERMISSIONS (the registry)
 *   allowed        — Array<string> of permission keys requested by a role/custom mapping
 * Return value: Array<string> — Intersection of `allowed` filtered to only keys present in `allPermissions`
 */
function pickRegistered(allPermissions, allowed) {
  const registered = new Set(allPermissions);
  return allowed.filter((permission) => registered.has(permission));
}

/**
 * Use case: Role mapping at auth time — Accepts any format of CMS platform role input (number, string label,
 * user object with userType/roleName/baseRole) and normalizes it to a numeric role code (0=super, 1=admin,
 * 2=editor/sales-manager, 3=author/sales-agent). Handles alias strings like "sales-manager", "crm-employee".
 * Input args:
 *   roleInput — null | undefined | number | string | { userType?: string, roleName?: string, name?: string, baseRole?: number, role?: number }
 * Return value: number | null — Numeric role code (0,1,2,3) or null if unrecognized
 */
function normalizeRoleValue(roleInput) {
  if (roleInput === null || roleInput === undefined) return null;

  if (typeof roleInput === 'object') {
    if (roleInput.userType || roleInput.roleName || roleInput.name) {
      const nameMatch = normalizeRoleValue(roleInput.userType || roleInput.roleName || roleInput.name);
      if (nameMatch !== null) return nameMatch;
    }
    if (typeof roleInput.baseRole === 'number' && Number.isFinite(roleInput.baseRole)) {
      return roleInput.baseRole;
    }
    if (typeof roleInput.role === 'number' && Number.isFinite(roleInput.role)) {
      return roleInput.role;
    }
    return null;
  }

  if (typeof roleInput === 'number' && Number.isFinite(roleInput)) return roleInput;

  const normalized = String(roleInput).trim().toLowerCase();
  if (!normalized) return null;

  if (!isNaN(normalized) && Number.isFinite(Number(normalized))) {
    return Number(normalized);
  }

  if (normalized === '0' || normalized.includes('super') || normalized.includes('owner') || normalized === 'crm-manager' || normalized === 'crm_manager') {
    return 0;
  }
  if (normalized === '1' || normalized.includes('admin')) {
    return 1;
  }
  if (normalized === '2' || normalized.includes('editor') || normalized === 'sales-manager' || normalized === 'sales_manager' || normalized === 'project-manager' || normalized === 'project_manager' || normalized === 'finance-manager' || normalized === 'finance_manager') {
    return 2;
  }
  if (normalized === '3' || normalized.includes('author') || normalized.includes('viewer') || normalized === 'sales-rep' || normalized === 'sales_rep' || normalized === 'crm-employee' || normalized === 'crm_employee') {
    return 3;
  }

  return null;
}

function resolveCrmRolePermissions(role, allPermissions = CRM_MANIFEST_PERMISSIONS) {
  if (typeof role === 'object' && role && Array.isArray(role.permissions)) {
    return pickRegistered(allPermissions, role.permissions);
  }

  const roleValue = role === undefined ? null : normalizeRoleValue(role);

  if (roleValue === null) {
    return [];
  }

  if (roleValue <= 1) {
    return [...allPermissions];
  }

  if (roleValue === 2) {
    return pickRegistered(allPermissions, EDITOR_SALES_MANAGER);
  }

  if (roleValue === 3) {
    return pickRegistered(allPermissions, AUTHOR_SALES_AGENT);
  }

  if (roleValue >= 4) {
    if (typeof role === 'object' && role && typeof role.baseRole === 'number') {
      return resolveCrmRolePermissions(role.baseRole, allPermissions);
    }
    return pickRegistered(allPermissions, AUTHOR_SALES_AGENT);
  }

  return [];
}

module.exports = {
  CRM_MANIFEST_PERMISSIONS,
  EDITOR_SALES_MANAGER,
  AUTHOR_SALES_AGENT,
  resolveCrmRolePermissions
};
