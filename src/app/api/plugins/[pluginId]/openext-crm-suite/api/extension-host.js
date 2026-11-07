'use strict';

/**
 * Generic OpenNext CMS extension host for Root CRM (`openext-crm-suite`).
 *
 * CMS contribution schema is strict (id/label/href/entry/…).
 * CRM-specific slots live in each extension's `ui/host-slots.json`
 * and are merged when building the UI summary.
 */

const registered = new Map();
/** @type {Map<string, object>} */
const hostSlotsCache = new Map();

const extensionHost = {
  pluginId: 'openext-crm-suite',
  sdkVersion: '^1.0.0',
  capabilities: [
    'navigation.register',
    'ui.page.register',
    'lifecycle.register',
    'settings.register',
    'fields.register',
    'workflows.register',
    'api.register',
    'events.subscribe',
    'migrations.register'
  ],

  async registerExtension(registration) {
    if (!registration || !registration.extensionId) return;
    const id = String(registration.extensionId);
    registered.set(id, {
      extensionId: id,
      version: registration.version || '',
      targetPluginId: registration.targetPluginId || 'openext-crm-suite',
      capabilities: Array.isArray(registration.capabilities)
        ? registration.capabilities
        : [],
      permissions: Array.isArray(registration.permissions)
        ? registration.permissions
        : [],
      contributions: registration.contributions || {},
      entry: registration.entry || {},
      registeredAt: new Date().toISOString()
    });
  },

  async unregisterExtension(extensionId) {
    const id = String(extensionId || '');
    registered.delete(id);
    hostSlotsCache.delete(id);
  }
};

function listRegisteredExtensions() {
  return [...registered.values()];
}

function getExtension(extensionId) {
  return registered.get(String(extensionId || '')) || null;
}

function isExtensionEnabled(extensionId) {
  return registered.has(String(extensionId || ''));
}

