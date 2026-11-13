'use strict';

/**
 * CRM-owned extension registry (Settings → Extensions).
 *
 * These are the internal workspace "modes" of Root CRM. They are separate from
 * the OpenNext CMS extension packages (Dashboard → Extensions):
 * the CMS manages those; the CRM manages these.
 *
 * Rules:
 *   - Exactly one CRM extension is active per tenant at any time.
 *   - The active extension fixes the lead Request Type, the opportunity
 *     pipeline, and the set of core modules shown in the sidebar.
 *   - `product` is the default and is always available as the fallback.
 */

const DEFAULT_EXTENSION_ID = 'product';

/** Sidebar route ids of every core module the CRM ships. */
const ALL_CORE_MODULES = [
  'dashboard',
  'reports',
  'leads',
  'contacts',
  'clients',
  'opportunities',
  'samples',
  'quotations',
  'sales-orders',
  'invoices',
  'payments',
  'projects',
  'tasks',
  'time-logs',
  'tickets',
  'audit',
  'settings'
];

/** Core modules an extension may hide. Dashboard and Settings always stay. */
const HIDEABLE_MODULES = ALL_CORE_MODULES.filter((id) => id !== 'dashboard' && id !== 'settings');

/**
 * Core Settings tabs an extension may hide (manifest `hiddenSettingsTabs`, CRM 3.43.0). General and
 * Extensions always stay (Extensions is where the workspace switches extension). Hiding a tab only
 * removes it from Settings; its data and APIs are unchanged.
 */
const HIDEABLE_SETTINGS_TABS = [
  'modules',
  'shipping',
  'finance',
  'email',
  'integrations',
  'leads',
  'qualification-match',
  'opportunities',
  'clients',
  'projects',
  'project-statuses',
  'users'
];

/** Lucide icon names the Extensions card grid knows how to render. */
const ALLOWED_ICONS = [
  'package',
  'folder-kanban',
  'blocks',
  'briefcase',
  'wrench',
  'graduation-cap',
  'heart-handshake',
  'store',
  'truck',
  'stethoscope',
  'hammer',
  'sparkles',
  'plane',
  'layers',
  'factory',
  'shopping-bag',
  'landmark',
  'cpu',
  'palette',
  'calendar-check',
  'map',
  'ticket'
];

const ALLOWED_ACCENTS = ['blue', 'violet', 'emerald', 'amber', 'rose', 'slate'];

/** Opportunity pipeline stage types the CRM workflows understand. */
const STAGE_TYPES = [
  'OPEN',
  'SAMPLE_SENT',
  'SAMPLE_APPROVED',
  'QUOTATION_SENT',
  'NEGOTIATION',
  'QUOTATION_ACCEPTED',
  'WON',
  'LOST'
];

/** Every pipeline must carry these so quotations, wins and losses have a home. */
const REQUIRED_STAGE_TYPES = ['WON', 'LOST', 'QUOTATION_SENT', 'NEGOTIATION'];

/**
 * Optional modules every extension can switch on independently
 * (Settings → Modules & Features). All are off by default.
 */
const OPTIONAL_MODULES = [
  {
    key: 'expenses',
    routeId: 'expenses',
    label: 'Expenses',
    featureKey: 'expenses'
  },
  {
    key: 'marketing',
    routeId: 'marketing',
    label: 'Marketing Automation',
    featureKey: 'marketing'
  },
  {
    key: 'customer_success',
    routeId: 'customer-success',
    label: 'Customer Success',
    featureKey: 'customerSuccess'
  },
  {
    key: 'data_quality',
    routeId: 'data-quality',
    label: 'Data Quality',
    featureKey: 'dataQuality'
  }
];

const PRODUCT_PIPELINE_STAGES = [
  { id: 'product_discovery', label: 'Discovery', type: 'OPEN', probability: 10 },
  { id: 'product_requirement', label: 'Requirement Confirmed', type: 'OPEN', probability: 25 },
  { id: 'product_validated', label: 'Product Validated', type: 'OPEN', probability: 40 },
  { id: 'product_sample_approved', label: 'Sample Approved', type: 'SAMPLE_APPROVED', probability: 55 },
  { id: 'product_quote_sent', label: 'Quotation Sent', type: 'QUOTATION_SENT', probability: 95 },
  { id: 'product_won', label: 'Won', type: 'WON', probability: 100 },
  { id: 'product_negotiation', label: 'Negotiation', type: 'NEGOTIATION', probability: 85 },
  { id: 'product_lost', label: 'Lost', type: 'LOST', probability: 0 }
];

