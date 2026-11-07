'use strict';

/**
 * Validation for the declarative part of a full CRM workspace extension
 * package (`json/` folder, manifestVersion 2).
 *
 *   json/fields.json      extra fields on core records (lead, client, opportunity, ticket, quotation)
 *   json/tabs.json        detail-page tabs, dashboard widgets
 *   json/catalog.json     values merged into the Settings lists (statuses, tags, …)
 *   json/settings.json    the extension's own settings form
 *   json/navigation.json  module pages inside the CRM navigation
 *
 * Every validator takes the parsed JSON plus a context and returns
 * `{ value, errors, warnings }`. `value` is the normalised declaration the CRM
 * stores and renders; it is null when there are errors. Messages are prefixed
 * with the file name so the upload dialog can show them as-is.
 */

const { ALLOWED_ICONS } = require('../crm-extensions');

/** Core records that carry an `extension` bag where declared fields are stored. */
const FIELD_RECORD_TYPES = ['lead', 'client', 'opportunity', 'ticket', 'quotation'];

const DECLARATION_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'currency',
  'date',
  'checkbox',
  'select',
  'radio',
  'multiselect',
  'user'
];
const CHOICE_FIELD_TYPES = ['select', 'radio', 'multiselect'];

/** Detail pages that accept declared tabs → record type they show (null = none). */
const TAB_PAGES = {
  leadDetail: 'lead',
  clientDetail: 'client',
  opportunityDetail: 'opportunity',
  ticketDetail: 'ticket',
  // Contact detail page: extension sections drawn by the extension (kind "mount" only).
  contactDetail: null,
  // Quotation detail page: extension sections drawn by the extension (kind "mount" only).
  quotationDetail: null,
  dashboard: null
};
const TAB_KINDS = ['fields', 'records', 'readonly', 'mount'];
const WIDGET_WIDTHS = ['full', 'half', 'third'];

/** catalog.json list name → settings key it merges into. */
const CATALOG_LISTS = {
  leadStatuses: 'lead_statuses',
  leadSources: 'lead_sources',
  leadTypes: 'lead_types',
  leadPriorities: 'lead_priorities',
  leadTags: 'lead_tags',
  activityTypes: 'activity_types',
  clientCategories: 'client_categories',
  clientStatuses: 'client_statuses',
  projectStatuses: 'project_statuses',
  projectPriorities: 'project_priorities',
  projectCategories: 'project_categories',
  projectTags: 'project_tags',
  projectLabels: 'project_labels',
  taskStatuses: 'task_statuses',
  taskPriorities: 'task_priorities',
  expenseCategories: 'expense_categories'
};

/**
 * `list` = editable list of text values (rendered like Settings → Leads → Lead Sources),
 * `json` = structured data an extension UI edits itself (hidden from the generic form).
 */
const SETTINGS_FIELD_TYPES = ['text', 'textarea', 'number', 'checkbox', 'select', 'list', 'json'];
const FIELD_WIDTHS = ['quarter', 'third', 'half', 'full'];
const FORMULA_OPS = ['sum', 'days_between', 'month_of'];
const MAX_LIST_ITEMS = 500;
const MAX_JSON_SETTING_BYTES = 256 * 1024;

const KEY_RE = /^[a-z][a-z0-9_]{1,59}$/;
const ID_RE = /^[a-z][a-z0-9_-]{1,59}$/;
const SLOT_RE = /^[a-z][a-z0-9_.-]{1,79}$/;
const DOTTED_PATH_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+){0,6}$/;
const RESERVED_WORDS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_FIELDS_PER_RECORD = 40;
const MAX_OPTIONS = 100;
const MAX_TABS_PER_PAGE = 10;
const MAX_CATALOG_VALUES = 50;
const MAX_SETTINGS_FIELDS = 40;
const MAX_PAGES = 12;

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function result(value, errors, warnings) {
  return { value: errors.length ? null : value, errors, warnings };
}

/* --------------------------------------------------------------- field items */

function normalizeOptions(raw, where, errors) {
  if (!Array.isArray(raw) || !raw.length) {
    errors.push(`${where} needs at least one option`);
    return [];
  }
  if (raw.length > MAX_OPTIONS) errors.push(`${where} has more than ${MAX_OPTIONS} options`);
  const seen = new Set();
  const options = [];
  raw.forEach((item, index) => {
    const label = isObject(item) ? str(item.label) || str(item.value) : str(item);
    const value = isObject(item) ? str(item.value) || label : label;
    if (!label || !value) {
      errors.push(`${where} option ${index + 1} needs a label`);
      return;
    }
    if (label.length > 120 || value.length > 120) errors.push(`${where} option "${label}" is longer than 120 characters`);
    const dedupe = value.toLowerCase();
    if (seen.has(dedupe)) {
      errors.push(`${where} has a duplicate option "${value}"`);
      return;
    }
    seen.add(dedupe);
    options.push({ label, value });
  });
  return options;
}

/**
 * Normalise one declared field. Shared by fields.json, settings.json (with its
 * own type list) and backend JSON models (through the backend schema).
 */
