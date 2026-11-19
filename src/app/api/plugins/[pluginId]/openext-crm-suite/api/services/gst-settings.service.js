'use strict';

/**
 * GST settings (GST suite, CRM 3.53.0; documentation/gst-planning/05).
 *
 * One record per tenant. The GSTIN is checked with its checksum, and state, state code and PAN are
 * taken from it on every save. Service rates must be GST portal rates. TCS rules stay off until the
 * admin fills in the slabs. Defaults for services and TCS rules may come from the ENABLED extension's
 * manifest (salesFlow.gst); the CRM itself has no industry list.
 *
 * The seller GSTIN is also written to the CRM setting `company_gstin`, which the existing quotation
 * and invoice pages already print, so there is one place to edit it.
 */

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { loadGstModule } = require('../lib/gst-core');
const { checkGstin } = require('../lib/gstin');
const AuditService = require('./audit.service');

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const SAC_RE = /^\d{4,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FY_RE = /^\d{4}-\d{2}$/;
const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LIST = 100;
const DEFAULT_NOTE = 'Default - confirm with CA';

function appError(message, status = 400, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function text(value, max) {
  const v = value === undefined || value === null ? '' : String(value).trim();
  return max ? v.slice(0, max) : v;
}

function getModel(req) {
  const Model = req.cms?.models?.get?.('GstSettings');
  if (!Model) throw appError('GstSettings model is not registered', 500);
  return Model;
}

function tenantOf(req) {
  return req.tenantId || resolveTenantId(req);
}

async function lean(query) {
  return query && typeof query.lean === 'function' ? query.lean() : query;
}

/** The shape the browser and the services read, also when nothing is saved yet. */
function present(doc) {
  const d = doc || {};
  return {
    exists: Boolean(doc),
    legalName: d.legalName || '',
    tradeName: d.tradeName || '',
    gstin: d.gstin || '',
    stateCode: d.stateCode || '',
    stateName: d.stateName || '',
    pan: d.pan || '',
    compositionScheme: d.compositionScheme === true,
    email: d.email || '',
    phone: d.phone || '',
    address: {
      line1: d.address?.line1 || '',
      line2: d.address?.line2 || '',
      city: d.address?.city || '',
      pincode: d.address?.pincode || ''
    },
    upiId: d.upiId || '',
    lut: { number: d.lut?.number || '', fy: d.lut?.fy || '' },
    serviceTaxes: Array.isArray(d.serviceTaxes) ? d.serviceTaxes.map((s) => ({ ...s })) : [],
    tcsRules: Array.isArray(d.tcsRules) ? d.tcsRules.map((r) => ({ ...r, slabs: (r.slabs || []).map((s) => ({ ...s })) })) : [],
    lockedUpTo: d.lockedUpTo || '',
    defaultTerms: d.defaultTerms || '',
    updatedAt: d.updatedAt || null
  };
}

async function readDoc(req) {
  return lean(getModel(req).findOne({ tenantId: tenantOf(req) }));
}

async function get(req) {
  return present(await readDoc(req));
}

/** Warnings that do not block a save (shown by the Settings page). */
async function warningsFor(settings) {
  const lut = await loadGstModule('lut');
  const warnings = [];
  if (settings.lut.number && !lut.isLikelyLutArn(settings.lut.number)) {
    warnings.push('The LUT number does not look like a portal ARN (14 to 16 letters and digits). Check it for a typo.');
  }
  if (settings.lut.number && settings.lut.fy && settings.lut.fy !== lut.fyOf(new Date())) {
    warnings.push(`The LUT is for ${settings.lut.fy}, not the current financial year ${lut.fyOf(new Date())}. File a new LUT for this year.`);
  }
  if (settings.serviceTaxes.some((s) => s.source)) {
    warnings.push('Rates loaded from the extension are defaults - confirm each with your CA.');
  }
  return warnings;
}

function cleanServiceTaxes(list, rates, errors) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) {
    errors.push('serviceTaxes must be a list');
    return undefined;
  }
  if (list.length > MAX_LIST) errors.push(`serviceTaxes has more than ${MAX_LIST} entries`);
  const seen = new Set();
  return list.slice(0, MAX_LIST).map((raw, i) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const where = `Service ${i + 1}`;
    const serviceType = text(item.serviceType);
    if (!KEY_RE.test(serviceType)) errors.push(`${where}: the key must be lowercase letters, digits or _ (2 to 41 characters)`);
    else if (seen.has(serviceType)) errors.push(`${where}: the key "${serviceType}" is used twice`);
    seen.add(serviceType);
    const sac = text(item.sac);
    if (!SAC_RE.test(sac)) errors.push(`${where}: the SAC code must be 4 to 8 digits`);
    const taxPercent = Number(item.taxPercent);
    if (item.taxPercent === '' || item.taxPercent === null || !rates.includes(taxPercent)) {
      errors.push(`${where}: ${item.taxPercent}% is not a GST rate (allowed: ${rates.join(', ')})`);
    }
    return {
      serviceType,
      label: text(item.label, 60),
      sac,
      taxPercent,
      note: text(item.note, 200),
      source: text(item.source, 60)
    };
  });
}