const PROJECT_PIPELINE_STAGES = [
  { id: 'project_discovery', label: 'Discovery', type: 'OPEN', probability: 10 },
  { id: 'project_requirement', label: 'Requirement Confirmed', type: 'OPEN', probability: 25 },
  { id: 'project_scope', label: 'Scope & Estimate Ready', type: 'OPEN', probability: 40 },
  { id: 'project_proposal', label: 'Proposal Presented', type: 'OPEN', probability: 55 },
  { id: 'project_quote_sent', label: 'Quotation Sent', type: 'QUOTATION_SENT', probability: 95 },
  { id: 'project_won', label: 'Won', type: 'WON', probability: 100 },
  { id: 'project_negotiation', label: 'Negotiation', type: 'NEGOTIATION', probability: 85 },
  { id: 'project_lost', label: 'Lost', type: 'LOST', probability: 0 }
];

const CRM_EXTENSIONS = [
  {
    id: 'product',
    name: 'Product Sales',
    tagline: 'Sell physical or packaged products',
    description:
      'Lead → Sample Request → Quotation → Sales Order → Invoice. Built for teams that sell products: ' +
      'sample approvals, dispatch-ready sales orders and product-level qualification checks.',
    icon: 'package',
    accent: 'blue',
    version: '1.0.0',
    publisher: 'OpenNext',
    isDefault: true,
    isInternal: true,
    /** Lead Request Type every new lead gets while this extension is active. */
    requestTypeKey: 'product',
    requestTypeName: 'Product',
    /** Opportunity pipeline activated with this extension. */
    pipelineKey: 'product_pipeline',
    pipelineName: 'Product Sales Pipeline',
    pipelineDescription: 'Discovery → Sample Approved → Quotation Sent → Won. Tailored for product sales.',
    pipelineStages: PRODUCT_PIPELINE_STAGES,
    /** When true the tenant's built-in Default Pipeline is adopted as this pipeline. */
    adoptDefaultPipeline: true,
    /** Core sidebar modules hidden while this extension is active. */
    hiddenModules: ['projects', 'tasks', 'time-logs'],
    /** Document conversions available from a won opportunity. */
    conversions: { salesOrder: true, invoice: false },
    highlights: [
      'Sample requests & approvals',
      'Sales orders with dispatch tracking',
      'Product category / spec qualification'
    ]
  },
  {
    id: 'project',
    name: 'Project Delivery',
    tagline: 'Sell and deliver software or services',
    description:
      'Lead → Quotation → Invoice → Project → Tasks → Time Logs. Built for teams that deliver projects: ' +
      'direct invoicing from won deals, project workspaces, task boards and billable hours.',
    icon: 'folder-kanban',
    accent: 'violet',
    version: '1.0.0',
    publisher: 'OpenNext',
    isDefault: false,
    isInternal: true,
    requestTypeKey: 'project_software',
    requestTypeName: 'Project (software)',
    pipelineKey: 'project_pipeline',
    pipelineName: 'Project Delivery Pipeline',
    pipelineDescription: 'Discovery → Scope & Estimate → Proposal → Quotation Sent → Won. Tailored for project delivery.',
    pipelineStages: PROJECT_PIPELINE_STAGES,
    adoptDefaultPipeline: false,
    hiddenModules: ['sales-orders'],
    conversions: { salesOrder: false, invoice: true },
    highlights: [
      'Projects, tasks & Gantt timeline',
      'Time logs & billable hours',
      'Convert won deals straight to invoices'
    ]
  }
];

const EXTENSION_IDS = new Set(CRM_EXTENSIONS.map((ext) => ext.id));

/** Request type keys owned by CRM extensions (never shown unless their extension is active). */
const EXTENSION_REQUEST_TYPE_KEYS = new Set(CRM_EXTENSIONS.map((ext) => ext.requestTypeKey));

function getExtensionDef(id) {
  const key = String(id || '')
    .trim()
    .toLowerCase();
  return CRM_EXTENSIONS.find((ext) => ext.id === key) || null;
}

function getDefaultExtensionDef() {
  return CRM_EXTENSIONS.find((ext) => ext.isDefault) || CRM_EXTENSIONS[0];
}

/** Resolve the active extension id from a settings map, falling back to the default. */
function resolveActiveExtensionId(settings) {
  const raw = settings && typeof settings === 'object' ? settings.active_extension : null;
  const def = getExtensionDef(raw);
  return def ? def.id : DEFAULT_EXTENSION_ID;
}

function isValidExtensionId(id) {
  return EXTENSION_IDS.has(
    String(id || '')
      .trim()
      .toLowerCase()
  );
}

/** Core modules visible for an extension (everything except its hidden list). */
function visibleModulesFor(def) {
  const hidden = new Set(def?.hiddenModules || []);
  return ALL_CORE_MODULES.filter((id) => !hidden.has(id));
}

