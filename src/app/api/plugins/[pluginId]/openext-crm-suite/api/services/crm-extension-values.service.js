'use strict';

/**
 * Declared field values on core CRM records (lead, client, opportunity, ticket, quotation).
 *
 * OWNER: Step 2 (see documentation/crm-upload-plan/AGY-STEP-2-declarations.md).
 *
 * Storage (CRM 3.10.0+): the extension's own table, one row per record
 * (extension-runtime/record-values.js). Core record tables are never written.
 * Values kept by older CRM versions on `record.extension[<extensionId>]` are
 * read as a fallback and copied into the extension's row on first save; the
 * old bag is left untouched.
 *   - Read returns stored values plus declared defaults for missing keys
 *     ("today" -> today's ISO date, "me" -> current user id).
 *   - Writes accept only fields of applicable groups declared for that record type.
 *     For leads, groups with `whenRequestTypeKey` apply only when the lead matches.
 *   - Coerces and validates each value by declared type.
 *   - Audits with AuditService.log (module = record type, action = updated).
 *   - Date rules (CRM 3.32.0): minDate "today" (a date set or changed cannot be in the past),
 *     minField / maxField (not before / after another date field of the record, stored or sent).
 *   - Leads (CRM 3.32.0): the active extension may refuse changed values (leadWorkflow.valuesCheckRoute)
 *     and Draft quotations of the lead must still fit its quotation dates rule (salesFlow.quotationDatesRoute).
 */

const { resolveTenantId, resolveUserId, isClientUser, resolveClientId, resolveClientIdAsync, applyClientScopeAsync } = require('../utils/tenant.util');
const CrmExtensionService = require('./crm-extension.service');
const AuditService = require('./audit.service');
const RecordValues = require('../extension-runtime/record-values');
const { resolveOptions, computeFormulas } = require('../utils/extension-field-logic.util');
const DateOnly = require('../utils/date-only.util');

/** Settings values of the active extension, for options read from settings (optionsFrom). Never throws. */
async function settingsValuesFor(req, def, fields) {
  if (![...fields].some((f) => f && f.optionsFrom)) return {};
  try {
    return await require('./crm-extension-settings.service').getValues(req, def);
  } catch {
    return {};
  }
}

const RECORD_MODEL_MAP = {
  lead: 'Lead',
  client: 'Company',
  opportunity: 'Opportunity',
  ticket: 'Ticket',
  // CRM 3.18.0: declared quotation fields (one row per quotation version).
  quotation: 'Estimate'
};

async function leanResult(query) {
  if (!query) return null;
  return typeof query.lean === 'function' ? query.lean() : query;
}

function coerceAndValidate(field, value) {
  if (value === null || value === undefined) {
    if (field.type === 'checkbox') return false;
    return null;
  }

  switch (field.type) {
    case 'number':
    case 'currency': {
      if (value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n)) {
        return { error: `${field.label || field.key} must be a number` };
      }
      if (field.min !== undefined && field.min !== null && n < field.min) {
        return { error: `${field.label || field.key} must be at least ${field.min}` };
      }
      if (field.max !== undefined && field.max !== null && n > field.max) {
        return { error: `${field.label || field.key} must be at most ${field.max}` };
      }
      return n;
    }
    case 'checkbox':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'select':
    case 'radio': {
      const v = String(value).trim();
      if (!v) return '';
      const allowed = (field.options || []).map((o) => (typeof o === 'object' && o !== null ? o.value : o));
      if (!allowed.includes(v)) {
        return { error: `${field.label || field.key} must be one of the options` };
      }
      return v;
    }
    case 'multiselect': {
      const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
      const allowed = new Set((field.options || []).map((o) => (typeof o === 'object' && o !== null ? o.value : o)));
      const result = [];
      for (const item of list) {
        const strItem = String(item ?? '').trim();
        if (!strItem) continue;
        if (!allowed.has(strItem)) {
          return { error: `${field.label || field.key} has invalid option: "${strItem}"` };
        }
        if (!result.includes(strItem)) result.push(strItem);
      }
      return result;
    }
    case 'date': {
      const v = String(value).trim();
      if (!v) return '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        return { error: `${field.label || field.key} must be a valid date in YYYY-MM-DD format` };
      }
      return v;
    }
    case 'user':
      return String(value).trim();
    case 'textarea':
      return String(value).trim().slice(0, 5000);
    case 'text':
    default:
      return String(value).trim().slice(0, 500);
  }
}

