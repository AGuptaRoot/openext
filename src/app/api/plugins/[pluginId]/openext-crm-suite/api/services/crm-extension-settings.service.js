'use strict';

/**
 * Values of an uploaded extension's own settings form (json/settings.json).
 *
 * Shared contract (documentation/crm-upload-plan/00-CONTRACTS.md):
 *   - Stored in the CRM settings collection under key `ext_<extensionId>_settings`,
 *     category `extensions`, value = plain object { [fieldKey]: value }.
 *   - Reads always return every declared key: stored value, else the declared
 *     default from definition.declarations.settings.defaults.
 *   - Writes accept only declared keys and coerce them to the declared type.
 *   - Used by the Settings tab (HTTP routes) and by the backend SDK
 *     (sdk.settings.getAll / get / set).
 *
 * Never throws on read; returns defaults when anything is missing.
 */

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');

const CATEGORY = 'extensions';

function settingKey(extensionId) {
  return `ext_${String(extensionId || '').toLowerCase().replace(/[^a-z0-9_]/g, '_')}_settings`;
}

function getSettingModel(req) {
  return req.cms?.models?.get?.('Setting') || null;
}

function declaredSettings(def) {
  const decl = def && def.declarations && def.declarations.settings;
  return decl && Array.isArray(decl.fields) ? decl : { fields: [], defaults: {} };
}

async function leanResult(query) {
  if (!query) return null;
  return typeof query.lean === 'function' ? query.lean() : query;
}

const MAX_LIST_ITEMS = 500;
const MAX_JSON_BYTES = 256 * 1024;

function coerce(field, value) {
  if (value === null || value === undefined) {
    if (field.type === 'checkbox') return false;
    if (field.type === 'list') return [];
    return null;
  }
  switch (field.type) {
    case 'list': {
      if (!Array.isArray(value)) return { error: `${field.label} must be a list` };
      const seen = new Set();
      const out = [];
      for (const item of value) {
        const text = String(item ?? '').trim();
        if (!text) continue;
        if (text.length > 120) return { error: `${field.label}: "${text.slice(0, 20)}…" is longer than 120 characters` };
        const dedupe = text.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push(text);
      }
      if (out.length > MAX_LIST_ITEMS) return { error: `${field.label} has more than ${MAX_LIST_ITEMS} values` };
      return out;
    }
    case 'json': {
      let text;
      try {
        text = JSON.stringify(value);
      } catch {
        return { error: `${field.label} must be JSON` };
      }
      if (text === undefined) return null;
      if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) return { error: `${field.label} is larger than 256 KB` };
      return { value: JSON.parse(text) };
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: `${field.label} must be a number` };
      if (field.min !== undefined && field.min !== null && n < field.min) return { error: `${field.label} must be at least ${field.min}` };
      if (field.max !== undefined && field.max !== null && n > field.max) return { error: `${field.label} must be at most ${field.max}` };
      return n;
    }
    case 'checkbox':
      return value === true || value === 'true';
    case 'select': {
      const v = String(value);
      if (v && !(field.options || []).some((o) => o.value === v)) return { error: `${field.label} must be one of the options` };
      return v;
    }
    default:
      return String(value).slice(0, field.type === 'textarea' ? 5000 : 500);
  }
}

/** All values for the extension, defaults filled in. */
async function getValues(req, def) {
  const decl = declaredSettings(def);
  const out = { ...(decl.defaults || {}) };
  try {
    const Setting = getSettingModel(req);
    if (!Setting || typeof Setting.findOne !== 'function') return out;
    const row = await leanResult(Setting.findOne({ tenantId: resolveTenantId(req), key: settingKey(def.id) }));
    const stored = row && row.value && typeof row.value === 'object' ? row.value : {};
    for (const field of decl.fields) {
      if (Object.prototype.hasOwnProperty.call(stored, field.key)) out[field.key] = stored[field.key];
    }
  } catch {
    /* defaults */
  }
  return out;
}

/**
 * Validate and store a partial update. Unknown keys are rejected.
 * @returns {Promise<object>} the full value set after the update
 */
async function setValues(req, def, patch) {
  const decl = declaredSettings(def);
  const byKey = new Map(decl.fields.map((f) => [f.key, f]));
  const errors = [];
  const clean = {};
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    const field = byKey.get(key);
    if (!field) {
      errors.push(`"${key}" is not a setting of ${def.name}`);
      continue;
    }
    const v = coerce(field, value);
    if (field.type === 'json') {
      // json results are wrapped ({ value }) so stored data can never look like an error object.
      if (v && typeof v === 'object' && !Array.isArray(v) && 'error' in v && !('value' in v)) errors.push(v.error);
      else clean[key] = v && typeof v === 'object' && 'value' in v ? v.value : v;
    } else if (v && typeof v === 'object' && !Array.isArray(v) && v.error) {
      errors.push(v.error);
    } else {
      clean[key] = v;
    }
  }
  for (const field of decl.fields) {
    if (field.required && Object.prototype.hasOwnProperty.call(clean, field.key) && (clean[field.key] === '' || clean[field.key] === null)) {
      errors.push(`${field.label} is required`);
    }
  }
  if (errors.length) {
    const error = new Error('Invalid extension settings');
    error.status = 400;
    error.code = 'INVALID_EXTENSION_SETTINGS';
    error.details = errors;
    throw error;
  }

  const current = await getValues(req, def);
  const next = { ...current, ...clean };
  const Setting = getSettingModel(req);
  if (!Setting) throw Object.assign(new Error('Setting model is not registered'), { status: 500 });
  require('./setting.service').invalidateSettingsCache(req);
  await Setting.findOneAndUpdate(
    { tenantId: resolveTenantId(req), key: settingKey(def.id) },
    {
      $set: {
        value: next,
        category: CATEGORY,
        updatedBy: resolveUserId(req) || 'system',
        isDeleted: false
      }
    },
    { upsert: true, new: true }
  );
  return next;
}

module.exports = { CATEGORY, settingKey, getValues, setValues };
