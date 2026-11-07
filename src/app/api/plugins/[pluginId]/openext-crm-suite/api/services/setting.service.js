'use strict';

/**
 * Default CRM settings seeded on install (Phase 1 plan Section 6.1).
 * Each entry becomes one row in plugin_openext_crm_suite_settings.
 */
const DEFAULT_SETTINGS = [
  { key: 'company_name', value: '', category: 'general' },
  {
    key: 'enabled_modules',
    value: {
      expenses: false,
      marketing: false,
      customer_success: false,
      data_quality: false
    },
    category: 'general'
  },
  /**
   * CRM-owned extension that fixes the workspace mode (Settings → Extensions).
   * Changed only through /crm-extensions/:id/enable so request types and the
   * opportunity pipeline switch with it; bulk PUT /settings ignores it.
   */
  { key: 'active_extension', value: 'product', category: 'general' },
  { key: 'company_state', value: 'Maharashtra', category: 'general' },
  { key: 'default_currency', value: 'INR', category: 'general' },
  { key: 'tax_rate', value: 18, category: 'finance' },
  {
    key: 'state_shipping_rates',
    value: {
      'Maharashtra': 100,
      'Gujarat': 150,
      'Karnataka': 150,
      'Delhi': 250,
      'Tamil Nadu': 250,
      'Uttar Pradesh': 250,
      'West Bengal': 250,
      'Rajasthan': 200,
      'Assam': 350,
      'Other': 300
    },
    category: 'logistics'
  },
  { key: 'free_shipping_threshold', value: 5000, category: 'logistics' },
  { key: 'quotation_prefix', value: 'QUO-', category: 'finance' },
  { key: 'sales_order_prefix', value: 'SO-', category: 'finance' },
  { key: 'invoice_prefix', value: 'INV-', category: 'finance' },
  /*
   * Proforma & advance payment.
   *
   * Off by default: a proforma is an extra document with its own numbering and
   * its own GST treatment, so a tenant opts in. While off, no proforma can be
   * created and a payment never accepts a quotation — existing proformas and
   * their payments stay exactly as they are.
   */
  { key: 'proforma_advance_enabled', value: false, category: 'finance' },
  /** Only meaningful while proforma_advance_enabled is on. */
  { key: 'quotation_auto_accept_on_payment', value: false, category: 'finance' },
  { key: 'auto_convert_proforma_on_delivery', value: false, category: 'finance' },
  /**
   * Raise the tax invoice from the proforma as soon as the quotation is accepted and paid in full
   * (the payment moves onto the invoice). For workspaces with no delivery step, e.g. no sales orders.
   * Only meaningful while proforma_advance_enabled is on.
   */
  { key: 'auto_invoice_on_full_payment', value: false, category: 'finance' },
  /**
   * Settings → General (shown when the active extension declares salesFlow.bookingAfterAdvance):
   * an extension's booking (fulfilment) may start once the required advance is verified. Off: only once
   * the quotation is paid in full. Read through sdk.finance.quotationPayment().bookingEligible.
   */
  { key: 'allow_booking_after_advance', value: false, category: 'finance' },
  { key: 'proforma_prefix', value: 'PI-', category: 'finance' },
  /** Default advance when a quotation asks for one (percent of the total). */
  { key: 'default_advance_percent', value: 30, category: 'finance' },
  { key: 'payment_prefix', value: 'PAY-', category: 'finance' },
  { key: 'expense_prefix', value: 'EXP-', category: 'finance' },
  { key: 'client_tax_id_prefix', value: 'TAX-', category: 'finance' },
  { key: 'quotation_valid_days', value: 30, category: 'finance' },
  {
    key: 'pipeline_stages',
    value: ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Won', 'Lost'],
    category: 'pipeline'
  },
  {
    key: 'opportunity_stages',
    value: [
      'Discovery',
      'Requirement Confirmed',
      'Product Validated',
      'Sample Approved',
      'Commercial Discussion',
      'Quotation Sent',
      'Won',
      'Negotiation',
      'Lost'
    ],
    category: 'pipeline'
  },
  {
    key: 'opportunity_stage_probabilities',
    value: {
      Discovery: 10,
      'Requirement Confirmed': 25,
      'Product Validated': 40,
      'Sample Approved': 55,
      'Commercial Discussion': 70,
      Negotiation: 85,
      'Quotation Sent': 95,
      Won: 100,
      Lost: 0
    },
    category: 'pipeline'
  },
  {
    key: 'task_statuses',
    value: ['To Do', 'In Progress', 'Review', 'Completed', 'On Hold'],
    category: 'tasks'
  },
  {
    key: 'task_priorities',
    value: ['Low', 'Medium', 'High', 'Urgent'],
    category: 'tasks'
  },
  { key: 'task_client_reminder_hours', value: 24, category: 'tasks' },
  { key: 'task_client_reminder_auto_enabled', value: false, category: 'tasks' },
  { key: 'default_hourly_rate', value: 0, category: 'finance' },
  { key: 'quotation_sequence', value: 0, category: 'finance' },
  { key: 'sales_order_sequence', value: 0, category: 'finance' },
  { key: 'invoice_sequence', value: 0, category: 'finance' },
  { key: 'proforma_sequence', value: 0, category: 'finance' },
  { key: 'payment_sequence', value: 0, category: 'finance' },
  { key: 'expense_sequence', value: 0, category: 'finance' },
  {
    key: 'expense_categories',
    value: ['Travel', 'Software', 'Office Supplies', 'Marketing', 'Hardware / Equipment', 'Meals & Entertainment', 'Professional Services', 'Utilities', 'Other'],
    category: 'finance'
  },
  {
    key: 'sales_order_generated_by_sources',
    value: ['Root CRM', 'Direct Sales', 'E-Commerce Store', 'POS Terminal', 'Client Portal'],
    category: 'logistics'
  },
  {
    key: 'bank_accounts',
    value: [
      {
        id: 'bank-1',
        accountName: 'Primary Operating Account',
        bankName: 'HDFC Bank',
        accountNumber: '50200012345678',
        ifscCode: 'HDFC0001234',
        branch: 'Main Branch',
        currency: 'INR',
        isDefault: true
      }
    ],
    category: 'finance'
  },
  { key: 'client_tax_id_sequence', value: 0, category: 'finance' },
  { key: 'payment_terms_days', value: 30, category: 'finance' },
  { key: 'email_enabled', value: false, category: 'email' },
  { key: 'smtp_host', value: '', category: 'email' },
  { key: 'smtp_port', value: 587, category: 'email' },
  { key: 'smtp_secure', value: false, category: 'email' },
  { key: 'smtp_user', value: '', category: 'email' },
  { key: 'smtp_pass', value: '', category: 'email' },
  { key: 'mail_from', value: '', category: 'email' },
  { key: 'mail_from_name', value: '', category: 'email' },
  {
    key: 'quotation_email_subject',
    value: 'Quotation {{docNo}} from {{companyName}}',
    category: 'email'
  },
  {
    key: 'invoice_email_subject',
    value: 'Invoice {{docNo}} from {{companyName}}',
    category: 'email'
  },
  {
    key: 'quotation_email_intro',
    value: 'Please review the quotation details below.',
    category: 'email'
  },
  {
    key: 'invoice_email_intro',
    value: 'Please find your invoice details below.',
    category: 'email'
  },
  {
    key: 'client_categories',
    value: ['VIP', 'Enterprise', 'SMB', 'Retainer', 'Strategic', 'Standard'],
    category: 'general'
  },
  {
    key: 'client_statuses',
    value: ['Active', 'Inactive'],
    category: 'general'
  },
  {
    key: 'project_statuses',
    value: ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'],
    category: 'projects'
  },
  {
    key: 'project_priorities',
    value: ['Low', 'Medium', 'High', 'Urgent'],
    category: 'projects'
  },
  {
    key: 'project_categories',
    value: ['Web Development', 'Mobile App', 'UI/UX Design', 'Marketing / SEO', 'Cloud / DevOps', 'Consulting', 'Maintenance', 'Internal'],
    category: 'projects'
  },
  {
    key: 'project_tags',
    value: ['Client Project', 'Internal', 'High Priority', 'Bug Fix', 'Feature MVP', 'Maintenance', 'Q3 Deliverable', 'Design System'],
    category: 'projects'
  },
  {
    key: 'project_labels',
    value: ['High Priority', 'Feature', 'Bug Fix', 'Urgent', 'Internal', 'Client Work', 'Q3 Deliverable'],
    category: 'projects'
  },
  {
    key: 'project_custom_fields',
    value: [],
    category: 'projects'
  },
  {
    key: 'lead_sources',
    value: ['Website', 'Referral', 'Cold Call', 'LinkedIn', 'Google Ads', 'Organic Search', 'Trade Show', 'Email Campaign', 'OCR', 'Other'],
    category: 'pipeline'
  },
  {
    key: 'lead_statuses',
    value: ['Hot', 'Warm', 'Cold', 'New', 'Contacted', 'Qualified', 'Won', 'Lost'],
    category: 'pipeline'
  },
  {
    key: 'lead_types',
    value: ['Organizational', 'Individual'],
    category: 'pipeline'
  },
  {
    key: 'lead_priorities',
    value: ['Low', 'Medium', 'High', 'Urgent'],
    category: 'pipeline'
  },
  {
    key: 'lead_tags',
    value: ['Enterprise', 'Hot Lead', 'Follow Up', 'Decision Maker', 'Inbound', 'Outbound', 'High Value', 'Partner'],
    category: 'pipeline'
  },
  {
    key: 'activity_types',
    value: ['Call', 'Meeting', 'Follow up', 'WhatsApp', 'Other'],
    category: 'pipeline'
  },
  {
    key: 'lead_custom_fields',
    value: [],
    category: 'pipeline'
  },
  {
    key: 'qualification_match',
    value: {
      projectSoftwareTypes: ['Web App', 'Mobile App', 'Embedded System', 'Desktop Software', 'Other'],
      projectTechnologies: ['React', 'Next.js', 'Node.js', 'Python', '.NET', 'Java', 'Flutter'],
      projectUserBands: ['1-10', '11-50', '51-200', '201-1000', '1000+'],
      projectIntegrations: ['CRM', 'ERP', 'Payment Gateway', 'Email / SMS', 'Accounting', 'Custom API'],
      productCategories: ['Hardware', 'Software License', 'SaaS Subscription', 'Accessory', 'Spare Part'],
      productSpecifications: ['Standard', 'Premium', 'Custom', 'Industrial Grade'],
      productCertifications: ['ISO', 'CE', 'BIS', 'RoHS', 'None']
    },
    category: 'pipeline'
  },
  {
    /**
     * When on, saving a lead's commercial requirement asks whether the lead
     * should move to the Qualified stage. Off by default: the prompt is a
     * tenant choice, not a rule, and the requirement save already advances the
     * lead to Contacted on its own.
     */
    key: 'qualification_prompt_on_requirement_save',
    value: false,
    category: 'pipeline'
  },
  {
    /**
     * Lead workflow rules (Settings → Qualification Match). An active extension can
     * tell the CRM when a lead is "ready" (manifest leadWorkflow.readinessRoute);
     * these switches decide what that changes. See services/lead-workflow.service.js.
     */
    key: 'lead_workflow',
    value: {
      opportunityButton: 'qualified_or_ready',
      hideReplacedCommercialRequirement: true,
      autoQualifyReadyLeads: true,
      opportunityLeads: 'qualified_or_ready',
      quotationNeedsOpportunity: 'extension'
    },
    category: 'pipeline'
  },
  {
    key: 'saved_lead_filters',
    value: [],
    category: 'pipeline'
  },
  {
    key: 'data_quality_lead_weights',
    value: { name: 10, email: 15, phone: 15, company: 15, pan: 15, address: 10, owner: 10, duplicates: 10 },
    category: 'dataQuality'
  },
  {
    key: 'data_quality_client_weights',
    value: { name: 15, email: 15, phone: 15, website: 10, address: 15, taxId: 10, contact: 10, duplicates: 10 },
    category: 'dataQuality'
  },
  {
    key: 'data_quality_thresholds',
    value: { excellent: 85, good: 70, needsAttention: 50 },
    category: 'dataQuality'
  },
  /** Encrypted at rest — never returned by GET /settings (see SECRET_SETTING_KEYS). */
  { key: 'groq_api_key', value: '', category: 'integrations' },
  { key: 'groq_api_key_hint', value: '', category: 'integrations' },
  /** "auto" = try Llama first, then public Groq chat models the key can access. */
  { key: 'groq_ocr_model', value: 'auto', category: 'integrations' },
  /** Google Maps / Places — encrypted at rest; client key only via dedicated endpoint. */
  { key: 'google_maps_api_key', value: '', category: 'integrations' },
  { key: 'google_maps_api_key_hint', value: '', category: 'integrations' }
];