function normalizeField(raw, index, where, errors, options = {}) {
  const allowedTypes = options.allowedTypes || DECLARATION_FIELD_TYPES;
  const source = isObject(raw) ? raw : {};
  const key = str(source.key).toLowerCase();
  const label = str(source.label);
  const type = str(source.type).toLowerCase() || 'text';
  const tag = `${where} field ${index + 1}${key ? ` ("${key}")` : ''}`;

  if (!KEY_RE.test(key) || RESERVED_WORDS.has(key)) {
    errors.push(`${tag}: key must be 2–60 characters: lowercase letters, numbers or "_", starting with a letter`);
  }
  if (!label || label.length > 80) errors.push(`${tag}: label is required (max 80 characters)`);
  if (!allowedTypes.includes(type)) errors.push(`${tag}: type "${type}" is not one of ${allowedTypes.join(', ')}`);

  const field = {
    key,
    label,
    type,
    required: source.required === true,
    placeholder: str(source.placeholder).slice(0, 120),
    helpText: str(source.helpText).slice(0, 240),
    options: [],
    default: undefined,
    min: undefined,
    max: undefined,
    showInList: source.showInList === true,
    /** Layout hint: share of the form row ('quarter', 'third' default, 'half', 'full'). */
    width: FIELD_WIDTHS.includes(str(source.width).toLowerCase()) ? str(source.width).toLowerCase() : 'third',
    readOnly: source.readOnly === true,
    hidden: source.hidden === true,
    optionsFrom: null,
    formula: null
  };
  // Team-only value: never sent to client (portal) users. Set only when true, so other fields keep their shape.
  if (source.internal === true) field.internal = true;
  if (source.width !== undefined && !FIELD_WIDTHS.includes(str(source.width).toLowerCase())) {
    errors.push(`${tag}: width must be one of ${FIELD_WIDTHS.join(', ')}`);
  }

  if (source.optionsFrom !== undefined && source.optionsFrom !== null) {
    if (!CHOICE_FIELD_TYPES.includes(type)) {
      errors.push(`${tag}: optionsFrom is only allowed on select, radio or multiselect fields`);
    } else {
      field.optionsFrom = normalizeOptionsFrom(source.optionsFrom, tag, errors);
    }
  }

  if (CHOICE_FIELD_TYPES.includes(type)) {
    // Dynamic options (optionsFrom) may come with static fallbacks or none at all.
    field.options =
      field.optionsFrom && (!Array.isArray(source.options) || !source.options.length)
        ? []
        : normalizeOptions(source.options, tag, errors);
  } else if (Array.isArray(source.options) && source.options.length) {
    errors.push(`${tag}: options are only allowed on select, radio or multiselect fields`);
  }

  if (source.formula !== undefined && source.formula !== null) {
    field.formula = normalizeFormula(source.formula, field, tag, errors);
    field.readOnly = true;
  }

  if (type === 'number' || type === 'currency') {
    if (source.min !== undefined) {
      if (!Number.isFinite(Number(source.min))) errors.push(`${tag}: min must be a number`);
      else field.min = Number(source.min);
    }
    if (source.max !== undefined) {
      if (!Number.isFinite(Number(source.max))) errors.push(`${tag}: max must be a number`);
      else field.max = Number(source.max);
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      errors.push(`${tag}: min cannot be greater than max`);
    }
  }

  // Date rules (CRM 3.32.0), only present when declared: minDate "today" (not in the past when it is set
  // or changed), minField / maxField (another date field of the same record it cannot be before / after).
  const hasDateRule = source.minDate !== undefined || source.minField !== undefined || source.maxField !== undefined;
  if (type === 'date') {
    if (source.minDate !== undefined) {
      if (str(source.minDate) !== 'today') errors.push(`${tag}: minDate must be "today"`);
      else field.minDate = 'today';
    }
    for (const prop of ['minField', 'maxField']) {
      if (source[prop] === undefined) continue;
      const other = str(source[prop]).toLowerCase();
      if (!KEY_RE.test(other) || other === key) errors.push(`${tag}: ${prop} must be the key of another date field`);
      else field[prop] = other;
    }
  } else if (hasDateRule) {
    errors.push(`${tag}: minDate, minField and maxField are only allowed on date fields`);
  }

  if (source.default !== undefined && source.default !== null) {
    field.default = checkDefault(source.default, field, tag, errors);
  }
  return field;
}

/**
 * Options read at runtime from one of the extension's own settings
 * (json/settings.json), so admins can maintain them in Settings.
 *   "settings.destinations"                                   → a `list` setting (strings)
 *   { "setting": "services", "value": "key", "label": "name",
 *     "enabledKey": "enabled" }                               → a `json` setting holding objects
 * Cross-checked against settings.json by validateFieldsDeclaration.
 */
function normalizeOptionsFrom(raw, tag, errors) {
  if (typeof raw === 'string') {
    const match = /^settings\.([a-z][a-z0-9_]{1,59})$/.exec(raw.trim());
    if (!match) {
      errors.push(`${tag}: optionsFrom must look like "settings.<key>"`);
      return null;
    }
    return { setting: match[1], value: '', label: '', enabledKey: '' };
  }
  if (!isObject(raw)) {
    errors.push(`${tag}: optionsFrom must be "settings.<key>" or { setting, value, label }`);
    return null;
  }
  const setting = str(raw.setting).replace(/^settings\./, '');
  const out = {
    setting,
    value: str(raw.value),
    label: str(raw.label),
    enabledKey: str(raw.enabledKey)
  };
  if (!KEY_RE.test(setting)) errors.push(`${tag}: optionsFrom.setting must be a settings key`);
  for (const prop of ['value', 'label', 'enabledKey']) {
    if (out[prop] && !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(out[prop])) errors.push(`${tag}: optionsFrom.${prop} must be a property name`);
  }
  if (!out.value) errors.push(`${tag}: optionsFrom.value is required for object lists`);
  return out;
}

/**
 * Read-only fields computed from other fields of the same record. Evaluated
 * in the form while typing and again on the server when saving.
 *   { "op": "sum", "of": ["adults", "children"] }                      → number
 *   { "op": "days_between", "from": "start", "to": "end", "inclusive": true } → number
 *   { "op": "month_of", "of": "start" }                                → "YYYY-MM" (text)
 */
function normalizeFormula(raw, field, tag, errors) {
  if (!isObject(raw)) {
    errors.push(`${tag}: formula must be an object with "op"`);
    return null;
  }
  const op = str(raw.op);
  if (!FORMULA_OPS.includes(op)) {
    errors.push(`${tag}: formula.op must be one of ${FORMULA_OPS.join(', ')}`);
    return null;
  }
  const keyOk = (k) => KEY_RE.test(String(k || ''));
  if (op === 'sum') {
    const of = Array.isArray(raw.of) ? raw.of.map((k) => str(k)) : [];
    if (of.length < 1 || of.length > 20 || !of.every(keyOk)) errors.push(`${tag}: formula.of must list 1–20 field keys`);
    if (field.type !== 'number' && field.type !== 'currency') errors.push(`${tag}: a "sum" formula needs a number or currency field`);
    return { op, of };
  }
  if (op === 'days_between') {
    const from = str(raw.from);
    const to = str(raw.to);
    if (!keyOk(from) || !keyOk(to)) errors.push(`${tag}: formula.from and formula.to must be field keys`);
    if (field.type !== 'number') errors.push(`${tag}: a "days_between" formula needs a number field`);
    return { op, from, to, inclusive: raw.inclusive === true };
  }
  const of = str(raw.of);
  if (!keyOk(of)) errors.push(`${tag}: formula.of must be a field key`);
  if (field.type !== 'text') errors.push(`${tag}: a "month_of" formula needs a text field`);
  return { op, of };
}

/** Field keys a formula reads. */
function formulaInputs(formula) {
  if (!formula) return [];
  if (formula.op === 'sum') return formula.of;
  if (formula.op === 'days_between') return [formula.from, formula.to];
  return [formula.of];
}

