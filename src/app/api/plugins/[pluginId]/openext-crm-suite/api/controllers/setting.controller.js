'use strict';

const SettingService = require('../services/setting.service');
const MailService = require('../services/mail.service');
const { isValidEmail } = require('../validation/common.util');

/**
 * Validate settings payload before save.
 * Returns an array of error strings (empty = valid).
 */
function validateSettingsInput(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if ('company_name' in source && typeof source.company_name !== 'string') {
    errors.push('company_name must be a string');
  } else if (
    'company_name' in source &&
    String(source.company_name || '').trim().length > 120
  ) {
    errors.push('company_name must be 120 characters or fewer');
  }

  if ('company_state' in source && typeof source.company_state !== 'string') {
    errors.push('company_state must be a string');
  }

  if ('state_shipping_rates' in source && (typeof source.state_shipping_rates !== 'object' || source.state_shipping_rates === null)) {
    errors.push('state_shipping_rates must be an object');
  }

  if ('enabled_modules' in source) {
    if (typeof source.enabled_modules !== 'object' || source.enabled_modules === null || Array.isArray(source.enabled_modules)) {
      errors.push('enabled_modules must be an object');
    } else {
      for (const [key, val] of Object.entries(source.enabled_modules)) {
        if (typeof val !== 'boolean') {
          errors.push(`enabled_modules.${key} must be a boolean`);
        }
      }
    }
  }

  if ('free_shipping_threshold' in source) {
    const threshold = Number(source.free_shipping_threshold);
    if (Number.isNaN(threshold) || threshold < 0) {
      errors.push('free_shipping_threshold must be a non-negative number');
    }
  }

  if ('default_currency' in source) {
    const currency = String(source.default_currency || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push('default_currency must be a 3-letter code (e.g. INR, USD)');
    }
  }

  if ('tax_rate' in source) {
    const rate = Number(source.tax_rate);
    if (Number.isNaN(rate) || rate < 0 || rate > 100) {
      errors.push('tax_rate must be a number between 0 and 100');
    }
  }

  if ('quotation_valid_days' in source) {
    const days = Number(source.quotation_valid_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      errors.push('quotation_valid_days must be an integer between 1 and 3650');
    }
  }

  if ('default_hourly_rate' in source) {
    const rate = Number(source.default_hourly_rate);
    if (!Number.isFinite(rate) || rate < 0) errors.push('default_hourly_rate must be zero or greater');
  }

  if ('task_client_reminder_hours' in source) {
    const hrs = Number(source.task_client_reminder_hours);
    if (!Number.isFinite(hrs) || hrs < 1 || hrs > 720) {
      errors.push('task_client_reminder_hours must be a number between 1 and 720 hours');
    }
  }

  for (const prefixKey of [
    'quotation_prefix',
    'invoice_prefix',
    'payment_prefix',
    'expense_prefix',
    'client_tax_id_prefix'
  ]) {
    const prefix = String(source[prefixKey] || '').trim();
    if (prefixKey in source && !prefix) {
      errors.push(`${prefixKey} cannot be empty`);
    }
    if (prefixKey in source && prefix.length > 20) errors.push(`${prefixKey} must be 20 characters or fewer`);
  }

  if ('expense_categories' in source) {
    if (!Array.isArray(source.expense_categories) || source.expense_categories.length === 0) {
      errors.push('expense_categories must be a non-empty array');
    } else if (
      source.expense_categories.some(
        (item) => typeof item !== 'string' || !String(item).trim()
      )
    ) {
      errors.push('expense_categories must contain non-empty strings');
    }
    if (Array.isArray(source.expense_categories) && source.expense_categories.length > 100) {
      errors.push('expense_categories cannot contain more than 100 values');
    }
  }

  if ('pipeline_stages' in source) {
    if (!Array.isArray(source.pipeline_stages) || source.pipeline_stages.length === 0) {
      errors.push('pipeline_stages must be a non-empty array');
    } else if (
      source.pipeline_stages.some(
        (stage) => typeof stage !== 'string' || !String(stage).trim()
      )
    ) {
      errors.push('pipeline_stages must contain non-empty strings');
    }
    if (Array.isArray(source.pipeline_stages) && source.pipeline_stages.length > 50) {
      errors.push('pipeline_stages cannot contain more than 50 values');
    }
  }

  if ('opportunity_stages' in source) {
    if (!Array.isArray(source.opportunity_stages) || source.opportunity_stages.length === 0) {
      errors.push('opportunity_stages must be a non-empty array');
    } else if (
      source.opportunity_stages.some(
        (stage) => typeof stage !== 'string' || !String(stage).trim()
      )
    ) {
      errors.push('opportunity_stages must contain non-empty strings');
    }
    if (Array.isArray(source.opportunity_stages) && source.opportunity_stages.length > 50) {
      errors.push('opportunity_stages cannot contain more than 50 values');
    }
  }

  if ('opportunity_stage_probabilities' in source) {
    if (
      source.opportunity_stage_probabilities == null ||
      typeof source.opportunity_stage_probabilities !== 'object' ||
      Array.isArray(source.opportunity_stage_probabilities)
    ) {
      errors.push('opportunity_stage_probabilities must be an object');
    }
  }

  if ('project_statuses' in source) {
    if (!Array.isArray(source.project_statuses) || source.project_statuses.length === 0) {
      errors.push('project_statuses must be a non-empty array');
    } else if (source.project_statuses.some((s) => typeof s !== 'string' || !String(s).trim())) {
      errors.push('project_statuses must contain non-empty strings');
    }
  }

  if ('project_priorities' in source) {
    if (!Array.isArray(source.project_priorities) || source.project_priorities.length === 0) {
      errors.push('project_priorities must be a non-empty array');
    } else if (source.project_priorities.some((p) => typeof p !== 'string' || !String(p).trim())) {
      errors.push('project_priorities must contain non-empty strings');
    }
  }

  if ('project_categories' in source) {
    if (!Array.isArray(source.project_categories) || source.project_categories.length === 0) {
      errors.push('project_categories must be a non-empty array');
    } else if (source.project_categories.some((c) => typeof c !== 'string' || !String(c).trim())) {
      errors.push('project_categories must contain non-empty strings');
    }
  }

  if ('project_tags' in source) {
    if (!Array.isArray(source.project_tags)) {
      errors.push('project_tags must be an array');
    }
  }

  if ('project_custom_fields' in source) {
    if (!Array.isArray(source.project_custom_fields)) {
      errors.push('project_custom_fields must be an array');
    }
  }

  if ('lead_sources' in source) {
    if (!Array.isArray(source.lead_sources) || source.lead_sources.length === 0) {
      errors.push('lead_sources must be a non-empty array');
    } else if (source.lead_sources.some((s) => typeof s !== 'string' || !String(s).trim())) {
      errors.push('lead_sources must contain non-empty strings');
    }
  }

  if ('activity_types' in source) {
    if (!Array.isArray(source.activity_types) || source.activity_types.length === 0) {
      errors.push('activity_types must be a non-empty array');
    } else if (source.activity_types.some((s) => typeof s !== 'string' || !String(s).trim())) {
      errors.push('activity_types must contain non-empty strings');
    } else if (source.activity_types.some((s) => String(s).trim().length > 80)) {
      errors.push('activity_types entries must be 80 characters or fewer');
    }
  }

  if ('lead_statuses' in source) {
    if (!Array.isArray(source.lead_statuses) || source.lead_statuses.length === 0) {
      errors.push('lead_statuses must be a non-empty array');
    } else if (source.lead_statuses.some((s) => typeof s !== 'string' || !String(s).trim())) {
      errors.push('lead_statuses must contain non-empty strings');
    }
  }

  if ('lead_types' in source) {
    if (!Array.isArray(source.lead_types) || source.lead_types.length === 0) {
      errors.push('lead_types must be a non-empty array');
    } else if (source.lead_types.some((s) => typeof s !== 'string' || !String(s).trim())) {
      errors.push('lead_types must contain non-empty strings');
    }
  }

  if ('lead_priorities' in source) {
    if (!Array.isArray(source.lead_priorities) || source.lead_priorities.length === 0) {
      errors.push('lead_priorities must be a non-empty array');
    } else if (source.lead_priorities.some((s) => typeof s !== 'string' || !String(s).trim())) {
      errors.push('lead_priorities must contain non-empty strings');
    }
  }

  if ('lead_tags' in source) {
    if (!Array.isArray(source.lead_tags)) {
      errors.push('lead_tags must be an array');
    }
  }

  if ('lead_custom_fields' in source) {
    if (!Array.isArray(source.lead_custom_fields)) {
      errors.push('lead_custom_fields must be an array');
    }
  }

  if ('qualification_prompt_on_requirement_save' in source && typeof source.qualification_prompt_on_requirement_save !== 'boolean') {
    errors.push('qualification_prompt_on_requirement_save must be true or false');
  }

  if ('lead_workflow' in source) {
    const lw = source.lead_workflow;
    if (!lw || typeof lw !== 'object' || Array.isArray(lw)) {
      errors.push('lead_workflow must be an object');
    } else {
      if ('opportunityButton' in lw && !['qualified', 'ready', 'qualified_or_ready'].includes(lw.opportunityButton)) {
        errors.push('lead_workflow.opportunityButton must be qualified, ready or qualified_or_ready');
      }
      if ('opportunityLeads' in lw && !['all', 'qualified_or_ready'].includes(lw.opportunityLeads)) {
        errors.push('lead_workflow.opportunityLeads must be all or qualified_or_ready');
      }
      if ('quotationNeedsOpportunity' in lw && !['extension', 'always', 'never'].includes(lw.quotationNeedsOpportunity)) {
        errors.push('lead_workflow.quotationNeedsOpportunity must be extension, always or never');
      }
      for (const key of ['hideReplacedCommercialRequirement', 'autoQualifyReadyLeads']) {
        if (key in lw && typeof lw[key] !== 'boolean') errors.push(`lead_workflow.${key} must be true or false`);
      }
    }
  }

  if ('qualification_match' in source && (typeof source.qualification_match !== 'object' || source.qualification_match === null || Array.isArray(source.qualification_match))) {
    errors.push('qualification_match must be an object');
  }

  if ('email_enabled' in source && typeof source.email_enabled !== 'boolean') {
    errors.push('email_enabled must be true or false');
  }

  if ('smtp_port' in source) {
    const port = Number(source.smtp_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('smtp_port must be an integer between 1 and 65535');
    }
  }

  if ('smtp_secure' in source && typeof source.smtp_secure !== 'boolean') {
    errors.push('smtp_secure must be true or false');
  }

  for (const emailKey of ['mail_from']) {
    if (emailKey in source && source[emailKey]) {
      const email = String(source[emailKey]).trim();
      if (!isValidEmail(email.toLowerCase())) {
        errors.push(`${emailKey} must be a valid email address`);
      }
    }
  }

  for (const [key, maximum] of Object.entries({
    smtp_host: 255,
    smtp_user: 255,
    mail_from_name: 120,
    quotation_email_subject: 200,
    invoice_email_subject: 200,
    quotation_email_intro: 2000,
    invoice_email_intro: 2000
  })) {
    if (key in source && String(source[key] || '').length > maximum) {
      errors.push(`${key} must be ${maximum} characters or fewer`);
    }
  }

  if (source.email_enabled) {
    if (!String(source.smtp_host || '').trim()) errors.push('smtp_host is required when email delivery is enabled');
    if (!String(source.mail_from || '').trim()) errors.push('mail_from is required when email delivery is enabled');
  }

  return errors;
}