const COLLECTION_NAME = 'plugin_openext_crm_suite_settings';

/** Keys exposed on GET/PUT /settings (pipeline has its own endpoints too) */
const KNOWN_KEYS = new Set(DEFAULT_SETTINGS.map((item) => item.key));

/** Secrets that must never appear in GET /settings or bulk PUT /settings. */
const SECRET_SETTING_KEYS = new Set(['groq_api_key', 'google_maps_api_key']);

/**
 * Rows owned by extensions (`ext_<extensionId>_…`) never appear in GET/PUT
 * /settings; extensions read and write them through their own APIs.
 */
const EXTENSION_KEY_RE = /^ext_/;
const EXTENSION_MANAGED_KEYS = Object.freeze({ has: (key) => EXTENSION_KEY_RE.test(String(key || '')) });

/** Readable on GET /settings, but written only by the CRM extension registry. */
const REGISTRY_MANAGED_KEYS = new Set(['active_extension']);

/** Integration keys managed only via /settings/integrations/* endpoints. */
const INTEGRATION_MANAGED_KEYS = new Set([
  'groq_api_key',
  'groq_api_key_hint',
  'groq_ocr_model',
  'google_maps_api_key',
  'google_maps_api_key_hint'
]);

const DEFAULT_GROQ_OCR_MODEL = 'auto';
const PROMPT_GUARD_MODELS = new Set([
  'meta-llama/llama-prompt-guard-2-86m',
  'meta-llama/llama-prompt-guard-2-22m',
  'llama-prompt-guard-2-86m',
  'llama-prompt-guard-2-22m'
]);

/** Deprecated for free/developer Groq keys — still tried first when Auto, but not forced. */
const LEGACY_LLAMA_DEFAULTS = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile'
]);

function normalizeGroqModel(raw) {
  const model = String(raw || '').trim();
  if (!model || PROMPT_GUARD_MODELS.has(model)) return DEFAULT_GROQ_OCR_MODEL;
  // Treat old defaults as Auto so OCR can fall back to accessible models.
  if (LEGACY_LLAMA_DEFAULTS.has(model)) return DEFAULT_GROQ_OCR_MODEL;
  return model.slice(0, 120);
}

function redactSecretsFromMap(map) {
  if (!map || typeof map !== 'object') return map;
  for (const key of SECRET_SETTING_KEYS) {
    if (key in map) delete map[key];
  }
  for (const key of Object.keys(map)) {
    if (EXTENSION_MANAGED_KEYS.has(key)) delete map[key];
  }
  return map;
}

function getSettingModel(req) {
  const Setting = req.cms?.models.get('Setting');
  if (!Setting) {
    throw new Error('Setting model is not registered');
  }
  return Setting;
}

/** Build { key: value } map from an array of setting documents */
function toSettingsMap(documents) {
  const map = {};
  const sorted = [...(documents || [])].sort((a, b) => {
    const ta = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
    const tb = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
    return ta - tb;
  });
  for (const doc of sorted) {
    if (!doc || !doc.key) continue;
    map[doc.key] = doc.value;
  }
  return map;
}

/**
 * Seed default settings for a tenant.
 * Used by install hook and ensureDefaults() on first API read.
 * Uses $setOnInsert so existing values are never overwritten.
 */