/** Make sure a default matches the field type; returns the normalised default. */
function checkDefault(value, field, tag, errors) {
  if (field.optionsFrom && CHOICE_FIELD_TYPES.includes(field.type)) {
    // Options are only known at runtime; keep the shape check only.
    if (field.type === 'multiselect') {
      if (!Array.isArray(value)) errors.push(`${tag}: default must be a list of option values`);
      return Array.isArray(value) ? value.map((v) => str(v)) : [];
    }
    return str(value);
  }
  switch (field.type) {
    case 'list': {
      if (!Array.isArray(value)) errors.push(`${tag}: default must be a list of text values`);
      const items = (Array.isArray(value) ? value : []).map((v) => str(v)).filter(Boolean);
      if (items.length > MAX_LIST_ITEMS) errors.push(`${tag}: default has more than ${MAX_LIST_ITEMS} values`);
      if (items.some((v) => v.length > 120)) errors.push(`${tag}: list values must be 120 characters or fewer`);
      return [...new Map(items.map((v) => [v.toLowerCase(), v])).values()];
    }
    case 'json': {
      let text;
      try {
        text = JSON.stringify(value);
      } catch {
        errors.push(`${tag}: default must be JSON`);
        return null;
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_JSON_SETTING_BYTES) {
        errors.push(`${tag}: default is larger than ${MAX_JSON_SETTING_BYTES / 1024} KB`);
      }
      return JSON.parse(text);
    }
    default:
      break;
  }
  switch (field.type) {
    case 'number':
    case 'currency':
      if (!Number.isFinite(Number(value))) errors.push(`${tag}: default must be a number`);
      return Number(value);
    case 'checkbox':
      if (typeof value !== 'boolean') errors.push(`${tag}: default must be true or false`);
      return value === true;
    case 'multiselect': {
      const list = Array.isArray(value) ? value.map((v) => str(v)) : [];
      if (!Array.isArray(value)) errors.push(`${tag}: default must be a list of option values`);
      const allowed = new Set(field.options.map((o) => o.value));
      for (const item of list) {
        if (!allowed.has(item)) errors.push(`${tag}: default "${item}" is not one of the options`);
      }
      return list;
    }
    case 'select':
    case 'radio': {
      const v = str(value);
      if (!field.options.some((o) => o.value === v)) errors.push(`${tag}: default "${v}" is not one of the options`);
      return v;
    }
    case 'date':
      if (value !== 'today' && Number.isNaN(Date.parse(String(value)))) {
        errors.push(`${tag}: default must be an ISO date or "today"`);
      }
      return String(value);
    case 'user':
      if (value !== 'me') errors.push(`${tag}: default for a user field can only be "me"`);
      return 'me';
    default:
      if (typeof value !== 'string') errors.push(`${tag}: default must be text`);
      return String(value).slice(0, 500);
  }
}

/* ---------------------------------------------------------------- fields.json */

/**
 * @param {object} raw parsed fields.json
 * @param {{ requestTypeKey: string, knownRequestTypeKeys: Set<string> }} context
 */
function validateFieldsDeclaration(raw, context) {
  const errors = [];
  const warnings = [];
  const FILE = 'json/fields.json';
  if (!isObject(raw)) return result(null, [`${FILE} must be a JSON object keyed by record type`], warnings);

  const value = {};
  let total = 0;
  for (const [recordRaw, groupsRaw] of Object.entries(raw)) {
    const record = str(recordRaw).toLowerCase();
    if (!FIELD_RECORD_TYPES.includes(record)) {
      errors.push(`${FILE}: "${recordRaw}" is not a supported record; use ${FIELD_RECORD_TYPES.join(', ')}`);
      continue;
    }
    const groupList = Array.isArray(groupsRaw) ? groupsRaw : [groupsRaw];
    const usedKeys = new Set();
    const usedGroupIds = new Set();
    const groups = [];

    groupList.forEach((groupRaw, groupIndex) => {
      if (!isObject(groupRaw)) {
        errors.push(`${FILE}: ${record} group ${groupIndex + 1} must be an object`);
        return;
      }
      const where = `${FILE}: ${record}${groupList.length > 1 ? ` group ${groupIndex + 1}` : ''}`;
      const id = str(groupRaw.id).toLowerCase() || (groupList.length === 1 ? record : `${record}_${groupIndex + 1}`);
      if (!ID_RE.test(id)) errors.push(`${where}: group id "${id}" is invalid`);
      if (usedGroupIds.has(id)) errors.push(`${where}: duplicate group id "${id}"`);
      usedGroupIds.add(id);

      const sectionLabel = str(groupRaw.sectionLabel) || str(groupRaw.label);
      if (sectionLabel.length > 80) errors.push(`${where}: sectionLabel is longer than 80 characters`);

      let whenRequestTypeKey = str(groupRaw.whenRequestTypeKey).toLowerCase();
      if (whenRequestTypeKey) {
        if (record !== 'lead') {
          errors.push(`${where}: whenRequestTypeKey only applies to lead fields`);
        } else if (
          whenRequestTypeKey !== context.requestTypeKey &&
          !(context.knownRequestTypeKeys && context.knownRequestTypeKeys.has(whenRequestTypeKey))
        ) {
          errors.push(`${where}: whenRequestTypeKey "${whenRequestTypeKey}" is neither this extension's request type nor a known one`);
        }
      } else {
        whenRequestTypeKey = '';
      }

      const fieldsRaw = Array.isArray(groupRaw.fields) ? groupRaw.fields : null;
      if (!fieldsRaw || !fieldsRaw.length) {
        errors.push(`${where}: fields must be a non-empty list`);
        return;
      }
      const fields = fieldsRaw.map((fieldRaw, index) => normalizeField(fieldRaw, index, where, errors));
      for (const field of fields) {
        if (usedKeys.has(field.key)) errors.push(`${where}: duplicate field key "${field.key}"`);
        usedKeys.add(field.key);
      }
      total += fields.length;
      if (usedKeys.size > MAX_FIELDS_PER_RECORD) {
        errors.push(`${FILE}: ${record} declares more than ${MAX_FIELDS_PER_RECORD} fields`);
      }
      const countCheck = normalizeCountCheck(groupRaw.countCheck, fields, where, errors);
      groups.push({ id, record, sectionLabel: sectionLabel || 'Additional details', whenRequestTypeKey, fields, ...(countCheck ? { countCheck } : {}) });
    });

    // Cross-checks that need every field of the record and the settings declaration.
    const byKey = new Map(groups.flatMap((g) => g.fields).map((f) => [f.key, f]));
    for (const field of byKey.values()) {
      const tag = `${FILE}: ${record} field "${field.key}"`;
      if (field.optionsFrom) {
        const settingType = context.settingsFields ? context.settingsFields.get(field.optionsFrom.setting) : undefined;
        if (!settingType) {
          errors.push(`${tag}: optionsFrom "settings.${field.optionsFrom.setting}" is not declared in json/settings.json`);
        } else if (settingType === 'list' && field.optionsFrom.value) {
          errors.push(`${tag}: optionsFrom on a "list" setting takes no value/label mapping; use "settings.${field.optionsFrom.setting}"`);
        } else if (settingType === 'json' && !field.optionsFrom.value) {
          errors.push(`${tag}: optionsFrom on a "json" setting needs { "setting", "value", "label" }`);
        } else if (settingType !== 'list' && settingType !== 'json') {
          errors.push(`${tag}: optionsFrom must point at a "list" or "json" setting`);
        }
      }
      for (const prop of ['minField', 'maxField']) {
        if (!field[prop]) continue;
        const other = byKey.get(field[prop]);
        if (!other || other.type !== 'date') errors.push(`${tag}: ${prop} "${field[prop]}" must be a date field of the ${record}`);
      }
      for (const input of formulaInputs(field.formula)) {
        const source = byKey.get(input);
        if (!source) {
          errors.push(`${tag}: formula reads "${input}", which is not a ${record} field`);
          continue;
        }
        if (input === field.key) errors.push(`${tag}: formula cannot read itself`);
        const wantsDate = field.formula.op !== 'sum';
        if (wantsDate && source.type !== 'date') errors.push(`${tag}: formula input "${input}" must be a date field`);
        if (!wantsDate && source.type !== 'number' && source.type !== 'currency') {
          errors.push(`${tag}: formula input "${input}" must be a number field`);
        }
        if (source.formula) errors.push(`${tag}: formula input "${input}" is itself calculated`);
      }
    }
    if (groups.length) value[record] = groups;
  }

  if (!total && !errors.length) warnings.push(`${FILE} declares no fields`);
  return result(value, errors, warnings);
}

