'use strict';

/**
 * Declared field values an extension keeps for core CRM records
 * (lead, client, opportunity, ticket), stored in the extension's OWN table:
 *
 *   model        X_<extensionId>__RecordValues
 *   collection   plugin_openext_crm_suite_x_<extensionId>__recordvalues
 *   one row per  (tenantId, recordType, recordId) → { values: { <fieldKey>: value } }
 *
 * Core record tables (Lead, Company, Opportunity, Ticket) are never written
 * here, so an extension can never change core CRM data.
 *
 * Values saved by CRM versions before 3.10.0 live on the core record in
 * `extension[<extensionId>]`. They are read as a fallback while the record
 * has no row yet, and copied into the new row on the record's first save.
 * The old bag itself is never modified or deleted.
 *
 * The double underscore in the model name keeps this CRM-owned table apart
 * from package models, whose names must start with a capital letter.
 */

const { getMongooseModel } = require('./models');
const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');

const MODEL_DEF = Object.freeze({
  name: '_RecordValues',
  fields: Object.freeze([
    Object.freeze({ key: 'recordType', type: 'text', index: true }),
    Object.freeze({ key: 'recordId', type: 'text', index: true }),
    Object.freeze({ key: 'values', type: 'json' })
  ]),
  indexes: Object.freeze([
    Object.freeze({ fields: { tenantId: 1, recordType: 1, recordId: 1 }, options: { name: 'x_record_idx' } })
  ])
});

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Values stored on the core record by CRM versions before 3.10.0 (read-only). */
function legacyValues(doc, extensionId) {
  const bag = plainObject(doc && doc.extension);
  const slice = bag ? plainObject(bag[extensionId]) : null;
  return slice ? { ...slice } : {};
}

async function lean(query) {
  return query && typeof query.lean === 'function' ? query.lean() : query;
}

function rowFilter(req, extensionId, recordType, doc) {
  return {
    tenantId: resolveTenantId(req),
    extensionId,
    recordType,
    recordId: String(doc._id),
    isDeleted: false
  };
}

async function findRow(req, extensionId, recordType, doc) {
  const Model = await getMongooseModel(req, extensionId, MODEL_DEF);
  const row = await lean(Model.findOne(rowFilter(req, extensionId, recordType, doc)));
  return { Model, row };
}

/**
 * Stored values of one extension for one core record.
 * @returns {Promise<object>} plain copy; empty when nothing is stored
 */
async function read(req, extensionId, recordType, doc) {
  if (!extensionId || !doc) return {};
  const { row } = await findRow(req, extensionId, recordType, doc);
  if (row && plainObject(row.values)) return { ...row.values };
  return legacyValues(doc, extensionId);
}

/**
 * Stored values for several core records of one type in one query.
 * @returns {Promise<Map<string, object>>} record id → plain copy (empty object when nothing is stored)
 */
async function readMany(req, extensionId, recordType, docs) {
  const out = new Map();
  const list = (docs || []).filter((d) => d && d._id);
  if (!extensionId || !list.length) return out;
  const Model = await getMongooseModel(req, extensionId, MODEL_DEF);
  const ids = list.map((d) => String(d._id));
  const rows = (await lean(Model.find({ tenantId: resolveTenantId(req), extensionId, recordType, recordId: { $in: ids }, isDeleted: false }))) || [];
  const byId = new Map(rows.map((r) => [String(r.recordId), r]));
  for (const doc of list) {
    const row = byId.get(String(doc._id));
    out.set(String(doc._id), row && plainObject(row.values) ? { ...row.values } : legacyValues(doc, extensionId));
  }
  return out;
}

/**
 * Merge `patch` into the extension's row for the record (creates the row on
 * first save, starting from any values an older CRM kept on the record).
 */
async function write(req, extensionId, recordType, doc, patch) {
  if (!extensionId || !doc) return;
  const clean = plainObject(patch) || {};
  if (!Object.keys(clean).length) return;
  const userId = resolveUserId(req) || 'system';
  const { Model, row } = await findRow(req, extensionId, recordType, doc);

  if (row) {
    const set = { updatedBy: userId };
    for (const [key, value] of Object.entries(clean)) set[`values.${key}`] = value;
    await Model.updateOne({ _id: row._id, tenantId: resolveTenantId(req) }, { $set: set });
    return;
  }

  const filter = rowFilter(req, extensionId, recordType, doc);
  await lean(
    Model.findOneAndUpdate(
      filter,
      {
        $set: {
          ...filter,
          values: { ...legacyValues(doc, extensionId), ...clean },
          createdBy: userId,
          updatedBy: userId
        }
      },
      { upsert: true, new: true }
    )
  );
}

module.exports = { MODEL_DEF, legacyValues, read, readMany, write };
