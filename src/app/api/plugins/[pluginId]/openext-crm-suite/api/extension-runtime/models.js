'use strict';

/**
 * Builds and registers Mongoose models for an extension's JSON models
 * (`api/models/<Name>.json`, normalised by crm-extension-backend.schema.js),
 * and exposes them through a tenant-locked repository.
 *
 *   model name   X_<extensionId>_<Name>            (registered via cms.models.register)
 *   collection   plugin_openext_crm_suite_x_<extensionId>_<name>
 *
 * Every document carries tenantId, extensionId, isDeleted and timestamps.
 * The repository injects tenantId / extensionId / isDeleted into every query
 * after the caller's filter, so a caller can never read or write another
 * tenant's rows or deleted rows. JSON models contain no code, so this API
 * works without the backend trust approval.
 */

const crypto = require('crypto');
const {
  OBJECT_ID_RE,
  runtimeError,
  sanitizeFilter,
  sanitizeSort,
  clampLimit,
  clampSkip,
  coerceDocument,
  coerceValue
} = require('./values');

const SYSTEM_FIELDS = ['_id', 'createdAt', 'updatedAt'];
/** Schema fingerprint per registered model name, for this process. */
const registered = new Map();

/**
 * Collection-safe extension id. Ids made only of [a-z0-9_] are used as-is;
 * any other id (e.g. "a-b") gets a short hash suffix so it can never share
 * collections or model names with a look-alike id ("a_b").
 */
