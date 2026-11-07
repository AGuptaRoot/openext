'use strict';

const { seedDefaults } = require('../services/setting.service');

/**
 * Install hook — runs after migrations, before routes are loaded.
 *
 * Seeds default CRM settings for the default tenant.
 * Uses raw MongoDB upserts (see setting.service seedDefaults) because
 * Mongoose models are not registered yet at install time.
 */
module.exports = async function install(cms) {
  await seedDefaults(cms, 'default', 'install');
  cms.logger.info('Root CRM installed — default settings seeded');
};
