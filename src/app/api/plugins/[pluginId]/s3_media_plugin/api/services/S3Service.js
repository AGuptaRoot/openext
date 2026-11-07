const SettingsService = require('./SettingsService');

/** Max object size for any upload through this plugin (50MB). */
const MAX_BYTES = 50 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

function loadAwsSdk() {
  try {
    return require('@aws-sdk/client-s3');
  } catch (error) {
    throw new Error(
      'AWS SDK is not installed. Run npm install @aws-sdk/client-s3 in the NextCMS project root.'
    );
  }
}

function loadPresigner() {
  try {
    return require('@aws-sdk/s3-request-presigner');
  } catch (error) {
    throw new Error(
      'AWS presigner is not installed. Run npm install @aws-sdk/s3-request-presigner in the NextCMS project root.'
    );
  }
}

function safeFileName(name) {
  return String(name || 'upload')
    .replace(/[^a-zA-Z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
}

function normalizePrefix(prefix) {
  return String(prefix || 'nextcms-media')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

function normalizeFolder(folder) {
  return String(folder || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.\./g, '')
    .slice(0, 80);
}

/**
 * Bucket parameter for AWS SDK calls.
 * Access Point ARNs are passed as Bucket (supported by AWS SDK v3).
 */
function resolveBucket(config) {
  const ap = String(config.accessPointArn || '').trim();
  if (ap) return ap;
  return String(config.bucket || '').trim();
}

function parseAccessPointArn(arn) {
  // arn:aws:s3:region:account-id:accesspoint/name
  const match = String(arn || '').match(
    /^arn:aws(?:-[a-z]+)?:s3:([a-z0-9-]+):(\d{12}):accesspoint\/([a-zA-Z0-9._-]+)$/i
  );
  if (!match) return null;
  return { region: match[1], accountId: match[2], name: match[3] };
}

function buildPublicUrl(config, key) {
  if (config.publicUrlBase) {
    return `${config.publicUrlBase.replace(/\/+$/, '')}/${key}`;
  }

  const ap = String(config.accessPointArn || '').trim();
  if (ap) {
    const parsed = parseAccessPointArn(ap);
    if (parsed) {
      return `https://${parsed.name}-${parsed.accountId}.s3-accesspoint.${parsed.region}.amazonaws.com/${key}`;
    }
  }

  const bucket = String(config.bucket || '').trim();
  return `https://${bucket}.s3.${config.region}.amazonaws.com/${key}`;
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  return `https://${value.replace(/\/+$/, '')}`;
}

function createClient(config) {
  const { S3Client } = loadAwsSdk();
  const endpoint = normalizeEndpoint(config.endpoint);
  const clientConfig = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    useArnRegion: true,
  };

  if (endpoint) {
    clientConfig.endpoint = endpoint;
    clientConfig.forcePathStyle = false;
  }

  return new S3Client(clientConfig);
}

function formatAwsError(error) {
  if (!error || typeof error !== 'object') {
    return 'Unknown AWS error';
  }

  const name = error.name || 'Error';
  const message = error.message || 'Request failed';
  return `${name}: ${message}`;
}

function encodeObjectKey(key) {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

function decodeObjectKey(encoded) {
  return Buffer.from(String(encoded), 'base64url').toString('utf8');
}

async function fileToBuffer(file) {
  if (Buffer.isBuffer(file)) return file;
  if (file && Buffer.isBuffer(file.buffer)) return file.buffer;
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Invalid file upload');
  }
  const arrayBuffer = await file.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function getConfigOrThrow(cms) {
  const config = await SettingsService.getFullConfig(cms);
  if (!config.isConfigured) {
    throw new Error(
      'S3 is not configured. Open Dashboard → Settings → Config and save your AWS credentials. Until then, this plugin will not store files locally — configure S3 first.'
    );
  }
  return config;
}

function targetLabel(config) {
  if (config.accessPointArn) return `access point "${config.accessPointArn}"`;
  return `bucket "${config.bucket}"`;
}

function buildObjectKey(config, fileName, folder) {
  const prefix = normalizePrefix(config.prefix);
  const folderPart = normalizeFolder(folder);
  const name = `${Date.now()}-${safeFileName(fileName)}`;
  return folderPart ? `${prefix}/${folderPart}/${name}` : `${prefix}/${name}`;
}

async function putObject(cms, { buffer, contentType, fileName, folder, size }) {
  const config = await getConfigOrThrow(cms);
  const byteLength = size ?? (Buffer.isBuffer(buffer) ? buffer.length : 0);

  if (!byteLength) {
    throw new Error('Empty file upload is not allowed');
  }
  if (byteLength > MAX_BYTES) {
    throw new Error(`File must be smaller than ${Math.round(MAX_BYTES / (1024 * 1024))}MB`);
  }

  const { PutObjectCommand } = loadAwsSdk();
  const client = createClient(config);
  const key = buildObjectKey(config, fileName || 'upload.bin', folder);
  const mime = contentType || 'application/octet-stream';

  await client.send(
    new PutObjectCommand({
      Bucket: resolveBucket(config),
      Key: key,
      Body: buffer,
      ContentType: mime,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  // Durable public/CDN URL — never persist temporary signed viewUrl.
  const url = buildPublicUrl(config, key);
  let viewUrl = url;
  try {
    viewUrl = await module.exports.getSignedViewUrl(cms, key);
  } catch {
    viewUrl = url;
  }

  return {
    key,
    s3Key: key,
    encodedKey: encodeObjectKey(key),
    url,
    filePath: url,
    viewUrl,
    originalName: fileName || key.split('/').pop(),
    mimeType: mime,
    size: byteLength,
    storage: 's3',
  };
}

module.exports = {
  /** @deprecated Prefer validateUploadFile — kept for older callers. */
  ALLOWED_TYPES: IMAGE_TYPES,
  IMAGE_TYPES,
  MAX_BYTES,
  SIGNED_URL_TTL_SECONDS,
  encodeObjectKey,
  decodeObjectKey,
  resolveBucket,
  buildPublicUrl,

  validateImageFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      return 'Image file is required (field name: file)';
    }
    if (!IMAGE_TYPES.has(file.type)) {
      return 'Only JPG, PNG, WEBP, GIF, and AVIF images are allowed';
    }
    if (file.size > MAX_BYTES) {
      return `Image must be smaller than ${Math.round(MAX_BYTES / (1024 * 1024))}MB`;
    }
    return null;
  },

  /**
   * Accept any file type — all bytes are stored in S3 when credentials are configured.
   */
  validateUploadFile(file) {
    if (!file || (typeof file.arrayBuffer !== 'function' && !Buffer.isBuffer(file.buffer))) {
      return 'File is required (field name: file)';
    }
    if (typeof file.size === 'number' && file.size > MAX_BYTES) {
      return `File must be smaller than ${Math.round(MAX_BYTES / (1024 * 1024))}MB`;
    }
    return null;
  },

  async testConnection(cms, overrideConfig) {
    const config = overrideConfig || (await SettingsService.getFullConfig(cms));
    const bucket = resolveBucket(config);

    if (!bucket || !config.region) {
      return {
        ok: false,
        message: 'Provide an S3 bucket name or Access Point ARN, plus region.',
      };
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      return { ok: false, message: 'AWS access key ID and secret access key are required.' };
    }
    if (
      config.accessPointArn &&
      !SettingsService.isAccessPointArn(config.accessPointArn)
    ) {
      return {
        ok: false,
        message:
          'Access Point must be a valid ARN, e.g. arn:aws:s3:us-east-1:123456789012:accesspoint/my-ap',
      };
    }

    try {
      const { HeadBucketCommand, ListObjectsV2Command } = loadAwsSdk();
      const client = createClient(config);

      await client.send(new HeadBucketCommand({ Bucket: bucket }));

      const prefix = normalizePrefix(config.prefix);
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          MaxKeys: 1,
        })
      );

      return {
        ok: true,
        message: `Connected to ${targetLabel(config)} in ${config.region}. All uploads will be stored in Amazon S3 only.`,
        prefix,
        sampleObjectsFound: listed.KeyCount || 0,
        usesAccessPoint: Boolean(config.accessPointArn),
        storage: 's3',
      };
    } catch (error) {
      return { ok: false, message: formatAwsError(error) };
    }
  },

  async getSignedViewUrl(cms, s3Key) {
    const config = await getConfigOrThrow(cms);
    const { GetObjectCommand } = loadAwsSdk();
    const { getSignedUrl } = loadPresigner();
    const client = createClient(config);

    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: resolveBucket(config),
        Key: s3Key,
      }),
      { expiresIn: SIGNED_URL_TTL_SECONDS }
    );
  },

  async listObjects(cms, limit = 50, { imagesOnly = false } = {}) {
    const config = await getConfigOrThrow(cms);
    const { ListObjectsV2Command } = loadAwsSdk();
    const client = createClient(config);
    const prefix = normalizePrefix(config.prefix);
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: resolveBucket(config),
        Prefix: `${prefix}/`,
        MaxKeys: safeLimit,
      })
    );

    let objects = (response.Contents || []).filter(
      (obj) => obj.Key && !obj.Key.endsWith('/')
    );

    if (imagesOnly) {
      objects = objects.filter((obj) => /\.(jpe?g|png|webp|gif|avif)$/i.test(obj.Key));
    }

    objects = objects.sort(
      (a, b) => new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime()
    );

    return Promise.all(
      objects.map(async (obj) => {
        const key = obj.Key;
        const url = buildPublicUrl(config, key);
        let viewUrl = url;
        try {
          viewUrl = await module.exports.getSignedViewUrl(cms, key);
        } catch {
          viewUrl = url;
        }

        return {
          key,
          s3Key: key,
          encodedKey: encodeObjectKey(key),
          originalName: key.split('/').pop() || key,
          size: obj.Size || 0,
          lastModified: obj.LastModified,
          url,
          filePath: url,
          viewUrl,
          storage: 's3',
        };
      })
    );
  },

  async listImages(cms, limit = 50) {
    return module.exports.listObjects(cms, limit, { imagesOnly: true });
  },

  async uploadImage(cms, file, options = {}) {
    const buffer = await fileToBuffer(file);
    return putObject(cms, {
      buffer,
      contentType: file.type || 'application/octet-stream',
      fileName: file.name || 'upload.bin',
      folder: options.folder,
      size: file.size ?? buffer.length,
    });
  },

  /**
   * Upload any file / buffer to S3. Never writes to local disk.
   */
  async uploadFile(cms, file, options = {}) {
    const buffer = await fileToBuffer(file);
    return putObject(cms, {
      buffer,
      contentType: file.type || options.contentType || 'application/octet-stream',
      fileName: file.name || options.fileName || 'upload.bin',
      folder: options.folder,
      size: file.size ?? buffer.length,
    });
  },

  /**
   * Programmatic buffer upload (JSON/base64 or raw Buffer).
   */
  async uploadBuffer(cms, { buffer, contentType, fileName, folder }) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('buffer must be a Buffer');
    }
    return putObject(cms, {
      buffer,
      contentType: contentType || 'application/octet-stream',
      fileName: fileName || 'upload.bin',
      folder,
      size: buffer.length,
    });
  },

  async fetchObject(cms, s3Key) {
    const config = await getConfigOrThrow(cms);
    const { GetObjectCommand } = loadAwsSdk();
    const client = createClient(config);

    const response = await client.send(
      new GetObjectCommand({
        Bucket: resolveBucket(config),
        Key: s3Key,
      })
    );

    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(Buffer.from(chunk));
    }

    return {
      buffer: Buffer.concat(chunks),
      contentType: response.ContentType || 'application/octet-stream',
      contentLength: response.ContentLength || 0,
    };
  },

  /**
   * Store bytes under an exact key for another plugin (api/storage-provider.js). Private: no public
   * cache headers and no URL is made for it. Never writes to local disk.
   */
  async putPrivateObject(cms, s3Key, buffer, contentType) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw new Error('Empty file upload is not allowed');
    }
    if (buffer.length > MAX_BYTES) {
      throw new Error(`File must be smaller than ${Math.round(MAX_BYTES / (1024 * 1024))}MB`);
    }
    const config = await getConfigOrThrow(cms);
    const { PutObjectCommand } = loadAwsSdk();
    const client = createClient(config);
    await client.send(
      new PutObjectCommand({
        Bucket: resolveBucket(config),
        Key: s3Key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: 'private, no-store',
      })
    );
    return { key: s3Key, size: buffer.length, storage: 's3' };
  },

  /** The configured media prefix (objects other plugins store must stay outside it). */
  async mediaPrefix(cms) {
    const config = await SettingsService.getPublicConfig(cms);
    return normalizePrefix(config.prefix);
  },

  async deleteObject(cms, s3Key) {
    const config = await getConfigOrThrow(cms);
    const { DeleteObjectCommand } = loadAwsSdk();
    const client = createClient(config);

    await client.send(
      new DeleteObjectCommand({
        Bucket: resolveBucket(config),
        Key: s3Key,
      })
    );
  },
};
