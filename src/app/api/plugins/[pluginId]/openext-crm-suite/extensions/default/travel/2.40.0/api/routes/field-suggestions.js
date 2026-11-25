'use strict';

/**
 * Type-ahead for the Travel Requirement text fields.
 *
 *   GET  /field-suggestions?field=<key>&q=<typed>   values entered before for that field (most used first)
 *   POST /field-suggestions { field, value }        add a new value to the field's list (any user who can edit)
 *
 * Only text fields of an active service, and never fields holding personal details.
 */

const { readServices } = require('../services/catalog.js');
const suggestions = require('../services/field-suggestions.js');

const str = (v) => (v === null || v === undefined ? '' : String(v));

async function fieldOf(sdk, key) {
  const field = suggestions.findField(await readServices(sdk), key);
  if (!field) throw sdk.error(404, 'This field has no suggestions', 'NOT_SUGGESTIBLE');
  return field;
}

exports.list = async (req, sdk) => {
  const query = req.query || {};
  const field = await fieldOf(sdk, str(query.field));
  return { field: field.key, values: await suggestions.search(sdk, field.key, str(query.q).slice(0, 120)) };
};

exports.add = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const field = await fieldOf(sdk, str(body.field));
  const value = suggestions.clean(body.value);
  if (!value) throw sdk.error(400, 'Type a value to add', 'INVALID_INPUT');
  const stored = await suggestions.record(sdk, field.key, value);
  return { field: field.key, value: stored };
};
