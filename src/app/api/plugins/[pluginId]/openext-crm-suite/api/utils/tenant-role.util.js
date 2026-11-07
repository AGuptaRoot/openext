'use strict';

const {
  CRM_MANIFEST_PERMISSIONS,
  EDITOR_SALES_MANAGER,
  AUTHOR_SALES_AGENT
} = require('./crm-role-permissions.util');

const PERMISSION_GROUPS = Object.freeze([
  {
    category: 'Dashboard',
    permissions: [
      { key: 'crm.dashboard.view', label: 'View Dashboard Metrics' }
    ]
  },
  {
    category: 'Leads',
    permissions: [
      { key: 'crm.leads.read', label: 'View Leads' },
      { key: 'crm.leads.write', label: 'Create / Edit Leads' },
      { key: 'crm.leads.delete', label: 'Delete Leads' },
      { key: 'crm.leads.convert', label: 'Convert Lead to Client' },
      { key: 'crm.leads.export', label: 'Export Leads (CSV / JSON)' },
      { key: 'crm.leads.duplicate.override', label: 'Override Exact Lead Duplicate' }
    ]
  },
  {
    category: 'Clients & Contacts',
    permissions: [
      { key: 'crm.clients.read', label: 'View Clients & Contacts' },
      { key: 'crm.clients.write', label: 'Create / Edit Clients & Contacts' },
      { key: 'crm.clients.delete', label: 'Delete Clients & Contacts' },
      { key: 'crm.clients.duplicate.override', label: 'Override Exact Customer Duplicate' }
    ]
  },
  {
    category: 'Data Quality',
    permissions: [
      { key: 'crm.dataQuality.read', label: 'View Data-quality Scores' },
      { key: 'crm.dataQuality.manage', label: 'Access Duplicate & Data-quality Center (Read Only)' }
    ]
  },
  {
    category: 'Projects',
    permissions: [
      { key: 'crm.projects.read', label: 'View Projects' },
      { key: 'crm.projects.write', label: 'Create / Edit Projects' },
      { key: 'crm.projects.delete', label: 'Delete Projects' }
    ]
  },
  {
    category: 'Tasks & Subtasks',
    permissions: [
      { key: 'crm.tasks.read', label: 'View Tasks & Subtasks' },
      { key: 'crm.tasks.write', label: 'Create / Edit Tasks & Subtasks' },
      { key: 'crm.tasks.delete', label: 'Delete Tasks & Subtasks' }
    ]
  },
  {
    category: 'Time Logs',
    permissions: [
      { key: 'crm.time.read', label: 'View Time Logs' },
      { key: 'crm.time.write', label: 'Log & Edit Hours' },
      { key: 'crm.time.delete', label: 'Delete Time Logs' }
    ]
  },
  {
    category: 'Expenses',
    permissions: [
      { key: 'crm.expenses.read', label: 'View Expenses' },
      { key: 'crm.expenses.write', label: 'Create / Edit Expenses' },
      { key: 'crm.expenses.delete', label: 'Delete Expenses' },
      { key: 'crm.expenses.approve', label: 'Approve / Reject Expenses' }
    ]
  },
  {
    category: 'Finance (Quotes, Invoices & Orders)',
    permissions: [
      { key: 'crm.finance.read', label: 'View Quotations, Invoices & Payments' },
      { key: 'crm.finance.write', label: 'Create / Edit Quotes, Invoices & Payments' },
      { key: 'crm.finance.delete', label: 'Delete Financial Documents' },
      { key: 'crm.quotes.approveDiscount', label: 'Approve Quotation Discounts' },
      { key: 'crm.orders.read', label: 'View Sales Orders' },
      { key: 'crm.orders.write', label: 'Create / Dispatch Orders' },
      { key: 'crm.orders.delete', label: 'Delete Sales Orders' }
    ]
  },
  {
    category: 'Support Tickets & CSAT',
    permissions: [
      { key: 'crm.tickets.read', label: 'View Support Tickets' },
      { key: 'crm.tickets.write', label: 'Create / Edit Tickets' },
      { key: 'crm.tickets.resolve', label: 'Resolve Tickets' },
      { key: 'crm.tickets.delete', label: 'Delete Tickets' },
      { key: 'crm.customerSuccess.read', label: 'View Customer Success CSAT' },
      { key: 'crm.customerSuccess.manage', label: 'Manage Customer Success' }
    ]
  },
  {
    category: 'Reports & Analytics',
    permissions: [
      { key: 'crm.reports.read', label: 'View Reports & Charts' },
      { key: 'crm.reports.export', label: 'Export Reports (CSV)' }
    ]
  },
  {
    category: 'Audit Log',
    permissions: [
      { key: 'crm.audit.read', label: 'View Audit History' }
    ]
  },
  {
    category: 'Marketing Automation',
    permissions: [
      { key: 'crm.marketing.read', label: 'View Marketing Campaigns & Audience Stats' },
      { key: 'crm.marketing.write', label: 'Create & Edit Marketing Automation Drips' },
      { key: 'crm.marketing.delete', label: 'Delete Marketing Campaigns' }
    ]
  },
  {
    category: 'AI Intelligence & Analytics',
    permissions: [
      { key: 'crm.analytics.read', label: 'View Executive Analytics & Forecasting' },
      { key: 'crm.ai.read', label: 'View AI Behavior & Demand Insights' },
      { key: 'crm.ai.write', label: 'Apply AI Next-Best-Actions & Feedback' }
    ]
  },
  {
    category: 'Settings & Security',
    permissions: [
      { key: 'crm.settings.manage', label: 'Manage CRM System Settings' },
      { key: 'crm.users.manage', label: 'Manage Tenant Security & User Roles' }
    ]
  }
]);

