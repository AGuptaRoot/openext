'use strict';

/**
 * TCS by rule (GST suite, Step 5; documentation/gst-planning/03 §5). TCS is INCOME TAX collected on top of
 * the invoice, not GST.
 *
 * Generic: the CRM knows rules by KEY only. The rules (label, section, slabs, no-PAN rate, needs PAN) are
 * settings (Settings → GST → TCS rules), off until the admin fills them in with the CA. An extension may
 * declare a rule and set `tcsRuleKey` on its documents; the CRM never names one itself.
 *
 * On a tax invoice with a `tcsRuleKey`:
 *   - unknown or disabled rule → no TCS, plus a warning;
 *   - cumulativeBefore = the TCS base of this client's earlier ISSUED invoices under the same rule key and
 *     the same PAN in this financial year (matched by a keyed PAN fingerprint, never the PAN itself);
 *   - this invoice's base is split across the slabs from cumulativeBefore; no PAN → the rule's no-PAN rate;
 *   - the blended rate goes to the GST app's engine (computeInvoiceTotals showTCS / tcsRate), which adds
 *     tcsAmount on top of the total.
 * The PAN is never stored in plain text on the invoice (masked + fingerprint only) and never logged.
 */

const { resolveTenantId } = require('../utils/tenant.util');
const Adapter = require('../lib/gst-adapter');
const { loadGstModule } = require('../lib/gst-core');
const Protect = require('../extension-runtime/data-protection');
const ClientGst = require('./client-gst.service');

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function tenantOf(req) {
  return req.tenantId || resolveTenantId(req);
}

/** The rule of `key` in the tenant's settings (or null). */
function ruleFor(settings, key) {
  const k = String(key || '').trim();
  if (!k || !KEY_RE.test(k)) return null;
  return ((settings && settings.tcsRules) || []).find((r) => r && r.key === k) || null;
}

/** Slabs in order (by upper limit, the open-ended one last). */
function orderedSlabs(slabs) {
  return (Array.isArray(slabs) ? slabs : [])
    .map((s) => ({ upTo: s && s.upTo !== null && s.upTo !== undefined && s.upTo !== '' ? Number(s.upTo) : null, rate: Number(s && s.rate) || 0 }))
    .sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo));
}

/**
 * Split `base` across the slabs, starting at `cumulativeBefore` (pure; exported for tests).
 * Returns { parts: [{ from, to, amount, rate, tcs }], amount, rate } — rate is the blended rate (%).
 * Above the last slab with a limit and no open-ended slab: the last slab's rate continues.
 */
function splitSlabs(slabs, cumulativeBefore, base) {
  const list = orderedSlabs(slabs);
  const start = Math.max(0, Number(cumulativeBefore) || 0);
  const amountBase = Math.max(0, Number(base) || 0);
  const end = start + amountBase;
  const parts = [];
  let lower = 0;
  list.forEach((slab, i) => {
    const last = i === list.length - 1;
    const upper = slab.upTo === null || last ? Infinity : slab.upTo;
    const from = Math.max(start, lower);
    const to = Math.min(end, upper);
    if (to > from) parts.push({ from, to: to === Infinity ? end : to, amount: to - from, rate: slab.rate, tcs: (to - from) * slab.rate / 100 });
    lower = upper === Infinity ? lower : upper;
  });
  const raw = parts.reduce((s, p) => s + p.tcs, 0);
  return {
    parts: parts.map((p) => ({ ...p, amount: r2(p.amount), tcs: r2(p.tcs) })),
    amount: r2(raw),
    // Unrounded, so the engine's r2(base × rate / 100) gives back the same rupees.
    rate: amountBase > 0 ? (raw / amountBase) * 100 : 0
  };
}

