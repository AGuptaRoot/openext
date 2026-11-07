const SettingsService = require('../services/SettingsService');

module.exports = async (cms) => {
  await SettingsService.wipeStoredCredentials(cms);
  cms.logger.info('[razorpay-payment-gateway] Uninstalled — stored credentials removed');
};
