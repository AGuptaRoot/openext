'use strict';

const fs = require('fs');
const path = require('path');
const { reRegisterModel } = require('./utils/model-register.util');

/**
 * Re-register every CRM model with a fresh schema (reload-safe).
 */
async function registerAllModels(cms) {
  const modelsDir = path.join(__dirname, 'models');
  const files = fs.readdirSync(modelsDir).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    const fullPath = path.join(modelsDir, file);
    // Bust Node require cache so plugin reload picks up new schema fields
    // (e.g. Lead.extension). Without this, Mongoose keeps the first schema
    // and silently drops new fields on save.
    try {
      delete require.cache[require.resolve(fullPath)];
    } catch {
      /* ignore */
    }
    const mod = require(fullPath);
    const name = mod.name;
    const schema = mod.schema || mod.LeadSchema;
    if (!name || !schema) continue;
    await reRegisterModel(cms, name, schema);
  }
}

module.exports = {
  registerAllModels
};