async function seedDefaults(cms, tenantId = 'default', createdBy = 'system') {
  const connection = await cms.database.user();
  if (!connection.db) {
    throw new Error('userDB connection is unavailable');
  }

  const collection = connection.db.collection(COLLECTION_NAME);
  const now = new Date();

  for (const setting of DEFAULT_SETTINGS) {
    await collection.updateOne(
      { tenantId, key: setting.key },
      {
        $setOnInsert: {
          tenantId,
          key: setting.key,
          value: setting.value,
          category: setting.category,
          createdBy,
          updatedBy: createdBy,
          status: 'active',
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          createdAt: now,
          updatedAt: now
        }
      },
      { upsert: true }
    );
  }

  // Auto-migrate any setting documents created with category 'clients' to 'general'
  if (typeof collection.updateMany === 'function') {
    await collection.updateMany(
      { category: 'clients' },
      { $set: { category: 'general' } }
    ).catch(() => {});
  }
}

/**
 * Performance: defaults are inserted once per tenant per process (they only ever add missing keys),
 * and one request reads the settings table once (req memo, cleared by every write).
 */
const seededTenants = new Set();
const SETTINGS_MEMO = Symbol.for('crm.settings.memo');

/** Forget this request's settings read (call after writing a setting outside this file). */
function invalidateSettingsCache(req) {
  if (req && typeof req === 'object') req[SETTINGS_MEMO] = null;
}

/** Ensure defaults exist, then return all settings as a flat object */
/**
 * Resolve tenant default currency from a settings map.
 * INR only when no valid 3-letter code is configured (new tenant seed).
 */
function resolveDefaultCurrency(settingsOrCode) {
  const raw =
    typeof settingsOrCode === 'string'
      ? settingsOrCode
      : settingsOrCode?.default_currency;
  const code = String(raw || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'INR';
}

async function getAll(req) {
  // Only real HTTP requests are memoised (jobs may reuse one req object), and only for a few seconds.
  const memoable = Boolean(req && req.headers && typeof req.method === 'string');
  const memo = memoable ? req[SETTINGS_MEMO] : null;
  if (memo && Date.now() - memo.at < 5000) return { ...(await memo.pending) };
  const pending = readAll(req);
  if (memoable) {
    req[SETTINGS_MEMO] = { at: Date.now(), pending };
    pending.catch(() => invalidateSettingsCache(req));
  }
  return { ...(await pending) };
}

async function readAll(req) {
  const tenantId = require('../utils/tenant.util').resolveTenantId(req);
  if (typeof req.cms?.database?.user === 'function' && !seededTenants.has(tenantId)) {
    try {
      await seedDefaults(req.cms, tenantId, require('../utils/tenant.util').resolveUserId(req));
      seededTenants.add(tenantId);
    } catch {
      /* try again on the next read */
    }
  }

  const Setting = getSettingModel(req);
  let rows = [];
  if (typeof Setting.find === 'function') {
    const res = Setting.find({
      tenantId,
      $nor: [{ isDeleted: true }]
    });
    rows = typeof res?.lean === 'function' ? await res.lean() : await res;
  } else if (typeof Setting.findOne === 'function') {
    const single = await (Setting.findOne({ tenantId, $nor: [{ isDeleted: true }] })?.lean?.() || Setting.findOne({ tenantId, $nor: [{ isDeleted: true }] }));
    if (single) rows = [single];
  }
  const map = toSettingsMap(rows);
  map.lead_statuses = mergeLeadStatusesWithBuiltins(map.lead_statuses);
  return redactSecretsFromMap(map);
}

/**
 * Write a setting by tenantId+key only.
 * Avoid filtering on isDeleted in the query — that breaks upserts when the field
 * is missing on older rows and causes "saved" keys to be unreadable later.
 */
async function upsertSettingValue(req, key, value) {
  if (!KNOWN_KEYS.has(key)) {
    const err = new Error(`Unknown setting key: ${key}`);
    err.status = 400;
    throw err;
  }
  const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const Setting = getSettingModel(req);
  const category = DEFAULT_SETTINGS.find((item) => item.key === key)?.category || 'general';

  invalidateSettingsCache(req);
  const updated = await Setting.findOneAndUpdate(
    { tenantId, key },
    {
      $set: {
        value,
        category,
        updatedBy: userId,
        status: 'active',
        isDeleted: false,
        deletedAt: null,
        deletedBy: null
      },
      $setOnInsert: {
        tenantId,
        key,
        createdBy: userId
      }
    },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  invalidateSettingsCache(req); // and after it, so a read during the write is not kept

  // Native-collection fallback if mongoose returned null / empty write
  if (!updated) {
    await writeSettingViaCollection(req, key, value, category, userId, tenantId);
  }

  return updated;
}

async function writeSettingViaCollection(req, key, value, category, userId, tenantId) {
  if (typeof req.cms?.database?.user !== 'function') return;
  const connection = await req.cms.database.user();
  const db = connection?.db || connection;
  if (!db || typeof db.collection !== 'function') return;
  const now = new Date();
  invalidateSettingsCache(req);
  await db.collection(COLLECTION_NAME).updateOne(
    { tenantId, key },
    {
      $set: {
        value,
        category,
        updatedBy: userId,
        status: 'active',
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now
      },
      $setOnInsert: {
        tenantId,
        key,
        createdBy: userId,
        createdAt: now
      }
    },
    { upsert: true }
  );
  invalidateSettingsCache(req); // and after it, so a read during the write is not kept
}

async function readRawSettingValue(req, key) {
  const { resolveTenantId } = require('../utils/tenant.util');
  const tenantId = resolveTenantId(req);

  try {
    const Setting = getSettingModel(req);
    // Do not require isDeleted:false in the filter — older rows may omit the field.
    const doc = await Setting.findOne({ tenantId, key }).lean();
    if (doc && doc.isDeleted !== true) {
      return doc.value;
    }
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] readRawSettingValue mongoose failed:', err?.message || err);
  }

  // Fallback: read directly from the settings collection (same path as seedDefaults).
  try {
    if (typeof req.cms?.database?.user === 'function') {
      const connection = await req.cms.database.user();
      const db = connection?.db || connection;
      if (db && typeof db.collection === 'function') {
        const doc = await db.collection(COLLECTION_NAME).findOne({ tenantId, key });
        if (doc && doc.isDeleted !== true) {
          return doc.value;
        }
      }
    }
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] readRawSettingValue collection failed:', err?.message || err);
  }

  return undefined;
}

/**
 * Public Groq integration status — never includes the raw API key.
 * @returns {{ configured: boolean, hint: string, model: string, source: 'settings'|'env'|'none', message: string, tenantId?: string }}
 */
async function getGroqIntegration(req) {
  const { resolveTenantId } = require('../utils/tenant.util');
  const { decryptCredential } = require('../utils/credential.util');
  const tenantId = resolveTenantId(req);
  const hint = String((await readRawSettingValue(req, 'groq_api_key_hint')) || '').trim();
  const model = normalizeGroqModel(
    (await readRawSettingValue(req, 'groq_ocr_model')) || DEFAULT_GROQ_OCR_MODEL
  );
  const encrypted = String((await readRawSettingValue(req, 'groq_api_key')) || '').trim();
  const envKey = String(process.env.GROQ_API_KEY || process.env.CRM_GROQ_API_KEY || '').trim();

  if (encrypted) {
    let decryptOk = false;
    try {
      decryptOk = Boolean(decryptCredential(encrypted));
    } catch {
      decryptOk = false;
    }
    return {
      configured: decryptOk,
      hint: hint || 'gsk_••••••••',
      model,
      source: 'settings',
      tenantId,
      message: decryptOk
        ? 'Groq API key is stored encrypted for this workspace.'
        : 'A Groq key is stored but cannot be decrypted. Re-save it in Settings → Integrations.'
    };
  }
  if (envKey) {
    const { maskSecretHint } = require('../utils/credential.util');
    return {
      configured: true,
      hint: maskSecretHint(envKey),
      model: normalizeGroqModel(process.env.GROQ_OCR_MODEL || process.env.CRM_GROQ_OCR_MODEL || model),
      source: 'env',
      tenantId,
      message: 'Using GROQ_API_KEY from server environment (Settings key not set).'
    };
  }
  return {
    configured: false,
    hint: hint || '',
    model,
    source: 'none',
    tenantId,
    message: hint
      ? 'Key hint exists but the encrypted key is missing. Paste the Groq API key again and Save.'
      : 'Add a Groq API key to enable visiting-card OCR import.'
  };
}

