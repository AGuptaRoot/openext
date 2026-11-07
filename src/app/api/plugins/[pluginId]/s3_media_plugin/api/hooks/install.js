const SettingsService = require('../services/SettingsService');

module.exports = async (cms) => {
  try {
    await SettingsService.getPublicConfig(cms);
  } catch (err) {
    if (cms && cms.logger && typeof cms.logger.warn === 'function') {
      cms.logger.warn(`[s3-media-plugin] Notice during install config read: ${err.message}`);
    }
  }
  if (cms && cms.logger && typeof cms.logger.info === 'function') {
    cms.logger.info(
      'S3 Media plugin installed — configure AWS credentials to store all media in Amazon S3 only (no local disk)'
    );
  }
};