const NOTICE_TONES = ['info', 'warning', 'danger', 'success'];

/**
 * Optional group notice comparing a number the page is given (a prefill fact, e.g. how many records
 * exist) with a number field of the group: { actualFact, expectedField, over: { tone, text }, under: { tone, text } }.
 * Texts may use {actual}, {expected} and {diff}. Nothing is shown when the numbers match.
 * Optional checkLabel (120 characters at most): a live checklist row on the create page, ticked when the
 * numbers match.
 */
function normalizeCountCheck(raw, fields, where, errors) {
  if (raw === undefined || raw === null) return null;
  const tag = `${where}: countCheck`;
  if (!isObject(raw)) {
    errors.push(`${tag} must be an object`);
    return null;
  }
  const actualFact = str(raw.actualFact).toLowerCase();
  const expectedField = str(raw.expectedField).toLowerCase();
  if (!KEY_RE.test(actualFact)) errors.push(`${tag}.actualFact must be a key (lowercase letters, numbers or "_")`);
  const field = fields.find((f) => f.key === expectedField);
  if (!field) errors.push(`${tag}.expectedField "${expectedField}" must be a field of this group`);
  else if (field.type !== 'number') errors.push(`${tag}.expectedField "${expectedField}" must be a number field`);
  const out = { actualFact, expectedField };
  if (raw.checkLabel !== undefined && raw.checkLabel !== null) {
    const checkLabel = str(raw.checkLabel);
    if (!checkLabel || checkLabel.length > 120) errors.push(`${tag}.checkLabel must be text of 1–120 characters`);
    else out.checkLabel = checkLabel;
  }
  for (const side of ['over', 'under']) {
    if (raw[side] === undefined) continue;
    const item = raw[side];
    const tone = str(isObject(item) ? item.tone : '').toLowerCase() || 'info';
    const text = str(isObject(item) ? item.text : '');
    if (!NOTICE_TONES.includes(tone)) errors.push(`${tag}.${side}.tone must be one of ${NOTICE_TONES.join(', ')}`);
    if (!text || text.length > 300) errors.push(`${tag}.${side}.text is required (300 characters at most)`);
    out[side] = { tone, text };
  }
  if (!out.over && !out.under) errors.push(`${tag} needs "over" and/or "under"`);
  return out;
}

/* ------------------------------------------------------------------ tabs.json */

/**
 * @param {object} raw parsed tabs.json
 * @param {{ fieldGroups: object|null, modelNames: Set<string>, hasUi: boolean }} context
 */