function resolveExtensionAssetUrl(extensionId, relativePath) {
  const path = String(relativePath || '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  if (!path) return `/extensions/${encodeURIComponent(String(extensionId))}`;
  return `/extensions/${encodeURIComponent(String(extensionId))}/${path}`;
}

function tabKey(extensionId, id) {
  return `ext__${String(extensionId)}__${String(id)}`;
}

function setHostSlots(extensionId, slots) {
  if (!extensionId) return;
  if (slots && typeof slots === 'object') {
    hostSlotsCache.set(String(extensionId), slots);
  }
}

function getHostSlots(extensionId) {
  return hostSlotsCache.get(String(extensionId || '')) || null;
}

function listContributedRequestTypes() {
  const out = [];
  for (const ext of listRegisteredExtensions()) {
    const slots = getHostSlots(ext.extensionId);
    for (const item of slots?.requestTypes || []) {
      const key = String(item.key || '')
        .trim()
        .toLowerCase();
      if (!key) continue;
      out.push({
        extensionId: ext.extensionId,
        key,
        name: String(item.name || key).trim() || key,
        description: String(item.description || '').trim()
      });
    }
  }
  return out;
}

function listContributedOpportunityPipelines() {
  const fs = require('fs');
  const path = require('path');
  const out = [];
  const seenKeys = new Set();

  function addPipeline(extId, item) {
    if (!item || !item.name) return;
    const key = String(item.key || `ext_${extId}_${item.name}`)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_');
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    out.push({
      extensionId: extId,
      key,
      name: String(item.name).trim(),
      description: String(item.description || '').trim(),
      quotationWorkflowEnabled: item.quotationWorkflowEnabled !== false,
      stages: Array.isArray(item.stages) ? item.stages : []
    });
  }

  // 1. From dynamically registered extensions & host-slots cache
  for (const ext of listRegisteredExtensions()) {
    const slots = getHostSlots(ext.extensionId) || {};
    const contrib = ext.contributions || {};
    const list = Array.isArray(slots.opportunityPipelines)
      ? slots.opportunityPipelines
      : Array.isArray(contrib.opportunityPipelines)
        ? contrib.opportunityPipelines
        : [];
    for (const item of list) {
      addPipeline(ext.extensionId, item);
    }
  }

  // 2. Also inspect installed extension packages and local extension directories
  const searchRoots = [
    path.resolve(process.cwd(), 'src/extension-packages'),
    path.resolve(process.cwd(), 'extension-packages'),
    path.resolve(process.cwd(), 'extensions'),
    path.resolve(process.cwd(), '../extensions'),
    path.resolve(__dirname, '../../extensions'),
    path.resolve(__dirname, '../../../extensions'),
    path.resolve(__dirname, '../../Refactor/extensions'),
    path.resolve(process.cwd(), '../Refactor/extensions')
  ];

  for (const root of searchRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const stat = fs.statSync(root);
      const extDirs = [];
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory()) {
            extDirs.push({ id: ent.name, dir: path.join(root, ent.name) });
          }
        }
        if (fs.existsSync(path.join(root, 'manifest.json')) || fs.existsSync(path.join(root, 'ui'))) {
          extDirs.push({ id: path.basename(root), dir: root });
        }
      }

      for (const { id: extId, dir: extDir } of extDirs) {
        const candidates = [];
        const versionsDir = path.join(extDir, 'versions');
        if (fs.existsSync(versionsDir)) {
          const currentFile = path.join(extDir, 'current.json');
          if (fs.existsSync(currentFile)) {
            try {
              const cur = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
              if (cur.version) candidates.push(path.join(versionsDir, cur.version));
            } catch {}
          }
          try {
            const vEntries = fs.readdirSync(versionsDir, { withFileTypes: true });
            for (const ve of vEntries) {
              if (ve.isDirectory()) candidates.push(path.join(versionsDir, ve.name));
            }
          } catch {}
        }
        candidates.push(extDir);

        for (const candidate of candidates) {
          const jsonFiles = [
            path.join(candidate, 'ui', 'opportunity-pipeline.json'),
            path.join(candidate, 'opportunity-pipeline.json'),
            path.join(candidate, 'ui', 'host-slots.json'),
            path.join(candidate, 'host-slots.json'),
            path.join(candidate, 'crm-extension.json')
          ];
          for (const f of jsonFiles) {
            if (fs.existsSync(f)) {
              try {
                const text = fs.readFileSync(f, 'utf8');
                const parsed = JSON.parse(text);
                const items = Array.isArray(parsed)
                  ? parsed
                  : Array.isArray(parsed.opportunityPipelines)
                    ? parsed.opportunityPipelines
                    : (parsed.stages && parsed.name)
                      ? [parsed]
                      : (parsed.pipelineStages && parsed.pipelineName)
                        ? [{
                            key: parsed.pipelineKey || `${extId}_pipeline`,
                            name: parsed.pipelineName,
                            description: parsed.pipelineDescription,
                            stages: parsed.pipelineStages,
                            quotationWorkflowEnabled: true
                          }]
                        : [];
                for (const item of items) {
                  addPipeline(extId, item);
                }
              } catch {}
            }
          }
        }
      }
    } catch {
      /* ignore root search errors */
    }
  }

  return out;
}

/** Default array key under client.extension[extensionId] for record groups. */
const DEFAULT_CLIENT_RECORD_STORE_KEY = 'records';

/** Native client-detail tab kinds the CRM knows how to render. */
const CLIENT_TAB_KINDS = new Set(['records']);

function normalizeClientDetailTab(extensionId, tab) {
  const id = String(tab?.id || tab?.pageId || '').trim();
  if (!id) return null;
  const kind = String(tab?.kind || 'records').trim();
  return {
    extensionId,
    id,
    tabId: tabKey(extensionId, `client__${id}`),
    label: String(tab.label || id),
    title: String(tab.label || id),
    slot: 'client.detail.tab',
    /** `records` → CRM record manager (upload + fields + list) for this tab. */
    kind: CLIENT_TAB_KINDS.has(kind) ? kind : 'records',
    whenRequestTypeKey: tab.whenRequestTypeKey
      ? String(tab.whenRequestTypeKey).trim().toLowerCase()
      : null,
    whenRequestTypeName: tab.whenRequestTypeName
      ? String(tab.whenRequestTypeName).trim().toLowerCase()
      : null,
    /** Dotted path inside the extension bag holding the allowed record count. */
    countBy: tab.countBy ? String(tab.countBy).trim() : null,
    /** Label used in the "{n} missing" banner (e.g. "documents"). */
    countLabel: tab.countLabel ? String(tab.countLabel).trim() : '',
    order: Number.isFinite(Number(tab.order)) ? Number(tab.order) : 100,
    hintMessage: tab.hintMessage ? String(tab.hintMessage) : ''
  };
}

