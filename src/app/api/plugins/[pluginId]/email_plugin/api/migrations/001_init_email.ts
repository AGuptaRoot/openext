module.exports = {
  name: '001_init_email',
  async up(cms) {
    await cms.database.user();

    const emailConfig = require('../models/EmailConfig');
    const emailLog = require('../models/EmailLog');

    cms.models.register(emailConfig.name, emailConfig.schema);
    cms.models.register(emailLog.name, emailLog.schema);

    cms.logger.info('Email plugin collections registered (EmailConfig, EmailLog)');
  },
};
