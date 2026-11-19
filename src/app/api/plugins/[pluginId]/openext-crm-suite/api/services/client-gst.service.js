'use strict';

/**
 * Client GST rules (GST suite, CRM 3.53.0; documentation/gst-planning/05 §4), as in the GST app's
 * client form:
 * - B2B or B2C is decided by whether a GSTIN is filled (no separate client type).
 * - A GSTIN must pass its checksum. An empty billing state is filled from it. A different state is
 *   saved, with a warning (the state decides CGST + SGST or IGST).
 * - The PAN is taken from the GSTIN. CRM 3.54.0: without a GSTIN a PAN may be typed; it is stored
 *   encrypted (panEnc + panHash fingerprint, select: false) and shown masked from panLast4.
 * - The same GSTIN on another client is a warning, not an error (branches).
 * No personal data is logged.
 */

const { checkGstin, stateCodeOf } = require('../lib/gstin');
const { resolveTenantId } = require('../utils/tenant.util');
const Protect = require('../extension-runtime/data-protection');

// Encryption scope of client PANs (bound to the tenant; never readable as another kind of value).
const PAN_SCOPE = 'crm-core:client-pan';
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

const tenantOf = (req) => req.tenantId || resolveTenantId(req);
const panMask = (last4) => (last4 ? `XXXXXX${last4}` : '');

/** Another client with the same typed PAN (names only). */
async function panDuplicateNames(req, hash, excludeId) {
  const Company = req.cms?.models?.get?.('Company');
  if (!Company || !hash) return [];
  const filter = { tenantId: tenantOf(req), 'gst.panHash': hash, isDeleted: { $ne: true } };
  if (excludeId) filter._id = { $ne: excludeId };
  let query = Company.find(filter);
  if (query && typeof query.select === 'function') query = query.select('name');
  if (query && typeof query.limit === 'function') query = query.limit(3);
  const rows = query && typeof query.lean === 'function' ? await query.lean() : await query;
  return (Array.isArray(rows) ? rows : []).map((r) => r.name).filter(Boolean);
}

/**
 * The client's full PAN for GST reports (GSTR-1, TCS register): from the GSTIN, or the typed one decrypted.
 * Never logged; callers must not return it to the browser except where the law needs it in a filing.
 */
