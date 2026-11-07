const credentialCrypto = require('../utils/credentialCrypto');

function getRazorpayConfigModel(cms) {
  const existing = cms.models.get('RazorpayConfig');
  if (existing) return existing;
  const { schema } = require('../models/RazorpayConfig');
  return cms.models.register('RazorpayConfig', schema);
}

function inferMode(keyId) {
  const id = String(keyId || '').trim();
  if (id.startsWith('rzp_live_')) return 'live';
  if (id.startsWith('rzp_test_')) return 'test';
  return 'test';
}

function isConfigured(doc) {
  const keyId = String(doc?.keyId || '').trim();
  if (!keyId) return false;
  if (doc?.secretStored) return true;
  return Boolean(String(doc?.keySecret || '').trim());
}

function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.replace(/rzp_[a-z]+_[A-Za-z0-9]+/gi, '[redacted-key]');
}

const RAZORPAY_API = 'https://api.razorpay.com/v1';

function buildAuthHeader(keyId, keySecret) {
  const token = Buffer.from(`${String(keyId).trim()}:${String(keySecret).trim()}`).toString(
    'base64'
  );
  return `Basic ${token}`;
}

async function razorpayRequest(keyId, keySecret, path, options = {}) {
  const url = `${RAZORPAY_API}${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: buildAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.description ||
      data?.error?.reason ||
      data?.message ||
      `Razorpay API error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  return data;
}

async function getOrCreateDoc(cms, { withSecret = false } = {}) {
  const RazorpayConfig = getRazorpayConfigModel(cms);
  let query = RazorpayConfig.findOne({});
  if (withSecret) query = query.select('+keySecret');
  let doc = await query.exec();
  if (!doc) {
    doc = await RazorpayConfig.create({});
  }
  return doc;
}

function readStoredSecret(doc) {
  if (!doc || !doc.keySecret) return '';
  const stored = String(doc.keySecret).trim();
  if (!stored) return '';
  return credentialCrypto.decryptCredential(stored);
}

function writeStoredSecret(doc, plainSecret) {
  const plain = String(plainSecret || '').trim();
  if (!plain) {
    doc.keySecret = '';
    doc.secretStored = false;
    doc.secretEncrypted = false;
    return;
  }
  doc.keySecret = credentialCrypto.encryptCredential(plain);
  doc.secretStored = true;
  doc.secretEncrypted = credentialCrypto.isEncryptedCredential(doc.keySecret);
}

async function migratePlaintextSecret(cms, doc) {
  if (!doc || !doc.keySecret) return false;
  const stored = String(doc.keySecret).trim();
  if (!stored || credentialCrypto.isEncryptedCredential(stored)) return false;

  const plain = stored;
  writeStoredSecret(doc, plain);
  await doc.save();
  cms.logger.info('[razorpay-payment-gateway] Migrated plaintext Key Secret to encrypted storage');
  return true;
}

function buildAdminSettings(doc) {
  const keyId = String(doc.keyId || '').trim();
  return {
    keyIdPreview: credentialCrypto.maskCredential(keyId),
    hasKeySecret: Boolean(doc.secretStored),
    secretEncrypted: Boolean(doc.secretEncrypted),
    businessName: String(doc.businessName || ''),
    defaultCurrency: String(doc.defaultCurrency || 'INR'),
    mode: String(doc.mode || inferMode(keyId)),
    configured: isConfigured(doc),
    credentialsUpdatedAt: doc.credentialsUpdatedAt || null,
    encryptionEnabled: true,
  };
}

module.exports = {
  inferMode,
  isConfigured,
  razorpayRequest,
  migratePlaintextSecret,

  async migrateAllPlaintextSecrets(cms) {
    const RazorpayConfig = getRazorpayConfigModel(cms);
    const doc = await RazorpayConfig.findOne({}).select('+keySecret').exec();
    if (!doc) return { migrated: false };
    const migrated = await migratePlaintextSecret(cms, doc);
    return { migrated };
  },

  async wipeStoredCredentials(cms) {
    const RazorpayConfig = getRazorpayConfigModel(cms);
    await RazorpayConfig.deleteMany({});
    cms.logger.info('[razorpay-payment-gateway] Stored credentials wiped');
  },

  async getPublicConfig(cms) {
    const doc = await getOrCreateDoc(cms);
    const configured = isConfigured(doc);
    return {
      configured,
      keyId: configured ? String(doc.keyId).trim() : '',
      businessName: String(doc.businessName || '').trim(),
      currency: String(doc.defaultCurrency || 'INR').trim().toUpperCase(),
      mode: String(doc.mode || inferMode(doc.keyId)),
    };
  },

  async getSettingsForAdmin(cms) {
    const doc = await getOrCreateDoc(cms);
    return buildAdminSettings(doc);
  },

  async updateSettings(cms, payload, actor = {}) {
    const doc = await getOrCreateDoc(cms, { withSecret: true });

    if (payload.keyId !== undefined) {
      const nextKeyId = String(payload.keyId || '').trim();
      const keyCheck = credentialCrypto.validateRazorpayKeyId(nextKeyId);
      if (!keyCheck.ok) throw new Error(keyCheck.message);
      doc.keyId = nextKeyId;
      doc.mode = inferMode(nextKeyId);
    }

    if (payload.keySecret !== undefined && String(payload.keySecret).trim()) {
      const nextSecret = String(payload.keySecret).trim();
      const secretCheck = credentialCrypto.validateRazorpayKeySecret(nextSecret);
      if (!secretCheck.ok) throw new Error(secretCheck.message);
      writeStoredSecret(doc, nextSecret);
    }

    if (!isConfigured(doc)) {
      throw new Error('Key ID and Key Secret are required to connect Razorpay.');
    }

    if (payload.businessName !== undefined) {
      doc.businessName = String(payload.businessName || '').trim().slice(0, 120);
    }
    if (payload.defaultCurrency !== undefined) {
      doc.defaultCurrency = String(payload.defaultCurrency || 'INR')
        .trim()
        .toUpperCase()
        .slice(0, 8);
    }

    doc.credentialsUpdatedAt = new Date();
    doc.credentialsUpdatedBy = String(actor.userId || actor.id || '').trim();

    await doc.save();
    return buildAdminSettings(doc);
  },

  async testConnection(cms) {
    const creds = await module.exports.getCredentials(cms);
    await razorpayRequest(creds.keyId, creds.keySecret, '/payments?count=1');
    return {
      success: true,
      message: 'Connected to Razorpay successfully.',
      mode: inferMode(creds.keyId),
    };
  },

  async getCredentials(cms) {
    const doc = await getOrCreateDoc(cms, { withSecret: true });
    await migratePlaintextSecret(cms, doc);

    if (!isConfigured(doc)) {
      throw new Error(
        'Razorpay is not configured. Connect your account in Payment Gateway settings.'
      );
    }

    const keySecret = readStoredSecret(doc);
    if (!keySecret) {
      throw new Error('Razorpay Key Secret could not be decrypted. Check CREDENTIAL_ENCRYPTION_KEY.');
    }

    return {
      keyId: String(doc.keyId).trim(),
      keySecret,
      currency: String(doc.defaultCurrency || 'INR').trim().toUpperCase(),
      businessName: String(doc.businessName || '').trim(),
    };
  },

  sanitizeErrorMessage,
};