/**
 * Read-only section rendered inside the client Overview tab.
 *
 * The extension's `logic` module supplies `toDisplaySections(bag)`, which
 * returns finished label/value strings — the CRM never interprets the bag
 * itself, so no raw ids or JSON reach the screen.
 */
function normalizeClientOverviewSection(extensionId, entry) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  const logicPath = entry.logic ? String(entry.logic).replace(/^\/+/, '') : '';
  const schemaPath = entry.schema ? String(entry.schema).replace(/^\/+/, '') : '';
  return {
    extensionId,
    id,
    sectionId: tabKey(extensionId, `overview__${id}`),
    label: String(entry.label || id),
    slot: 'client.overview.section',
    whenRequestTypeKey: entry.whenRequestTypeKey
      ? String(entry.whenRequestTypeKey).trim().toLowerCase()
      : null,
    whenRequestTypeName: entry.whenRequestTypeName
      ? String(entry.whenRequestTypeName).trim().toLowerCase()
      : null,
    logicUrl: logicPath ? resolveExtensionAssetUrl(extensionId, logicPath) : '',
    schemaUrl: schemaPath ? resolveExtensionAssetUrl(extensionId, schemaPath) : '',
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100,
    hintMessage: entry.hintMessage ? String(entry.hintMessage) : ''
  };
}

function normalizeClientDetailFieldGroup(extensionId, group) {
  const tabId = String(group?.tabId || '').trim();
  if (!tabId) return null;
  const logicPath = group.logic ? String(group.logic).replace(/^\/+/, '') : '';
  const schemaPath = group.schema ? String(group.schema).replace(/^\/+/, '') : '';
  return {
    extensionId,
    tabId,
    key: String(group.key || tabId),
    sectionLabel: String(group.sectionLabel || 'Extension fields'),
    /** Array key under client.extension[extensionId] that stores the records. */
    storeKey: String(group.storeKey || group.key || DEFAULT_CLIENT_RECORD_STORE_KEY),
    logicUrl: logicPath ? resolveExtensionAssetUrl(extensionId, logicPath) : '',
    schemaUrl: schemaPath ? resolveExtensionAssetUrl(extensionId, schemaPath) : '',
    fields: Array.isArray(group.fields) ? group.fields : [],
    order: Number.isFinite(Number(group.order)) ? Number(group.order) : 100
  };
}

function findPageEntry(ext, pageId) {
  const pages = ext.contributions?.pages || [];
  const page = pages.find((p) => String(p.id) === String(pageId));
  if (page?.entry) return String(page.entry);
  const nav = (ext.contributions?.navigation || []).find((n) => String(n.id) === String(pageId));
  if (nav?.href) return String(nav.href);
  return ext.entry?.frontend || '';
}

/**
 * Build CRM UI summary from CMS contributions + optional ui/host-slots.json cache.
 */