async function clientPan(req, companyOrId) {
  const Company = req.cms?.models?.get?.('Company');
  let doc = companyOrId && typeof companyOrId === 'object' ? companyOrId : null;
  if ((!doc || doc.gst?.panEnc === undefined) && Company) {
    const id = doc ? doc._id : companyOrId;
    let q = Company.findOne({ tenantId: tenantOf(req), _id: id });
    if (q && typeof q.select === 'function') q = q.select('+gst.panEnc gst');
    doc = q && typeof q.lean === 'function' ? await q.lean() : await q;
  }
  const gst = (doc && doc.gst) || {};
  if (gst.gstin && gst.pan) return gst.pan;
  if (!gst.panEnc) return '';
  try {
    return Protect.decryptText(tenantOf(req), PAN_SCOPE, gst.panEnc);
  } catch {
    return '';
  }
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isForeign(country) {
  const c = String(country || '').trim().toLowerCase();
  return Boolean(c) && c !== 'india' && c !== 'in' && c !== 'bharat';
}

async function duplicateNames(req, gstin, excludeId) {
  const Company = req.cms?.models?.get?.('Company');
  if (!Company || !gstin) return [];
  const filter = { tenantId: req.tenantId || resolveTenantId(req), 'gst.gstin': gstin, isDeleted: { $ne: true } };
  if (excludeId) filter._id = { $ne: excludeId };
  let query = Company.find(filter);
  if (query && typeof query.select === 'function') query = query.select('name');
  if (query && typeof query.limit === 'function') query = query.limit(3);
  const rows = query && typeof query.lean === 'function' ? await query.lean() : await query;
  return (Array.isArray(rows) ? rows : []).map((r) => r.name).filter(Boolean);
}

/**
 * Work out the GST fields of a client save.
 * @param {object} req
 * @param {{ gst?: object, billingAddress?: object, existing?: object, excludeId?: string }} input
 *   gst: the client's new GST input (undefined = unchanged); billingAddress: the new billing address
 *   (undefined = unchanged); existing: the stored client on update.
 * @returns {Promise<null | { gst?: object, billingAddress?: object, warnings: string[] }>}
 *   null when nothing GST-related changed.
 */
async function prepare(req, { gst, billingAddress, existing, excludeId } = {}) {
  if (gst === undefined && billingAddress === undefined) return null;
  const prior = existing && existing.gst ? existing.gst : {};
  const address = { ...((existing && existing.billingAddress) || {}), ...(billingAddress || {}) };
  const gstin = gst !== undefined ? String(gst.gstin || '').trim().toUpperCase() : String(prior.gstin || '');
  const out = { warnings: [] };

  if (gst !== undefined) {
    out.gst = {
      gstin: '',
      pan: '',
      isSEZ: gst.isSEZ === true,
      isDeemedExport: gst.isDeemedExport === true
    };
  }
  if (!gstin) {
    if (gst === undefined) return out.warnings.length ? out : null;
    // 3.54.0: no GSTIN. A typed PAN is encrypted; none sent keeps the stored typed one; '' removes it.
    const typed = gst.pan === undefined ? undefined : String(gst.pan || '').toUpperCase();
    if (typed) {
      if (!PAN_RE.test(typed)) throw appError('PAN must be 10 characters: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)');
      const hash = Protect.hashText(tenantOf(req), PAN_SCOPE, typed);
      Object.assign(out.gst, {
        panEnc: Protect.encryptText(tenantOf(req), PAN_SCOPE, typed),
        panHash: hash,
        panLast4: typed.slice(-4),
        panSource: 'typed'
      });
      const names = await panDuplicateNames(req, hash, excludeId);
      if (names.length) out.warnings.push(`Another client already has this PAN: ${names.join(', ')}.`);
    } else if (typed === '' || prior.panSource === 'gstin' || prior.gstin) {
      // Removed, or the PAN came from the GSTIN that is now removed.
      Object.assign(out.gst, { panEnc: '', panHash: '', panLast4: '', panSource: '' });
    }
    return out;
  }

  const check = await checkGstin(gstin);
  if (!check.ok) {
    // Only a newly entered GSTIN is refused; a stored one is not re-judged when the address changes.
    if (gst !== undefined) throw appError(`GSTIN: ${check.message}`);
    return null;
  }
  if (out.gst) {
    out.gst.gstin = check.gstin;
    out.gst.pan = check.pan;
    // The GSTIN's PAN replaces a typed one (no encrypted copy kept).
    Object.assign(out.gst, { panEnc: '', panHash: '', panLast4: String(check.pan || '').slice(-4), panSource: 'gstin' });
  }

  if (isForeign(address.country)) {
    out.warnings.push(`The client's country is ${address.country}, but a GSTIN is an Indian registration. Check the country.`);
  } else if (!String(address.state || '').trim()) {
    if (gst !== undefined) {
      out.billingAddress = { ...address, state: check.state };
      if (!address.country) out.billingAddress.country = 'India';
    }
  } else {
    const code = await stateCodeOf(address.state);
    if (code !== check.stateCode) {
      out.warnings.push(
        `This GSTIN is registered in ${check.state}, but the billing state says ${address.state}. The state decides CGST + SGST or IGST: check it.`
      );
    }
  }

  if (gst !== undefined && check.gstin !== String(prior.gstin || '')) {
    const names = await duplicateNames(req, check.gstin, excludeId);
    if (names.length) out.warnings.push(`Another client already has this GSTIN: ${names.join(', ')}. That is fine for branches of one business.`);
  }
  return out;
}

module.exports = { prepare, isForeign, clientPan, panMask, PAN_SCOPE };
