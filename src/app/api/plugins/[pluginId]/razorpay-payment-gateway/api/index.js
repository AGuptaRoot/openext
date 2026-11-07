module.exports = {
  register({ cms }) {
    cms.logger.info('Razorpay Payment Gateway registered');
  },

  async boot({ cms }) {
    try {
      const result = await require('./services/SettingsService').migrateAllPlaintextSecrets(cms);
      if (result.migrated) {
        cms.logger.info('[razorpay-payment-gateway] Plaintext credentials migrated to encrypted storage');
      }
    } catch (error) {
      cms.logger.warn(
        '[razorpay-payment-gateway] Credential migration skipped:',
        error instanceof Error ? error.message : error
      );
    }
    cms.logger.info('Razorpay Payment Gateway booted — credentials encrypted at rest');
  },

  shutdown() {
    console.log('[plugin:razorpay-payment-gateway] shutdown');
  },
};