let cmsRolesManifest = null;
try {
  cmsRolesManifest = require('../roles');
} catch {
  cmsRolesManifest = null;
}

const cmsRoles = Array.isArray(cmsRolesManifest?.roles) ? cmsRolesManifest.roles : [];
const BUILTIN_ROLE_DEFS = {};

cmsRoles.forEach((r) => {
  const key = r.id;
  if (!key) return;
  BUILTIN_ROLE_DEFS[key] = {
    key: key,
    label: r.name || key,
    description: r.description || `${r.name || key} role defined in api/roles.js.`,
    permissions: Array.isArray(r.permissions) ? [...r.permissions] : []
  };
});

const ROLE_DEFINITIONS = Object.freeze(BUILTIN_ROLE_DEFS);
const TENANT_ROLES = Object.freeze(Object.keys(ROLE_DEFINITIONS));

function normalizePlatformRole(roleInput) {
  if (roleInput === null || roleInput === undefined) return 3;
  if (typeof roleInput === 'number' && Number.isFinite(roleInput)) {
    if (roleInput <= 0) return 0;
    if (roleInput === 1) return 1;
    if (roleInput === 2) return 2;
    return roleInput;
  }
  const s = String(roleInput).trim().toLowerCase();
  if (s === '0' || s.includes('super') || s.includes('owner')) return 0;
  if (s === '1' || s.includes('admin')) return 1;
  if (s === '2' || s.includes('editor')) return 2;
  return 3;
}

function deriveTenantRole(platformRoleInput, cmsRolesMap = null) {
  if (platformRoleInput === null || platformRoleInput === undefined) return 'crm-employee';
  if (typeof platformRoleInput === 'object') {
    if (platformRoleInput.role !== undefined) return deriveTenantRole(platformRoleInput.role, cmsRolesMap);
    if (platformRoleInput.userType !== undefined) return deriveTenantRole(platformRoleInput.userType, cmsRolesMap);
    if (platformRoleInput.baseRole !== undefined) return deriveTenantRole(platformRoleInput.baseRole, cmsRolesMap);
  }

  if (typeof platformRoleInput === 'number') {
    if (cmsRolesMap && cmsRolesMap.has(platformRoleInput)) {
      const matched = cmsRolesMap.get(platformRoleInput);
      if (matched.id) return normalizeTenantRoleKey(matched.id);
      if (matched.name) return normalizeTenantRoleKey(matched.name);
    }
    if (platformRoleInput <= 1 || platformRoleInput === 100) return 'crm-manager';
    if (platformRoleInput === 2 || platformRoleInput === 101) return 'sales-manager';
    if (platformRoleInput === 3 || platformRoleInput === 102) return 'sales-representative';
    if (platformRoleInput === 103) return 'project-manager';
    if (platformRoleInput === 104) return 'crm-employee';
    if (platformRoleInput === 105) return 'finance-manager';
    if (platformRoleInput === 106 || platformRoleInput === 107) return 'crm-employee';
  }

  return normalizeTenantRoleKey(platformRoleInput);
}

function isTenantRole(role) {
  if (role === null || role === undefined) return false;
  if (typeof role === 'number' && Number.isFinite(role)) return true;
  const r = String(role || '').trim();
  if (!r) return false;
  return true;
}