function cleanTcsRules(list, errors) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) {
    errors.push('tcsRules must be a list');
    return undefined;
  }
  if (list.length > MAX_LIST) errors.push(`tcsRules has more than ${MAX_LIST} entries`);
  const seen = new Set();
  return list.slice(0, MAX_LIST).map((raw, i) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const key = text(item.key);
    const where = `TCS rule "${text(item.label) || key || i + 1}"`;
    if (!KEY_RE.test(key)) errors.push(`${where}: the key must be lowercase letters, digits or _`);
    else if (seen.has(key)) errors.push(`${where}: the key is used twice`);
    seen.add(key);
    const slabs = (Array.isArray(item.slabs) ? item.slabs : []).slice(0, 10).map((s, j) => {
      const upTo = s && s.upTo !== undefined && s.upTo !== null && s.upTo !== '' ? Number(s.upTo) : null;
      const rate = Number(s && s.rate);
      if (upTo !== null && (!Number.isFinite(upTo) || upTo <= 0)) errors.push(`${where}, slab ${j + 1}: the upper limit must be a positive amount, or empty for no limit`);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.push(`${where}, slab ${j + 1}: the rate must be 0 to 100`);
      return { upTo, rate };
    });
    // Each slab's limit must be higher than the one before; only the last may have no limit.
    for (let j = 0; j < slabs.length; j += 1) {
      if (slabs[j].upTo === null && j !== slabs.length - 1) errors.push(`${where}: only the last slab may have no upper limit`);
      if (j > 0 && slabs[j].upTo !== null && slabs[j - 1].upTo !== null && slabs[j].upTo <= slabs[j - 1].upTo) {
        errors.push(`${where}: slab limits must go up`);
      }
    }
    const noPanRate = item.noPanRate === undefined || item.noPanRate === null || item.noPanRate === '' ? null : Number(item.noPanRate);
    if (noPanRate !== null && (!Number.isFinite(noPanRate) || noPanRate < 0 || noPanRate > 100)) errors.push(`${where}: the no-PAN rate must be 0 to 100`);
    const enabled = item.enabled === true;
    if (enabled && !slabs.length) errors.push(`${where}: add the slabs (confirmed by your CA) before switching it on`);
    return {
      key,
      label: text(item.label, 60),
      source: text(item.source, 60),
      enabled,
      needsPan: item.needsPan !== false,
      sectionLabel: text(item.sectionLabel, 40),
      slabs,
      noPanRate
    };
  });
}

/**
 * Save (create or update) the tenant's GST settings. Only crm.settings.manage reaches this (route).
 * Returns { settings, warnings }.
 */
