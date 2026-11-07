module.exports = {
  name: '001_init_s3_media',
  async up(cms) {
    await cms.database.user();

    const s3Config = require('../models/S3Config');
    cms.models.register(s3Config.name, s3Config.schema);

    cms.logger.info('S3 Media plugin config collection registered (images stored in S3 only)');
  },
};
