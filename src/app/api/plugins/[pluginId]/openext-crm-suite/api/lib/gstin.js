'use strict';

/**
 * One GSTIN check for the whole CRM (GST suite, CRM 3.53.0; documentation/gst-planning/05 §3).
 * Wraps the GST app's tested decodeGstin: format, Luhn mod-36 checksum, state and PAN.
 *
 * checkGstin(value) → { ok, message, gstin, stateCode, state, pan, entityType, registration,
 *                       taxpayerType, checksumOk }
 * The state code is normalised (old 28 → 37, 25 → 26) before it is named.
 */

const { loadGstModule } = require('./gst-core');

async function checkGstin(value) {
  const [utils, gstr1] = await Promise.all([loadGstModule('utils'), loadGstModule('gstr1')]);
  const raw = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
  if (!raw) return { ok: false, message: 'Enter a GSTIN' };
  const d = utils.decodeGstin(raw);
  if (!d) return { ok: false, message: 'A GSTIN has 15 characters' };
  if (!gstr1.gstinFormatOk(d.gstin)) return { ok: false, message: 'This is not a GSTIN format' };
  if (!d.checksumOk) return { ok: false, message: 'This GSTIN fails its checksum - check for a typo' };
  const stateCode = utils.getStateCode(d.gstin);
  const state = stateCode ? utils.stateNameForCode(stateCode) : null;
  if (!state) return { ok: false, message: `Unknown state code ${d.stateCode}` };
  return { ...d, ok: true, message: '', stateCode, state };
}

/** The GST state code of a state name, code or GSTIN ('' when unknown). */
async function stateCodeOf(value) {
  const utils = await loadGstModule('utils');
  return utils.getStateCode(String(value || '').trim()) || '';
}

module.exports = { checkGstin, stateCodeOf };
