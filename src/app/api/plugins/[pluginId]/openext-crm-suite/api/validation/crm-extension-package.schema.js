'use strict';

/**
 * Validation for an uploaded CRM workspace extension package.
 *
 * Two manifest versions are accepted:
 *
 *   manifestVersion 1 — declarative mode package (text files at the root)
 *     crm-extension.json, request-type.json?, README.md?
 *
 *   manifestVersion 2 — full package
 *     crm-extension.json, request-type.json?, README.md?, CHANGELOG.md?
 *     json/        fields.json tabs.json catalog.json settings.json navigation.json
 *     ui/          mount.js (ESM, exports mount/unmount), style.css, assets
 *     api/         routes.json, routes/*.js, services/*.js, models/*.json, index.js
 *
 * A single wrapper folder is accepted when crm-extension.json sits inside it.
 * The manifest rules are the same invariants the built-in registry is tested
 * against, plus uniqueness checks that only make sense for uploads, plus the
 * v2 sections (compatibility, capabilities, entry, declarations, permissions).
 */

const { validateFields } = require('./request-type.schema');
const {
  ALL_CORE_MODULES,
  HIDEABLE_MODULES,
  ALLOWED_ICONS,
  ALLOWED_ACCENTS,
  STAGE_TYPES,
  REQUIRED_STAGE_TYPES
} = require('../crm-extensions');
const { CRM_MANIFEST_PERMISSIONS } = require('../utils/crm-role-permissions.util');
const { satisfies, isValidRange } = require('../utils/semver-range.util');
const declarations = require('./crm-extension-declarations.schema');
const { validateBackend } = require('./crm-extension-backend.schema');

const PACKAGE_MANIFEST = 'crm-extension.json';
const REQUEST_TYPE_FILE = 'request-type.json';
const MAX_FILES = 500;
const MAX_DEPTH = 6;
const MAX_UI_BYTES = 8 * 1024 * 1024;