function validateTabsDeclaration(raw, context) {
  const errors = [];
  const warnings = [];
  const FILE = 'json/tabs.json';
  if (!isObject(raw)) return result(null, [`${FILE} must be a JSON object keyed by page`], warnings);

  const value = {};
  const slots = new Set();
  for (const [pageRaw, tabsRaw] of Object.entries(raw)) {
    const page = str(pageRaw);
    if (!(page in TAB_PAGES)) {
      errors.push(`${FILE}: "${pageRaw}" is not a supported page; use ${Object.keys(TAB_PAGES).join(', ')}`);
      continue;
    }
    if (!Array.isArray(tabsRaw)) {
      errors.push(`${FILE}: ${page} must be a list of tabs`);
      continue;
    }
    if (tabsRaw.length > MAX_TABS_PER_PAGE) errors.push(`${FILE}: ${page} has more than ${MAX_TABS_PER_PAGE} tabs`);
    const record = TAB_PAGES[page];
    const ids = new Set();
    const tabs = [];

    tabsRaw.forEach((tabRaw, index) => {
      const source = isObject(tabRaw) ? tabRaw : {};
      const id = str(source.id).toLowerCase();
      const where = `${FILE}: ${page} tab ${index + 1}${id ? ` ("${id}")` : ''}`;
      if (!ID_RE.test(id)) errors.push(`${where}: id must be 2–60 characters: lowercase letters, numbers, "-" or "_"`);
      if (ids.has(id)) errors.push(`${where}: duplicate tab id`);
      ids.add(id);

      const label = str(source.label);
      if (!label || label.length > 40) errors.push(`${where}: label is required (max 40 characters)`);
      const kind = str(source.kind).toLowerCase();
      if (!TAB_KINDS.includes(kind)) errors.push(`${where}: kind "${kind}" is not one of ${TAB_KINDS.join(', ')}`);
      const order = source.order === undefined ? 100 : Number(source.order);
      if (!Number.isInteger(order) || order < 0 || order > 999) errors.push(`${where}: order must be an integer from 0 to 999`);

      const tab = { id, label, kind, order, permission: str(source.permission) || '' };
      if (tab.permission && context.permissionKeys && !context.permissionKeys.has(tab.permission)) {
        errors.push(`${where}: permission "${tab.permission}" is not a CRM permission or one this package defines`);
      }

      // CRM 3.33.0: the tab label shows a count, from a GET route of the package with one ":param"
      // (the record id), answering { count }, e.g. "Travellers (3)".
      if (source.countRoute !== undefined) {
        const countRoute = str(source.countRoute);
        const declared = (context.routes || []).some((r) => r.method === 'GET' && r.path === countRoute);
        if (!declared || (countRoute.match(/:[a-z][a-z0-9_]*/gi) || []).length !== 1) {
          errors.push(`${where}: countRoute "${countRoute}" must be a GET route of api/routes.json with one ":param" (the record id)`);
        } else tab.countRoute = countRoute;
      }

      if ((page === 'contactDetail' || page === 'quotationDetail') && kind !== 'mount') {
        errors.push(`${where}: contact sections must be of kind "mount"`);
      }

      if (page === 'dashboard') {
        if (kind !== 'mount') errors.push(`${where}: dashboard widgets must be of kind "mount"`);
        const width = str(source.width).toLowerCase() || 'half';
        if (!WIDGET_WIDTHS.includes(width)) errors.push(`${where}: width must be one of ${WIDGET_WIDTHS.join(', ')}`);
        tab.width = width;
      }

      switch (kind) {
        case 'fields': {
          const ref = str(source.fields).toLowerCase() || record || '';
          const groups = (context.fieldGroups && record && context.fieldGroups[record]) || [];
          const group = groups.find((g) => g.id === ref) || (ref === record && groups[0]) || null;
          if (!record) errors.push(`${where}: a "fields" tab is not possible on ${page}`);
          else if (!group) errors.push(`${where}: no declared field group "${ref}" for ${record} in json/fields.json`);
          tab.fields = group ? group.id : ref;
          break;
        }
        case 'records': {
          const model = str(source.model);
          if (!model || !(context.modelNames && context.modelNames.has(model))) {
            errors.push(`${where}: model "${model}" is not declared in api/models/`);
          }
          const columns = Array.isArray(source.columns) ? source.columns.map((c) => str(c)).filter(Boolean) : [];
          if (!columns.length) errors.push(`${where}: a "records" tab needs a non-empty columns list`);
          if (columns.length > 8) errors.push(`${where}: at most 8 columns are shown`);
          // The link field ties a row to the record being viewed; it must be a declared model field.
          const linkField = str(source.linkField) || (record ? `${record}_id` : '');
          const fieldKeys = context.modelFields && context.modelFields.get(model);
          if (fieldKeys) {
            if (!record) errors.push(`${where}: a "records" tab is not possible on ${page}`);
            else if (!fieldKeys.has(linkField)) {
              errors.push(`${where}: link field "${linkField}" is not a field of model "${model}" (declare it, e.g. { "${linkField}": { "type": "ref", "ref": "${record === 'client' ? 'Client' : record.charAt(0).toUpperCase() + record.slice(1)}" } }, or set "linkField")`);
            }
            for (const column of columns) {
              if (!fieldKeys.has(column) && column !== 'createdAt' && column !== 'updatedAt') {
                errors.push(`${where}: column "${column}" is not a field of model "${model}"`);
              }
            }
          }
          tab.model = model;
          tab.columns = columns;
          tab.linkField = linkField;
          break;
        }
        case 'readonly': {
          const source_ = str(source.source);
          if (!DOTTED_PATH_RE.test(source_)) errors.push(`${where}: source must be a dotted path such as "lead.extension.services"`);
          tab.source = source_;
          break;
        }
        case 'mount': {
          const slot = str(source.slot).toLowerCase();
          if (!SLOT_RE.test(slot)) errors.push(`${where}: slot must be 2–80 characters: lowercase letters, numbers, ".", "-" or "_"`);
          if (!context.hasUi) errors.push(`${where}: a "mount" tab needs a ui/ bundle and the "ui.mount" capability`);
          if (slots.has(slot)) errors.push(`${where}: slot "${slot}" is used by another tab`);
          slots.add(slot);
          tab.slot = slot;
          break;
        }
        default:
          break;
      }
      tabs.push(tab);
    });
    if (tabs.length) value[page] = tabs.sort((a, b) => a.order - b.order);
  }

  if (!Object.keys(value).length && !errors.length) warnings.push(`${FILE} declares no tabs`);
  return result(value, errors, warnings);
}

/* --------------------------------------------------------------- catalog.json */

/**
 * @param {object} raw parsed catalog.json
 * @param {{ builtinValues?: Record<string, string[]> }} context
 */
function validateCatalogDeclaration(raw, context = {}) {
  const errors = [];
  const warnings = [];
  const FILE = 'json/catalog.json';
  if (!isObject(raw)) return result(null, [`${FILE} must be a JSON object of lists`], warnings);

  const value = {};
  for (const [listRaw, itemsRaw] of Object.entries(raw)) {
    const list = str(listRaw);
    const settingKey = CATALOG_LISTS[list];
    if (!settingKey) {
      errors.push(`${FILE}: "${listRaw}" is not a known list; use ${Object.keys(CATALOG_LISTS).join(', ')}`);
      continue;
    }
    if (!Array.isArray(itemsRaw)) {
      errors.push(`${FILE}: ${list} must be a list of strings`);
      continue;
    }
    if (itemsRaw.length > MAX_CATALOG_VALUES) errors.push(`${FILE}: ${list} has more than ${MAX_CATALOG_VALUES} values`);
    const seen = new Set();
    const items = [];
    const builtin = new Set(((context.builtinValues && context.builtinValues[settingKey]) || []).map((v) => String(v).toLowerCase()));
    for (const itemRaw of itemsRaw) {
      const item = str(itemRaw);
      if (!item || item.length > 60) {
        errors.push(`${FILE}: ${list} values must be 1–60 characters`);
        continue;
      }
      const dedupe = item.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (builtin.has(dedupe)) warnings.push(`${FILE}: ${list} value "${item}" already exists in the CRM defaults`);
      items.push(item);
    }
    if (items.length) value[list] = { settingKey, values: items };
  }
  return result(value, errors, warnings);
}

/* -------------------------------------------------------------- settings.json */

function validateSettingsDeclaration(raw, context = {}) {
  const errors = [];
  const warnings = [];
  const FILE = 'json/settings.json';
  if (!isObject(raw)) return result(null, [`${FILE} must be a JSON object with "tab" and "fields"`], warnings);

  const tabRaw = isObject(raw.tab) ? raw.tab : {};
  const tabLabel = str(tabRaw.label);
  if (!tabLabel || tabLabel.length > 40) errors.push(`${FILE}: tab.label is required (max 40 characters)`);
  const icon = str(tabRaw.icon) || 'blocks';
  if (!ALLOWED_ICONS.includes(icon)) errors.push(`${FILE}: tab.icon "${icon}" is not available; use one of ${ALLOWED_ICONS.join(', ')}`);
  const description = str(tabRaw.description).slice(0, 240);
  const eyebrow = str(tabRaw.eyebrow).slice(0, 60);
  // Optional extension UI mounted under the generic form (e.g. a form builder).
  const slot = str(tabRaw.slot).toLowerCase();
  if (slot) {
    if (!SLOT_RE.test(slot)) errors.push(`${FILE}: tab.slot "${slot}" is invalid`);
    if (!context.hasUi) errors.push(`${FILE}: tab.slot needs a ui/ bundle and the "ui.mount" capability`);
  }

  const fieldsRaw = Array.isArray(raw.fields) ? raw.fields : null;
  if (!fieldsRaw || !fieldsRaw.length) errors.push(`${FILE}: fields must be a non-empty list`);
  if (fieldsRaw && fieldsRaw.length > MAX_SETTINGS_FIELDS) errors.push(`${FILE}: more than ${MAX_SETTINGS_FIELDS} settings fields`);

  const keys = new Set();
  const fields = (fieldsRaw || []).map((fieldRaw, index) => {
    const field = normalizeField(fieldRaw, index, FILE, errors, { allowedTypes: SETTINGS_FIELD_TYPES });
    if (keys.has(field.key)) errors.push(`${FILE}: duplicate settings key "${field.key}"`);
    keys.add(field.key);
    const section = str(isObject(fieldRaw) ? fieldRaw.section : '').slice(0, 60);
    return { ...field, section, secret: isObject(fieldRaw) && fieldRaw.secret === true && field.type === 'text' };
  });

  const defaults = {};
  for (const field of fields) {
    if (field.default !== undefined) defaults[field.key] = field.default;
    else if (field.type === 'checkbox') defaults[field.key] = false;
    else if (field.type === 'number') defaults[field.key] = null;
    else if (field.type === 'list') defaults[field.key] = [];
    else if (field.type === 'json') defaults[field.key] = null;
    else defaults[field.key] = '';
  }

  return result({ tab: { label: tabLabel, icon, description, eyebrow, slot }, fields, defaults }, errors, warnings);
}