function normalizeTenantRoleKey(role) {
  if (role === null || role === undefined) return 'crm-employee';
  if (typeof role === 'number') {
    if (role <= 1 || role === 100) return 'crm-manager';
    if (role === 2 || role === 101) return 'sales-manager';
    if (role === 3 || role === 102) return 'sales-representative';
    if (role === 103) return 'project-manager';
    if (role === 104) return 'crm-employee';
    if (role === 105) return 'finance-manager';
    if (role === 106 || role === 107) return 'support-agent';
    return 'crm-employee';
  }
  const r = String(role || '').trim();
  if (!r) return 'crm-employee';
  if (TENANT_ROLES.includes(r)) return r;

  const s = r.toLowerCase();
  const matchedKey = TENANT_ROLES.find((k) => k.toLowerCase() === s);
  if (matchedKey) return matchedKey;

  if (s === '0' || s === '1' || s === '100' || s === 'tenant-admin' || s === 'tenant_admin' || s === 'crm-manager' || s === 'crm_manager' || s === 'crm manager' || s === 'admin' || s === 'superadmin') return 'crm-manager';
  if (s === '2' || s === '101' || s === 'sales_manager' || s === 'sales-manager' || s === 'sales manager') return 'sales-manager';
  if (s === '103' || s === 'project-manager' || s === 'project_manager' || s === 'project manager') return 'project-manager';
  if (s === '104' || s === 'crm-employee' || s === 'crm_employee' || s === 'employee' || s === 'freelancer') return 'crm-employee';
  if (s === '105' || s === 'finance-manager' || s === 'finance_manager' || s === 'finance manager' || s === 'accountant') return 'finance-manager';
  if (s === '106' || s === '107' || s === 'support-agent' || s === 'support_agent' || s === 'support agent' || s === 'user-agent' || s === 'user_agent' || s === 'user agent') return 'support-agent';
  if (s === 'client' || s.includes('client') || s.includes('customer') || s.includes('portal')) return 'client';
  if (s === '3' || s === '102' || s === 'sales-rep' || s === 'sales_rep' || s === 'sales-agent' || s === 'sales_agent' || s === 'sales-representative' || s === 'sales representative' || s === 'author' || s === 'viewer') return 'sales-representative';
  return s;
}

function resolveTenantRolePermissions(role, allPermissions = CRM_MANIFEST_PERMISSIONS, customRoleMap = null) {
  const roleKey = normalizeTenantRoleKey(role);
  const definition = ROLE_DEFINITIONS[roleKey];
  if (!definition) {
    if (customRoleMap && Array.isArray(customRoleMap[roleKey])) {
      const registered = new Set(allPermissions);
      return [...new Set(customRoleMap[roleKey])].filter((permission) => registered.has(permission));
    }
    return [];
  }

  // tenant_admin / crm-manager retains full permissions
  if (definition.permissions === '*') return [...allPermissions];

  if (customRoleMap && Array.isArray(customRoleMap[roleKey])) {
    const customList = customRoleMap[roleKey];
    if (roleKey === 'client') {
      const merged = new Set([...customList, 'crm.samples.read', 'crm.samples.feedback', 'crm.contracts.read']);
      const registered = new Set(allPermissions);
      return [...merged].filter((permission) => registered.has(permission));
    }
    const registered = new Set(allPermissions);
    return [...new Set(customList)].filter((permission) => registered.has(permission));
  }

  const registered = new Set(allPermissions);
  return [...new Set(definition.permissions)].filter((permission) => registered.has(permission));
}

function listTenantRoles(allPermissions = CRM_MANIFEST_PERMISSIONS, customRoleMap = null) {
  return TENANT_ROLES.map((role) => {
    const definition = ROLE_DEFINITIONS[role];
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      permissions: resolveTenantRolePermissions(role, allPermissions, customRoleMap)
    };
  });
}

function getDefaultRolePermissionsMap() {
  const map = {};
  TENANT_ROLES.forEach((roleKey) => {
    const def = ROLE_DEFINITIONS[roleKey];
    if (def.permissions === '*') {
      map[roleKey] = [...CRM_MANIFEST_PERMISSIONS];
    } else {
      map[roleKey] = [...def.permissions];
    }
  });
  return map;
}

function getRoleDefinition(roleKey) {
  if (!roleKey) return null;
  const key = normalizeTenantRoleKey(roleKey);
  return ROLE_DEFINITIONS[key] || ROLE_DEFINITIONS[roleKey] || null;
}

module.exports = {
  PERMISSION_GROUPS,
  ALL_PERMISSIONS: CRM_MANIFEST_PERMISSIONS,
  CRM_MANIFEST_PERMISSIONS,
  ROLE_DEFINITIONS,
  getRoleDefinition,
  TENANT_ROLES,
  normalizePlatformRole,
  deriveTenantRole,
  isTenantRole,
  normalizeTenantRoleKey,
  resolveTenantRolePermissions,
  listTenantRoles,
  getDefaultRolePermissionsMap
};