/**
 * Save Groq API key (encrypted) and/or model. Empty apiKey leaves existing key unchanged.
 * @param {{ apiKey?: string, model?: string, clearKey?: boolean }} input
 */
async function updateGroqIntegration(req, input) {
  const { encryptCredential, maskSecretHint, decryptCredential } = require('../utils/credential.util');
  const AuditService = require('./audit.service');
  const { resolveTenantId } = require('../utils/tenant.util');

  const source = input && typeof input === 'object' ? input : {};
  const clearKey = Boolean(source.clearKey);
  const apiKey = String(source.apiKey || '').trim();
  const modelProvided = 'model' in source;
  const model = modelProvided ? normalizeGroqModel(source.model) : null;

  if (clearKey) {
    await upsertSettingValue(req, 'groq_api_key', '');
    await upsertSettingValue(req, 'groq_api_key_hint', '');
  } else if (apiKey) {
    if (apiKey.length < 20 || apiKey.length > 200) {
      const err = new Error('Groq API key looks invalid (expected 20–200 characters)');
      err.status = 400;
      throw err;
    }
    if (!/^gsk_/i.test(apiKey)) {
      const err = new Error('Groq API key should start with gsk_');
      err.status = 400;
      throw err;
    }
    let encrypted;
    try {
      encrypted = encryptCredential(apiKey);
    } catch (encryptError) {
      const err = new Error(
        encryptError?.message ||
          'Could not encrypt API key. Set CREDENTIAL_ENCRYPTION_KEY or JWT_SECRET on the server.'
      );
      err.status = 503;
      throw err;
    }
    if (!encrypted) {
      const err = new Error('Failed to encrypt Groq API key');
      err.status = 500;
      throw err;
    }

    await upsertSettingValue(req, 'groq_api_key', encrypted);
    await upsertSettingValue(req, 'groq_api_key_hint', maskSecretHint(apiKey));

    // Verify round-trip immediately so UI never shows "saved" when OCR can't read it.
    const stored = String((await readRawSettingValue(req, 'groq_api_key')) || '').trim();
    let verified = '';
    try {
      verified = stored ? decryptCredential(stored) : '';
    } catch (verifyErr) {
      const err = new Error(
        `Groq key was written but could not be read back (${verifyErr?.message || 'decrypt failed'}). Re-try Save.`
      );
      err.status = 500;
      throw err;
    }
    if (verified !== apiKey) {
      const err = new Error(
        'Groq key save verification failed — stored value does not match. Check server logs / DB permissions.'
      );
      err.status = 500;
      throw err;
    }
  }

  if (modelProvided && model) {
    await upsertSettingValue(req, 'groq_ocr_model', model);
  }

  try {
    await AuditService.log(req, {
      action: 'updated',
      module: 'settings',
      recordId: resolveTenantId(req),
      description: clearKey
        ? 'Cleared Groq API key'
        : apiKey
          ? 'Updated Groq API key (encrypted)'
          : 'Updated Groq OCR settings',
      metadata: {
        keys: [
          ...(clearKey || apiKey ? ['groq_api_key'] : []),
          ...(modelProvided ? ['groq_ocr_model'] : [])
        ],
        cleared: clearKey,
        keyRotated: Boolean(apiKey)
      }
    });
  } catch (auditErr) {
    // Key is already persisted — do not fail the save because of audit logging.
    console.warn('[plugin:openext-crm-suite] Groq settings audit log failed:', auditErr?.message || auditErr);
  }

  return getGroqIntegration(req);
}

/** Decrypt tenant Groq key for server-side use only. Never send to clients. */
async function resolveGroqApiKey(req) {
  const { decryptCredential } = require('../utils/credential.util');
  const encrypted = String((await readRawSettingValue(req, 'groq_api_key')) || '').trim();
  if (encrypted) {
    try {
      const decrypted = decryptCredential(encrypted);
      if (decrypted) return { apiKey: decrypted, source: 'settings' };
    } catch (err) {
      console.error(
        '[plugin:openext-crm-suite] Groq key decrypt failed:',
        err?.message || err
      );
      const error = new Error(
        'Stored Groq API key could not be decrypted. Open Settings → Integrations and Save the key again.'
      );
      error.status = 503;
      throw error;
    }
  }
  const envKey = String(process.env.GROQ_API_KEY || process.env.CRM_GROQ_API_KEY || '').trim();
  if (envKey) return { apiKey: envKey, source: 'env' };
  return { apiKey: '', source: 'none' };
}

async function resolveGroqOcrModel(req) {
  const fromSettings = String((await readRawSettingValue(req, 'groq_ocr_model')) || '').trim();
  if (fromSettings) return normalizeGroqModel(fromSettings);
  return normalizeGroqModel(process.env.GROQ_OCR_MODEL || process.env.CRM_GROQ_OCR_MODEL || DEFAULT_GROQ_OCR_MODEL);
}

/**
 * Public Google Maps integration status — never includes the raw API key.
 * @returns {{ configured: boolean, hint: string, source: 'settings'|'env'|'none', message: string, tenantId?: string }}
 */
async function getGoogleMapsIntegration(req) {
  const { resolveTenantId } = require('../utils/tenant.util');
  const { decryptCredential } = require('../utils/credential.util');
  const tenantId = resolveTenantId(req);
  const hint = String((await readRawSettingValue(req, 'google_maps_api_key_hint')) || '').trim();
  const encrypted = String((await readRawSettingValue(req, 'google_maps_api_key')) || '').trim();
  const envKey = String(
    process.env.GOOGLE_MAPS_API_KEY || process.env.CRM_GOOGLE_MAPS_API_KEY || ''
  ).trim();

  if (encrypted) {
    let decryptOk = false;
    try {
      decryptOk = Boolean(decryptCredential(encrypted));
    } catch {
      decryptOk = false;
    }
    return {
      configured: decryptOk,
      hint: hint || 'AIza••••••••',
      source: 'settings',
      tenantId,
      message: decryptOk
        ? 'Google Maps API key is stored encrypted for this workspace.'
        : 'A Google Maps key is stored but cannot be decrypted. Re-save it in Settings → Integrations.'
    };
  }
  if (envKey) {
    const { maskSecretHint } = require('../utils/credential.util');
    return {
      configured: true,
      hint: maskSecretHint(envKey),
      source: 'env',
      tenantId,
      message: 'Using GOOGLE_MAPS_API_KEY from server environment (Settings key not set).'
    };
  }
  return {
    configured: false,
    hint: hint || '',
    source: 'none',
    tenantId,
    message: hint
      ? 'Key hint exists but the encrypted key is missing. Paste the Google Maps API key again and Save.'
      : 'Add a Google Maps API key to enable address search on lead create (Places Autocomplete).'
  };
}

/**
 * Save Google Maps API key (encrypted). Empty apiKey leaves existing key unchanged.
 * @param {{ apiKey?: string, clearKey?: boolean }} input
 */
