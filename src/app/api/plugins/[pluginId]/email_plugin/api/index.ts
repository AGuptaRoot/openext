module.exports = {
  register({ cms }) {
    cms.logger.info('Email Service plugin registered');
  },

  boot({ cms }) {
    cms.logger.info('Email Service plugin booted');
  },

  shutdown() {
    console.log('[plugin:email_plugin] shutdown');
  },
};