async function save(req, input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = [];
  const utils = await loadGstModule('utils');
  const lutLib = await loadGstModule('lut');
  const before = await readDoc(req);
  const current = present(before);

  const legalName = src.legalName !== undefined ? text(src.legalName, 200) : current.legalName;
  if (!legalName) errors.push('Enter the legal name (as on the GST certificate)');

  const gstinRaw = src.gstin !== undefined ? src.gstin : current.gstin;
  const check = await checkGstin(gstinRaw);
  if (!check.ok) errors.push(`GSTIN: ${check.message}`);

  const email = src.email !== undefined ? text(src.email, 120).toLowerCase() : current.email;
  if (email && !EMAIL_RE.test(email)) errors.push('The email address is not valid');
  const upiId = src.upiId !== undefined ? text(src.upiId, 100) : current.upiId;
  if (upiId && !UPI_RE.test(upiId)) errors.push('The UPI id should look like name@bank');

  const lutIn = src.lut && typeof src.lut === 'object' ? src.lut : current.lut;
  const lut = { number: lutLib.normaliseLutArn(lutIn.number).slice(0, 20), fy: text(lutIn.fy, 7) };
  if (lut.fy && !FY_RE.test(lut.fy)) errors.push('The LUT financial year must look like 2026-27');
  if (lut.number && !lut.fy) errors.push('Choose the financial year of the LUT');

  const lockedUpTo = src.lockedUpTo !== undefined ? text(src.lockedUpTo) : current.lockedUpTo;
  if (lockedUpTo && (!DATE_RE.test(lockedUpTo) || Number.isNaN(new Date(`${lockedUpTo}T00:00:00Z`).getTime()))) {
    errors.push('The lock date must be a date (YYYY-MM-DD)');
  }

  const serviceTaxes = cleanServiceTaxes(src.serviceTaxes, utils.GST_PORTAL_RATES, errors) ?? current.serviceTaxes;
  const tcsRules = cleanTcsRules(src.tcsRules, errors) ?? current.tcsRules;
  const compositionScheme = src.compositionScheme !== undefined ? src.compositionScheme === true : current.compositionScheme;
  if (compositionScheme && serviceTaxes.some((s) => Number(s.taxPercent) > 0)) {
    errors.push('A composition dealer issues a bill of supply and charges no GST: set every service rate to 0, or switch composition off');
  }

  if (errors.length) throw appError('GST settings are not valid', 400, errors);

  const address = src.address && typeof src.address === 'object' ? src.address : current.address;
  const userId = resolveUserId(req);
  const values = {
    legalName,
    tradeName: src.tradeName !== undefined ? text(src.tradeName, 200) : current.tradeName,
    gstin: check.gstin,
    stateCode: check.stateCode,
    stateName: check.state,
    pan: check.pan,
    compositionScheme,
    email,
    phone: src.phone !== undefined ? text(src.phone, 20) : current.phone,
    address: {
      line1: text(address.line1, 200),
      line2: text(address.line2, 200),
      city: text(address.city, 80),
      pincode: text(address.pincode, 10)
    },
    upiId,
    lut,
    serviceTaxes,
    tcsRules,
    lockedUpTo,
    defaultTerms: src.defaultTerms !== undefined ? text(src.defaultTerms, 3000) : current.defaultTerms,
    updatedBy: userId
  };

  const tenantId = tenantOf(req);
  const saved = await lean(getModel(req).findOneAndUpdate(
    { tenantId },
    { $set: values, $setOnInsert: { tenantId, createdBy: userId } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ));

  // The existing quotation / invoice pages print `company_gstin`: keep it the same GSTIN.
  try {
    await require('./setting.service').upsertSettingValue(req, 'company_gstin', check.gstin);
  } catch (error) {
    console.error('[plugin:openext-crm-suite] gst settings: company_gstin not updated:', error?.message || error);
  }

  const changed = Object.keys(values).filter((k) => k !== 'updatedBy' && JSON.stringify(values[k]) !== JSON.stringify(current[k]));
  await AuditService.log(req, {
    action: before ? 'updated' : 'created',
    module: 'settings',
    recordId: String(saved?._id || tenantId),
    description: 'GST settings saved',
    // Field names only: no GSTIN, PAN, bank or contact values in the audit trail.
    metadata: { area: 'gst', changed }
  });

  const settings = present(saved);
  return { settings, warnings: await warningsFor(settings) };
}

/** The ENABLED extension's salesFlow.gst block (validated by the package validator), or null. */
async function extensionGstDefaults(req) {
  const CrmExtensionService = require('./crm-extension.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  const gst = def && def.isInternal === false && def.salesFlow && def.salesFlow.gst;
  if (!gst || typeof gst !== 'object') return null;
  return { extensionId: def.id, extensionName: def.name || def.id, gst };
}

/**
 * Load the enabled extension's defaults: its services only when the list is empty, and any TCS rule
 * keys not yet present (switched off, no slabs). Saves only when something is added.
 * → { extensionId, extensionName, addedServices, addedTcsRules, message, settings }
 */
async function seedServices(req) {
  const found = await extensionGstDefaults(req);
  const doc = await readDoc(req);
  const current = present(doc);
  if (!found) {
    return { extensionId: '', addedServices: 0, addedTcsRules: 0, message: 'No enabled extension declares GST defaults.', settings: current };
  }
  if (!doc) throw appError('Save your GSTIN and legal name first, then load the defaults', 409);

  const utils = await loadGstModule('utils');
  const services = Array.isArray(found.gst.serviceTaxes) ? found.gst.serviceTaxes : [];
  const rules = Array.isArray(found.gst.tcsRules) ? found.gst.tcsRules : [];

  const addServices = current.serviceTaxes.length
    ? []
    : services
      .filter((s) => KEY_RE.test(String(s.serviceType || '')) && SAC_RE.test(String(s.sac || '')) && utils.GST_PORTAL_RATES.includes(Number(s.taxPercent)))
      .map((s) => ({
        serviceType: s.serviceType,
        label: text(s.label, 60),
        sac: s.sac,
        taxPercent: Number(s.taxPercent),
        note: text(s.note, 200) || DEFAULT_NOTE,
        source: found.extensionId
      }));
  const haveKeys = new Set(current.tcsRules.map((r) => r.key));
  const addRules = rules
    .filter((r) => KEY_RE.test(String(r.key || '')) && !haveKeys.has(r.key))
    .map((r) => ({
      key: r.key,
      label: text(r.label, 60),
      source: found.extensionId,
      enabled: false,
      needsPan: r.needsPan === true,
      sectionLabel: text(r.sectionLabel, 40),
      slabs: [],
      noPanRate: null
    }));

  let settings = current;
  if (addServices.length || addRules.length) {
    const set = { updatedBy: resolveUserId(req) };
    if (addServices.length) set.serviceTaxes = addServices;
    if (addRules.length) set.tcsRules = [...current.tcsRules, ...addRules];
    settings = present(await lean(getModel(req).findOneAndUpdate({ tenantId: tenantOf(req) }, { $set: set }, { new: true, runValidators: true })));
    await AuditService.log(req, {
      action: 'updated',
      module: 'settings',
      recordId: String(doc._id || tenantOf(req)),
      description: `GST defaults loaded from ${found.extensionName}`,
      metadata: { area: 'gst', extensionId: found.extensionId, addedServices: addServices.length, addedTcsRules: addRules.length }
    });
  }
  const parts = [];
  if (addServices.length) parts.push(`${addServices.length} service${addServices.length === 1 ? '' : 's'}`);
  if (addRules.length) parts.push(`${addRules.length} TCS rule${addRules.length === 1 ? '' : 's'} (switched off)`);
  let message;
  if (parts.length) message = `Loaded ${parts.join(' and ')} from ${found.extensionName}. Confirm each rate with your CA.`;
  else if (current.serviceTaxes.length && services.length) message = 'Your service list is not empty, so it was left as it is.';
  else message = 'Nothing new to load.';
  return {
    extensionId: found.extensionId,
    extensionName: found.extensionName,
    addedServices: addServices.length,
    addedTcsRules: addRules.length,
    message,
    settings
  };
}

/** What the Settings page needs to know about the enabled extension's defaults (no values). */
async function extensionInfo(req) {
  const found = await extensionGstDefaults(req);
  if (!found) return { extensionId: '', extensionName: '', services: 0, tcsRules: 0 };
  return {
    extensionId: found.extensionId,
    extensionName: found.extensionName,
    services: Array.isArray(found.gst.serviceTaxes) ? found.gst.serviceTaxes.length : 0,
    tcsRules: Array.isArray(found.gst.tcsRules) ? found.gst.tcsRules.length : 0
  };
}

/**
 * For other services and sdk.finance.gstSettings: is GST ready, and the seller state code.
 * Bank details are never part of it.
 */
async function summary(req) {
  const s = await get(req);
  return {
    ready: Boolean(s.exists && s.gstin && s.stateCode),
    sellerStateCode: s.stateCode,
    compositionScheme: s.compositionScheme,
    serviceTaxes: s.serviceTaxes.map(({ serviceType, label, sac, taxPercent }) => ({ serviceType, label, sac, taxPercent })),
    tcsRules: s.tcsRules
      .filter((r) => r.enabled)
      .map(({ key, label, needsPan, sectionLabel }) => ({ key, label, needsPan, sectionLabel }))
  };
}

module.exports = {
  get,
  save,
  seedServices,
  extensionInfo,
  summary,
  present,
  DEFAULT_NOTE
};
