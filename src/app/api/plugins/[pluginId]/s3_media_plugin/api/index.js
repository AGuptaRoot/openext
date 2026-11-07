module.exports = {
  register({ cms }) {
    cms.logger.info(
      'S3 Media Storage plugin registered — uploads go to Amazon S3 when credentials are configured'
    );
  },

  boot({ cms }) {
    cms.logger.info('S3 Media Storage plugin booted');
  },

  shutdown() {
    console.log('[plugin:s3_media_plugin] shutdown');
  },
};
