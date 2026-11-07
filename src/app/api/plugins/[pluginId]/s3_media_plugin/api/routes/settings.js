const SettingsService = require('../services/SettingsService');
const S3Service = require('../services/S3Service');
const { canAccess } = require('../utils/permissions');

function mergeTestConfig(base, payload) {
  const next = { ...(base || {}) };

  if (typeof payload.bucket === 'string') next.bucket = payload.bucket.trim();
  if (typeof payload.accessPointArn === 'string') {
    next.accessPointArn = payload.accessPointArn.trim();
  }
  if (typeof payload.endpoint === 'string') next.endpoint = payload.endpoint.trim();
  if (typeof payload.region === 'string') next.region = payload.region.trim();
  if (typeof payload.prefix === 'string') {
    next.prefix = payload.prefix.trim() || 'nextcms-media';
  }
  if (typeof payload.publicUrlBase === 'string') {
    next.publicUrlBase = payload.publicUrlBase.trim();
  }
  if (typeof payload.accessKeyId === 'string' && payload.accessKeyId.trim()) {
    next.accessKeyId = payload.accessKeyId.trim();
  }
  if (typeof payload.secretAccessKey === 'string' && payload.secretAccessKey.trim()) {
    next.secretAccessKey = payload.secretAccessKey.trim();
  }

  return next;
}

module.exports = (app) => {
  app.get('/settings', async (req, res) => {
    if (!canAccess(req, 's3.read')) {
      return res.status(403).json({ message: 'Missing permission: s3.read' });
    }

    const settings = await SettingsService.getPublicConfig(req.cms);
    const status = await SettingsService.getStorageStatus(req.cms);
    res.json({ settings, status });
  });

  app.get('/settings/status', async (req, res) => {
    if (!canAccess(req, 's3.read')) {
      return res.status(403).json({ message: 'Missing permission: s3.read' });
    }

    const status = await SettingsService.getStorageStatus(req.cms);
    res.json({ success: true, ...status });
  });

  app.put('/settings', async (req, res) => {
    if (!canAccess(req, 's3.configure')) {
      return res.status(403).json({ message: 'Missing permission: s3.configure' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};

    try {
      const settings = await SettingsService.updateConfig(req.cms, payload);
      const connection = await S3Service.testConnection(req.cms);
      const status = await SettingsService.getStorageStatus(req.cms);

      res.json({
        settings,
        connection,
        status,
        message: connection.ok
          ? 'S3 settings saved. All media from this plugin will be stored in Amazon S3 only.'
          : 'Settings saved, but S3 connection test failed — uploads will fail until connection works.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save settings';
      res.status(400).json({ message });
    }
  });

  app.post('/settings/test', async (req, res) => {
    if (!canAccess(req, 's3.configure')) {
      return res.status(403).json({ message: 'Missing permission: s3.configure' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    let config = null;

    if (payload.useSaved !== false) {
      config = await SettingsService.getFullConfig(req.cms);
    }

    const hasOverride =
      payload.bucket ||
      payload.accessPointArn ||
      payload.endpoint ||
      payload.region ||
      payload.accessKeyId ||
      payload.secretAccessKey;

    if (hasOverride) {
      config = mergeTestConfig(config, payload);
    }

    const connection = await S3Service.testConnection(req.cms, config || undefined);
    res.json({ connection });
  });
};