/** India financial year of a date: { from, to } as 'YYYY-MM-DD'. */
function fyRange(date) {
  const iso = Adapter.localIsoDate(date || new Date()) || Adapter.localIsoDate(new Date());
  const y = Number(iso.slice(0, 4));
  const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/** Start / end instants (India time) of a 'YYYY-MM-DD' range, for querying Date fields. */
function instantRange({ from, to }) {
  return { $gte: new Date(`${from}T00:00:00.000+05:30`), $lte: new Date(`${to}T23:59:59.999+05:30`) };
}

/** Keyed fingerprint of a PAN (same scope as the client's typed PAN), so invoices group by PAN. */
function panFingerprint(req, pan) {
  const p = String(pan || '').trim().toUpperCase();
  return p ? Protect.hashText(tenantOf(req), ClientGst.PAN_SCOPE, p) : '';
}

/** Sum of gst.tcs.base of the earlier issued invoices of this PAN under this rule in the FY. */
async function cumulativeBefore(req, { ruleKey, panHash, issueDate, excludeInvoiceId } = {}) {
  const Invoice = req.cms?.models?.get?.('Invoice');
  if (!Invoice || !ruleKey || !panHash) return 0;
  const filter = {
    tenantId: tenantOf(req),
    documentType: { $ne: 'proforma' },
    isDeleted: { $ne: true },
    status: { $ne: 'Cancelled' },
    'gst.issuedAt': { $ne: null },
    'gst.tcs.applicable': true,
    'gst.tcs.ruleKey': ruleKey,
    'gst.tcs.panHash': panHash,
    issueDate: instantRange(fyRange(issueDate))
  };
  if (excludeInvoiceId) filter._id = { $ne: String(excludeInvoiceId) };
  let q = Invoice.find(filter);
  if (q && typeof q.select === 'function') q = q.select('gst.tcs.base');
  const rows = q && typeof q.lean === 'function' ? await q.lean() : await q;
  return r2((Array.isArray(rows) ? rows : []).reduce((s, row) => s + (Number(row?.gst?.tcs?.base) || 0), 0));
}

/**
 * TCS for one tax invoice (before the engine adds it). `base` = the engine's TCS base of this invoice.
 * Returns { tcs, warnings } — tcs is the `gst.tcs` sub-document ({ applicable: false } when none applies).
 */
async function forInvoice(req, { settings, tcsRuleKey, clientId, clientGstin, issueDate, base, excludeInvoiceId } = {}) {
  const key = String(tcsRuleKey || '').trim();
  if (!key) return { tcs: { applicable: false }, warnings: [] };
  const rule = ruleFor(settings, key);
  if (!rule || rule.enabled !== true) {
    const name = (rule && rule.label) || key;
    return {
      tcs: { applicable: false, ruleKey: key },
      warnings: [`TCS rule "${name}" is ${rule ? 'switched off' : 'not set up'} in Settings → GST, so no TCS was added to this invoice.`]
    };
  }
  const warnings = [];
  let pan = '';
  try {
    pan = clientId ? await ClientGst.clientPan(req, String(clientId)) : '';
  } catch {
    pan = '';
  }
  // A client with a GSTIN but no PAN on record: the PAN inside the GSTIN (the GST app's panFromGstin).
  if (!pan && clientGstin) pan = (await loadGstModule('tdsTcs')).panFromGstin(clientGstin);
  const panHash = panFingerprint(req, pan);
  const hasNoPanRate = rule.noPanRate !== null && rule.noPanRate !== undefined && Number.isFinite(Number(rule.noPanRate));
  let split;
  let before = 0;
  if (!pan && hasNoPanRate) {
    const rate = Number(rule.noPanRate) || 0;
    split = { parts: [{ from: 0, to: base, amount: r2(base), rate, tcs: r2(base * rate / 100) }], amount: r2(base * rate / 100), rate };
    warnings.push(`The client has no PAN on record, so TCS is at the no-PAN rate of ${rate}%. Add the client's PAN before issuing to use the normal rates.`);
  } else {
    if (!pan) warnings.push('The client has no PAN on record and this TCS rule has no no-PAN rate set in Settings → GST: the normal slabs were used. Ask your CA.');
    before = pan ? await cumulativeBefore(req, { ruleKey: key, panHash, issueDate, excludeInvoiceId }) : 0;
    split = splitSlabs(rule.slabs, before, base);
  }
  if (rule.needsPan !== false && !pan) warnings.push(`TCS rule "${rule.label || key}" needs the client's PAN.`);
  return {
    tcs: {
      applicable: true,
      ruleKey: key,
      section: String(rule.sectionLabel || ''),
      rate: split.rate,
      base: r2(base),
      amount: split.amount,
      pan: pan ? ClientGst.panMask(pan.slice(-4)) : '',
      panHash,
      cumulativeBefore: r2(before)
    },
    warnings
  };
}

module.exports = { ruleFor, orderedSlabs, splitSlabs, fyRange, instantRange, panFingerprint, cumulativeBefore, forInvoice };