async function updateGoogleMapsIntegration(req, input) {
  const { encryptCredential, maskSecretHint, decryptCredential } = require('../utils/credential.util');
  const AuditService = require('./audit.service');
  const { resolveTenantId } = require('../utils/tenant.util');

  const source = input && typeof input === 'object' ? input : {};
  const clearKey = Boolean(source.clearKey);
  const apiKey = String(source.apiKey || '').trim();

  if (clearKey) {
    await upsertSettingValue(req, 'google_maps_api_key', '');
    await upsertSettingValue(req, 'google_maps_api_key_hint', '');
  } else if (apiKey) {
    if (apiKey.length < 20 || apiKey.length > 200) {
      const err = new Error('Google Maps API key looks invalid (expected 20–200 characters)');
      err.status = 400;
      throw err;
    }
    if (!/^AIza[0-9A-Za-z_-]+$/.test(apiKey)) {
      const err = new Error('Google Maps API key should start with AIza');
      err.status = 400;
      throw err;
    }
    let encrypted;
    try {
      encrypted = encryptCredential(apiKey);
    } catch (encryptError) {
      const err = new Error(
        encryptError?.message ||
          'Could not encrypt API key. Set CREDENTIAL_ENCRYPTION_KEY or JWT_SECRET on the server.'
      );
      err.status = 503;
      throw err;
    }
    if (!encrypted) {
      const err = new Error('Failed to encrypt Google Maps API key');
      err.status = 500;
      throw err;
    }

    await upsertSettingValue(req, 'google_maps_api_key', encrypted);
    await upsertSettingValue(req, 'google_maps_api_key_hint', maskSecretHint(apiKey));

    const stored = String((await readRawSettingValue(req, 'google_maps_api_key')) || '').trim();
    let verified = '';
    try {
      verified = stored ? decryptCredential(stored) : '';
    } catch (verifyErr) {
      const err = new Error(
        `Google Maps key was written but could not be read back (${verifyErr?.message || 'decrypt failed'}). Re-try Save.`
      );
      err.status = 500;
      throw err;
    }
    if (verified !== apiKey) {
      const err = new Error(
        'Google Maps key save verification failed — stored value does not match. Check server logs / DB permissions.'
      );
      err.status = 500;
      throw err;
    }
  }

  try {
    await AuditService.log(req, {
      action: 'updated',
      module: 'settings',
      recordId: resolveTenantId(req),
      description: clearKey
        ? 'Cleared Google Maps API key'
        : apiKey
          ? 'Updated Google Maps API key (encrypted)'
          : 'Updated Google Maps integration',
      metadata: {
        keys: clearKey || apiKey ? ['google_maps_api_key'] : [],
        cleared: clearKey,
        keyRotated: Boolean(apiKey)
      }
    });
  } catch (auditErr) {
    console.warn(
      '[plugin:openext-crm-suite] Google Maps settings audit log failed:',
      auditErr?.message || auditErr
    );
  }

  return getGoogleMapsIntegration(req);
}

/**
 * Resolve Google Maps key for Places Autocomplete.
 * Settings (encrypted) → server env. Returned to authenticated CRM clients only.
 */
async function resolveGoogleMapsApiKey(req) {
  const { decryptCredential } = require('../utils/credential.util');
  const encrypted = String((await readRawSettingValue(req, 'google_maps_api_key')) || '').trim();
  if (encrypted) {
    try {
      const decrypted = decryptCredential(encrypted);
      if (decrypted) return { apiKey: decrypted, source: 'settings' };
    } catch (err) {
      console.error(
        '[plugin:openext-crm-suite] Google Maps key decrypt failed:',
        err?.message || err
      );
      const error = new Error(
        'Stored Google Maps API key could not be decrypted. Open Settings → Integrations and Save the key again.'
      );
      error.status = 503;
      throw error;
    }
  }
  const envKey = String(
    process.env.GOOGLE_MAPS_API_KEY || process.env.CRM_GOOGLE_MAPS_API_KEY || ''
  ).trim();
  if (envKey) return { apiKey: envKey, source: 'env' };
  return { apiKey: '', source: 'none' };
}

/** Update one or more settings from request body { key: value, ... } */
async function updateMany(req, input) {
  const { resolveTenantId } = require('../utils/tenant.util');
  const AuditService = require('./audit.service');

  const tenantId = resolveTenantId(req);
  const updatedKeys = [];

  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_KEYS.has(key)) continue;
    // Integrations / secrets use dedicated encrypted endpoints only.
    if (
      SECRET_SETTING_KEYS.has(key) ||
      INTEGRATION_MANAGED_KEYS.has(key) ||
      EXTENSION_MANAGED_KEYS.has(key) ||
      REGISTRY_MANAGED_KEYS.has(key)
    ) {
      continue;
    }

    // Use tenantId+key upsert (no isDeleted filter) — same path as upsertSettingValue.
    await upsertSettingValue(req, key, value);
    updatedKeys.push(key);
  }

  const result = await getAll(req);

  if (updatedKeys.length > 0) {
    await AuditService.log(req, {
      action: 'updated',
      module: 'settings',
      recordId: tenantId,
      description: `Updated settings: ${updatedKeys.join(', ')}`,
      metadata: { keys: updatedKeys }
    });
  }

  return result;
}