function getExtensionUiSummary() {
  const extensions = listRegisteredExtensions().map((ext) => ({
    extensionId: ext.extensionId,
    version: ext.version,
    registeredAt: ext.registeredAt,
    capabilities: ext.capabilities,
    permissions: ext.permissions,
    hostSlotsUrl: resolveExtensionAssetUrl(ext.extensionId, 'ui/pages/host-slots.html')
  }));

  const navigation = [];
  const pages = [];
  const modulePages = [];
  const settings = [];
  const leadDetailTabs = [];
  const leadDetailEmbeds = [];
  const leadCreateHints = [];
  const leadCreateFields = [];
  const clientDetailTabs = [];
  const clientDetailFields = [];
  const clientOverviewSections = [];

  for (const ext of listRegisteredExtensions()) {
    const contrib = ext.contributions || {};
    const slots = getHostSlots(ext.extensionId) || {};
    const moduleIds = new Set((slots.modulePageIds || []).map(String));
    const pageById = new Map();

    // Native Create Lead field slot (no nested iframe) — docs: fields.register
    const fieldDefs = Array.isArray(contrib.fields) ? contrib.fields : [];
    if (fieldDefs.length) {
      const slotMeta =
        slots.leadCreateFields && typeof slots.leadCreateFields === 'object'
          ? slots.leadCreateFields
          : {};
      const logicPath = String(slotMeta.logic || 'ui/fields/calc.js').replace(/^\/+/, '');
      const schemaPath = slotMeta.schema
        ? String(slotMeta.schema).replace(/^\/+/, '')
        : 'ui/fields/fields.json';
      leadCreateFields.push({
        extensionId: ext.extensionId,
        sectionLabel: String(slotMeta.sectionLabel || fieldDefs[0]?.section || 'Extension fields'),
        whenRequestTypeKey: slotMeta.whenRequestTypeKey
          ? String(slotMeta.whenRequestTypeKey).trim().toLowerCase()
          : fieldDefs[0]?.whenRequestTypeKey
            ? String(fieldDefs[0].whenRequestTypeKey).trim().toLowerCase()
            : null,
        whenRequestTypeName: slotMeta.whenRequestTypeName
          ? String(slotMeta.whenRequestTypeName).trim().toLowerCase()
          : fieldDefs[0]?.whenRequestTypeName
            ? String(fieldDefs[0].whenRequestTypeName).trim().toLowerCase()
            : null,
        logicUrl: resolveExtensionAssetUrl(ext.extensionId, logicPath),
        schemaUrl: resolveExtensionAssetUrl(ext.extensionId, schemaPath),
        order: Number.isFinite(Number(slotMeta.order)) ? Number(slotMeta.order) : 100,
        fields: fieldDefs.map((f, index) => ({
          id: String(f.id || ''),
          label: String(f.label || f.id || ''),
          fieldType: String(f.fieldType || 'text'),
          required: !!f.required,
          readOnly: !!f.readOnly,
          order: Number.isFinite(Number(f.order)) ? Number(f.order) : (index + 1) * 10,
          options: Array.isArray(f.options) ? f.options : [],
          placeholder: f.placeholder ? String(f.placeholder) : '',
          helpText: f.helpText ? String(f.helpText) : '',
          section: f.section ? String(f.section) : null,
          whenRequestTypeKey: f.whenRequestTypeKey
            ? String(f.whenRequestTypeKey).trim().toLowerCase()
            : null,
          whenRequestTypeName: f.whenRequestTypeName
            ? String(f.whenRequestTypeName).trim().toLowerCase()
            : null
        }))
      });
    }

    for (const page of contrib.pages || []) {
      const entry = page.entry || ext.entry?.frontend || '';
      const normalized = {
        extensionId: ext.extensionId,
        id: String(page.id || ''),
        tabId: tabKey(ext.extensionId, page.id || page.title || 'page'),
        title: page.title || page.id || 'Extension page',
        label: page.title || page.id || 'Extension',
        entry,
        url: resolveExtensionAssetUrl(ext.extensionId, entry),
        slot: 'module',
        whenRequestTypeKey: null,
        whenRequestTypeName: null,
        appendLeadId: false,
        openOnCreate: false,
        order: 100,
        hintMessage: ''
      };
      pageById.set(normalized.id, normalized);
      pages.push(normalized);
    }

    for (const nav of contrib.navigation || []) {
      const href = nav.href || ext.entry?.frontend || '';
      navigation.push({
        extensionId: ext.extensionId,
        id: String(nav.id || ''),
        label: nav.label || nav.id || ext.extensionId,
        url: resolveExtensionAssetUrl(ext.extensionId, href),
        order: 100
      });
      if (!pageById.has(String(nav.id || ''))) {
        moduleIds.add(String(nav.id || ''));
      }
    }

    // Opt-in only: never auto-promote the first contributed page to a sidebar module.
    // Extensions must list ids in host-slots.modulePageIds when they want a menu item.

    for (const id of moduleIds) {
      const page = pageById.get(String(id));
      if (page) {
        modulePages.push({ ...page, slot: 'module' });
      } else {
        const entry = findPageEntry(ext, id);
        if (entry) {
          modulePages.push({
            extensionId: ext.extensionId,
            id: String(id),
            tabId: tabKey(ext.extensionId, id),
            title: String(id),
            label: String(id),
            entry,
            url: resolveExtensionAssetUrl(ext.extensionId, entry),
            slot: 'module',
            whenRequestTypeKey: null,
            whenRequestTypeName: null,
            appendLeadId: false,
            openOnCreate: false,
            order: 100,
            hintMessage: ''
          });
        }
      }
    }

    for (const setting of slots.settings || []) {
      const pageId = String(setting.pageId || setting.key || '');
      const entry = findPageEntry(ext, pageId) || setting.entry || '';
      if (!entry) continue;
      settings.push({
        extensionId: ext.extensionId,
        key: String(setting.key || pageId),
        tabId: tabKey(ext.extensionId, setting.key || pageId),
        label: setting.label || pageId,
        url: resolveExtensionAssetUrl(ext.extensionId, entry),
        order: Number.isFinite(Number(setting.order)) ? Number(setting.order) : 100
      });
    }

    for (const tab of slots.leadDetailTabs || []) {
      const pageId = String(tab.pageId || '');
      const entry = findPageEntry(ext, pageId);
      if (!entry) continue;
      const item = {
        extensionId: ext.extensionId,
        id: pageId,
        tabId: tabKey(ext.extensionId, pageId),
        title: tab.label || pageId,
        label: tab.label || pageId,
        entry,
        url: resolveExtensionAssetUrl(ext.extensionId, entry),
        slot: 'lead.detail.tab',
        whenRequestTypeKey: tab.whenRequestTypeKey
          ? String(tab.whenRequestTypeKey).trim().toLowerCase()
          : null,
        whenRequestTypeName: tab.whenRequestTypeName
          ? String(tab.whenRequestTypeName).trim().toLowerCase()
          : null,
        appendLeadId: tab.appendLeadId !== false,
        openOnCreate: !!tab.openOnCreate,
        order: Number.isFinite(Number(tab.order)) ? Number(tab.order) : 100,
        hintMessage: tab.hintMessage ? String(tab.hintMessage) : ''
      };
      leadDetailTabs.push(item);
      if (item.openOnCreate) leadCreateHints.push(item);
    }

    // Lead Create form embeds (shown when Request Type matches — not a detail tab).
    for (const emb of slots.leadCreateEmbeds || []) {
      const pageId = String(emb.pageId || '');
      const entry = findPageEntry(ext, pageId);
      if (!entry) continue;
      const item = {
        extensionId: ext.extensionId,
        id: pageId,
        tabId: tabKey(ext.extensionId, pageId),
        title: emb.label || pageId,
        label: emb.label || pageId,
        entry,
        url: resolveExtensionAssetUrl(ext.extensionId, entry),
        slot: 'lead.create.embed',
        whenRequestTypeKey: emb.whenRequestTypeKey
          ? String(emb.whenRequestTypeKey).trim().toLowerCase()
          : null,
        whenRequestTypeName: emb.whenRequestTypeName
          ? String(emb.whenRequestTypeName).trim().toLowerCase()
          : null,
        appendLeadId: false,
        openOnCreate: emb.openOnCreate !== false,
        order: Number.isFinite(Number(emb.order)) ? Number(emb.order) : 100,
        hintMessage: emb.hintMessage ? String(emb.hintMessage) : ''
      };
      if (!leadCreateHints.some((x) => x.tabId === item.tabId)) {
        leadCreateHints.push(item);
      }
    }

    // Lead Details embeds — same UI pages as create; CRM hydrates from Lead.extension.
    const detailEmbedDefs = Array.isArray(slots.leadDetailEmbeds) && slots.leadDetailEmbeds.length
      ? slots.leadDetailEmbeds
      : slots.leadCreateEmbeds || [];
    for (const emb of detailEmbedDefs) {
      const pageId = String(emb.pageId || '');
      const entry = findPageEntry(ext, pageId);
      if (!entry) continue;
      const item = {
        extensionId: ext.extensionId,
        id: pageId,
        tabId: tabKey(ext.extensionId, `detail__${pageId}`),
        title: emb.label || pageId,
        label: emb.label || pageId,
        entry,
        url: resolveExtensionAssetUrl(ext.extensionId, entry),
        slot: 'lead.detail.embed',
        whenRequestTypeKey: emb.whenRequestTypeKey
          ? String(emb.whenRequestTypeKey).trim().toLowerCase()
          : null,
        whenRequestTypeName: emb.whenRequestTypeName
          ? String(emb.whenRequestTypeName).trim().toLowerCase()
          : null,
        appendLeadId: true,
        openOnCreate: false,
        order: Number.isFinite(Number(emb.order)) ? Number(emb.order) : 100,
        hintMessage: emb.hintMessage ? String(emb.hintMessage) : ''
      };
      if (!leadDetailEmbeds.some((x) => x.tabId === item.tabId)) {
        leadDetailEmbeds.push(item);
      }
    }

    // Client Details tabs — rendered natively by CRM (no iframe, no HTML entry).
    for (const tab of slots.clientDetailTabs || []) {
      const item = normalizeClientDetailTab(ext.extensionId, tab);
      if (!item) continue;
      if (clientDetailTabs.some((x) => x.tabId === item.tabId)) continue;
      clientDetailTabs.push(item);
    }

    // Read-only sections rendered on the client Overview tab.
    for (const entry of slots.clientOverviewSections || []) {
      const item = normalizeClientOverviewSection(ext.extensionId, entry);
      if (!item) continue;
      if (clientOverviewSections.some((x) => x.sectionId === item.sectionId)) continue;
      clientOverviewSections.push(item);
    }

    // Field groups backing a `records` client tab (schema + logic from the zip).
    for (const group of slots.clientDetailFields || []) {
      const item = normalizeClientDetailFieldGroup(ext.extensionId, group);
      if (!item) continue;
      if (
        clientDetailFields.some(
          (x) => x.extensionId === item.extensionId && x.tabId === item.tabId
        )
      ) {
        continue;
      }
      clientDetailFields.push(item);
    }
  }

  const byOrder = (a, b) =>
    (a.order || 100) - (b.order || 100) ||
    String(a.label || a.title || '').localeCompare(String(b.label || b.title || ''));

  return {
    extensions,
    navigation: navigation.sort(byOrder),
    pages,
    modulePages: modulePages.sort(byOrder),
    settings: settings.sort(byOrder),
    leadDetailTabs: leadDetailTabs.sort(byOrder),
    leadDetailEmbeds: leadDetailEmbeds.sort(byOrder),
    leadCreateHints: leadCreateHints.sort(byOrder),
    leadCreateFields: leadCreateFields.sort(byOrder),
    clientDetailTabs: clientDetailTabs.sort(byOrder),
    clientDetailFields: clientDetailFields.sort(byOrder),
    clientOverviewSections: clientOverviewSections.sort(byOrder),
    requestTypes: listContributedRequestTypes()
  };
}

