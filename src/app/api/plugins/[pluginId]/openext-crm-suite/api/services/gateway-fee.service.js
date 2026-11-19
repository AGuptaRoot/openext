'use strict';

/**
 * Razorpay fee log (GST suite, CRM 3.53.0; documentation/gst-planning/04 §2).
 *
 * - logPayment: called once, right after a Razorpay payment is recorded (never on a repeated confirmation).
 *   Upsert with $setOnInsert on { tenantId, gateway, paymentId }: one row per payment, ever. Never throws.
 * - refresh: fills fees / GST on fee / net / settlement of rows that do not know them yet, from Razorpay
 *   (GET /payments/:id, and the settlement reconciliation report by settlement day). Run when the
 *   reconciliation page opens or "Refresh fees" is pressed.
 * - summary: one month's gross, fee, GST on fee and net, for comparing with Razorpay's GST invoice (GSTR-2B).
 * Razorpay keys stay in the Razorpay plugin's own config (getCredentials); nothing is copied.
 */

const { resolveTenantId } = require('../utils/tenant.util');
const Adapter = require('../lib/gst-adapter');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY_MS = 86400000;

function model(req) {
  return req.cms?.models?.get?.('GatewayFee') || null;
}

function tenantOf(req) {
  return req.tenantId || resolveTenantId(req);
}

/** Paise → rupees; null when not given. */
function rupees(paise, currency = 'INR') {
  if (paise === null || paise === undefined || paise === '') return null;
  const n = Number(paise);
  if (!Number.isFinite(n) || n < 0) return null;
  const divisor = ['JPY', 'KRW'].includes(String(currency).toUpperCase()) ? 1 : 100;
  return r2(n / divisor);
}

function netOf(gross, fee, gst) {
  return fee === null || fee === undefined ? null : r2(gross - (Number(fee) || 0) - (Number(gst) || 0));
}

/** Log the fee of a payment just recorded. `razorpayPayment` = Razorpay's payment entity. Never throws. */
async function logPayment(req, { razorpayPayment, payment, invoiceId, currency } = {}) {
  try {
    const Fee = model(req);
    const rp = razorpayPayment || {};
    if (!Fee || !rp.id) return null;
    const cur = String(currency || rp.currency || 'INR').toUpperCase();
    const gross = rupees(rp.amount, cur) || 0;
    const fee = rupees(rp.fee, cur);
    const gstOnFee = rupees(rp.tax, cur);
    const createdAt = Number(rp.created_at) > 0 ? new Date(Number(rp.created_at) * 1000) : new Date();
    await Fee.updateOne(
      { tenantId: tenantOf(req), gateway: 'razorpay', paymentId: String(rp.id) },
      {
        $setOnInsert: {
          tenantId: tenantOf(req),
          gateway: 'razorpay',
          paymentId: String(rp.id),
          orderId: String(rp.order_id || ''),
          invoiceId: String(invoiceId || ''),
          crmPaymentId: payment && payment._id ? String(payment._id) : '',
          method: String(rp.method || ''),
          paidOn: Adapter.localIsoDate(createdAt),
          currency: cur,
          gross,
          fee,
          gstOnFee,
          net: netOf(gross, fee, gstOnFee)
        }
      },
      { upsert: true }
    );
    return true;
  } catch (error) {
    // A fee-log failure must never fail the customer's payment.
    console.error('[plugin:openext-crm-suite] gateway fee not logged:', error?.code || '', error?.message || error);
    return null;
  }
}

async function rows(query) {
  if (!query) return [];
  const out = typeof query.lean === 'function' ? await query.lean() : await query;
  return Array.isArray(out) ? out : [];
}

/** India date (YYYY-MM-DD) → { year, month, day } numbers, plus n days. */
function dayParts(iso, plus = 0) {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + plus * DAY_MS;
  const d = new Date(t);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), iso: d.toISOString().slice(0, 10) };
}

/**
 * Fill what is still unknown, from Razorpay. `api(path)` = authenticated GET (injected in tests).
 * Looks at rows of the last 60 days without a fee or without a settlement; at most 40 Razorpay calls.
 * → { checked, feesFilled, settlementsFilled, calls }
 */