/* ------------------------------------------------------------ navigation.json */

/**
 * @param {object} raw parsed navigation.json
 * @param {{ hasUi: boolean, permissionKeys: Set<string> }} context
 */
function validateNavigationDeclaration(raw, context) {
  const errors = [];
  const warnings = [];
  const FILE = 'json/navigation.json';
  if (!isObject(raw)) return result(null, [`${FILE} must be a JSON object with "pages"`], warnings);

  const pagesRaw = Array.isArray(raw.pages) ? raw.pages : null;
  if (!pagesRaw || !pagesRaw.length) return result(null, [`${FILE}: pages must be a non-empty list`], warnings);
  if (pagesRaw.length > MAX_PAGES) errors.push(`${FILE}: more than ${MAX_PAGES} pages`);
  if (!context.hasUi) errors.push(`${FILE}: navigation pages need a ui/ bundle and the "ui.mount" capability`);

  const ids = new Set();
  const slots = new Set();
  const pages = pagesRaw.map((pageRaw, index) => {
    const source = isObject(pageRaw) ? pageRaw : {};
    const id = str(source.id).toLowerCase();
    const where = `${FILE}: page ${index + 1}${id ? ` ("${id}")` : ''}`;
    if (!ID_RE.test(id)) errors.push(`${where}: id must be 2–60 characters: lowercase letters, numbers, "-" or "_"`);
    if (ids.has(id)) errors.push(`${where}: duplicate page id`);
    ids.add(id);

    const label = str(source.label);
    if (!label || label.length > 40) errors.push(`${where}: label is required (max 40 characters)`);
    const icon = str(source.icon) || 'blocks';
    if (!ALLOWED_ICONS.includes(icon)) errors.push(`${where}: icon "${icon}" is not available; use one of ${ALLOWED_ICONS.join(', ')}`);
    const kind = str(source.kind).toLowerCase() || 'mount';
    if (kind !== 'mount') errors.push(`${where}: kind must be "mount"`);
    const slot = str(source.slot).toLowerCase() || `page.${id}`;
    if (!SLOT_RE.test(slot)) errors.push(`${where}: slot "${slot}" is invalid`);
    if (slots.has(slot)) errors.push(`${where}: slot "${slot}" is used by another page`);
    slots.add(slot);
    const permission = str(source.permission);
    if (permission && context.permissionKeys && !context.permissionKeys.has(permission)) {
      errors.push(`${where}: permission "${permission}" is not a CRM permission or one this package defines`);
    }
    const order = source.order === undefined ? 100 : Number(source.order);
    if (!Number.isInteger(order) || order < 0 || order > 999) errors.push(`${where}: order must be an integer from 0 to 999`);

    const description = str(source.description);
    if (description.length > 160) errors.push(`${where}: description must be 160 characters or fewer`);
    // A page reached only by link (e.g. a detail page opened with ?id=) can stay out of the sidebar.
    const showInSidebar = source.showInSidebar !== false;
    // Who the page is for: staff, client-portal logins, or everyone holding the permission (default).
    const audience = str(source.audience).toLowerCase() || 'all';
    if (!['all', 'staff', 'portal'].includes(audience)) errors.push(`${where}: audience must be "all", "staff" or "portal"`);
    return { id, label, icon, kind: 'mount', slot, permission, order, description, showInQuickActions: source.showInQuickActions === true, showInSidebar, audience };
  });

  return result({ pages: pages.sort((a, b) => a.order - b.order) }, errors, warnings);
}

/* ------------------------------------------------------------ actions.json */

/** Core detail pages that show extension action buttons. */
// invoiceDetail (CRM 3.28.0): e.g. "Open Booking" on a paid invoice.
const ACTION_PAGES = ['leadDetail', 'opportunityDetail', 'quotationDetail', 'contactDetail', 'invoiceDetail'];
const ACTION_WHEN_KEYS = ['status', 'stage', 'stageType'];
const MAX_ACTIONS = 20;

/**
 * Buttons an extension adds to core detail pages.
 * { actions: [{ id, page, label, icon?, kind: 'route'|'mount', route? (POST), slot?, permission?,
 *               when?: { status?: [..], stage?: [..], stageType?: [..] }, confirm? }] }
 * @param {object} raw parsed actions.json
 * @param {{ routes: Array<{method,path}>, hasUi: boolean, permissionKeys?: Set<string> }} context
 */
