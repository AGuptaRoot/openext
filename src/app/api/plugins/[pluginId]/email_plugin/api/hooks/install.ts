const SettingsService = require('../services/SettingsService');

module.exports = async (cms) => {
  await SettingsService.getPublicConfig(cms);
  cms.logger.info('Email plugin installed — configure SMTP under Email Service → SMTP Settings');
};