/** Shape sent to the browser on /me — enough to gate navigation and forms. */
/**
 * `/me` → features.activeExtension. Every CRM user receives this.
 *
 * Shared contract for the full-package work streams
 * (documentation/crm-upload-plan/00-CONTRACTS.md §1). Fields added for
 * manifestVersion 2 are always present (empty for built-ins) so the UI never
 * has to guess.
 */
function toFeaturePayload(def) {
  const ext = def || getDefaultExtensionDef();
  const decl = ext.declarations && typeof ext.declarations === 'object' ? ext.declarations : {};
  const settings = decl.settings && typeof decl.settings === 'object' ? decl.settings : null;
  const ui = ext.ui && ext.ui.entry ? ext.ui : null;
  return {
    id: ext.id,
    name: ext.name,
    version: ext.version || '1.0.0',
    source: ext.isInternal === false ? 'uploaded' : 'builtin',
    manifestVersion: Number(ext.manifestVersion || 1),
    requestTypeKey: ext.requestTypeKey,
    requestTypeName: ext.requestTypeName,
    pipelineKey: ext.pipelineKey,
    hiddenModules: [...(ext.hiddenModules || [])],
    hiddenSettingsTabs: [...(ext.hiddenSettingsTabs || [])],
    conversions: { ...(ext.conversions || {}) },
    declarations: {
      fields: decl.fields || {},
      tabs: decl.tabs || {},
      navigation: decl.navigation || { pages: [] },
      actions: (decl.actions && Array.isArray(decl.actions.actions) ? decl.actions.actions : []).map((a) => ({
        id: a.id,
        page: a.page,
        label: a.label,
        icon: a.icon,
        kind: a.kind,
        slot: a.slot || '',
        permission: a.permission || '',
        when: a.when || {},
        confirm: a.confirm || ''
      })),
      settingsTab: settings ? { ...settings.tab, fieldCount: (settings.fields || []).length } : null
    },
    ui: ui
      ? {
          entry: ui.entry,
          styles: ui.styles || '',
          assetBase: `/x-assets/${ext.id}/${ext.version || '1.0.0'}`
        }
      : null,
    permissionsDefined: ((ext.permissions && ext.permissions.defines) || []).map((p) => ({ key: p.key, label: p.label, grantedWith: p.grantedWith || '' })),
    backend: ext.backend
      ? {
          apiBase: `/x/${ext.id}`,
          models: (ext.backend.models || []).map((m) => ({
            name: m.name,
            label: m.label,
            pluralLabel: m.pluralLabel,
            titleField: m.titleField,
            permissions: m.permissions,
            fields: m.fields
          })),
          requiresTrust: Boolean(ext.requiresTrust),
          trust: ext.trust || (ext.requiresTrust ? 'pending' : 'n/a'),
          status: ext.backendStatus || 'n/a'
        }
      : null
  };
}

/**
 * Resolve the active id against a full definition list (built-ins plus the
 * tenant's uploaded extensions). Unknown or uninstalled ids fall back to
 * the default so a removed package never leaves the workspace mode-less.
 */
function resolveActiveExtensionIdFrom(settings, definitions) {
  const raw = String(
    settings && typeof settings === 'object' ? settings.active_extension || '' : ''
  )
    .trim()
    .toLowerCase();
  const list = Array.isArray(definitions) && definitions.length ? definitions : CRM_EXTENSIONS;
  return list.some((def) => def.id === raw) ? raw : DEFAULT_EXTENSION_ID;
}

/**
 * The feature payload as one viewer may see it: a page declared for the client portal
 * (`audience: "portal"`) is never sent to staff, and a staff page never to a client login.
 * Pages for everyone (`all`, the default) stay for both.
 */
function forViewer(payload, { isClient = false } = {}) {
  const pages = payload?.declarations?.navigation?.pages;
  if (!Array.isArray(pages)) return payload;
  const kept = pages.filter((page) => {
    const audience = page && page.audience ? String(page.audience) : 'all';
    return isClient ? audience !== 'staff' : audience !== 'portal';
  });
  return {
    ...payload,
    declarations: { ...payload.declarations, navigation: { ...payload.declarations.navigation, pages: kept } }
  };
}

module.exports = {
  DEFAULT_EXTENSION_ID,
  ALL_CORE_MODULES,
  HIDEABLE_MODULES,
  HIDEABLE_SETTINGS_TABS,
  ALLOWED_ICONS,
  ALLOWED_ACCENTS,
  STAGE_TYPES,
  REQUIRED_STAGE_TYPES,
  OPTIONAL_MODULES,
  CRM_EXTENSIONS,
  EXTENSION_REQUEST_TYPE_KEYS,
  getExtensionDef,
  getDefaultExtensionDef,
  resolveActiveExtensionId,
  resolveActiveExtensionIdFrom,
  isValidExtensionId,
  visibleModulesFor,
  toFeaturePayload,
  forViewer
};