function validateActionsDeclaration(raw, context) {
  const errors = [];
  const warnings = [];
  const FILE = 'json/actions.json';
  if (!isObject(raw) || !Array.isArray(raw.actions)) return result(null, [`${FILE} must be a JSON object with "actions"`], warnings);
  if (raw.actions.length > MAX_ACTIONS) errors.push(`${FILE}: more than ${MAX_ACTIONS} actions`);
  const ids = new Set();
  const actions = raw.actions.slice(0, MAX_ACTIONS).map((item, index) => {
    const source = isObject(item) ? item : {};
    const id = str(source.id).toLowerCase();
    const where = `${FILE}: action ${index + 1}${id ? ` ("${id}")` : ''}`;
    if (!ID_RE.test(id)) errors.push(`${where}: id must be 2–60 characters: lowercase letters, numbers, "-" or "_"`);
    if (ids.has(id)) errors.push(`${where}: duplicate action id`);
    ids.add(id);
    const page = str(source.page);
    if (!ACTION_PAGES.includes(page)) errors.push(`${where}: page must be one of ${ACTION_PAGES.join(', ')}`);
    const label = str(source.label);
    if (!label || label.length > 40) errors.push(`${where}: label is required (max 40 characters)`);
    const icon = str(source.icon) || 'blocks';
    if (!ALLOWED_ICONS.includes(icon)) errors.push(`${where}: icon "${icon}" is not available`);
    const kind = str(source.kind).toLowerCase() || 'route';
    let route = '';
    let slot = '';
    if (kind === 'route') {
      route = str(source.route);
      if (!(context.routes || []).some((r) => r.method === 'POST' && r.path === route)) {
        errors.push(`${where}: route "${route}" must be a POST route declared in api/routes.json`);
      }
    } else if (kind === 'mount') {
      slot = str(source.slot).toLowerCase();
      if (!SLOT_RE.test(slot)) errors.push(`${where}: slot "${slot}" is invalid`);
      if (!context.hasUi) errors.push(`${where}: mount actions need a ui/ bundle and the "ui.mount" capability`);
    } else {
      errors.push(`${where}: kind must be "route" or "mount"`);
    }
    const permission = str(source.permission);
    if (permission && context.permissionKeys && !context.permissionKeys.has(permission)) {
      errors.push(`${where}: permission "${permission}" is not a CRM permission or one this package defines`);
    }
    const when = {};
    if (source.when !== undefined) {
      if (!isObject(source.when)) errors.push(`${where}: when must be an object`);
      else {
        for (const [key, values] of Object.entries(source.when)) {
          if (!ACTION_WHEN_KEYS.includes(key)) errors.push(`${where}: when.${key} is not supported (use ${ACTION_WHEN_KEYS.join(', ')})`);
          else if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string' || v.length > 60)) {
            errors.push(`${where}: when.${key} must be a list of strings`);
          } else when[key] = values.map((v) => v.trim());
        }
      }
    }
    const confirm = str(source.confirm);
    if (confirm.length > 200) errors.push(`${where}: confirm must be 200 characters or fewer`);
    const order = source.order === undefined ? 100 : Number(source.order);
    return { id, page, label, icon, kind, route, slot, permission, when, confirm, order: Number.isInteger(order) ? order : 100 };
  });
  return result({ actions: actions.sort((a, b) => a.order - b.order) }, errors, warnings);
}

/* ------------------------------------------------------------ reports.json */

/** Section kinds the CRM draws on the Reports page (data from the extension's GET route). */
// list / steps / progress (CRM 3.31.0): short action lists, simple pipelines, a received-of-total bar.
const REPORT_SECTION_KINDS = ['kpis', 'funnel', 'groups', 'table', 'chart', 'list', 'steps', 'progress'];
const REPORT_FILTER_TYPES = ['daterange', 'select'];
/** Options the CRM fills itself (generic sources); anything else comes from options or optionsRoute. */
const REPORT_FILTER_SOURCES = ['users', 'leadSources', 'pipelineStages'];
/** Core report tabs an extension may keep beside its dashboard. */
const CORE_REPORT_TABS = ['sales', 'conversion', 'activity-location', 'projects', 'employees', 'time', 'income-expense', 'ageing', 'recurring-invoices', 'payment-reconciliation'];
const MAX_REPORT_SECTIONS = 24;
const MAX_REPORT_FILTERS = 12;
const REPORT_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const REPORT_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * The Reports page of an extension (CRM 3.29.0): replaces the core report tabs while the extension is active.
 * { title, subtitle?, keepCoreTabs?: [core tab ids],
 *   filters: [{ key, label, type: 'daterange'|'select', source?, options?: [{value,label}], optionsRoute?: GET route }],
 *   tabs?: [{ id, label }] (CRM 3.30.0: sections with a tab are shown under it; the others above the tabs),
 *   sections: [{ id, kind, title, subtitle?, route (GET), dataKey?, permission?, width: 'full'|'half',
 *                export?: boolean, periods?: [{ value, label }], tab? }] }
 * @param {{ routes: Array<{method,path}>, permissionKeys?: Set<string> }} context
 */