/** Atomically increment a sequence counter stored in settings. */
async function incrementCounter(req, counterKey) {
  const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const Setting = getSettingModel(req);

  const defaultSetting = DEFAULT_SETTINGS.find((item) => item.key === counterKey);
  const category = defaultSetting?.category || 'finance';

  invalidateSettingsCache(req);
  const doc = await Setting.findOneAndUpdate(
    { tenantId, key: counterKey, isDeleted: false },
    {
      $inc: { value: 1 },
      $set: { updatedBy: userId, category },
      $setOnInsert: {
        tenantId,
        key: counterKey,
        createdBy: userId,
        status: 'active',
        isDeleted: false
      }
    },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  invalidateSettingsCache(req); // and after it, so a read during the write is not kept

  return Math.max(1, Number(doc?.value) || 1);
}

/** Ensure a sequence counter is at least `minimumValue` (never decreases). */
async function setCounterAtLeast(req, counterKey, minimumValue) {
  const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const Setting = getSettingModel(req);

  const min = Math.max(0, Number(minimumValue) || 0);
  const defaultSetting = DEFAULT_SETTINGS.find((item) => item.key === counterKey);
  const category = defaultSetting?.category || 'finance';

  const existing = await Setting.findOne({ tenantId, key: counterKey, isDeleted: false }).lean();
  const current = Math.max(0, Number(existing?.value) || 0);
  if (min <= current) return current;
  invalidateSettingsCache(req);

  const doc = await Setting.findOneAndUpdate(
    { tenantId, key: counterKey, isDeleted: false },
    {
      $set: { value: min, updatedBy: userId, category },
      $setOnInsert: {
        tenantId,
        key: counterKey,
        createdBy: userId,
        status: 'active',
        isDeleted: false
      }
    },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  invalidateSettingsCache(req); // and after it, so a read during the write is not kept

  return Math.max(0, Number(doc?.value) || min);
}

/** Pipeline stages only — readable by users with crm.leads.read */
async function getPipelineStages(req) {
  const all = await getAll(req);
  const stages = Array.isArray(all.pipeline_stages) ? all.pipeline_stages : [];
  return stages.filter((stage) => typeof stage === 'string' && stage.trim());
}

/** Resolve the pipeline stage that qualifies a lead for conversion. */
function resolveWonStage(stages) {
  const list = Array.isArray(stages)
    ? stages.map((stage) => String(stage).trim()).filter(Boolean)
    : [];
  if (!list.length) return 'Won';

  const exact = list.find((stage) => stage.toLowerCase() === 'won');
  if (exact) return exact;

  const lostIndex = list.findIndex((stage) => stage.toLowerCase() === 'lost');
  if (lostIndex > 0) return list[lostIndex - 1];

  return list[list.length - 1];
}

/** Update pipeline stages array */
async function updatePipelineStages(req, stages) {
  return updateMany(req, { pipeline_stages: stages });
}

const DEFAULT_OPPORTUNITY_STAGES = [
  'Discovery',
  'Requirement Confirmed',
  'Product Validated',
  'Sample Approved',
  'Commercial Discussion',
  'Quotation Sent',
  'Won',
  'Negotiation',
  'Lost'
];

const DEFAULT_OPPORTUNITY_STAGE_PROBABILITIES = {
  Discovery: 10,
  'Requirement Confirmed': 25,
  'Product Validated': 40,
  'Sample Approved': 55,
  'Commercial Discussion': 70,
  Negotiation: 85,
  'Quotation Sent': 95,
  Won: 100,
  Lost: 0
};

function normalizeOpportunityStageName(stage) {
  const key = String(stage || '').trim();
  if (/^contract reviews?$/i.test(key)) return 'Quotation Sent';
  return key;
}

function normalizeOpportunityStageList(stages) {
  const list = [];
  for (const stage of stages || []) {
    const name = normalizeOpportunityStageName(stage);
    if (name && !list.includes(name)) list.push(name);
  }
  // Negotiation must sit immediately after Won (before Lost).
  const negIdx = list.findIndex((name) => /negotiat/i.test(name));
  const wonIdx = list.findIndex((name) => String(name).trim().toLowerCase() === 'won');
  if (negIdx >= 0 && wonIdx >= 0 && negIdx !== wonIdx + 1) {
    const [negotiation] = list.splice(negIdx, 1);
    const newWonIdx = list.findIndex((name) => String(name).trim().toLowerCase() === 'won');
    list.splice(newWonIdx >= 0 ? newWonIdx + 1 : list.length, 0, negotiation);
  }
  return list;
}

/** Opportunity pipeline stages — readable by users with crm.opportunities.read */
async function getOpportunityStages(req) {
  const all = await getAll(req);
  const stages = Array.isArray(all.opportunity_stages) ? all.opportunity_stages : [];
  const list = normalizeOpportunityStageList(stages);
  return list.length ? list : [...DEFAULT_OPPORTUNITY_STAGES];
}

async function getOpportunityStageProbabilities(req) {
  const all = await getAll(req);
  const raw =
    all.opportunity_stage_probabilities && typeof all.opportunity_stage_probabilities === 'object'
      ? all.opportunity_stage_probabilities
      : {};
  const stages = await getOpportunityStages(req);
  const result = { ...DEFAULT_OPPORTUNITY_STAGE_PROBABILITIES };
  for (const [key, value] of Object.entries(raw)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const normalizedKey = normalizeOpportunityStageName(key);
    result[normalizedKey] = Math.min(100, Math.max(0, Math.round(n)));
  }
  for (const stage of stages) {
    if (result[stage] === undefined) result[stage] = 50;
  }
  return result;
}

async function updateOpportunityStages(req, stages, probabilities) {
  const list = normalizeOpportunityStageList(
    Array.isArray(stages) ? stages : []
  );
  if (!list.length) throw new Error('At least one opportunity stage is required');
  const patch = { opportunity_stages: list };
  if (probabilities && typeof probabilities === 'object') {
    const cleaned = {};
    for (const stage of list) {
      const n = Number(
        probabilities[stage] ??
          (stage === 'Quotation Sent' ? probabilities['Contract Review'] : undefined)
      );
      cleaned[stage] = Number.isFinite(n)
        ? Math.min(100, Math.max(0, Math.round(n)))
        : DEFAULT_OPPORTUNITY_STAGE_PROBABILITIES[stage] ?? 50;
    }
    patch.opportunity_stage_probabilities = cleaned;
  }
  return updateMany(req, patch);
}

const BUILTIN_PROJECT_STATUSES = Object.freeze([
  'Not Started',
  'In Progress',
  'On Hold',
  'Completed',
  'Cancelled',
]);

/** Always keep built-in statuses first; append unique custom statuses only. */
function mergeProjectStatusesWithBuiltins(statuses) {
  const incoming = Array.isArray(statuses)
    ? statuses.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const result = [...BUILTIN_PROJECT_STATUSES];
  for (const status of incoming) {
    if (!result.some((s) => s.toLowerCase() === status.toLowerCase())) {
      result.push(status);
    }
  }
  return result;
}

async function getProjectStatuses(req) {
  const all = await getAll(req);
  const statuses = Array.isArray(all.project_statuses) ? all.project_statuses : [];
  return mergeProjectStatusesWithBuiltins(statuses);
}

async function addProjectStatus(req, statusName) {
  const cleanName = String(statusName || '').trim();
  if (!cleanName) throw new Error('Status name is required');
  const current = await getProjectStatuses(req);
  if (!current.some((s) => s.toLowerCase() === cleanName.toLowerCase())) {
    const updated = mergeProjectStatusesWithBuiltins([...current, cleanName]);
    await updateMany(req, { project_statuses: updated });
    return updated;
  }
  return current;
}

async function updateProjectStatuses(req, statuses) {
  const list = mergeProjectStatusesWithBuiltins(statuses);
  if (!list.length) throw new Error('At least one project status is required');
  await updateMany(req, { project_statuses: list });
  return list;
}

async function getProjectPriorities(req) {
  const all = await getAll(req);
  const priorities = Array.isArray(all.project_priorities) ? all.project_priorities : [];
  const list = priorities.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Low', 'Medium', 'High', 'Urgent'];
}

async function addProjectPriority(req, priorityName) {
  const cleanName = String(priorityName || '').trim();
  if (!cleanName) throw new Error('Priority name is required');
  const current = await getProjectPriorities(req);
  if (!current.some((p) => p.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { project_priorities: updated });
    return updated;
  }
  return current;
}

async function updateProjectPriorities(req, priorities) {
  const list = Array.isArray(priorities) ? priorities.map((p) => String(p || '').trim()).filter(Boolean) : [];
  if (!list.length) throw new Error('At least one project priority is required');
  await updateMany(req, { project_priorities: list });
  return list;
}

async function getTaskStatuses(req) {
  const all = await getAll(req);
  const statuses = Array.isArray(all.task_statuses) ? all.task_statuses : [];
  const list = statuses.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['To Do', 'In Progress', 'Review', 'Completed', 'On Hold'];
}

async function getTaskPriorities(req) {
  const all = await getAll(req);
  const priorities = Array.isArray(all.task_priorities) ? all.task_priorities : [];
  const list = priorities.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Low', 'Medium', 'High', 'Urgent'];
}

async function getTaskClientReminderHours(req) {
  const all = await getAll(req);
  const hrs = Number(all.task_client_reminder_hours);
  return Number.isFinite(hrs) && hrs > 0 ? hrs : 24;
}

async function getTaskClientReminderAutoEnabled(req) {
  const all = await getAll(req);
  return all.task_client_reminder_auto_enabled === true || all.task_client_reminder_auto_enabled === 'true' || all.task_client_reminder_auto_enabled === 1 || all.task_client_reminder_auto_enabled === '1';
}

async function getClientCategories(req) {
  const all = await getAll(req);
  const categories = Array.isArray(all.client_categories) ? all.client_categories : [];
  const list = categories.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['VIP', 'Enterprise', 'SMB', 'Retainer', 'Strategic', 'Standard'];
}

async function addClientCategory(req, categoryName) {
  const cleanName = String(categoryName || '').trim();
  if (!cleanName) throw new Error('Category name is required');
  const current = await getClientCategories(req);
  if (!current.some((c) => c.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { client_categories: updated });
    return updated;
  }
  return current;
}

async function getProjectCategories(req) {
  const all = await getAll(req);
  const categories = Array.isArray(all.project_categories) ? all.project_categories : [];
  const list = categories.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Web Development', 'Mobile App', 'UI/UX Design', 'Marketing / SEO', 'Cloud / DevOps', 'Consulting', 'Maintenance', 'Internal'];
}

async function addProjectCategory(req, categoryName) {
  const cleanName = String(categoryName || '').trim();
  if (!cleanName) throw new Error('Category name is required');
  const current = await getProjectCategories(req);
  if (!current.some((c) => c.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { project_categories: updated });
    return updated;
  }
  return current;
}

async function updateProjectCategories(req, categories) {
  const list = Array.isArray(categories) ? categories.map((c) => String(c || '').trim()).filter(Boolean) : [];
  if (!list.length) throw new Error('At least one project category is required');
  await updateMany(req, { project_categories: list });
  return list;
}

async function getProjectTags(req) {
  const all = await getAll(req);
  const tags = Array.isArray(all.project_tags) ? all.project_tags : (Array.isArray(all.project_labels) ? all.project_labels : []);
  const list = tags.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Client Project', 'Internal', 'High Priority', 'Bug Fix', 'Feature MVP', 'Maintenance', 'Q3 Deliverable', 'Design System'];
}

async function addProjectTag(req, tagName) {
  const cleanName = String(tagName || '').trim();
  if (!cleanName) throw new Error('Tag name is required');
  const current = await getProjectTags(req);
  if (!current.some((t) => t.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { project_tags: updated, project_labels: updated });
    return updated;
  }
  return current;
}

async function updateProjectTags(req, tags) {
  const list = Array.isArray(tags) ? tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
  await updateMany(req, { project_tags: list, project_labels: list });
  return list;
}

async function getProjectLabels(req) {
  return getProjectTags(req);
}

async function addProjectLabel(req, labelName) {
  return addProjectTag(req, labelName);
}

async function getProjectCustomFields(req) {
  const all = await getAll(req);
  const fields = Array.isArray(all.project_custom_fields) ? all.project_custom_fields : [];
  return fields;
}

async function addProjectCustomField(req, fieldDef) {
  if (!fieldDef || typeof fieldDef !== 'object') throw new Error('Custom field definition is required');
  const key = String(fieldDef.key || fieldDef.name || '').trim().replace(/\s+/g, '_').toLowerCase();
  const label = String(fieldDef.label || fieldDef.title || key).trim();
  if (!key) throw new Error('Custom field key is required');
  if (!label) throw new Error('Custom field label is required');

  const type = ['text', 'number', 'date', 'select', 'textarea', 'boolean', 'url', 'email'].includes(fieldDef.type)
    ? fieldDef.type
    : 'text';

  const options = Array.isArray(fieldDef.options)
    ? fieldDef.options.map((o) => String(o || '').trim()).filter(Boolean)
    : [];

  const required = Boolean(fieldDef.required);

  const current = await getProjectCustomFields(req);
  const existingIdx = current.findIndex((f) => f.key === key);
  let updated;
  if (existingIdx >= 0) {
    updated = [...current];
    updated[existingIdx] = { key, label, type, options, required };
  } else {
    updated = [...current, { key, label, type, options, required }];
  }

  await updateMany(req, { project_custom_fields: updated });
  return updated;
}

async function updateProjectCustomFields(req, fieldDefs) {
  const list = Array.isArray(fieldDefs) ? fieldDefs.filter((f) => f && typeof f === 'object' && f.key && f.label) : [];
  await updateMany(req, { project_custom_fields: list });
  return list;
}

/**
 * Activity types for lead activities. Tenants manage these in
 * Settings → Leads & Funnels; the LeadEvent schema deliberately has no enum so
 * custom types are allowed.
 */
const FIXED_ACTIVITY_TYPES = ['Call', 'Meeting', 'Follow up', 'WhatsApp'];

async function getActivityTypes(req) {
  const all = await getAll(req);
  const types = Array.isArray(all.activity_types) ? all.activity_types : [];
  const list = types.filter((item) => typeof item === 'string' && item.trim());
  const merged = list.length ? [...list] : ['Call', 'Meeting', 'Follow up', 'WhatsApp', 'Other'];
  for (const f of FIXED_ACTIVITY_TYPES) {
    if (!merged.some((t) => t.toLowerCase() === f.toLowerCase())) {
      merged.push(f);
    }
  }
  return merged;
}

async function addActivityType(req, typeName) {
  const cleanName = String(typeName || '').trim();
  if (!cleanName) throw new Error('Activity type is required');
  const current = await getActivityTypes(req);
  if (!current.some((t) => t.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { activity_types: updated });
    return updated;
  }
  return current;
}

async function updateActivityTypes(req, types) {
  const list = Array.isArray(types) ? types.map((t) => String(t || '').trim()).filter(Boolean) : [];
  for (const f of FIXED_ACTIVITY_TYPES) {
    if (!list.some((t) => t.toLowerCase() === f.toLowerCase())) {
      list.unshift(f);
    }
  }
  await updateMany(req, { activity_types: list });
  return list;
}

async function getLeadSources(req) {
  const all = await getAll(req);
  const sources = Array.isArray(all.lead_sources) ? all.lead_sources : [];
  const list = sources.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Website', 'Referral', 'Cold Call', 'LinkedIn', 'Google Ads', 'Organic Search', 'Trade Show', 'Email Campaign', 'OCR', 'Other'];
}

async function addLeadSource(req, sourceName) {
  const cleanName = String(sourceName || '').trim();
  if (!cleanName) throw new Error('Source name is required');
  const current = await getLeadSources(req);
  if (!current.some((s) => s.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { lead_sources: updated });
    return updated;
  }
  return current;
}

async function updateLeadSources(req, sources) {
  const list = Array.isArray(sources) ? sources.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!list.length) throw new Error('At least one lead source is required');
  await updateMany(req, { lead_sources: list });
  return list;
}

const DEFAULT_LEAD_STATUS_LIST = [
  'Hot',
  'Warm',
  'Cold',
  'New',
  'Contacted',
  'Qualified',
  'Won',
  'Lost'
];

/** Temperature statuses always available on lead Status fields. */
const BUILTIN_LEAD_TEMPERATURE_STATUSES = ['Hot', 'Warm', 'Cold'];

function mergeLeadStatusesWithBuiltins(statuses) {
  const seen = new Set();
  const out = [];
  for (const item of [...BUILTIN_LEAD_TEMPERATURE_STATUSES, ...(Array.isArray(statuses) ? statuses : [])]) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length ? out : [...DEFAULT_LEAD_STATUS_LIST];
}

async function getLeadStatuses(req) {
  const all = await getAll(req);
  const statuses = Array.isArray(all.lead_statuses) ? all.lead_statuses : [];
  const list = statuses.filter((item) => typeof item === 'string' && item.trim());
  return mergeLeadStatusesWithBuiltins(list.length ? list : DEFAULT_LEAD_STATUS_LIST);
}

async function addLeadStatus(req, statusName) {
  const cleanName = String(statusName || '').trim();
  if (!cleanName) throw new Error('Status name is required');
  const current = await getLeadStatuses(req);
  if (!current.some((s) => s.toLowerCase() === cleanName.toLowerCase())) {
    const updated = mergeLeadStatusesWithBuiltins([...current, cleanName]);
    await updateMany(req, { lead_statuses: updated });
    return updated;
  }
  return current;
}

async function updateLeadStatuses(req, statuses) {
  const list = mergeLeadStatusesWithBuiltins(
    Array.isArray(statuses) ? statuses.map((s) => String(s || '').trim()).filter(Boolean) : []
  );
  if (!list.length) throw new Error('At least one lead status is required');
  await updateMany(req, { lead_statuses: list });
  return list;
}

async function getLeadTypes(req) {
  const all = await getAll(req);
  const types = Array.isArray(all.lead_types) ? all.lead_types : [];
  const list = types.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Organizational', 'Individual'];
}

async function addLeadType(req, typeName) {
  const cleanName = String(typeName || '').trim();
  if (!cleanName) throw new Error('Lead type name is required');
  const current = await getLeadTypes(req);
  if (!current.some((s) => s.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { lead_types: updated });
    return updated;
  }
  return current;
}

async function updateLeadTypes(req, types) {
  const list = Array.isArray(types) ? types.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!list.length) throw new Error('At least one lead type is required');
  await updateMany(req, { lead_types: list });
  return list;
}