/** Normalize validated input to storable values */
function normalizeSettingsInput(body) {
  const source = body && typeof body === 'object' ? body : {};
  const normalized = {};

  if ('company_name' in source) {
    // Empty company_name on non-General saves should not wipe identity — keep prior via omit,
    // or fall back to a safe default when explicitly blank.
    const trimmedName = String(source.company_name || '').trim();
    if (trimmedName) {
      normalized.company_name = trimmedName;
    }
  }

  if ('company_state' in source) {
    const trimmedState = String(source.company_state || '').trim();
    if (trimmedState) {
      normalized.company_state = trimmedState;
    }
  }

  if ('state_shipping_rates' in source && typeof source.state_shipping_rates === 'object' && source.state_shipping_rates !== null) {
    const rates = {};
    for (const [stateName, rateVal] of Object.entries(source.state_shipping_rates)) {
      const cleanName = String(stateName || '').trim();
      const numRate = Number(rateVal);
      if (cleanName && !Number.isNaN(numRate)) {
        rates[cleanName] = Math.max(0, numRate);
      }
    }
    normalized.state_shipping_rates = rates;
  }

  if ('enabled_modules' in source && typeof source.enabled_modules === 'object' && source.enabled_modules !== null) {
    const rawMods = source.enabled_modules;
    const modules = {};
    if ('expenses' in rawMods) modules.expenses = Boolean(rawMods.expenses);
    if ('marketing' in rawMods) modules.marketing = Boolean(rawMods.marketing);
    if ('customer_success' in rawMods || 'customerSuccess' in rawMods) {
      modules.customer_success = Boolean(
        'customer_success' in rawMods ? rawMods.customer_success : rawMods.customerSuccess
      );
    }
    if ('data_quality' in rawMods || 'dataQuality' in rawMods) {
      modules.data_quality = Boolean('data_quality' in rawMods ? rawMods.data_quality : rawMods.dataQuality);
    }
    normalized.enabled_modules = modules;
  }

  if ('free_shipping_threshold' in source) {
    normalized.free_shipping_threshold = Number(source.free_shipping_threshold) || 0;
  }

  if ('default_currency' in source) {
    normalized.default_currency = String(source.default_currency || 'INR')
      .trim()
      .toUpperCase();
  }

  if ('tax_rate' in source) {
    normalized.tax_rate = Number(source.tax_rate);
  }

  if ('quotation_prefix' in source) {
    normalized.quotation_prefix = String(source.quotation_prefix || '').trim();
  }

  if ('invoice_prefix' in source) {
    normalized.invoice_prefix = String(source.invoice_prefix || '').trim();
  }

  if ('payment_prefix' in source) {
    normalized.payment_prefix = String(source.payment_prefix || '').trim();
  }

  if ('expense_prefix' in source) {
    normalized.expense_prefix = String(source.expense_prefix || '').trim();
  }

  if ('client_tax_id_prefix' in source) {
    normalized.client_tax_id_prefix = String(source.client_tax_id_prefix || '').trim();
  }

  if ('quotation_valid_days' in source) {
    normalized.quotation_valid_days = Number(source.quotation_valid_days);
  }

  if ('pipeline_stages' in source) {
    normalized.pipeline_stages = source.pipeline_stages.map((stage) =>
      String(stage).trim()
    );
  }

  if ('opportunity_stages' in source) {
    const seen = new Set();
    normalized.opportunity_stages = source.opportunity_stages
      .map((stage) => {
        const trimmed = String(stage).trim();
        if (/^contract reviews?$/i.test(trimmed)) return 'Quotation Sent';
        return trimmed;
      })
      .filter((stage) => {
        if (!stage || seen.has(stage)) return false;
        seen.add(stage);
        return true;
      });
  }

  if (
    'opportunity_stage_probabilities' in source &&
    source.opportunity_stage_probabilities &&
    typeof source.opportunity_stage_probabilities === 'object' &&
    !Array.isArray(source.opportunity_stage_probabilities)
  ) {
    const cleaned = {};
    for (const [key, value] of Object.entries(source.opportunity_stage_probabilities)) {
      let stage = String(key || '').trim();
      if (!stage) continue;
      if (/^contract reviews?$/i.test(stage)) stage = 'Quotation Sent';
      const n = Number(value);
      cleaned[stage] = Number.isFinite(n)
        ? Math.min(100, Math.max(0, Math.round(n)))
        : 50;
    }
    normalized.opportunity_stage_probabilities = cleaned;
  }

  if ('project_statuses' in source) {
    const BUILTIN_PROJECT_STATUSES = [
      'Not Started',
      'In Progress',
      'On Hold',
      'Completed',
      'Cancelled',
    ];
    const incoming = source.project_statuses.map((s) => String(s).trim()).filter(Boolean);
    const merged = [...BUILTIN_PROJECT_STATUSES];
    for (const status of incoming) {
      if (!merged.some((s) => s.toLowerCase() === status.toLowerCase())) {
        merged.push(status);
      }
    }
    normalized.project_statuses = merged;
  }

  if ('project_priorities' in source) {
    normalized.project_priorities = source.project_priorities.map((p) => String(p).trim()).filter(Boolean);
  }

  if ('project_categories' in source) {
    normalized.project_categories = source.project_categories.map((c) => String(c).trim()).filter(Boolean);
  }

  if ('project_tags' in source) {
    normalized.project_tags = source.project_tags.map((t) => String(t).trim()).filter(Boolean);
  }

  if ('project_custom_fields' in source && Array.isArray(source.project_custom_fields)) {
    normalized.project_custom_fields = source.project_custom_fields
      .filter((cf) => cf && typeof cf === 'object' && (cf.key || cf.name || cf.label))
      .map((cf) => ({
        key: String(cf.key || cf.name || cf.label).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        label: String(cf.label || cf.name || cf.key || '').trim(),
        type: ['text', 'number', 'date', 'select', 'textarea', 'boolean', 'url', 'email'].includes(cf.type) ? cf.type : 'text',
        options: Array.isArray(cf.options) ? cf.options.map((o) => String(o).trim()).filter(Boolean) : [],
        required: Boolean(cf.required)
      }));
  }

  if ('lead_sources' in source) {
    normalized.lead_sources = source.lead_sources.map((s) => String(s).trim()).filter(Boolean);
  }

  if ('activity_types' in source) {
    const list = source.activity_types.map((s) => String(s).trim()).filter(Boolean);
    const fixed = ['Call', 'Meeting', 'Follow up', 'WhatsApp'];
    for (const f of fixed) {
      if (!list.some((item) => item.toLowerCase() === f.toLowerCase())) {
        list.unshift(f);
      }
    }
    normalized.activity_types = list;
  }

  if ('lead_statuses' in source) {
    normalized.lead_statuses = source.lead_statuses.map((s) => String(s).trim()).filter(Boolean);
  }

  if ('lead_types' in source) {
    normalized.lead_types = source.lead_types.map((s) => String(s).trim()).filter(Boolean);
  }

  if ('lead_priorities' in source) {
    normalized.lead_priorities = source.lead_priorities.map((s) => String(s).trim()).filter(Boolean);
  }

  if ('lead_tags' in source) {
    normalized.lead_tags = source.lead_tags.map((t) => String(t).trim()).filter(Boolean);
  }

  if ('lead_custom_fields' in source && Array.isArray(source.lead_custom_fields)) {
    normalized.lead_custom_fields = source.lead_custom_fields
      .filter((cf) => cf && typeof cf === 'object' && (cf.key || cf.name || cf.label))
      .map((cf) => ({
        key: String(cf.key || cf.name || cf.label).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        label: String(cf.label || cf.name || cf.key || '').trim(),
        type: ['text', 'number', 'date', 'select', 'textarea', 'boolean', 'url', 'email'].includes(cf.type) ? cf.type : 'text',
        options: Array.isArray(cf.options) ? cf.options.map((o) => String(o).trim()).filter(Boolean) : [],
        required: Boolean(cf.required)
      }));
  }

  if ('default_hourly_rate' in source) {
    normalized.default_hourly_rate = Number(source.default_hourly_rate);
  }

  if ('task_client_reminder_hours' in source) {
    normalized.task_client_reminder_hours = Number(source.task_client_reminder_hours) || 24;
  }

  if ('task_client_reminder_auto_enabled' in source) {
    normalized.task_client_reminder_auto_enabled = Boolean(
      source.task_client_reminder_auto_enabled === true ||
      source.task_client_reminder_auto_enabled === 'true' ||
      source.task_client_reminder_auto_enabled === 1 ||
      source.task_client_reminder_auto_enabled === '1'
    );
  }

  if ('expense_categories' in source) {
    normalized.expense_categories = source.expense_categories.map((item) => String(item).trim());
  }

  if ('email_enabled' in source) {
    normalized.email_enabled = Boolean(source.email_enabled);
  }

  if ('smtp_host' in source) {
    normalized.smtp_host = String(source.smtp_host || '').trim();
  }

  if ('smtp_port' in source) {
    normalized.smtp_port = Number(source.smtp_port);
  }

  if ('smtp_secure' in source) {
    normalized.smtp_secure = Boolean(source.smtp_secure);
  }

  if ('smtp_user' in source) {
    normalized.smtp_user = String(source.smtp_user || '').trim();
  }

  if ('smtp_pass' in source) {
    const pass = String(source.smtp_pass || '');
    if (pass && pass !== '********') {
      normalized.smtp_pass = pass;
    }
  }

  if ('mail_from' in source) {
    normalized.mail_from = String(source.mail_from || '').trim();
  }

  if ('mail_from_name' in source) {
    normalized.mail_from_name = String(source.mail_from_name || '').trim();
  }

  if ('quotation_email_subject' in source) {
    normalized.quotation_email_subject = String(source.quotation_email_subject || '').trim();
  }

  if ('invoice_email_subject' in source) {
    normalized.invoice_email_subject = String(source.invoice_email_subject || '').trim();
  }

  if ('quotation_email_intro' in source) {
    normalized.quotation_email_intro = String(source.quotation_email_intro || '').trim();
  }

  if ('invoice_email_intro' in source) {
    normalized.invoice_email_intro = String(source.invoice_email_intro || '').trim();
  }

  if ('qualification_prompt_on_requirement_save' in source) {
    normalized.qualification_prompt_on_requirement_save = Boolean(
      source.qualification_prompt_on_requirement_save === true ||
      source.qualification_prompt_on_requirement_save === 'true' ||
      source.qualification_prompt_on_requirement_save === 1 ||
      source.qualification_prompt_on_requirement_save === '1'
    );
  }

  if ('lead_workflow' in source && source.lead_workflow && typeof source.lead_workflow === 'object') {
    const { normalizeRules } = require('../services/lead-workflow.service');
    normalized.lead_workflow = normalizeRules(source.lead_workflow);
  }

  if ('qualification_match' in source && source.qualification_match && typeof source.qualification_match === 'object') {
    normalized.qualification_match = source.qualification_match;
  }

  if ('sales_order_prefix' in source) {
    normalized.sales_order_prefix = String(source.sales_order_prefix || '').trim();
  }

  if ('client_categories' in source && Array.isArray(source.client_categories)) {
    normalized.client_categories = source.client_categories.map((c) => String(c).trim()).filter(Boolean);
  }

  if ('client_tags' in source && Array.isArray(source.client_tags)) {
    normalized.client_tags = source.client_tags.map((t) => String(t).trim()).filter(Boolean);
  }

  if ('client_statuses' in source && Array.isArray(source.client_statuses)) {
    normalized.client_statuses = source.client_statuses.map((s) => String(s).trim()).filter(Boolean);
  }

  if ('task_statuses' in source && Array.isArray(source.task_statuses)) {
    normalized.task_statuses = source.task_statuses.map((s) => String(s).trim()).filter(Boolean);
  }

  if ('task_priorities' in source && Array.isArray(source.task_priorities)) {
    normalized.task_priorities = source.task_priorities.map((p) => String(p).trim()).filter(Boolean);
  }

  // Pass through any other known setting keys that don't need custom transforms
  for (const [key, val] of Object.entries(source)) {
    if (key in normalized) continue;
    if (SettingService.KNOWN_KEYS && SettingService.KNOWN_KEYS.has(key)) {
      if (
        SettingService.SECRET_SETTING_KEYS?.has(key) ||
        SettingService.EXTENSION_MANAGED_KEYS?.has(key)
      ) {
        continue;
      }
      normalized[key] = val;
    }
  }

  return normalized;
}

