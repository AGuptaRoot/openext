'use strict';

/**
 * Re-register a Mongoose model after plugin reload.
 * Without deleteModel(), the shared connection keeps the first schema and silently drops new fields on save.
 */
async function reRegisterModel(cms, name, schema) {
  const conn = await cms.database.user();
  const modelName = `${cms.pluginId}_${name}`;
  if (conn.models[modelName]) {
    conn.deleteModel(modelName);
  }
  cms.models.register(name, schema);
}

module.exports = {
  reRegisterModel
};