async function getLeadPriorities(req) {
  const all = await getAll(req);
  const priorities = Array.isArray(all.lead_priorities) ? all.lead_priorities : [];
  const list = priorities.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Low', 'Medium', 'High', 'Urgent'];
}

async function addLeadPriority(req, priorityName) {
  const cleanName = String(priorityName || '').trim();
  if (!cleanName) throw new Error('Lead priority name is required');
  const current = await getLeadPriorities(req);
  if (!current.some((s) => s.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { lead_priorities: updated });
    return updated;
  }
  return current;
}

async function updateLeadPriorities(req, priorities) {
  const list = Array.isArray(priorities) ? priorities.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!list.length) throw new Error('At least one lead priority is required');
  await updateMany(req, { lead_priorities: list });
  return list;
}

async function getLeadTags(req) {
  const all = await getAll(req);
  const tags = Array.isArray(all.lead_tags) ? all.lead_tags : [];
  const list = tags.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['Enterprise', 'Hot Lead', 'Follow Up', 'Decision Maker', 'Inbound', 'Outbound', 'High Value', 'Partner'];
}

async function addLeadTag(req, tagName) {
  const cleanName = String(tagName || '').trim();
  if (!cleanName) throw new Error('Tag name is required');
  const current = await getLeadTags(req);
  if (!current.some((t) => t.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { lead_tags: updated });
    return updated;
  }
  return current;
}

async function updateLeadTags(req, tags) {
  const list = Array.isArray(tags) ? tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
  await updateMany(req, { lead_tags: list });
  return list;
}

async function getLeadCustomFields(req) {
  const all = await getAll(req);
  const fields = Array.isArray(all.lead_custom_fields) ? all.lead_custom_fields : [];
  return fields;
}