function validateReportsDeclaration(raw, context, FILE = 'json/reports.json') {
  const errors = [];
  const warnings = [];
  if (!isObject(raw)) return result(null, [`${FILE} must be a JSON object`], warnings);
  const getRoute = (path) => (context.routes || []).some((r) => r.method === 'GET' && r.path === path);
  const title = str(raw.title);
  if (!title || title.length > 60) errors.push(`${FILE}: title is required (max 60 characters)`);
  const subtitle = str(raw.subtitle);
  if (subtitle.length > 160) errors.push(`${FILE}: subtitle must be 160 characters or fewer`);
  // Header buttons (e.g. "+ New Travel Lead"): a label and a page of this CRM.
  const actions = [];
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || raw.actions.length > 3) errors.push(`${FILE}: actions must be a list of at most 3`);
    else for (const [index, a] of raw.actions.entries()) {
      const label = str(isObject(a) ? a.label : '');
      const link = str(isObject(a) ? a.link : '');
      const permission = str(isObject(a) ? a.permission : '');
      if (!label || label.length > 40) errors.push(`${FILE}: action ${index + 1}: label is required (max 40 characters)`);
      else if (!/^\/[a-z0-9/_-]{1,80}(\?[\w=&%.-]{0,120})?$/i.test(link) || link.includes('//')) errors.push(`${FILE}: action ${index + 1}: link must be a page path of this CRM`);
      else {
        if (permission && context.permissionKeys && !context.permissionKeys.has(permission)) errors.push(`${FILE}: action ${index + 1}: permission "${permission}" is unknown`);
        actions.push({ label, link, ...(permission ? { permission } : {}) });
      }
    }
  }
  const keepCoreTabs = [];
  if (raw.keepCoreTabs !== undefined) {
    if (!Array.isArray(raw.keepCoreTabs)) errors.push(`${FILE}: keepCoreTabs must be a list`);
    else for (const t of raw.keepCoreTabs) {
      if (!CORE_REPORT_TABS.includes(String(t))) errors.push(`${FILE}: keepCoreTabs "${t}" is not a core report (${CORE_REPORT_TABS.join(', ')})`);
      else if (!keepCoreTabs.includes(String(t))) keepCoreTabs.push(String(t));
    }
  }
  const permissionOk = (where, permission) => {
    if (permission && context.permissionKeys && !context.permissionKeys.has(permission)) {
      errors.push(`${where}: permission "${permission}" is not a CRM permission or one this package defines`);
    }
  };
  const optionList = (where, list) => {
    if (!Array.isArray(list) || list.length > 50) {
      errors.push(`${where} must be a list of at most 50 { value, label }`);
      return [];
    }
    return list.map((o) => ({ value: str(isObject(o) ? o.value : o).slice(0, 80), label: str(isObject(o) ? o.label || o.value : o).slice(0, 80) })).filter((o) => o.value);
  };

  const filters = [];
  const filterKeys = new Set();
  if (!Array.isArray(raw.filters || [])) errors.push(`${FILE}: filters must be a list`);
  for (const [index, f] of (Array.isArray(raw.filters) ? raw.filters : []).slice(0, MAX_REPORT_FILTERS).entries()) {
    const src = isObject(f) ? f : {};
    const key = str(src.key);
    const where = `${FILE}: filter ${index + 1}${key ? ` ("${key}")` : ''}`;
    if (!REPORT_KEY_RE.test(key) || ['from', 'to', 'limit', 'skip'].includes(key)) errors.push(`${where}: key must be 2–40 lowercase letters, numbers or "_" (not from / to)`);
    if (filterKeys.has(key)) errors.push(`${where}: duplicate key`);
    filterKeys.add(key);
    const label = str(src.label);
    if (!label || label.length > 40) errors.push(`${where}: label is required (max 40 characters)`);
    const type = str(src.type) || 'select';
    if (!REPORT_FILTER_TYPES.includes(type)) errors.push(`${where}: type must be one of ${REPORT_FILTER_TYPES.join(', ')}`);
    const filter = { key, label, type };
    if (type === 'select') {
      const source = str(src.source);
      if (source && !REPORT_FILTER_SOURCES.includes(source)) errors.push(`${where}: source must be one of ${REPORT_FILTER_SOURCES.join(', ')}`);
      if (source) filter.source = source;
      if (src.options !== undefined) filter.options = optionList(`${where}: options`, src.options);
      if (src.optionsRoute !== undefined) {
        const r = str(src.optionsRoute);
        if (!getRoute(r)) errors.push(`${where}: optionsRoute "${r}" must be a GET route declared in api/routes.json`);
        else filter.optionsRoute = r;
        filter.optionsKey = REPORT_KEY_RE.test(str(src.optionsKey)) ? str(src.optionsKey) : key;
      }
      if (!filter.source && !filter.options && !filter.optionsRoute) errors.push(`${where}: a select filter needs source, options or optionsRoute`);
      if (src.default !== undefined) {
        const d = str(src.default);
        if (!filter.options || !filter.options.some((o) => o.value === d)) errors.push(`${where}: default must be one of its options`);
        else filter.default = d;
      }
    } else if (src.default !== undefined) {
      const d = str(src.default);
      if (!['this_month', 'last_30_days', 'this_quarter', 'this_year', 'all'].includes(d)) errors.push(`${where}: default must be this_month, last_30_days, this_quarter, this_year or all`);
      else filter.default = d;
    }
    filters.push(filter);
  }

  const tabs = [];
  if (raw.tabs !== undefined) {
    if (!Array.isArray(raw.tabs) || raw.tabs.length > 12) errors.push(`${FILE}: tabs must be a list of at most 12`);
    else for (const [index, t] of raw.tabs.entries()) {
      const id = str(isObject(t) ? t.id : '');
      const label = str(isObject(t) ? t.label : '');
      if (!REPORT_ID_RE.test(id) || tabs.some((x) => x.id === id)) errors.push(`${FILE}: tab ${index + 1}: id must be unique, 2–40 lowercase letters, numbers or "-"`);
      else if (!label || label.length > 40) errors.push(`${FILE}: tab "${id}": label is required (max 40 characters)`);
      else tabs.push({ id, label });
    }
  }

  const sections = [];
  const ids = new Set();
  if (!Array.isArray(raw.sections) || !raw.sections.length) errors.push(`${FILE}: sections must be a non-empty list`);
  if (Array.isArray(raw.sections) && raw.sections.length > MAX_REPORT_SECTIONS) errors.push(`${FILE}: more than ${MAX_REPORT_SECTIONS} sections`);
  for (const [index, item] of (Array.isArray(raw.sections) ? raw.sections : []).slice(0, MAX_REPORT_SECTIONS).entries()) {
    const src = isObject(item) ? item : {};
    const id = str(src.id);
    const where = `${FILE}: section ${index + 1}${id ? ` ("${id}")` : ''}`;
    if (!REPORT_ID_RE.test(id)) errors.push(`${where}: id must be 2–40 lowercase letters, numbers or "-"`);
    if (ids.has(id)) errors.push(`${where}: duplicate id`);
    ids.add(id);
    const kind = str(src.kind);
    if (!REPORT_SECTION_KINDS.includes(kind)) errors.push(`${where}: kind must be one of ${REPORT_SECTION_KINDS.join(', ')}`);
    const sTitle = str(src.title);
    if (sTitle.length > 60 || (!sTitle && kind !== 'kpis')) errors.push(`${where}: title is required (max 60 characters)`);
    const route = str(src.route);
    if (!getRoute(route)) errors.push(`${where}: route "${route}" must be a GET route declared in api/routes.json`);
    const dataKey = src.dataKey === undefined ? id : str(src.dataKey);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/.test(dataKey)) errors.push(`${where}: dataKey must be 2–40 letters, numbers, "-" or "_"`);
    const permission = str(src.permission);
    permissionOk(where, permission);
    const width = str(src.width) || 'full';
    if (!['full', 'half'].includes(width)) errors.push(`${where}: width must be full or half`);
    const section = { id, kind, title: sTitle, subtitle: str(src.subtitle).slice(0, 160), route, dataKey, permission, width, export: src.export === true };
    if (src.periods !== undefined) section.periods = optionList(`${where}: periods`, src.periods);
    if (src.tab !== undefined) {
      const tab = str(src.tab);
      if (!tabs.some((t) => t.id === tab)) errors.push(`${where}: tab "${tab}" is not one of the declared tabs`);
      else section.tab = tab;
    }
    sections.push(section);
  }
  return result({ title, subtitle, actions, keepCoreTabs, filters, tabs, sections }, errors, warnings);
}

/** The Dashboard of an extension (json/dashboard.json, CRM 3.31.0): the same format as reports.json. */
function validateDashboardDeclaration(raw, context) {
  return validateReportsDeclaration(raw, context, 'json/dashboard.json');
}

module.exports = {
  REPORT_SECTION_KINDS,
  CORE_REPORT_TABS,
  validateReportsDeclaration,
  validateDashboardDeclaration,
  ACTION_PAGES,
  validateActionsDeclaration,
  FIELD_RECORD_TYPES,
  DECLARATION_FIELD_TYPES,
  CHOICE_FIELD_TYPES,
  TAB_PAGES,
  TAB_KINDS,
  CATALOG_LISTS,
  SETTINGS_FIELD_TYPES,
  KEY_RE,
  ID_RE,
  SLOT_RE,
  normalizeField,
  validateFieldsDeclaration,
  validateTabsDeclaration,
  validateCatalogDeclaration,
  validateSettingsDeclaration,
  validateNavigationDeclaration
};