function sendError(res, status, error, details = []) {
  res.status(status).json({
    success: false,
    error,
    details
  });
}

/** GET /settings — full CRM configuration object */
async function getSettings(req, res) {
  try {
    const data = await SettingService.getAll(req);

    if (data.smtp_pass) {
      data.smtp_pass = '********';
    }

    res.json({
      success: true,
      data,
      message: 'Settings loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getSettings:', error);
    sendError(res, 500, 'Failed to load settings');
  }
}

/** PUT /settings — update one or more keys */
async function putSettings(req, res) {
  try {
    const errors = validateSettingsInput(req.body);
    if (errors.length > 0) {
      sendError(res, 400, 'Validation failed', errors);
      return;
    }

    const normalized = normalizeSettingsInput(req.body);
    if (Object.keys(normalized).length === 0) {
      sendError(res, 400, 'Validation failed', ['No valid settings keys provided']);
      return;
    }

    const data = await SettingService.updateMany(req, normalized);
    if (data.smtp_pass) {
      data.smtp_pass = '********';
    }

    res.json({
      success: true,
      data,
      message: 'Settings updated'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] putSettings:', error);
    sendError(res, error.status || 500, error.message || 'Failed to update settings');
  }
}

/** GET /settings/pipeline — stages for lead module (read-only users OK) */
async function getPipeline(req, res) {
  try {
    const stages = await SettingService.getPipelineStages(req);
    // Carried here rather than on /settings, because every lead user needs the
    // flag and only settings managers may read the full settings document.
    const all = await SettingService.getAll(req).catch(() => ({}));
    res.json({
      success: true,
      data: {
        pipeline_stages: stages,
        qualification_prompt_on_requirement_save: Boolean(
          all.qualification_prompt_on_requirement_save
        )
      },
      message: 'Pipeline stages loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getPipeline:', error);
    sendError(res, 500, 'Failed to load pipeline stages');
  }
}

/** PUT /settings/pipeline — update stages only */
async function putPipeline(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const stages = body.pipeline_stages ?? body.stages ?? body;

    const errors = validateSettingsInput({ pipeline_stages: stages });
    if (errors.length > 0) {
      sendError(res, 400, 'Validation failed', errors);
      return;
    }

    const normalized = normalizeSettingsInput({ pipeline_stages: stages });
    const data = await SettingService.updatePipelineStages(
      req,
      normalized.pipeline_stages
    );

    res.json({
      success: true,
      data: { pipeline_stages: data.pipeline_stages },
      message: 'Pipeline stages updated'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] putPipeline:', error);
    sendError(res, 500, 'Failed to update pipeline stages');
  }
}

/** GET /settings/opportunity-pipeline — stages for opportunities module */
async function getOpportunityPipeline(req, res) {
  try {
    const [opportunity_stages, opportunity_stage_probabilities] = await Promise.all([
      SettingService.getOpportunityStages(req),
      SettingService.getOpportunityStageProbabilities(req)
    ]);
    res.json({
      success: true,
      data: { opportunity_stages, opportunity_stage_probabilities },
      message: 'Opportunity stages loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getOpportunityPipeline:', error);
    sendError(res, 500, 'Failed to load opportunity stages');
  }
}

/** PUT /settings/opportunity-pipeline — update opportunity stages + probabilities */
async function putOpportunityPipeline(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const stages = body.opportunity_stages ?? body.stages ?? body;
    const probabilities = body.opportunity_stage_probabilities ?? body.probabilities;

    const errors = validateSettingsInput({
      opportunity_stages: stages,
      ...(probabilities != null ? { opportunity_stage_probabilities: probabilities } : {})
    });
    if (errors.length > 0) {
      sendError(res, 400, 'Validation failed', errors);
      return;
    }

    const normalized = normalizeSettingsInput({
      opportunity_stages: stages,
      ...(probabilities != null ? { opportunity_stage_probabilities: probabilities } : {})
    });
    const data = await SettingService.updateOpportunityStages(
      req,
      normalized.opportunity_stages,
      normalized.opportunity_stage_probabilities
    );

    res.json({
      success: true,
      data: {
        opportunity_stages: data.opportunity_stages,
        opportunity_stage_probabilities: data.opportunity_stage_probabilities
      },
      message: 'Opportunity stages updated'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] putOpportunityPipeline:', error);
    sendError(res, error.status || 500, error.message || 'Failed to update opportunity stages');
  }
}

/** GET /settings/delivery — project/task statuses for delivery modules */
async function getDelivery(req, res) {
  try {
    const [project_statuses, project_priorities, project_categories, project_tags, project_custom_fields, task_statuses, task_priorities, task_client_reminder_hours, task_client_reminder_auto_enabled] = await Promise.all([
      SettingService.getProjectStatuses(req),
      SettingService.getProjectPriorities(req),
      SettingService.getProjectCategories(req),
      SettingService.getProjectTags(req),
      SettingService.getProjectCustomFields(req),
      SettingService.getTaskStatuses(req),
      SettingService.getTaskPriorities(req),
      SettingService.getTaskClientReminderHours(req),
      SettingService.getTaskClientReminderAutoEnabled(req)
    ]);

    res.json({
      success: true,
      data: { project_statuses, project_priorities, project_categories, project_tags, project_custom_fields, task_statuses, task_priorities, task_client_reminder_hours, task_client_reminder_auto_enabled },
      message: 'Delivery settings loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getDelivery:', error);
    sendError(res, 500, 'Failed to load delivery settings');
  }
}

/** POST /settings/test-email — verify SMTP configuration */
async function testEmail(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const to = String(body.to || body.email || '').trim();
    const result = await MailService.sendTestEmail(req, to);

    res.json({
      success: true,
      data: result,
      message: `Test email sent to ${result.to}`
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] testEmail:', error);
    const status = error.status || 500;
    sendError(res, status, error.message || 'Failed to send test email');
  }
}

/** GET /settings/email-status — diagnostic status of Email Service Plugin integration */
async function getEmailStatus(req, res) {
  try {
    const status = await MailService.getEmailPluginStatus(req);
    res.json({
      success: true,
      data: status,
      message: 'Email plugin status checked'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getEmailStatus:', error);
    sendError(res, 500, 'Failed to check Email plugin status');
  }
}

/** GET /settings/integrations/groq — status only (never returns raw key) */
async function getGroqIntegration(req, res) {
  try {
    const data = await SettingService.getGroqIntegration(req);
    res.json({
      success: true,
      data,
      message: 'Groq integration status loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getGroqIntegration:', error);
    sendError(res, error.status || 500, error.message || 'Failed to load Groq integration');
  }
}

/** PUT /settings/integrations/groq — save encrypted key and/or model */
async function putGroqIntegration(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const apiKey = body.apiKey != null ? String(body.apiKey).trim() : '';
    const clearKey = Boolean(body.clearKey);
    const model = body.model != null ? String(body.model).trim() : undefined;

    if (!clearKey && !apiKey && model === undefined) {
      sendError(res, 400, 'Validation failed', [
        'Provide apiKey to save, model to update, or clearKey: true to remove the stored key'
      ]);
      return;
    }

    if (apiKey && apiKey.includes('*')) {
      sendError(res, 400, 'Validation failed', [
        'Paste the full Groq API key — masked placeholders cannot be saved'
      ]);
      return;
    }

    const data = await SettingService.updateGroqIntegration(req, {
      apiKey: apiKey || undefined,
      model,
      clearKey
    });

    res.json({
      success: true,
      data,
      message: clearKey ? 'Groq API key removed' : 'Groq integration saved'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] putGroqIntegration:', error);
    sendError(res, error.status || 500, error.message || 'Failed to save Groq integration');
  }
}

/** GET /settings/integrations/google-maps — status only (never returns raw key) */
async function getGoogleMapsIntegration(req, res) {
  try {
    const data = await SettingService.getGoogleMapsIntegration(req);
    res.json({
      success: true,
      data,
      message: 'Google Maps integration status loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getGoogleMapsIntegration:', error);
    sendError(res, error.status || 500, error.message || 'Failed to load Google Maps integration');
  }
}

/** PUT /settings/integrations/google-maps — save encrypted key */
async function putGoogleMapsIntegration(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const apiKey = body.apiKey != null ? String(body.apiKey).trim() : '';
    const clearKey = Boolean(body.clearKey);

    if (!clearKey && !apiKey) {
      sendError(res, 400, 'Validation failed', [
        'Provide apiKey to save, or clearKey: true to remove the stored key'
      ]);
      return;
    }

    if (apiKey && apiKey.includes('*')) {
      sendError(res, 400, 'Validation failed', [
        'Paste the full Google Maps API key — masked placeholders cannot be saved'
      ]);
      return;
    }

    const data = await SettingService.updateGoogleMapsIntegration(req, {
      apiKey: apiKey || undefined,
      clearKey
    });

    res.json({
      success: true,
      data,
      message: clearKey ? 'Google Maps API key removed' : 'Google Maps integration saved'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] putGoogleMapsIntegration:', error);
    sendError(res, error.status || 500, error.message || 'Failed to save Google Maps integration');
  }
}

/**
 * GET /settings/integrations/google-maps/client-key
 * Returns the decrypted key for Places Autocomplete (Maps JS runs in the browser).
 * Restricted to authenticated staff with leads or settings access.
 */
async function getGoogleMapsClientKey(req, res) {
  try {
    const resolved = await SettingService.resolveGoogleMapsApiKey(req);
    if (!resolved.apiKey) {
      sendError(res, 404, 'Google Maps API key is not configured', [
        'Add the key under Settings → Integrations → Google Maps'
      ]);
      return;
    }
    res.json({
      success: true,
      data: {
        apiKey: resolved.apiKey,
        source: resolved.source
      },
      message: 'Google Maps client key loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] getGoogleMapsClientKey:', error);
    sendError(res, error.status || 500, error.message || 'Failed to load Google Maps key');
  }
}

module.exports = {
  getSettings,
  putSettings,
  getPipeline,
  putPipeline,
  getOpportunityPipeline,
  putOpportunityPipeline,
  getDelivery,
  testEmail,
  getEmailStatus,
  getGroqIntegration,
  putGroqIntegration,
  getGoogleMapsIntegration,
  putGoogleMapsIntegration,
  getGoogleMapsClientKey,
  validateSettingsInput,
  normalizeSettingsInput
};