/**
 * Fetch ui/host-slots.json for each registered extension (cookie-forwarded).
 */
async function enrichHostSlotsFromRequest(req) {
  const exts = listRegisteredExtensions();
  if (!exts.length) return getExtensionUiSummary();

  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  if (!host || typeof fetch !== 'function') {
    return getExtensionUiSummary();
  }

  const origin = `${proto}://${host}`;
  const cookie = req.headers.cookie || '';

  await Promise.all(
    exts.map(async (ext) => {
      const url = `${origin}${resolveExtensionAssetUrl(ext.extensionId, 'ui/pages/host-slots.html')}`;
      try {
        const res = await fetch(url, {
          headers: cookie ? { cookie } : {},
          redirect: 'follow'
        });
        if (!res.ok) return;
        const text = await res.text();
        const m = text.match(/id="host-slots">([\s\S]*?)<\/script>/);
        const json = m ? JSON.parse(m[1]) : null;
        if (json) setHostSlots(ext.extensionId, json);
      } catch {
        /* optional file */
      }
    })
  );

  return getExtensionUiSummary();
}

module.exports = {
  extensionHost,
  listRegisteredExtensions,
  getExtension,
  isExtensionEnabled,
  resolveExtensionAssetUrl,
  listContributedRequestTypes,
  listContributedOpportunityPipelines,
  getExtensionUiSummary,
  setHostSlots,
  getHostSlots,
  enrichHostSlotsFromRequest,
  DEFAULT_CLIENT_RECORD_STORE_KEY
};