async function refresh(req, { api } = {}) {
  const Fee = model(req);
  if (!Fee) return { checked: 0, feesFilled: 0, settlementsFilled: 0, calls: 0 };
  let call = api;
  if (!call) {
    const Razorpay = require('./razorpay-gateway.service');
    const creds = await Razorpay.getCredentials(req);
    call = (path) => Razorpay.razorpayRequest(creds.keyId, creds.keySecret, path);
  }
  const since = dayParts(Adapter.localIsoDate(new Date()), -60).iso;
  const pending = await rows(Fee.find({
    tenantId: tenantOf(req),
    gateway: 'razorpay',
    paidOn: { $gte: since },
    $or: [{ fee: null }, { settlementId: '' }]
  }));
  const MAX_CALLS = 40;
  let calls = 0;
  let feesFilled = 0;
  let settlementsFilled = 0;

  // Fees: the payment entity carries fee and tax once captured.
  for (const row of pending.filter((r) => r.fee === null || r.fee === undefined)) {
    if (calls >= MAX_CALLS) break;
    calls += 1;
    try {
      const p = await call(`/payments/${encodeURIComponent(row.paymentId)}`);
      const fee = rupees(p && p.fee, row.currency);
      if (fee === null) continue;
      const gstOnFee = rupees(p && p.tax, row.currency) || 0;
      await Fee.updateOne({ _id: row._id }, { $set: { fee, gstOnFee, net: netOf(row.gross, fee, gstOnFee) } });
      row.fee = fee;
      feesFilled += 1;
    } catch (error) {
      console.error('[plugin:openext-crm-suite] gateway fee refresh (payment) failed:', error?.message || error);
    }
  }

  // Settlements: Razorpay settles a few days after payment. Read the combined reconciliation report for the
  // days after each pending payment (settlement day), once per day.
  const unsettled = pending.filter((r) => !r.settlementId);
  const byPayment = new Map(unsettled.map((r) => [r.paymentId, r]));
  const days = [...new Set(unsettled.flatMap((r) => [0, 1, 2, 3, 4, 5].map((n) => dayParts(r.paidOn, n).iso)))]
    .filter((d) => d <= Adapter.localIsoDate(new Date()))
    .sort();
  for (const iso of days) {
    if (calls >= MAX_CALLS || !byPayment.size) break;
    const { year, month, day } = dayParts(iso);
    calls += 1;
    let report;
    try {
      report = await call(`/settlements/recon/combined?year=${year}&month=${month}&day=${day}&count=1000`);
    } catch (error) {
      console.error('[plugin:openext-crm-suite] gateway fee refresh (settlements) failed:', error?.message || error);
      continue;
    }
    for (const item of (report && Array.isArray(report.items) ? report.items : [])) {
      const row = item && byPayment.get(String(item.entity_id || ''));
      if (!row || !item.settlement_id) continue;
      const set = {
        settlementId: String(item.settlement_id),
        settledOn: Number(item.settled_at) > 0 ? Adapter.localIsoDate(new Date(Number(item.settled_at) * 1000)) : iso
      };
      if ((row.fee === null || row.fee === undefined) && item.fee !== undefined) {
        set.fee = rupees(item.fee, row.currency) || 0;
        set.gstOnFee = rupees(item.tax, row.currency) || 0;
        set.net = netOf(row.gross, set.fee, set.gstOnFee);
      }
      await Fee.updateOne({ _id: row._id }, { $set: set });
      byPayment.delete(row.paymentId);
      settlementsFilled += 1;
    }
  }
  return { checked: pending.length, feesFilled, settlementsFilled, calls };
}

/** One month (YYYY-MM): totals, the rows, and how many still wait for their fee. */
async function summary(req, { month } = {}) {
  const Fee = model(req);
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : Adapter.localIsoDate(new Date()).slice(0, 7);
  const list = Fee ? await rows(Fee.find({ tenantId: tenantOf(req), paidOn: { $gte: `${m}-01`, $lte: `${m}-31` } })) : [];
  const sum = (k) => r2(list.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  return {
    month: m,
    payments: list.length,
    gross: sum('gross'),
    fee: sum('fee'),
    gstOnFee: sum('gstOnFee'),
    net: sum('net'),
    pending: list.filter((r) => r.fee === null || r.fee === undefined).length,
    rows: list
      .sort((a, b) => String(a.paidOn).localeCompare(String(b.paidOn)))
      .map((r) => ({
        paymentId: r.paymentId, paidOn: r.paidOn, method: r.method, gross: r2(r.gross),
        fee: r.fee, gstOnFee: r.gstOnFee, net: r.net, settlementId: r.settlementId, settledOn: r.settledOn,
        invoiceId: r.invoiceId, bankMatched: Boolean(r.bankLineId)
      })),
    note: "Compare the GST on fees with the GST on Razorpay's invoice for this month in GSTR-2B before claiming input tax credit."
  };
}

/** Razorpay settlements known so far, as bank-matching entries (net amounts, money in). */
async function settlementEntries(req) {
  const Fee = model(req);
  if (!Fee) return [];
  const list = await rows(Fee.find({ tenantId: tenantOf(req), settlementId: { $ne: '' } }));
  const bySettlement = new Map();
  for (const r of list) {
    const s = bySettlement.get(r.settlementId) || { id: r.settlementId, date: r.settledOn, amount: 0, matched: false, complete: true };
    s.amount = r2(s.amount + (Number(r.net) || 0));
    if (r.net === null || r.net === undefined) s.complete = false;
    if (r.bankLineId) s.matched = true;
    bySettlement.set(r.settlementId, s);
  }
  return [...bySettlement.values()]
    .filter((s) => s.complete && s.amount > 0)
    .map((s) => ({
      side: 'credit',
      kind: 'settlement',
      key: `settlement:${s.id}`,
      id: s.id,
      number: s.id,
      party: 'Razorpay',
      date: s.date,
      amount: s.amount,
      record: false,
      matched: s.matched
    }));
}

/** Link (or unlink) a settlement's rows to a bank line. */
async function setSettlementBankLine(req, settlementId, bankLineId) {
  const Fee = model(req);
  if (!Fee) return;
  await Fee.updateMany({ tenantId: tenantOf(req), settlementId: String(settlementId) }, { $set: { bankLineId: String(bankLineId || '') } });
}

module.exports = { logPayment, refresh, summary, settlementEntries, setSettlementBankLine, rupees };