/** Allowed file extensions per package area. */
const AREA_EXTENSIONS = {
  root: new Set(['.json', '.md', '.txt']),
  json: new Set(['.json', '.md']),
  ui: new Set(['.js', '.mjs', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.json', '.map', '.txt']),
  api: new Set(['.js', '.cjs', '.json', '.md'])
};
const IGNORED_ENTRY_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const FORBIDDEN_SEGMENT_RE = /^(node_modules|\.git|\.svn|\.hg)$|^\.env/i;

const CAPABILITIES = [
  'declarations.fields',
  'declarations.tabs',
  'declarations.catalog',
  'declarations.settings',
  'declarations.navigation',
  'ui.mount',
  'api.routes',
  'api.models',
  'files.private',
  'ai.vision',
  'documents.pdf',
  'declarations.actions',
  'declarations.reports',
  'declarations.dashboard'
];
const DECLARATION_FILES = {
  fields: 'json/fields.json',
  tabs: 'json/tabs.json',
  catalog: 'json/catalog.json',
  settings: 'json/settings.json',
  navigation: 'json/navigation.json',
  actions: 'json/actions.json',
  reports: 'json/reports.json',
  dashboard: 'json/dashboard.json'
};
const UI_ENTRY_DEFAULT = 'ui/mount.js';
const UI_STYLES_DEFAULT = 'ui/style.css';
const API_ENTRY_DEFAULT = 'api/index.js';

const ID_RE = /^[a-z][a-z0-9_-]{2,31}$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,59}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ESM_EXPORT_RE = /\bexport\s*(default\b|\{|function\b|const\b|let\b|var\b|class\b|async\b)/;

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripBom(buffer) {
  return buffer.toString('utf8').replace(/^﻿/, '');
}

function currentCrmVersion() {
  try {
    // eslint-disable-next-line global-require
    return String(require('../../manifest.json').version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/* ----------------------------------------------------------------- files */

/**
 * Sort zip entries into package areas and apply the file rules.
 *
 * @returns {{ errors: string[], root: string, files: Map<string, Buffer>,
 *             areas: Record<'root'|'json'|'ui'|'api', string[]>,
 *             manifestText: string, requestTypeText: string }}
 */
function pickPackageFiles(entries) {
  const files = entries.filter((entry) => !entry.isDirectory && !IGNORED_ENTRY_RE.test(entry.path));
  const errors = [];
  const empty = { errors, root: '', files: new Map(), areas: { root: [], json: [], ui: [], api: [] }, manifestText: '', requestTypeText: '' };

  if (!files.length) {
    errors.push('The zip is empty');
    return empty;
  }
  if (files.length > MAX_FILES) errors.push(`The zip has ${files.length} files; at most ${MAX_FILES} are allowed`);

  // The manifest may sit at the root or inside exactly one wrapper folder.
  const manifestEntry =
    files.find((f) => f.path === PACKAGE_MANIFEST) ||
    files.find((f) => /^[^/]+\/crm-extension\.json$/.test(f.path));
  if (!manifestEntry) {
    errors.push(`${PACKAGE_MANIFEST} is missing (expected at the zip root or inside one folder)`);
    return empty;
  }
  const root = manifestEntry.path.slice(0, manifestEntry.path.length - PACKAGE_MANIFEST.length);

  const map = new Map();
  const areas = { root: [], json: [], ui: [], api: [] };
  for (const file of files) {
    if (!file.path.startsWith(root)) {
      errors.push(`File is outside the package folder: ${file.path}`);
      continue;
    }
    const rel = file.path.slice(root.length);
    const segments = rel.split('/');
    if (segments.length > MAX_DEPTH) {
      errors.push(`Folder nesting is too deep: ${rel}`);
      continue;
    }
    if (segments.some((s) => FORBIDDEN_SEGMENT_RE.test(s))) {
      errors.push(`Not allowed in an extension package: ${rel}`);
      continue;
    }
    const area = segments.length === 1 ? 'root' : segments[0];
    if (!(area in AREA_EXTENSIONS)) {
      errors.push(`Unexpected folder "${segments[0]}/" — a package may only contain json/, ui/ and api/ folders: ${rel}`);
      continue;
    }
    const base = segments[segments.length - 1];
    const dot = base.lastIndexOf('.');
    const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
    if (!AREA_EXTENSIONS[area].has(ext)) {
      errors.push(`File type not allowed in an extension package: ${rel}`);
      continue;
    }
    if (map.has(rel)) {
      errors.push(`Duplicate file in the zip: ${rel}`);
      continue;
    }
    map.set(rel, file.data);
    areas[area].push(rel);
  }

  const requestType = map.get(REQUEST_TYPE_FILE);
  return {
    errors,
    root,
    files: map,
    areas,
    manifestText: stripBom(manifestEntry.data),
    requestTypeText: requestType ? stripBom(requestType) : ''
  };
}

function parseJson(text, label, errors) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

/* ---------------------------------------------------------------- stages */

function validateStages(rawStages, errors) {
  if (!Array.isArray(rawStages) || rawStages.length < 4) {
    errors.push('pipelineStages must list at least 4 stages');
    return [];
  }
  if (rawStages.length > 20) errors.push('pipelineStages cannot have more than 20 stages');

  const seenIds = new Set();
  const stages = rawStages.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const label = str(source.label);
    const type = str(source.type).toUpperCase() || 'OPEN';
    const id = str(source.id) || `stage_${index + 1}`;
    const probability = Number(source.probability);
    if (!label) errors.push(`pipelineStages[${index}] needs a label`);
    if (label.length > 80) errors.push(`pipelineStages[${index}] label is longer than 80 characters`);
    if (!STAGE_TYPES.includes(type)) {
      errors.push(`pipelineStages[${index}] type "${type}" is not one of ${STAGE_TYPES.join(', ')}`);
    }
    if (seenIds.has(id)) errors.push(`pipelineStages has a duplicate id "${id}"`);
    seenIds.add(id);
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
      errors.push(`pipelineStages[${index}] probability must be a number from 0 to 100`);
    }
    return { id, label, type, probability: Number.isFinite(probability) ? probability : 50 };
  });

  const types = new Set(stages.map((s) => s.type));
  for (const required of REQUIRED_STAGE_TYPES) {
    if (!types.has(required)) errors.push(`pipelineStages must include a ${required} stage`);
  }
  return stages;
}

/* ------------------------------------------------------------ v2 sections */

function validatePermissionsSection(source, id, errors) {
  const raw = isObject(source.permissions) ? source.permissions : {};
  const crmKeys = new Set(CRM_MANIFEST_PERMISSIONS);
  const uses = [];
  for (const item of Array.isArray(raw.uses) ? raw.uses : []) {
    const key = str(item);
    if (!crmKeys.has(key)) errors.push(`permissions.uses: "${key}" is not a CRM permission`);
    else if (!uses.includes(key)) uses.push(key);
  }
  const defines = [];
  const definedRe = new RegExp(`^x\\.${id.replace(/[-]/g, '\\-')}\\.[a-z0-9_.]{2,60}$`);
  for (const item of Array.isArray(raw.defines) ? raw.defines : []) {
    const key = str(isObject(item) ? item.key : item);
    const label = str(isObject(item) ? item.label : '') || key;
    if (!definedRe.test(key)) {
      errors.push(`permissions.defines: "${key}" must look like "x.${id}.<name>" (lowercase letters, numbers, "_" or ".")`);
      continue;
    }
    if (defines.some((d) => d.key === key)) errors.push(`permissions.defines: duplicate key "${key}"`);
    // Optional: the core permission this key comes with (e.g. crm.leads.write); never crm.settings.manage-only keys of other extensions.
    const grantedWith = str(isObject(item) ? item.grantedWith : '');
    if (grantedWith && !crmKeys.has(grantedWith)) errors.push(`permissions.defines: "${key}" grantedWith "${grantedWith}" is not a CRM permission`);
    defines.push({
      key,
      label: label.slice(0, 80),
      description: str(isObject(item) ? item.description : '').slice(0, 200),
      ...(grantedWith && crmKeys.has(grantedWith) ? { grantedWith } : {})
    });
  }
  if (defines.length > 30) errors.push('permissions.defines: at most 30 permissions can be defined');
  return { uses, defines, allKeys: new Set([...crmKeys, ...defines.map((d) => d.key)]) };
}

function validateCapabilities(source, files, areas, errors, warnings) {
  const declared = [];
  for (const item of Array.isArray(source.capabilities) ? source.capabilities : []) {
    const key = str(item);
    if (!CAPABILITIES.includes(key)) errors.push(`capabilities: "${key}" is unknown; valid: ${CAPABILITIES.join(', ')}`);
    else if (!declared.includes(key)) declared.push(key);
  }
  const has = (cap) => declared.includes(cap);

  // Shipped but not declared → error; declared but not shipped → warning.
  for (const [name, path] of Object.entries(DECLARATION_FILES)) {
    const cap = `declarations.${name}`;
    if (files.has(path) && !has(cap)) errors.push(`${path} is shipped but "${cap}" is not in capabilities`);
    if (!files.has(path) && has(cap)) warnings.push(`capability "${cap}" is declared but ${path} is missing`);
  }
  if (areas.ui.length && !has('ui.mount')) errors.push('ui/ is shipped but "ui.mount" is not in capabilities');
  if (!areas.ui.length && has('ui.mount')) warnings.push('capability "ui.mount" is declared but ui/ is empty');
  const hasRoutes = files.has('api/routes.json') || areas.api.some((p) => p.startsWith('api/routes/'));
  const hasModels = areas.api.some((p) => /^api\/models\/[^/]+\.json$/.test(p));
  if (hasRoutes && !has('api.routes')) errors.push('api/routes are shipped but "api.routes" is not in capabilities');
  if (!hasRoutes && has('api.routes')) warnings.push('capability "api.routes" is declared but no api/routes.json is shipped');
  for (const service of ['files.private', 'ai.vision', 'documents.pdf']) {
    if (has(service) && !hasRoutes) warnings.push(`capability "${service}" is declared but no api/ routes use it`);
  }
  if (hasModels && !has('api.models')) errors.push('api/models are shipped but "api.models" is not in capabilities');
  if (!hasModels && has('api.models')) warnings.push('capability "api.models" is declared but api/models/ is empty');
  if (areas.api.length && !hasRoutes && !hasModels && !files.has(API_ENTRY_DEFAULT)) {
    warnings.push('api/ contains neither routes nor models');
  }
  return declared;
}

function validateUi(source, files, areas, errors, warnings) {
  if (!areas.ui.length) return null;
  const entryRaw = isObject(source.entry) ? source.entry : {};
  const entry = str(entryRaw.ui) || UI_ENTRY_DEFAULT;
  const styles = str(entryRaw.styles) || (files.has(UI_STYLES_DEFAULT) ? UI_STYLES_DEFAULT : '');

  if (!/^ui\/[^/]+\.(js|mjs)$/.test(entry)) errors.push(`entry.ui must be a .js or .mjs file at the top of ui/ (got "${entry}")`);
  else if (!files.has(entry)) errors.push(`entry.ui "${entry}" is not in the package`);
  else if (!ESM_EXPORT_RE.test(files.get(entry).toString('utf8'))) {
    errors.push(`entry.ui "${entry}" must be an ES module that exports mount() (build with Vite "lib" mode, format "es")`);
  }
  if (styles) {
    if (!styles.startsWith('ui/') || !styles.endsWith('.css')) errors.push(`entry.styles must be a .css file inside ui/ (got "${styles}")`);
    else if (!files.has(styles)) errors.push(`entry.styles "${styles}" is not in the package`);
  }

  let totalBytes = 0;
  for (const path of areas.ui) {
    const data = files.get(path);
    totalBytes += data.length;
    if (/\.(js|mjs)$/.test(path)) {
      const text = data.toString('utf8');
      if (/document\s*\.\s*cookie/.test(text)) warnings.push(`${path} reads document.cookie; the CRM never exposes session cookies to extensions`);
      if (/\bwindow\s*\.\s*(top|parent)\b/.test(text)) warnings.push(`${path} references window.top/parent`);
    }
    if (path.endsWith('.html') && /<script[^>]+src\s*=\s*["']https?:/i.test(files.get(path).toString('utf8'))) {
      errors.push(`${path} loads a script from an external URL; bundle all scripts into the package`);
    }
  }
  if (totalBytes > MAX_UI_BYTES) errors.push(`ui/ is larger than ${MAX_UI_BYTES / (1024 * 1024)} MB`);

  return { entry, styles, files: [...areas.ui].sort(), totalBytes };
}

/**
 * Sales forms (CRM 3.18.0): salesFlow.opportunityForm, salesFlow.quotationForm and
 * salesFlow.quotationLineGroups. Unknown keys are ignored; the cleaned values are written into `out`.
 *
 *   opportunityForm { title ≤60, subtitle ≤200, linkTypes ⊆ [lead, client], leadOnlySetting (checkbox setting),
 *                     needsLead, emptyText ≤120, savedRoute (POST route),
 *                     startStage { stage, readyStage? } (ids of pipelineStages: the stage is set by the CRM) }
 *   quotationForm   { emptyText ≤120, savedRoute (POST route), acceptedRoute (POST route, CRM 3.19.0),
 *                     paidRoute (POST route, CRM 3.28.0: after each verified payment),
 *                     totalPer { label ≤40, countField (number field of record "quotation"), showSetting (checkbox setting) } }
 *   quotationLineGroups [{ key, title ≤40, fields ⊆ quotationLineFields keys, icon? }] ≤ 12, needs quotationPrefillRoute
 */
const SALES_FORM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const LINK_TYPES = ['lead', 'client'];
const MAX_LINE_GROUPS = 12;
/** Icons a quotation line group may show on its cards (generic shapes, drawn by the CRM UI). */
const LINE_GROUP_ICONS = ['flight', 'hotel', 'car', 'activity', 'document', 'shield', 'place', 'beach', 'event', 'group', 'package', 'service'];

function validateSalesForms(raw, out, { errors, routes, settingsFields, quotationFields, pipelineStages }) {
  const label = (obj, key, max, where) => {
    if (obj[key] === undefined || obj[key] === null) return '';
    if (typeof obj[key] !== 'string') {
      errors.push(`${where}.${key} must be text`);
      return '';
    }
    const value = str(obj[key]);
    if (value.length > max) {
      errors.push(`${where}.${key} is too long (${max} characters at most)`);
      return '';
    }
    return value;
  };
  const route = (obj, where, key = 'savedRoute') => {
    const value = str(obj[key]);
    if (!value) return '';
    if (!routes.some((r) => r.method === 'POST' && r.path === value)) {
      errors.push(`${where}.${key} "${value}" must be a POST route declared in api/routes.json`);
    }
    return value;
  };
  const checkboxSetting = (obj, key, where) => {
    const value = str(obj[key]);
    if (!value) return '';
    const field = settingsFields.find((f) => f && f.key === value);
    if (!field || field.type !== 'checkbox') {
      errors.push(`${where}.${key} "${value}" must be the key of a checkbox field in json/settings.json`);
    }
    return value;
  };

  if (raw.opportunityForm !== undefined) {
    const where = 'salesFlow.opportunityForm';
    if (!isObject(raw.opportunityForm)) {
      errors.push(`${where} must be an object`);
    } else {
      const src = raw.opportunityForm;
      let linkTypes = [...LINK_TYPES];
      if (src.linkTypes !== undefined) {
        const list = Array.isArray(src.linkTypes) ? src.linkTypes.map((t) => str(t).toLowerCase()) : null;
        if (!list || !list.length) errors.push(`${where}.linkTypes must be a non-empty list of lead, client`);
        else if (list.some((t) => !LINK_TYPES.includes(t))) errors.push(`${where}.linkTypes may only contain lead, client`);
        else if (new Set(list).size !== list.length) errors.push(`${where}.linkTypes lists a type twice`);
        else linkTypes = list;
      }
      if (src.needsLead !== undefined && typeof src.needsLead !== 'boolean') errors.push(`${where}.needsLead must be true or false`);
      out.opportunityForm = {
        title: label(src, 'title', 60, where),
        subtitle: label(src, 'subtitle', 200, where),
        linkTypes,
        leadOnlySetting: checkboxSetting(src, 'leadOnlySetting', where),
        needsLead: src.needsLead === true,
        emptyText: label(src, 'emptyText', 120, where),
        savedRoute: route(src, where)
      };
      // startStage: a new opportunity's stage is set by the CRM, not picked by the user —
      // `stage` at first, `readyStage` when the lead's workflow readiness says it is ready.
      if (src.startStage !== undefined) {
        const startWhere = `${where}.startStage`;
        if (!isObject(src.startStage)) {
          errors.push(`${startWhere} must be an object`);
        } else {
          const stageIds = new Set((pipelineStages || []).map((s) => s.id));
          const stageId = (key, required) => {
            const value = str(src.startStage[key]);
            if (!value) {
              if (required) errors.push(`${startWhere}.${key} must be the id of one of pipelineStages`);
              return '';
            }
            if (!stageIds.has(value)) {
              errors.push(`${startWhere}.${key} "${value}" must be the id of one of pipelineStages`);
              return '';
            }
            return value;
          };
          const stage = stageId('stage', true);
          const readyStage = stageId('readyStage', false);
          if (stage) out.opportunityForm.startStage = { stage, readyStage };
        }
      }
    }
  }

  if (raw.quotationForm !== undefined) {
    const where = 'salesFlow.quotationForm';
    if (!isObject(raw.quotationForm)) {
      errors.push(`${where} must be an object`);
    } else {
      const src = raw.quotationForm;
      const form = { emptyText: label(src, 'emptyText', 120, where), savedRoute: route(src, where) };
      const acceptedRoute = route(src, where, 'acceptedRoute');
      if (acceptedRoute) form.acceptedRoute = acceptedRoute;
      // CRM 3.28.0: told after every verified payment on the quotation (e.g. to start a booking).
      const paidRoute = route(src, where, 'paidRoute');
      if (paidRoute) form.paidRoute = paidRoute;
      if (src.totalPer !== undefined) {
        const tw = `${where}.totalPer`;
        if (!isObject(src.totalPer)) {
          errors.push(`${tw} must be an object`);
        } else {
          const totalLabel = label(src.totalPer, 'label', 40, tw);
          const countField = str(src.totalPer.countField);
          if (!totalLabel) errors.push(`${tw}.label is required (40 characters at most)`);
          const field = quotationFields.find((f) => f && f.key === countField);
          if (!countField || !field || field.type !== 'number') {
            errors.push(`${tw}.countField "${countField}" must be the key of a number field declared for record "quotation" in json/fields.json`);
          }
          form.totalPer = { label: totalLabel, countField, showSetting: checkboxSetting(src.totalPer, 'showSetting', tw) };
        }
      }
      out.quotationForm = form;
    }
  }

  if (raw.quotationLineGroups !== undefined) {
    const where = 'salesFlow.quotationLineGroups';
    const list = raw.quotationLineGroups;
    if (!Array.isArray(list) || list.length > MAX_LINE_GROUPS) {
      errors.push(`${where} must be a list of at most ${MAX_LINE_GROUPS} groups`);
    } else if (list.length && !out.quotationPrefillRoute) {
      errors.push(`${where} needs salesFlow.quotationPrefillRoute`);
    } else {
      const lineKeys = (out.quotationLineFields || []).map((f) => f.key);
      const groups = [];
      for (const item of list) {
        const key = str(item && item.key);
        if (!SALES_FORM_KEY_RE.test(key)) { errors.push(`${where}: "${key}" is not a valid key`); continue; }
        if (groups.some((g) => g.key === key)) { errors.push(`${where}: "${key}" is listed twice`); continue; }
        const title = isObject(item) ? str(item.title) : '';
        if (!title || title.length > 40) { errors.push(`${where}.${key}: title is required (40 characters or fewer)`); continue; }
        let fields = lineKeys;
        if (item.fields !== undefined) {
          if (!Array.isArray(item.fields)) { errors.push(`${where}.${key}: fields must be a list`); continue; }
          const keys = [...new Set(item.fields.map((f) => str(f)))];
          const unknown = keys.filter((f) => !lineKeys.includes(f));
          if (unknown.length) { errors.push(`${where}.${key}: "${unknown[0]}" is not one of salesFlow.quotationLineFields`); continue; }
          fields = keys;
        }
        // Optional card icon, from a fixed generic set (drawn by the CRM).
        const icon = isObject(item) && item.icon !== undefined ? str(item.icon) : '';
        if (icon && !LINE_GROUP_ICONS.includes(icon)) { errors.push(`${where}.${key}: icon must be one of ${LINE_GROUP_ICONS.join(', ')}`); continue; }
        groups.push({ key, title, fields: [...fields], ...(icon ? { icon } : {}) });
      }
      if (groups.length) out.quotationLineGroups = groups;
    }
  }
}

function validateDeclarations(source, files, context, errors, warnings, extras) {
  const declaredPaths = isObject(source.declarations) ? source.declarations : {};
  const out = { fields: null, tabs: null, catalog: null, settings: null, navigation: null, actions: null, reports: null, dashboard: null };

  const read = (name) => {
    const custom = str(declaredPaths[name]);
    const path = custom || DECLARATION_FILES[name];
    if (custom && custom !== DECLARATION_FILES[name]) {
      errors.push(`declarations.${name} must be "${DECLARATION_FILES[name]}" (got "${custom}")`);
      return undefined;
    }
    if (!files.has(path)) return undefined;
    const parsed = parseJson(stripBom(files.get(path)), path, errors);
    return parsed === null ? undefined : parsed;
  };

  // Settings first: fields may take their options from settings (optionsFrom).
  const settingsRaw = read('settings');
  if (settingsRaw !== undefined) {
    const r = declarations.validateSettingsDeclaration(settingsRaw, { hasUi: extras.hasUi });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.settings = r.value;
  }
  const settingsFields = new Map(
    ((out.settings && out.settings.fields) || (settingsRaw && Array.isArray(settingsRaw.fields) ? settingsRaw.fields : []))
      .filter((f) => f && typeof f === 'object')
      .map((f) => [String(f.key || '').toLowerCase(), String(f.type || 'text').toLowerCase()])
  );

  const fieldsRaw = read('fields');
  if (fieldsRaw !== undefined) {
    const r = declarations.validateFieldsDeclaration(fieldsRaw, {
      requestTypeKey: extras.requestTypeKey,
      knownRequestTypeKeys: context.knownRequestTypeKeys || new Set(),
      settingsFields
    });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.fields = r.value;
  }

  const catalogRaw = read('catalog');
  if (catalogRaw !== undefined) {
    const r = declarations.validateCatalogDeclaration(catalogRaw, { builtinValues: context.builtinCatalogValues || {} });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.catalog = r.value;
  }

  const tabsRaw = read('tabs');
  if (tabsRaw !== undefined) {
    const r = declarations.validateTabsDeclaration(tabsRaw, {
      fieldGroups: out.fields,
      modelNames: extras.modelNames,
      modelFields: extras.modelFields,
      hasUi: extras.hasUi,
      permissionKeys: extras.permissionKeys,
      routes: extras.routes || []
    });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.tabs = r.value;
  }

  const navigationRaw = read('navigation');
  if (navigationRaw !== undefined) {
    const r = declarations.validateNavigationDeclaration(navigationRaw, {
      hasUi: extras.hasUi,
      permissionKeys: extras.permissionKeys
    });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.navigation = r.value;
  }

  const actionsRaw = read('actions');
  if (actionsRaw !== undefined) {
    const r = declarations.validateActionsDeclaration(actionsRaw, {
      routes: extras.routes || [],
      hasUi: extras.hasUi,
      permissionKeys: extras.permissionKeys
    });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.actions = r.value;
  }

  // The extension's Reports page (CRM 3.29.0).
  const reportsRaw = read('reports');
  if (reportsRaw !== undefined) {
    const r = declarations.validateReportsDeclaration(reportsRaw, {
      routes: extras.routes || [],
      permissionKeys: extras.permissionKeys
    });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.reports = r.value;
  }

  // The extension's Dashboard (CRM 3.31.0), same format as reports.json.
  const dashboardRaw = read('dashboard');
  if (dashboardRaw !== undefined) {
    const r = declarations.validateDashboardDeclaration(dashboardRaw, {
      routes: extras.routes || [],
      permissionKeys: extras.permissionKeys
    });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    out.dashboard = r.value;
  }

  return out;
}

/* ------------------------------------------------------------ definition */

/**
 * Validate the parsed package.
 *
 * @param {object} manifest            parsed crm-extension.json
 * @param {object|null} requestType    parsed request-type.json, if shipped
 * @param {object} context
 * @param {Set<string>} context.builtinIds            ids that can never be uploaded over
 * @param {Set<string>} context.takenPipelineKeys     pipeline keys used by other extensions
 * @param {Set<string>} context.systemRequestTypeKeys keys with a system seed (product, project_software)
 * @param {Set<string>} [context.knownRequestTypeKeys] every request type key the tenant knows
 * @param {{ id: string, version: string } | null} context.existingUpload same id already installed
 * @param {string} [context.crmVersion]              running plugin version (defaults to manifest.json)
 * @param {Map<string, Buffer>} [files]              every package file by relative path (v2)
 */
function validatePackageDefinition(manifest, requestType, context, files = new Map()) {
  const errors = [];
  const warnings = [];
  const source = isObject(manifest) ? manifest : null;
  if (!source) {
    return { ok: false, errors: ['crm-extension.json must be a JSON object'], warnings, definition: null };
  }

  const areas = { root: [], json: [], ui: [], api: [] };
  for (const path of files.keys()) {
    const area = path.includes('/') ? path.split('/')[0] : 'root';
    if (areas[area]) areas[area].push(path);
  }
  const hasFolders = areas.json.length + areas.ui.length + areas.api.length > 0;

  const manifestVersion = Number(source.manifestVersion);
  if (manifestVersion !== 1 && manifestVersion !== 2) errors.push('manifestVersion must be 1 or 2');
  if (manifestVersion === 1 && hasFolders) {
    errors.push('manifestVersion 2 is required for a package with json/, ui/ or api/ folders');
  }

  const id = str(source.id).toLowerCase();
  if (!ID_RE.test(id)) {
    errors.push('id must be 3–32 characters: lowercase letters, numbers, "-" or "_", starting with a letter');
  } else if (context.builtinIds.has(id)) {
    errors.push(`id "${id}" belongs to a built-in extension and cannot be replaced`);
  }

  const name = str(source.name);
  if (name.length < 2 || name.length > 60) errors.push('name must be 2–60 characters');

  const version = str(source.version);
  if (!SEMVER_RE.test(version)) errors.push('version must be a strict semantic version such as 1.0.0');
  if (context.existingUpload && SEMVER_RE.test(version)) {
    if (compareSemver(version, context.existingUpload.version) <= 0) {
      errors.push(
        `version ${version} must be higher than the installed ${context.existingUpload.version} for "${id}"`
      );
    }
  }

  const tagline = str(source.tagline);
  if (tagline.length > 80) errors.push('tagline must be 80 characters or fewer');
  const description = str(source.description);
  if (description.length > 600) errors.push('description must be 600 characters or fewer');
  if (!description) warnings.push('description is empty; the card will show no explanation');

  const publisher = isObject(source.publisher) ? str(source.publisher.name) : str(source.publisher);
  const publisherUrl = isObject(source.publisher) ? str(source.publisher.url) : '';
  const contact = isObject(source.publisher) ? str(source.publisher.contact) : '';

  const icon = str(source.icon) || 'blocks';
  if (!ALLOWED_ICONS.includes(icon)) {
    errors.push(`icon "${icon}" is not available; use one of ${ALLOWED_ICONS.join(', ')}`);
  }
  const accent = str(source.accent) || 'slate';
  if (!ALLOWED_ACCENTS.includes(accent)) {
    errors.push(`accent "${accent}" is not available; use one of ${ALLOWED_ACCENTS.join(', ')}`);
  }

  if (source.isDefault === true) errors.push('an uploaded extension cannot be the default');

  const requestTypeKey = str(source.requestTypeKey).toLowerCase();
  if (!KEY_RE.test(requestTypeKey)) {
    errors.push('requestTypeKey must be 2–60 characters: lowercase letters, numbers or "_", starting with a letter');
  }
  const requestTypeName = str(source.requestTypeName);
  if (!requestTypeName || requestTypeName.length > 120) {
    errors.push('requestTypeName is required (max 120 characters)');
  }

  // Request type form: a system seed, an inline list, or request-type.json.
  let requestTypeFields = null;
  const inlineFields = Array.isArray(source.requestTypeFields) ? source.requestTypeFields : null;
  const fileFields =
    requestType && typeof requestType === 'object'
      ? Array.isArray(requestType.fields)
        ? requestType.fields
        : Array.isArray(requestType)
          ? requestType
          : null
      : null;
  const hasSystemSeed = context.systemRequestTypeKeys.has(requestTypeKey);
  if (fileFields || inlineFields) {
    // The shared normaliser expects the optional strings to be present.
    const prepared = (fileFields || inlineFields).map((field) => ({
      placeholder: '',
      helpText: '',
      ...(field && typeof field === 'object' ? field : {})
    }));
    const checked = validateFields(prepared);
    for (const message of checked.errors) errors.push(`request type form: ${message}`);
    if (!checked.fields.length) errors.push('request type form must declare at least one field');
    requestTypeFields = checked.fields;
    if (hasSystemSeed) {
      warnings.push(`requestTypeKey "${requestTypeKey}" has a built-in form; the shipped fields replace it for new tenants only`);
    }
  } else if (!hasSystemSeed) {
    errors.push(
      `requestTypeKey "${requestTypeKey}" has no built-in form — ship request-type.json with its fields, or reuse "product" / "project_software"`
    );
  }

  const pipelineKey = str(source.pipelineKey).toLowerCase();
  if (!KEY_RE.test(pipelineKey)) {
    errors.push('pipelineKey must be 2–60 characters: lowercase letters, numbers or "_", starting with a letter');
  } else if (context.takenPipelineKeys.has(pipelineKey)) {
    errors.push(`pipelineKey "${pipelineKey}" is already used by another extension`);
  }
  const pipelineName = str(source.pipelineName) || `${name} Pipeline`;
  if (pipelineName.length > 120) errors.push('pipelineName must be 120 characters or fewer');
  const pipelineDescription = str(source.pipelineDescription);
  const pipelineStages = validateStages(source.pipelineStages, errors);

  const hiddenRaw = Array.isArray(source.hiddenModules) ? source.hiddenModules : [];
  const hiddenModules = [];
  for (const raw of hiddenRaw) {
    const moduleId = str(raw).toLowerCase();
    if (!ALL_CORE_MODULES.includes(moduleId)) {
      errors.push(`hiddenModules contains an unknown module "${moduleId}"; valid ids: ${ALL_CORE_MODULES.join(', ')}`);
    } else if (!HIDEABLE_MODULES.includes(moduleId)) {
      errors.push(`hiddenModules cannot hide "${moduleId}"`);
    } else if (!hiddenModules.includes(moduleId)) {
      hiddenModules.push(moduleId);
    }
  }

  const conversionsRaw = isObject(source.conversions) ? source.conversions : {};
  const conversions = {
    salesOrder: conversionsRaw.salesOrder === true,
    invoice: conversionsRaw.invoice === true
  };
  if (conversions.salesOrder && hiddenModules.includes('sales-orders')) {
    errors.push('conversions.salesOrder cannot be true while sales-orders is hidden');
  }
  if (!conversions.salesOrder && !conversions.invoice) {
    warnings.push('neither conversion is enabled; won opportunities will offer no document action');
  }

  const highlights = (Array.isArray(source.highlights) ? source.highlights : [])
    .map((h) => str(h))
    .filter(Boolean)
    .slice(0, 5);

  /* ------------------------------------------------------------- v2 only */
  let v2 = null;
  if (manifestVersion === 2) {
    const compatibility = isObject(source.compatibility) ? str(source.compatibility.crm) : '';
    const crmVersion = context.crmVersion || currentCrmVersion();
    if (compatibility) {
      if (!isValidRange(compatibility)) errors.push(`compatibility.crm "${compatibility}" is not a valid version range`);
      else if (satisfies(crmVersion, compatibility) === false) {
        errors.push(`compatibility.crm "${compatibility}" is not satisfied by this CRM (v${crmVersion})`);
      }
    }

    const capabilities = validateCapabilities(source, files, areas, errors, warnings);
    const permissions = ID_RE.test(id) ? validatePermissionsSection(source, id, errors) : { uses: [], defines: [], allKeys: new Set(CRM_MANIFEST_PERMISSIONS) };
    const ui = validateUi(source, files, areas, errors, warnings);

    const entryRaw = isObject(source.entry) ? source.entry : {};
    const entryApi = str(entryRaw.api) || (files.has(API_ENTRY_DEFAULT) ? API_ENTRY_DEFAULT : '');
    if (entryApi && !entryApi.startsWith('api/')) errors.push(`entry.api must be inside api/ (got "${entryApi}")`);
    const backendResult = validateBackend(files, {
      permissionKeys: permissions.allKeys,
      entryApi,
      parseJson
    });
    errors.push(...backendResult.errors);
    warnings.push(...backendResult.warnings);
    const backend = backendResult.backend;

    const decl = validateDeclarations(source, files, context, errors, warnings, {
      requestTypeKey,
      modelNames: new Set((backend?.models || []).map((m) => m.name)),
      modelFields: new Map((backend?.models || []).map((m) => [m.name, new Set(m.fields.map((f) => f.key))])),
      hasUi: Boolean(ui) && capabilities.includes('ui.mount'),
      permissionKeys: permissions.allKeys,
      routes: (backend && backend.routes) || []
    });

    // Every route should map to an allow-listed outbound domain list if it calls out.
    const outboundRaw = isObject(source.network) && Array.isArray(source.network.allowedHosts) ? source.network.allowedHosts : [];
    const allowedHosts = [];
    for (const item of outboundRaw) {
      const host = str(item).toLowerCase();
      if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) errors.push(`network.allowedHosts: "${host}" is not a host name`);
      else if (!allowedHosts.includes(host)) allowedHosts.push(host);
    }
    if (allowedHosts.length && !backend?.requiresTrust) warnings.push('network.allowedHosts is set but the package ships no backend code');

    // Scheduled jobs (CRM 3.33.0): [{ route: POST route, every: "daily" }] ≤ 5, run by the CRM as the system.
    let schedules = null;
    if (source.schedules !== undefined) {
      if (!Array.isArray(source.schedules) || source.schedules.length > 5) {
        errors.push('schedules must be a list of at most 5 jobs');
      } else {
        schedules = [];
        for (const [index, item] of source.schedules.entries()) {
          const route = str(isObject(item) ? item.route : '');
          const every = str(isObject(item) ? item.every : '') || 'daily';
          if (!((backend && backend.routes) || []).some((r) => r.method === 'POST' && r.path === route)) {
            errors.push(`schedules[${index}].route "${route}" must be a POST route declared in api/routes.json`);
          } else if (every !== 'daily') {
            errors.push(`schedules[${index}].every must be "daily"`);
          } else schedules.push({ route, every });
        }
        if (!schedules.length) schedules = null;
      }
    }

    // Lead workflow contract: the extension tells the CRM when a lead is ready (readinessRoute,
    // POST { leadIds } → { leads: { <id>: { ready, reasons, summary } } }) and whether its own
    // requirement tab replaces the CRM's Commercial Requirement tab. The CRM decides what "ready" does.
    let leadWorkflow = null;
    if (source.leadWorkflow !== undefined) {
      if (!isObject(source.leadWorkflow)) {
        errors.push('leadWorkflow must be an object');
      } else {
        const readinessRoute = str(source.leadWorkflow.readinessRoute);
        if (readinessRoute && !((backend && backend.routes) || []).some((r) => r.method === 'POST' && r.path === readinessRoute)) {
          errors.push(`leadWorkflow.readinessRoute "${readinessRoute}" must be a POST route declared in api/routes.json`);
        }
        leadWorkflow = {
          readinessRoute,
          replacesCommercialRequirement: source.leadWorkflow.replacesCommercialRequirement === true
        };
        // CRM 3.32.0: before lead field values are saved the extension may refuse them
        // (POST { leadId, values, changed } → { errors: [text] }), e.g. dates its own records depend on.
        const valuesCheckRoute = str(source.leadWorkflow.valuesCheckRoute);
        if (valuesCheckRoute) {
          if (!((backend && backend.routes) || []).some((r) => r.method === 'POST' && r.path === valuesCheckRoute)) {
            errors.push(`leadWorkflow.valuesCheckRoute "${valuesCheckRoute}" must be a POST route declared in api/routes.json`);
          } else leadWorkflow.valuesCheckRoute = valuesCheckRoute;
        }
      }
    }

    // Sales flow contract: the extension suggests what a new opportunity / quotation starts with
    // (POST { leadId } → opportunity: { title, expectedCloseDate, lines, values, warnings };
    //  quotation: { lines, sections, warnings }). The CRM cleans the answer and the agent saves the form.
    let salesFlow = null;
    if (source.salesFlow !== undefined) {
      if (!isObject(source.salesFlow)) {
        errors.push('salesFlow must be an object');
      } else {
        salesFlow = {};
        // quotationDatesRoute (CRM 3.32.0): POST { leadId, opportunityId, leadValues? } →
        //   { issueDateMin?, validTillMax?, validTillMaxLabel? }, enforced on every quotation save.
        for (const key of ['opportunityPrefillRoute', 'quotationPrefillRoute', 'invoicePrefillRoute', 'quotationDatesRoute']) {
          const route = str(source.salesFlow[key]);
          if (!route) continue;
          if (!((backend && backend.routes) || []).some((r) => r.method === 'POST' && r.path === route)) {
            errors.push(`salesFlow.${key} "${route}" must be a POST route declared in api/routes.json`);
          }
          salesFlow[key] = route;
        }
        // Page layout switches: the extension's own panels replace the opportunity's product lines;
        // quotation lines come only from the extension (agent enters price and tax).
        if (salesFlow.opportunityPrefillRoute && source.salesFlow.hideOpportunityLines === true) salesFlow.hideOpportunityLines = true;
        if (salesFlow.quotationPrefillRoute && source.salesFlow.lockQuotationLines === true) salesFlow.lockQuotationLines = true;
        // Fixed lines (3.22.0): lines come only from the extension's records; users change price and tax only.
        if (source.salesFlow.fixedLines !== undefined) {
          if (typeof source.salesFlow.fixedLines !== 'boolean') errors.push('salesFlow.fixedLines must be true or false');
          else if (source.salesFlow.fixedLines) {
            if (!salesFlow.lockQuotationLines && !salesFlow.hideOpportunityLines) errors.push('salesFlow.fixedLines needs lockQuotationLines or hideOpportunityLines');
            else salesFlow.fixedLines = true;
          }
        }
        // The quotation's text sections are not edited on the create page (they still come from the prefill).
        if (source.salesFlow.hideQuotationSections !== undefined) {
          if (typeof source.salesFlow.hideQuotationSections !== 'boolean') errors.push('salesFlow.hideQuotationSections must be true or false');
          else if (source.salesFlow.hideQuotationSections) salesFlow.hideQuotationSections = true;
        }
        // Wording for the opportunity / quotation pages (3.23.0): { lines, line, proposedLines, subtotal, commercialSummary }.
        if (source.salesFlow.terms !== undefined) {
          const raw = source.salesFlow.terms;
          if (!isObject(raw)) errors.push('salesFlow.terms must be an object');
          else {
            const terms = {};
            for (const key of ['lines', 'line', 'proposedLines', 'subtotal', 'commercialSummary']) {
              if (raw[key] === undefined) continue;
              const value = str(raw[key]);
              if (!value || value.length > 40) errors.push(`salesFlow.terms.${key} must be 1–40 characters`);
              else terms[key] = value;
            }
            if (Object.keys(terms).length) salesFlow.terms = terms;
          }
        }
        // No shipping (services, not goods): no shipping charge on opportunities or quotations.
        // hideRecurringInvoices / hideInvoiceTemplates: no Recurring Profiles / Templates button on the
        // invoice list (existing profiles and templates are kept).
        // lockOpportunityOnAccept: once a quotation of an opportunity is accepted the other open ones close
        //   (status Closed) and the opportunity's commercial lines are locked.
        // lockConvertedLead: no new quotation from a lead converted into a client.
        // completeOpportunitiesOnConversion: the converted lead's other open opportunities move to Won.
        // clientQuotationStartsWithLead: Client → Create Quotation starts a new lead (enquiry) for the client.
        // bookingAfterAdvance: shows Settings → General "Allow Booking Creation After Advance Payment".
        // lockWonLead (3.34.0): a Won or converted lead is read-only for users (UI and server).
        // hideInvoiceWriteOff (3.39.0): no Write off on invoices (button hidden, server refuses).
        for (const key of ['hideShipping', 'lockOpportunityContact', 'invoiceFromQuotation', 'hideRecurringInvoices', 'hideInvoiceTemplates', 'hideInvoiceWriteOff', 'lockOpportunityOnAccept', 'lockConvertedLead', 'completeOpportunitiesOnConversion', 'clientQuotationStartsWithLead', 'bookingAfterAdvance', 'lockWonLead']) {
          if (source.salesFlow[key] === undefined) continue;
          if (typeof source.salesFlow[key] !== 'boolean') errors.push(`salesFlow.${key} must be true or false`);
          else if (source.salesFlow[key]) salesFlow[key] = true;
        }
        // Quotation for a client (3.34.0): which clients may get one, a picker (e.g. travellers) shown before,
        // and a start route that returns the lead / opportunity the quotation belongs to.
        if (source.salesFlow.clientQuotation !== undefined) {
          const cq = source.salesFlow.clientQuotation;
          const routes = (backend && backend.routes) || [];
          const has = (method, path) => routes.some((r) => r.method === method && r.path === path);
          if (!isObject(cq)) errors.push('salesFlow.clientQuotation must be an object');
          else {
            const eligibleRoute = str(cq.eligibleRoute);
            const pickerRoute = str(cq.pickerRoute);
            const startRoute = str(cq.startRoute);
            const oneParam = (p) => (p.match(/:[a-z][a-z0-9_]*/gi) || []).length === 1;
            if (!has('GET', eligibleRoute)) errors.push(`salesFlow.clientQuotation.eligibleRoute "${eligibleRoute}" must be a GET route declared in api/routes.json`);
            if (!has('GET', pickerRoute) || !oneParam(pickerRoute)) errors.push(`salesFlow.clientQuotation.pickerRoute "${pickerRoute}" must be a GET route with one ":param" (the client id)`);
            if (!has('POST', startRoute) || !oneParam(startRoute)) errors.push(`salesFlow.clientQuotation.startRoute "${startRoute}" must be a POST route with one ":param" (the client id)`);
            const notEligibleText = str(cq.notEligibleText);
            if (notEligibleText.length > 200) errors.push('salesFlow.clientQuotation.notEligibleText is too long (200 characters at most)');
            salesFlow.clientQuotation = { eligibleRoute, pickerRoute, startRoute, ...(notEligibleText ? { notEligibleText } : {}) };
          }
        }
        // Service invoice PDF: { layout: 'service', title?, summaryTitle?, linesTitle?, footer? }. The
        // invoice PDF prints services (Rate / Tax / Amount, no quantity, unit, product code or shipping), the
        // extension's invoice summary (invoicePrefillRoute) and the payments (advance, paid, balance, status).
        if (source.salesFlow.invoicePrint !== undefined) {
          const ip = source.salesFlow.invoicePrint;
          if (!isObject(ip) || ip.layout !== 'service') errors.push('salesFlow.invoicePrint must be an object with layout "service"');
          else {
            const invoicePrint = { layout: 'service' };
            for (const [key, max] of [['title', 40], ['summaryTitle', 40], ['linesTitle', 40], ['footer', 200]]) {
              const value = str(ip[key]);
              if (value.length > max) errors.push(`salesFlow.invoicePrint.${key} is too long (${max} characters at most)`);
              else if (value) invoicePrint[key] = value;
            }
            salesFlow.invoicePrint = invoicePrint;
          }
        }
        // Where the source data is edited: a lead tab of this extension ({ label, leadTab }).
        if (source.salesFlow.requirementLink !== undefined) {
          const link = source.salesFlow.requirementLink;
          const label = isObject(link) ? str(link.label) : '';
          const leadTab = isObject(link) ? str(link.leadTab) : '';
          if (!label || label.length > 40) errors.push('salesFlow.requirementLink.label is required (40 characters or fewer)');
          else if (!/^[a-z][a-z0-9_-]{1,59}$/.test(leadTab)) errors.push('salesFlow.requirementLink.leadTab must be a lead tab id');
          else salesFlow.requirementLink = { label, leadTab };
        }
        // Every new quotation must belong to an opportunity (tenant setting can override).
        if (source.salesFlow.requireOpportunityForQuotation !== undefined) {
          if (typeof source.salesFlow.requireOpportunityForQuotation !== 'boolean') errors.push('salesFlow.requireOpportunityForQuotation must be true or false');
          else if (source.salesFlow.requireOpportunityForQuotation) salesFlow.requireOpportunityForQuotation = true;
        }
        // Page header text for the quotation page.
        const LABEL_MAX = {
          quotationPageTitle: 60,
          quotationPageSubtitle: 200,
          quotationSummaryTitle: 40,
          quotationLinesTitle: 60,
          quotationLinesSubtitle: 200,
          quotationAddLineLabel: 30
        };
        for (const [key, max] of Object.entries(LABEL_MAX)) {
          const value = str(source.salesFlow[key]);
          if (value.length > max) errors.push(`salesFlow.${key} is too long (${max} characters at most)`);
          else if (value) salesFlow[key] = value;
        }
        // Extra columns on quotation lines: [{ key, label, type: select|text, options, maxLength, print }].
        if (source.salesFlow.quotationLineFields !== undefined) {
          const raw = source.salesFlow.quotationLineFields;
          if (!Array.isArray(raw) || raw.length > 10) {
            errors.push('salesFlow.quotationLineFields must be a list of at most 10 columns');
          } else {
            const fields = [];
            for (const item of raw) {
              const key = str(item && item.key);
              const label = str(item && item.label);
              const type = str(item && item.type) || 'text';
              if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) { errors.push(`salesFlow.quotationLineFields: "${key}" is not a valid key`); continue; }
              if (fields.some((f) => f.key === key)) { errors.push(`salesFlow.quotationLineFields: "${key}" is listed twice`); continue; }
              if (!label || label.length > 40) { errors.push(`salesFlow.quotationLineFields.${key}: label is required (40 characters or fewer)`); continue; }
              if (type !== 'select' && type !== 'text') { errors.push(`salesFlow.quotationLineFields.${key}: type must be select or text`); continue; }
              const field = { key, label, type, print: item.print === true };
              if (type === 'select') {
                const options = Array.isArray(item.options) ? [...new Set(item.options.map((o) => str(o)).filter((o) => o && o.length <= 60))] : [];
                if (!options.length || options.length > 20) { errors.push(`salesFlow.quotationLineFields.${key}: a select needs 1–20 options`); continue; }
                field.options = options;
                if (item.tones !== undefined) {
                  const TONES = ['success', 'info', 'warning', 'danger', 'neutral'];
                  if (!item.tones || typeof item.tones !== 'object' || Array.isArray(item.tones)) {
                    errors.push(`salesFlow.quotationLineFields.${key}: tones must be an object`);
                  } else {
                    const tones = {};
                    for (const [option, tone] of Object.entries(item.tones)) {
                      if (!options.includes(option) || !TONES.includes(tone)) {
                        errors.push(`salesFlow.quotationLineFields.${key}: tone "${tone}" for "${option}" is not valid`);
                      } else tones[option] = tone;
                    }
                    if (Object.keys(tones).length) field.tones = tones;
                  }
                }
              } else {
                const max = Number(item.maxLength);
                field.maxLength = Number.isInteger(max) && max > 0 && max <= 200 ? max : 200;
              }
              fields.push(field);
            }
            if (fields.length && salesFlow.quotationPrefillRoute) salesFlow.quotationLineFields = fields;
          }
        }
        validateSalesForms(source.salesFlow, salesFlow, {
          errors,
          routes: (backend && backend.routes) || [],
          settingsFields: (decl && decl.settings && Array.isArray(decl.settings.fields)) ? decl.settings.fields : [],
          quotationFields: (decl && decl.fields && Array.isArray(decl.fields.quotation) ? decl.fields.quotation : []).flatMap((g) => g.fields || []),
          pipelineStages
        });
        if (!Object.keys(salesFlow).length) salesFlow = null;
      }
    }

    v2 = {
      compatibility: compatibility || '',
      capabilities,
      permissions: { uses: permissions.uses, defines: permissions.defines },
      entry: { ui: ui?.entry || '', styles: ui?.styles || '', api: backend?.entry || '' },
      ui,
      backend,
      declarations: decl,
      network: { allowedHosts },
      leadWorkflow,
      salesFlow,
      schedules,
      requiresTrust: Boolean(backend?.requiresTrust)
    };
  }

  if (errors.length) return { ok: false, errors, warnings, definition: null };

  const definition = {
    id,
    name,
    tagline,
    description,
    icon,
    accent,
    version,
    publisher: publisher || 'Uploaded package',
    publisherUrl,
    contact,
    isDefault: false,
    isInternal: false,
    requestTypeKey,
    requestTypeName,
    requestTypeFields,
    pipelineKey,
    pipelineName,
    pipelineDescription,
    pipelineStages,
    adoptDefaultPipeline: false,
    hiddenModules,
    conversions,
    highlights,
    manifestVersion,
    compatibility: v2?.compatibility || '',
    capabilities: v2?.capabilities || [],
    permissions: v2?.permissions || { uses: [], defines: [] },
    entry: v2?.entry || { ui: '', styles: '', api: '' },
    ui: v2?.ui || null,
    backend: v2?.backend || null,
    declarations: v2?.declarations || { fields: null, tabs: null, catalog: null, settings: null, navigation: null, actions: null, reports: null, dashboard: null },
    network: v2?.network || { allowedHosts: [] },
    leadWorkflow: v2?.leadWorkflow || null,
    // Scheduled jobs (CRM 3.33.0); only present when declared.
    ...(v2?.schedules ? { schedules: v2.schedules } : {}),
    salesFlow: v2?.salesFlow || null,
    requiresTrust: Boolean(v2?.requiresTrust)
  };

  return { ok: true, errors: [], warnings, definition, summary: summarize(definition, files) };
}

/** Counts shown on the upload review screen. */
function summarize(definition, files) {
  const decl = definition.declarations || {};
  const countFields = (groups) => Object.values(groups || {}).reduce((n, list) => n + list.reduce((m, g) => m + g.fields.length, 0), 0);
  const countTabs = (pages) => Object.values(pages || {}).reduce((n, list) => n + list.length, 0);
  const countCatalog = (lists) => Object.values(lists || {}).reduce((n, list) => n + list.values.length, 0);
  return {
    manifestVersion: definition.manifestVersion,
    capabilities: definition.capabilities,
    requiresTrust: definition.requiresTrust,
    files: files.size,
    uiFiles: definition.ui?.files?.length || 0,
    apiFiles: definition.backend?.files?.length || 0,
    fields: countFields(decl.fields),
    tabs: countTabs(decl.tabs),
    catalogValues: countCatalog(decl.catalog),
    settingsFields: decl.settings?.fields?.length || 0,
    pages: decl.navigation?.pages?.length || 0,
    routes: definition.backend?.routes?.length || 0,
    models: definition.backend?.models?.length || 0,
    definedPermissions: definition.permissions?.defines?.length || 0,
    allowedHosts: definition.network?.allowedHosts || []
  };
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/** Content type for serving a package file. */
function contentTypeFor(path) {
  const ext = String(path).slice(String(path).lastIndexOf('.')).toLowerCase();
  return (
    {
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.cjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf'
    }[ext] || 'application/octet-stream'
  );
}

module.exports = {
  PACKAGE_MANIFEST,
  REQUEST_TYPE_FILE,
  CAPABILITIES,
  DECLARATION_FILES,
  AREA_EXTENSIONS,
  MAX_FILES,
  MAX_UI_BYTES,
  pickPackageFiles,
  parseJson,
  validatePackageDefinition,
  summarize,
  compareSemver,
  contentTypeFor,
  currentCrmVersion
};
