const {
  encryptCredential,
  decryptCredential,
  maskCredential,
  isEncryptedCredential,
} = require('../utils/credentialCrypto');

function getS3ConfigModel(cms) {
  const existing = cms.models.get('S3Config');
  if (existing) return existing;
  const { schema } = require('../models/S3Config');
  return cms.models.register('S3Config', schema);
}

function isAccessPointArn(value) {
  return /^arn:aws(-[a-z]+)?:s3:[a-z0-9-]+:\d{12}:accesspoint\/[a-zA-Z0-9._-]+$/i.test(
    String(value || '').trim()
  );
}

function looksLikeAccessPointAlias(value) {
  return /\.s3-accesspoint\./i.test(String(value || ''));
}

function sanitizeForClient(doc) {
  const bucket = doc.bucket || '';
  const accessPointArn = doc.accessPointArn || '';
  const endpoint = doc.endpoint || '';
  const region = doc.region || 'us-east-1';
  const prefix = doc.prefix || 'nextcms-media';
  const accessKeyId = decryptCredential(doc.accessKeyId || '');
  const secretAccessKey = decryptCredential(doc.secretAccessKey || '');
  const hasTarget = Boolean(bucket || accessPointArn);

  return {
    bucket,
    accessPointArn,
    endpoint,
    region,
    prefix,
    publicUrlBase: doc.publicUrlBase || '',
    hasCredentials: Boolean(accessKeyId && secretAccessKey),
    isConfigured: Boolean(hasTarget && region && accessKeyId && secretAccessKey),
    usesAccessPoint: Boolean(accessPointArn),
    accessKeyIdPreview: accessKeyId ? maskCredential(accessKeyId) : '',
    storageMode: hasTarget && region && accessKeyId && secretAccessKey ? 's3' : 'unconfigured',
  };
}

async function getOrCreateDoc(cms) {
  const S3Config = getS3ConfigModel(cms);
  let doc = await S3Config.findOne({});
  if (!doc) {
    doc = await S3Config.create({});
  }
  return doc;
}

module.exports = {
  isAccessPointArn,
  looksLikeAccessPointAlias,

  async getPublicConfig(cms) {
    const doc = await getOrCreateDoc(cms);
    return sanitizeForClient(doc.toObject());
  },

  async getFullConfig(cms) {
    const doc = await getOrCreateDoc(cms);
    const plain = doc.toObject();
    return {
      ...sanitizeForClient(plain),
      accessKeyId: decryptCredential(plain.accessKeyId || ''),
      secretAccessKey: decryptCredential(plain.secretAccessKey || ''),
    };
  },

  async getStorageStatus(cms) {
    const settings = await module.exports.getPublicConfig(cms);
    if (settings.isConfigured) {
      return {
        storage: 's3',
        configured: true,
        message:
          'Credentials are saved. All media uploaded through this plugin is stored only in Amazon S3 — nothing is written to local disk.',
        bucket: settings.bucket || null,
        accessPointArn: settings.accessPointArn || null,
        region: settings.region,
        prefix: settings.prefix,
        publicUrlBase: settings.publicUrlBase || null,
      };
    }

    return {
      storage: 'unconfigured',
      configured: false,
      message:
        'S3 credentials are not configured yet. Save bucket/Access Point, region, and AWS keys to store all media in Amazon S3.',
      bucket: null,
      accessPointArn: null,
      region: settings.region || null,
      prefix: settings.prefix || null,
      publicUrlBase: null,
    };
  },

  async updateConfig(cms, payload) {
    const doc = await getOrCreateDoc(cms);
    const current = doc.toObject();

    const updates = {};

    if (typeof payload.bucket === 'string') updates.bucket = payload.bucket.trim();
    if (typeof payload.accessPointArn === 'string') {
      updates.accessPointArn = payload.accessPointArn.trim();
    }
    if (typeof payload.endpoint === 'string') updates.endpoint = payload.endpoint.trim();
    if (typeof payload.region === 'string') updates.region = payload.region.trim() || 'us-east-1';
    if (typeof payload.prefix === 'string') updates.prefix = payload.prefix.trim() || 'nextcms-media';
    if (typeof payload.publicUrlBase === 'string') updates.publicUrlBase = payload.publicUrlBase.trim();

    if (typeof payload.accessKeyId === 'string' && payload.accessKeyId.trim()) {
      updates.accessKeyId = encryptCredential(payload.accessKeyId.trim());
    } else if (current.accessKeyId && !isEncryptedCredential(current.accessKeyId)) {
      // Re-encrypt legacy plaintext keys on next save of other fields.
      updates.accessKeyId = encryptCredential(current.accessKeyId);
    }

    if (typeof payload.secretAccessKey === 'string' && payload.secretAccessKey.trim()) {
      updates.secretAccessKey = encryptCredential(payload.secretAccessKey.trim());
    } else if (current.secretAccessKey && !isEncryptedCredential(current.secretAccessKey)) {
      updates.secretAccessKey = encryptCredential(current.secretAccessKey);
    }

    const nextBucket = updates.bucket ?? current.bucket ?? '';
    const nextAccessPoint = updates.accessPointArn ?? current.accessPointArn ?? '';
    const nextEndpoint = updates.endpoint ?? current.endpoint ?? '';
    const nextRegion = updates.region ?? current.region ?? '';
    const nextAccessKeyId = decryptCredential(updates.accessKeyId ?? current.accessKeyId ?? '');
    const nextSecret = decryptCredential(updates.secretAccessKey ?? current.secretAccessKey ?? '');

    if (nextAccessPoint && !isAccessPointArn(nextAccessPoint)) {
      throw new Error(
        'Access Point must be a valid ARN, e.g. arn:aws:s3:us-east-1:123456789012:accesspoint/my-ap'
      );
    }

    if (nextEndpoint && !/^https?:\/\//i.test(nextEndpoint) && !looksLikeAccessPointAlias(nextEndpoint)) {
      // Allow hostname-only aliases; normalize later in S3Service.
    }

    if (!nextBucket && !nextAccessPoint) {
      throw new Error('Provide either an S3 bucket name or an S3 Access Point ARN.');
    }

    if (!nextRegion) {
      throw new Error('AWS region is required.');
    }

    if (!nextAccessKeyId || !nextSecret) {
      throw new Error('AWS access key ID and secret access key are required.');
    }

    Object.assign(doc, updates);
    await doc.save();

    return sanitizeForClient(doc.toObject());
  },
};