async function resolveRecordDoc(req, record, recordId, mode = 'read') {
  const modelName = RECORD_MODEL_MAP[record];
  if (!modelName) {
    const err = new Error(`Invalid record type: "${record}". Supported types: ${Object.keys(RECORD_MODEL_MAP).join(', ')}.`);
    err.status = 400;
    err.code = 'INVALID_RECORD_TYPE';
    throw err;
  }

  const idStr = String(recordId || '').trim();
  if (!idStr || !/^[a-f0-9]{24}$/i.test(idStr)) {
    const err = new Error(`${modelName} not found`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (isClientUser(req) && record === 'lead') {
    const err = new Error('Access denied: client users cannot access lead extension values');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }

  const Model = req.cms?.models?.get?.(modelName);
  if (!Model) {
    const err = new Error(`${modelName} model is not registered`);
    err.status = 500;
    throw err;
  }

  const tenantId = resolveTenantId(req);
  const filter = { _id: idStr, tenantId, isDeleted: { $ne: true } };

  if (record === 'opportunity' || record === 'ticket' || record === 'quotation') {
    await applyClientScopeAsync(req, filter, 'clientId');
  } else if (record === 'client' && isClientUser(req)) {
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!clientId || String(clientId) !== idStr) {
      filter._id = '__CLIENT_SCOPE_MISMATCH__';
    }
  }

  const doc = await leanResult(Model.findOne(filter));
  if (!doc) {
    const err = new Error(`${modelName} not found`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  await assertStaffRecordAccess(req, record, doc, mode);
  return { Model, doc, tenantId, modelName };
}

/**
 * Staff see and change a record's extension fields only when they may open the record itself
 * (sales agents: their own leads and deals; reps: the quotations they created). Clients are scoped above.
 */
async function assertStaffRecordAccess(req, record, doc, mode) {
  if (isClientUser(req)) return;
  const access = require('../utils/sales-access.util');
  const getLeadModel = (r) => r.cms?.models?.get?.('Lead');
  if (record === 'lead') {
    if (mode === 'write') access.assertLeadWriteAccess(req, doc);
    else access.assertLeadReadAccess(req, doc);
  } else if (record === 'opportunity') {
    await access.assertSalesAgentOpportunityAccessAsync(req, doc, getLeadModel);
  } else if (record === 'quotation') {
    access.assertSalesAgentCreatorAccess(req, doc, 'Quotation');
  } else if (record === 'ticket') {
    access.assertSalesAgentTicketAccess(req, doc);
  } else if (record === 'client') {
    if (mode === 'write') await access.assertClientWriteAccess(req, doc, getLeadModel);
    else await access.assertClientReadAccess(req, doc, getLeadModel);
  }
}

async function resolveApplicableGroups(req, record, doc, def) {
  if (!def || def.manifestVersion !== 2 || !def.declarations?.fields?.[record]) {
    return [];
  }
  const groups = Array.isArray(def.declarations.fields[record]) ? def.declarations.fields[record] : [];
  if (record !== 'lead') {
    return groups;
  }

  let leadReqTypeKey = doc.commercialRequirement?.requestTypeKey || null;
  if (!leadReqTypeKey && doc.requestTypeId) {
    const RequestType = req.cms?.models?.get?.('RequestType');
    if (RequestType) {
      const tenantId = resolveTenantId(req);
      const rt = await leanResult(RequestType.findOne({ _id: doc.requestTypeId, tenantId, isDeleted: { $ne: true } }));
      leadReqTypeKey = rt?.key || rt?.requestTypeKey || null;
    }
  }

  return groups.filter((group) => {
    if (!group.whenRequestTypeKey) return true;
    if (!leadReqTypeKey) return false;
    return String(group.whenRequestTypeKey).toLowerCase() === String(leadReqTypeKey).toLowerCase();
  });
}

/**
 * Get declared field values for active extension on a core record.
 * @returns {Promise<{ extensionId: string, values: object }>}
 */
async function getValues(req, record, recordId) {
  const { doc } = await resolveRecordDoc(req, record, recordId);
  const def = await CrmExtensionService.getActive(req);
  const extensionId = def?.id || '';

  const applicableGroups = await resolveApplicableGroups(req, record, doc, def);
  const applicableFields = new Map();
  for (const group of applicableGroups) {
    for (const field of group.fields || []) {
      applicableFields.set(field.key, field);
    }
  }

  const stored = applicableFields.size ? await RecordValues.read(req, extensionId, record, doc) : {};

  const values = {};
  for (const [key, field] of applicableFields.entries()) {
    if (Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined && stored[key] !== null) {
      values[key] = stored[key];
    } else if (field.default !== undefined && field.default !== null) {
      if (field.default === 'today' && field.type === 'date') {
        values[key] = DateOnly.localDay();
      } else if (field.default === 'me' && field.type === 'user') {
        values[key] = resolveUserId(req) || '';
      } else {
        values[key] = field.default;
      }
    }
  }

  // Calculated fields always reflect the current inputs.
  Object.assign(values, computeFormulas(applicableFields.values(), values));
  // Fields the extension marks internal stay with the team: client (portal) users never get them.
  if (isClientUser(req)) {
    for (const [key, field] of applicableFields.entries()) if (field.internal) delete values[key];
  }
  return { extensionId, values };
}

/**
 * Set declared field values for active extension on a core record.
 * Rejects unknown or non-applicable fields with 400 (INVALID_EXTENSION_VALUES).
 * Writes namespaced without touching other extension keys.
 * @returns {Promise<{ extensionId: string, values: object }>}
 */
async function setValues(req, record, recordId, values) {
  const { doc } = await resolveRecordDoc(req, record, recordId, 'write');
  // salesFlow.lockWonLead: a Won lead's fields are read-only.
  if (record === 'lead') await require('../utils/lead-lock.util').assertEditable(req, recordId);
  const def = await CrmExtensionService.getActive(req);
  const extensionId = def?.id || '';

  const applicableGroups = await resolveApplicableGroups(req, record, doc, def);
  const applicableFields = new Map();
  for (const group of applicableGroups) {
    for (const field of group.fields || []) {
      applicableFields.set(field.key, field);
    }
  }

  const inputValues = values && typeof values === 'object' ? values : {};
  const errors = [];
  const clean = {};
  const settingsValues = await settingsValuesFor(req, def, applicableFields.values());

  for (const [key, rawVal] of Object.entries(inputValues)) {
    const declared = applicableFields.get(key);
    if (!declared) {
      errors.push(`"${key}" is not an allowed extension field for ${record}`);
      continue;
    }
    // Calculated fields are computed below; whatever the client sent is ignored.
    if (declared.formula) continue;
    if (declared.internal && isClientUser(req)) {
      errors.push(`"${key}" cannot be changed from the client portal`);
      continue;
    }
    const field = declared.optionsFrom ? { ...declared, options: resolveOptions(declared, settingsValues) } : declared;
    const coerced = coerceAndValidate(field, rawVal);
    if (coerced && typeof coerced === 'object' && coerced.error) {
      errors.push(coerced.error);
    } else {
      clean[key] = coerced;
    }
  }

  for (const field of applicableFields.values()) {
    if (field.required && Object.prototype.hasOwnProperty.call(clean, field.key)) {
      const v = clean[field.key];
      if (v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) {
        errors.push(`${field.label || field.key} is required`);
      } else if (field.type === 'checkbox' && v !== true) {
        errors.push(`${field.label || field.key} is required`);
      }
    }
  }

  // Stored values: for date rules against fields not sent now, for "changed", and for formulas.
  const needsStored = Object.keys(clean).length > 0 && extensionId &&
    ([...applicableFields.values()].some((fld) => fld.formula || fld.minDate || fld.minField || fld.maxField) || record === 'lead');
  const storedBag = needsStored ? (await RecordValues.read(req, extensionId, record, doc)) || {} : {};
  if (!errors.length) errors.push(...dateRuleErrors(applicableFields, clean, storedBag));

  if (!errors.length && record === 'lead' && Object.keys(clean).length > 0) {
    const merged = withoutUnknown({ ...storedBag, ...clean }, applicableFields);
    const changed = Object.keys(clean).filter((k) => JSON.stringify(clean[k] ?? null) !== JSON.stringify(storedBag[k] ?? null));
    if (changed.length) errors.push(...(await leadValuesCheck(req, def, String(recordId), merged, changed)));
    if (!errors.length && changed.length) {
      const SalesFlowService = require('./sales-flow.service');
      errors.push(...(await SalesFlowService.draftQuotationDateErrors(req, String(recordId), merged).catch(() => [])));
    }
  }

  if (errors.length > 0) {
    const err = new Error('Invalid extension values');
    err.status = 400;
    err.code = 'INVALID_EXTENSION_VALUES';
    err.details = errors;
    throw err;
  }

  // Recompute calculated fields from the stored values merged with this update.
  if (Object.keys(clean).length > 0 && [...applicableFields.values()].some((fld) => fld.formula)) {
    Object.assign(clean, computeFormulas(applicableFields.values(), { ...storedBag, ...clean }));
  }

  if (Object.keys(clean).length > 0 && extensionId) {
    // The extension's own table; the core record is not modified.
    await RecordValues.write(req, extensionId, record, doc, clean);

    await AuditService.log(req, {
      action: 'updated',
      module: record,
      recordId: String(recordId),
      description: 'Updated extension fields'
    });

    // An extension that keeps its own copy of sales records (salesFlow savedRoute) hears about every
    // change, not only the create pages. Never fails the save; the hook reports its own problems.
    if (record === 'opportunity' || record === 'quotation') {
      const SalesFlowService = require('./sales-flow.service');
      const hook = record === 'opportunity' ? SalesFlowService.opportunitySaved : SalesFlowService.quotationSaved;
      await hook(req, { [`${record}Id`]: String(recordId) }).catch(() => null);
    }
  }

  return await getValues(req, record, recordId);
}

/** Only declared fields of the record. */
function withoutUnknown(values, fields) {
  return Object.fromEntries(Object.entries(values).filter(([k]) => fields.has(k)));
}

/**
 * Declared date rules on the values after this save (sent values over stored ones). A rule is only
 * judged when one of its dates is sent now, so an old record is not blocked by a date nobody changed.
 */
function dateRuleErrors(fields, clean, stored) {
  const out = [];
  const merged = { ...stored, ...clean };
  const today = DateOnly.localDay();
  const day = (k) => (DateOnly.isDay(merged[k]) ? String(merged[k]) : '');
  for (const field of fields.values()) {
    if (field.type !== 'date') continue;
    const label = field.label || field.key;
    const mine = day(field.key);
    if (!mine) continue;
    const sent = Object.prototype.hasOwnProperty.call(clean, field.key);
    if (field.minDate === 'today' && sent && mine !== String(stored[field.key] || '') && mine < today) {
      out.push(`${label} cannot be in the past.`);
    }
    for (const [prop, word] of [['minField', 'before'], ['maxField', 'after']]) {
      const otherKey = field[prop];
      const other = otherKey ? day(otherKey) : '';
      if (!other || !(sent || Object.prototype.hasOwnProperty.call(clean, otherKey))) continue;
      if (word === 'before' ? mine < other : mine > other) {
        const otherField = fields.get(otherKey);
        out.push(`${label} cannot be ${word} ${(otherField && otherField.label) || otherKey}.`);
      }
    }
  }
  return out;
}

/**
 * The active extension's check of a lead's changed values (leadWorkflow.valuesCheckRoute):
 * POST { leadId, values, changed } → { errors: [text] }. Runs as the system (a validation the CRM asks
 * for). An extension that cannot answer does not block the save.
 */
async function leadValuesCheck(req, def, leadId, values, changed) {
  const route = def && def.isInternal === false && def.leadWorkflow && String(def.leadWorkflow.valuesCheckRoute || '');
  if (!route) return [];
  try {
    const { callActiveRoute } = require('../extension-runtime/runtime');
    const res = await callActiveRoute(req, 'POST', route, { leadId, values, changed }, { system: true });
    const list = res && res.available !== false && res.data && Array.isArray(res.data.errors) ? res.data.errors : [];
    return list.map((e) => String(e === null || e === undefined ? '' : e).trim().slice(0, 300)).filter(Boolean).slice(0, 10);
  } catch (error) {
    console.warn(`[plugin:openext-crm-suite] lead values check unavailable (status ${Number(error && error.status) || 500})`);
    return [];
  }
}

module.exports = {
  RECORD_MODEL_MAP,
  getValues,
  setValues
};