function safeId(extensionId) {
  const id = String(extensionId || '').toLowerCase();
  if (/^[a-z0-9_]+$/.test(id)) return id;
  const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${id.replace(/[^a-z0-9_]/g, '_')}_${hash}`;
}

/** Live (not soft-deleted) rows one tenant may keep in one extension model. */
const MAX_ROWS_PER_MODEL = 100000;

function modelName(extensionId, name) {
  return `X_${safeId(extensionId)}_${name}`;
}

function collectionName(extensionId, name) {
  return `plugin_openext_crm_suite_x_${safeId(extensionId)}_${String(name).toLowerCase()}`;
}

function mongooseTypeFor(field, Schema) {
  switch (field.type) {
    case 'number':
    case 'currency':
      return Number;
    case 'checkbox':
      return Boolean;
    case 'multiselect':
      return [String];
    case 'json':
      return Schema.Types.Mixed;
    default:
      return String; // text, textarea, date (ISO string), select, radio, user, ref
  }
}

function buildSchema(extensionId, modelDef) {
  // eslint-disable-next-line global-require
  const { Schema } = require('mongoose');
  const shape = {
    tenantId: { type: String, required: true, index: true },
    extensionId: { type: String, required: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null }
  };
  for (const field of modelDef.fields) {
    shape[field.key] = { type: mongooseTypeFor(field, Schema) };
  }
  const schema = new Schema(shape, {
    collection: collectionName(extensionId, modelDef.name),
    timestamps: true,
    strict: true,
    minimize: false
  });
  schema.index({ tenantId: 1, isDeleted: 1, createdAt: -1 });
  for (const field of modelDef.fields) {
    if (field.unique) {
      schema.index(
        { tenantId: 1, [field.key]: 1 },
        { unique: true, partialFilterExpression: { isDeleted: false }, name: `x_${field.key}_unique` }
      );
    } else if (field.index) {
      schema.index({ tenantId: 1, [field.key]: 1 }, { name: `x_${field.key}_idx` });
    }
  }
  // Compound indexes of CRM-owned helper tables (never from a package file).
  for (const extra of Array.isArray(modelDef.indexes) ? modelDef.indexes : []) {
    schema.index(extra.fields, extra.options || {});
  }
  return schema;
}

function fingerprint(modelDef) {
  return crypto.createHash('sha1').update(JSON.stringify(modelDef.fields)).digest('hex');
}

/** Register (or re-register after a schema change) and return the Mongoose model. */
async function getMongooseModel(req, extensionId, modelDef) {
  const cms = req.cms;
  const name = modelName(extensionId, modelDef.name);
  const fp = fingerprint(modelDef);
  const existing = cms?.models?.get?.(name);
  if (existing && registered.get(name) === fp) return existing;

  if (!cms?.models?.register || !cms?.database?.user) {
    if (existing) return existing;
    throw runtimeError(500, 'Model registry is not available', 'MODEL_REGISTRY_UNAVAILABLE');
  }
  const conn = await cms.database.user();
  const fullName = `${cms.pluginId || 'openext-crm-suite'}_${name}`;
  if (conn?.models?.[fullName] && typeof conn.deleteModel === 'function') conn.deleteModel(fullName);
  const model = cms.models.register(name, buildSchema(extensionId, modelDef)) || cms.models.get(name);
  registered.set(name, fp);
  return model;
}

async function lean(query) {
  return query && typeof query.lean === 'function' ? query.lean() : query;
}

function toRow(doc, modelDef) {
  if (!doc) return null;
  const row = { _id: String(doc._id) };
  for (const field of modelDef.fields) {
    if (doc[field.key] !== undefined) row[field.key] = doc[field.key];
  }
  row.createdAt = doc.createdAt ? new Date(doc.createdAt).toISOString() : null;
  row.updatedAt = doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null;
  return row;
}

/**
 * Tenant-locked repository for one extension model.
 * Method shapes are part of the SDK contract (sdk.models.<Name>).
 */
function createRepository(req, extensionId, modelDef, { tenantId, userId }) {
  const fieldKeys = new Set(modelDef.fields.map((f) => f.key));
  const isAllowed = (key) => fieldKeys.has(key) || SYSTEM_FIELDS.includes(key);
  const scope = () => ({ tenantId, extensionId, isDeleted: false });
  const model = () => getMongooseModel(req, extensionId, modelDef);

  function scopedFilter(filter) {
    const clean = sanitizeFilter(filter, isAllowed);
    if (clean._id !== undefined && typeof clean._id === 'string' && !OBJECT_ID_RE.test(clean._id)) {
      return null; // an invalid id can never match
    }
    return { ...clean, ...scope() };
  }

  function mapDuplicate(error) {
    if (error && (error.code === 11000 || /duplicate key/i.test(String(error.message)))) {
      return runtimeError(409, `A ${modelDef.label || modelDef.name} with the same unique value already exists`, 'DUPLICATE');
    }
    return error;
  }

  async function find(filter = {}, options = {}) {
    const where = scopedFilter(filter);
    if (!where) return [];
    const Model = await model();
    let query = Model.find(where);
    const sort = sanitizeSort(options.sort, isAllowed) || { createdAt: -1 };
    query = query.sort(sort).skip(clampSkip(options.skip)).limit(clampLimit(options.limit));
    const docs = (await lean(query)) || [];
    return docs.map((d) => toRow(d, modelDef));
  }

  return Object.freeze({
    name: modelDef.name,
    async find(filter = {}, options = {}) {
      const where = scopedFilter(filter);
      if (!where) return [];
      const Model = await model();
      let query = Model.find(where);
      const sort = sanitizeSort(options.sort, isAllowed) || { createdAt: -1 };
      query = query.sort(sort).skip(clampSkip(options.skip)).limit(clampLimit(options.limit));
      const docs = (await lean(query)) || [];
      return docs.map((d) => toRow(d, modelDef));
    },
    async findOne(filter = {}) {
      const rows = await find(filter, { limit: 1 });
      return rows[0] || null;
    },
    async findById(id) {
      const key = String(id || '');
      if (!OBJECT_ID_RE.test(key)) return null;
      const Model = await model();
      return toRow(await lean(Model.findOne({ _id: key, ...scope() })), modelDef);
    },
    async count(filter = {}) {
      const where = scopedFilter(filter);
      if (!where) return 0;
      const Model = await model();
      return Model.countDocuments(where);
    },
    async create(data) {
      const doc = coerceDocument(data, modelDef.fields, { partial: false });
      const Model = await model();
      const live = await Model.countDocuments(scope());
      if (live >= MAX_ROWS_PER_MODEL) {
        throw runtimeError(409, `${modelDef.pluralLabel || modelDef.name} reached the limit of ${MAX_ROWS_PER_MODEL} records for this workspace`, 'EXTENSION_QUOTA_EXCEEDED');
      }
      try {
        const created = await Model.create({ ...doc, ...scope(), createdBy: userId, updatedBy: userId });
        return toRow(typeof created?.toObject === 'function' ? created.toObject() : created, modelDef);
      } catch (error) {
        throw mapDuplicate(error);
      }
    },
    async updateById(id, patch) {
      const key = String(id || '');
      if (!OBJECT_ID_RE.test(key)) return null;
      const doc = coerceDocument(patch, modelDef.fields, { partial: true });
      const Model = await model();
      try {
        const updated = await lean(
          Model.findOneAndUpdate({ _id: key, ...scope() }, { $set: { ...doc, updatedBy: userId } }, { new: true })
        );
        return toRow(updated, modelDef);
      } catch (error) {
        throw mapDuplicate(error);
      }
    },
    async deleteById(id) {
      const key = String(id || '');
      if (!OBJECT_ID_RE.test(key)) return false;
      const Model = await model();
      const result = await Model.updateOne(
        { _id: key, ...scope() },
        { $set: { isDeleted: true, deletedAt: new Date(), updatedBy: userId } }
      );
      return Boolean(result && (result.modifiedCount || result.nModified || result.matchedCount));
    }
  });
}

/** Turn query-string values into a typed equality filter on declared fields. */
function filterFromQuery(query, modelDef) {
  const reserved = new Set(['limit', 'skip', 'sort']);
  const byKey = new Map(modelDef.fields.map((f) => [f.key, f]));
  const filter = {};
  for (const [key, raw] of Object.entries(query || {})) {
    if (reserved.has(key)) continue;
    if (key === '_id') {
      filter._id = String(raw);
      continue;
    }
    const field = byKey.get(key);
    if (!field) throw runtimeError(400, `cannot filter on "${key}"`, 'INVALID_FILTER');
    const result = field.type === 'multiselect' ? { value: String(raw) } : coerceValue(field, raw);
    if (result.error) throw runtimeError(400, result.error, 'INVALID_FILTER');
    filter[key] = result.value;
  }
  return filter;
}

module.exports = {
  MAX_ROWS_PER_MODEL,
  safeId,
  modelName,
  collectionName,
  buildSchema,
  getMongooseModel,
  createRepository,
  filterFromQuery,
  toRow,
  _registered: registered
};