async function addLeadCustomField(req, fieldDef) {
  if (!fieldDef || typeof fieldDef !== 'object') throw new Error('Custom field definition is required');
  const key = String(fieldDef.key || fieldDef.name || '').trim().replace(/\s+/g, '_').toLowerCase();
  const label = String(fieldDef.label || fieldDef.title || key).trim();
  if (!key) throw new Error('Custom field key is required');
  if (!label) throw new Error('Custom field label is required');

  const type = ['text', 'number', 'date', 'select', 'textarea', 'boolean', 'url', 'email'].includes(fieldDef.type)
    ? fieldDef.type
    : 'text';

  const options = Array.isArray(fieldDef.options)
    ? fieldDef.options.map((o) => String(o || '').trim()).filter(Boolean)
    : [];

  const required = Boolean(fieldDef.required);

  const current = await getLeadCustomFields(req);
  const existingIdx = current.findIndex((f) => f.key === key);
  let updated;
  if (existingIdx >= 0) {
    updated = [...current];
    updated[existingIdx] = { key, label, type, options, required };
  } else {
    updated = [...current, { key, label, type, options, required }];
  }

  await updateMany(req, { lead_custom_fields: updated });
  return updated;
}

async function updateLeadCustomFields(req, fieldDefs) {
  const list = Array.isArray(fieldDefs) ? fieldDefs.filter((f) => f && typeof f === 'object' && f.key && f.label) : [];
  await updateMany(req, { lead_custom_fields: list });
  return list;
}

async function getClientTags(req) {
  const all = await getAll(req);
  const tags = Array.isArray(all.client_tags) ? all.client_tags : [];
  const list = tags.filter((item) => typeof item === 'string' && item.trim());
  return list.length ? list : ['VIP', 'Key Account', 'Enterprise', 'SMB', 'Referral Partner', 'High Value', 'Monthly Retainer', 'Prospect'];
}

async function addClientTag(req, tagName) {
  const cleanName = String(tagName || '').trim();
  if (!cleanName) throw new Error('Tag name is required');
  const current = await getClientTags(req);
  if (!current.some((t) => t.toLowerCase() === cleanName.toLowerCase())) {
    const updated = [...current, cleanName];
    await updateMany(req, { client_tags: updated });
    return updated;
  }
  return current;
}

async function updateClientTags(req, tags) {
  const list = Array.isArray(tags) ? tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
  await updateMany(req, { client_tags: list });
  return list;
}

async function getClientCustomFields(req) {
  const all = await getAll(req);
  const fields = Array.isArray(all.client_custom_fields) ? all.client_custom_fields : [];
  return fields;
}

async function addClientCustomField(req, fieldDef) {
  if (!fieldDef || typeof fieldDef !== 'object') throw new Error('Custom field definition is required');
  const key = String(fieldDef.key || fieldDef.name || '').trim().replace(/\s+/g, '_').toLowerCase();
  const label = String(fieldDef.label || fieldDef.title || key).trim();
  if (!key) throw new Error('Custom field key is required');
  if (!label) throw new Error('Custom field label is required');

  const type = ['text', 'number', 'date', 'select', 'textarea', 'boolean', 'url', 'email'].includes(fieldDef.type)
    ? fieldDef.type
    : 'text';

  const options = Array.isArray(fieldDef.options)
    ? fieldDef.options.map((o) => String(o || '').trim()).filter(Boolean)
    : [];

  const required = Boolean(fieldDef.required);

  const current = await getClientCustomFields(req);
  const existingIdx = current.findIndex((f) => f.key === key);
  let updated;
  if (existingIdx >= 0) {
    updated = [...current];
    updated[existingIdx] = { key, label, type, options, required };
  } else {
    updated = [...current, { key, label, type, options, required }];
  }

  await updateMany(req, { client_custom_fields: updated });
  return updated;
}

async function updateClientCustomFields(req, fieldDefs) {
  const list = Array.isArray(fieldDefs) ? fieldDefs.filter((f) => f && typeof f === 'object' && f.key && f.label) : [];
  await updateMany(req, { client_custom_fields: list });
  return list;
}

const { DEFAULT_LEAD_WEIGHTS, DEFAULT_CLIENT_WEIGHTS } = require('../utils/data-quality.util');

async function getDataQualityRules(req) {
  const all = await getAll(req);
  return {
    leadWeights: all.data_quality_lead_weights || DEFAULT_LEAD_WEIGHTS,
    clientWeights: all.data_quality_client_weights || DEFAULT_CLIENT_WEIGHTS,
    thresholds: all.data_quality_thresholds || { excellent: 85, good: 70, needsAttention: 50 }
  };
}

async function updateDataQualityRules(req, payload = {}) {
  const updates = {};
  if (payload.leadWeights && typeof payload.leadWeights === 'object') {
    updates.data_quality_lead_weights = { ...DEFAULT_LEAD_WEIGHTS, ...payload.leadWeights };
  }
  if (payload.clientWeights && typeof payload.clientWeights === 'object') {
    updates.data_quality_client_weights = { ...DEFAULT_CLIENT_WEIGHTS, ...payload.clientWeights };
  }
  if (payload.thresholds && typeof payload.thresholds === 'object') {
    updates.data_quality_thresholds = {
      excellent: Number(payload.thresholds.excellent) || 85,
      good: Number(payload.thresholds.good) || 70,
      needsAttention: Number(payload.thresholds.needsAttention) || 50
    };
  }

  if (Object.keys(updates).length) {
    await updateMany(req, updates);
  }
  return getDataQualityRules(req);
}

/**
 * Auto-convert proforma to tax invoice when a sales order is delivered.
 * Only meaningful while proforma_advance_enabled is on.
 */
async function isAutoConvertOnDeliveryEnabled(req) {
  try {
    const settings = await getAll(req);
    return Boolean(
      settings.proforma_advance_enabled && settings.auto_convert_proforma_on_delivery
    );
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  KNOWN_KEYS,
  SECRET_SETTING_KEYS,
  EXTENSION_MANAGED_KEYS,
  COLLECTION_NAME,
  seedDefaults,
  resolveDefaultCurrency,
  isAutoConvertOnDeliveryEnabled,
  getAll,
  get: getAll,
  updateMany,
  upsertSettingValue,
  getGroqIntegration,
  updateGroqIntegration,
  resolveGroqApiKey,
  resolveGroqOcrModel,
  getGoogleMapsIntegration,
  updateGoogleMapsIntegration,
  resolveGoogleMapsApiKey,
  incrementCounter,
  invalidateSettingsCache,
  setCounterAtLeast,
  getPipelineStages,
  updatePipelineStages,
  getOpportunityStages,
  getOpportunityStageProbabilities,
  updateOpportunityStages,
  resolveWonStage,
  getProjectStatuses,
  addProjectStatus,
  updateProjectStatuses,
  getProjectPriorities,
  addProjectPriority,
  updateProjectPriorities,
  getTaskStatuses,
  getTaskPriorities,
  getTaskClientReminderHours,
  getTaskClientReminderAutoEnabled,
  getClientCategories,
  addClientCategory,
  getProjectCategories,
  addProjectCategory,
  updateProjectCategories,
  getProjectLabels,
  addProjectLabel,
  getProjectTags,
  addProjectTag,
  updateProjectTags,
  getProjectCustomFields,
  addProjectCustomField,
  updateProjectCustomFields,
  getActivityTypes,
  addActivityType,
  updateActivityTypes,
  getLeadSources,
  addLeadSource,
  updateLeadSources,
  getLeadStatuses,
  addLeadStatus,
  updateLeadStatuses,
  getLeadTypes,
  addLeadType,
  updateLeadTypes,
  getLeadPriorities,
  addLeadPriority,
  updateLeadPriorities,
  getLeadTags,
  addLeadTag,
  updateLeadTags,
  getLeadCustomFields,
  addLeadCustomField,
  updateLeadCustomFields,
  getClientTags,
  addClientTag,
  updateClientTags,
  getClientCustomFields,
  addClientCustomField,
  updateClientCustomFields,
  getDataQualityRules,
  updateDataQualityRules
};
