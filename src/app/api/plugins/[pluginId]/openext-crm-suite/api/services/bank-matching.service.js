'use strict';

/**
 * Bank statement matching (GST suite, CRM 3.53.0; documentation/gst-planning/04 §3).
 *
 * The GST app's tested rules (lib/gst-core bankMatch.js) do the work: toBankLines (dates, opening / total
 * rows dropped), freshLines (a statement imported twice adds nothing twice), suggestFor (same amount or ₹1
 * round-off, within 7 days, number / party in the description, each with a reason) and pickList.
 * The CRM side only lists what a line can be, in the app's entry shape:
 *   credit  · a non-cash, non-gateway payment already on an invoice / proforma   (record: false)
 *           · the open balance of an invoice / proforma                          (record: true → a Payment)
 *           · a Razorpay settlement (net of many payments)                        (record: false)
 *   debit   · an approved expense not paid in cash                                (record: false)
 * Razorpay payments are never offered on their own: the bank receives their settlement, so the money is
 * never counted twice. Confirming an open balance records a CRM Payment (Bank Transfer) through
 * PaymentService, so every follow-up (balance, proforma → booking, advance receipt voucher) runs as usual.
 * No file is stored: the browser reads the statement and sends its rows.
 */

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { loadGstModule } = require('../lib/gst-core');
const Adapter = require('../lib/gst-adapter');
const AuditService = require('./audit.service');
const GatewayFees = require('./gateway-fee.service');

const MAX_ROWS = 5000;
const UNVERIFIED = ['Pending', 'Failed', 'Cancelled'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function appError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function model(req, name) {
  const M = req.cms?.models?.get?.(name);
  if (!M) throw appError(`${name} model is not registered`, 500);
  return M;
}

const optional = (req, name) => req.cms?.models?.get?.(name) || null;
const tenantOf = (req) => req.tenantId || resolveTenantId(req);

async function rows(query) {
  if (!query) return [];
  const out = typeof query.lean === 'function' ? await query.lean() : await query;
  return Array.isArray(out) ? out : [];
}

/* ------------------------------------------------------------------ import */

/**
 * Save the new lines of a statement read in the browser. rows: [{ date, description, reference, credit,
 * debit, balance }] (credit and debit as separate positive numbers).
 * → { statementId, added, skippedAsDuplicate, ignoredRows }
 */
async function importStatement(req, input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const account = String(src.account || '').trim().slice(0, 120);
  const fileName = String(src.fileName || '').trim().slice(0, 200);
  const raw = Array.isArray(src.rows) ? src.rows : [];
  if (!raw.length) throw appError('The statement has no rows');
  if (raw.length > MAX_ROWS) throw appError(`A statement can have at most ${MAX_ROWS} rows`);
  const bank = await loadGstModule('bankMatch');
  const Statement = model(req, 'BankStatement');
  const statementId = `bs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const parsed = bank.toBankLines(raw.map((r) => (r && typeof r === 'object' ? r : {})), statementId);
  const saved = (await rows(Statement.find({ tenantId: tenantOf(req), account }))).flatMap((s) => s.lines || []);
  const fresh = bank.freshLines(saved, parsed);
  if (fresh.length) {
    await Statement.create({ tenantId: tenantOf(req), account, fileName, importedBy: resolveUserId(req), lines: fresh });
    await AuditService.log(req, {
      action: 'created',
      module: 'payment',
      recordId: statementId,
      description: `Bank statement imported: ${fresh.length} new line(s)${account ? ` (${account})` : ''}`,
      metadata: { area: 'bank_matching', added: fresh.length, duplicates: parsed.length - fresh.length }
    });
  }
  return { statementId, added: fresh.length, skippedAsDuplicate: parsed.length - fresh.length, ignoredRows: raw.length - parsed.length };
}

/* ------------------------------------------------------------------ entries */

/** Everything a bank line could be, in the GST app's entry shape. */
async function bookEntries(req) {
  const tenantId = tenantOf(req);
  const since = new Date(Date.now() - 550 * 86400000);
  const Invoice = optional(req, 'Invoice');
  const Payment = optional(req, 'Payment');
  const Expense = optional(req, 'Expense');
  const Company = optional(req, 'Company');
  const [invoices, payments, expenses] = await Promise.all([
    Invoice ? rows(Invoice.find({ tenantId, isDeleted: { $ne: true }, status: { $nin: ['Draft', 'Cancelled', 'Converted', 'Written Off'] }, issueDate: { $gte: since } })) : [],
    Payment ? rows(Payment.find({ tenantId, isDeleted: { $ne: true }, mode: { $ne: 'Cash' }, paymentDate: { $gte: since } })) : [],
    Expense ? rows(Expense.find({ tenantId, isDeleted: { $ne: true }, status: 'Approved', paymentMode: { $ne: 'Cash' }, expenseDate: { $gte: since } })) : []
  ]);
  const inr = (d) => String(d.currency || 'INR').toUpperCase() === 'INR';
  const clientIds = [...new Set(invoices.map((i) => String(i.clientId || '')).filter((id) => /^[a-f0-9]{24}$/i.test(id)))];
  let names = new Map();
  if (Company && clientIds.length) {
    let q = Company.find({ tenantId, _id: { $in: clientIds } });
    if (q && typeof q.select === 'function') q = q.select('name');
    names = new Map((await rows(q)).map((c) => [String(c._id), c.name || '']));
  }
  const byId = new Map(invoices.map((i) => [String(i._id), i]));
  const out = [];

  for (const p of payments) {
    const inv = byId.get(String(p.invoiceId || ''));
    if (!inv || !inr(p) || UNVERIFIED.includes(String(p.status || '')) || !(Number(p.amount) > 0)) continue;
    // Gateway payments reach the bank inside their settlement.
    if (String(p.paymentGateway || '').toLowerCase() === 'razorpay') continue;
    out.push({
      side: 'credit',
      kind: 'invoice',
      id: String(inv._id),
      number: inv.invoiceNo || '',
      party: names.get(String(inv.clientId)) || '',
      key: `invoice:${inv._id}:${p._id}`,
      paymentId: String(p._id),
      record: false,
      amount: r2(p.amount),
      date: Adapter.localIsoDate(p.paymentDate)
    });
  }
  for (const inv of invoices) {
    if (!inr(inv) || !(Number(inv.balanceDue) > 0.005)) continue;
    out.push({
      side: 'credit',
      kind: 'invoice',
      id: String(inv._id),
      number: inv.invoiceNo || '',
      party: names.get(String(inv.clientId)) || '',
      key: `invoice:${inv._id}:open`,
      record: true,
      amount: r2(inv.balanceDue),
      date: Adapter.localIsoDate(inv.issueDate)
    });
  }
  for (const e of expenses) {
    if (!inr(e) || !(Number(e.amount) > 0)) continue;
    out.push({
      side: 'debit',
      kind: 'expense',
      id: String(e._id),
      number: e.expenseNo || '',
      party: e.purchasedFrom || e.title || '',
      key: `expense:${e._id}:paid`,
      record: false,
      amount: r2(e.amount),
      date: Adapter.localIsoDate(e.expenseDate)
    });
  }
  for (const s of await GatewayFees.settlementEntries(req)) out.push(s);
  return out;
}

const labelOf = (bank, e) => (e.kind === 'settlement' ? `Razorpay settlement ${e.id}` : bank.entryLabel(e));

/* ------------------------------------------------------------------ lines */

async function allStatements(req, account) {
  const filter = { tenantId: tenantOf(req) };
  if (account !== undefined && account !== null && account !== '') filter.account = String(account);
  let q = model(req, 'BankStatement').find(filter);
  if (q && typeof q.sort === 'function') q = q.sort({ createdAt: -1 });
  return rows(q);
}

/** Lines of a status ('open' | 'matched' | 'ignored' | 'all'), open ones with their top 3 suggestions. */
async function lines(req, { status = 'open', account = '' } = {}) {
  const bank = await loadGstModule('bankMatch');
  const statements = await allStatements(req, account);
  const all = statements.flatMap((s) => (s.lines || []).map((l) => ({ ...l, statementId: String(s._id), account: s.account || '' })));
  const used = bank.usedKeys(all);
  const entries = status === 'open' || status === 'all' ? await bookEntries(req) : [];
  const wanted = all.filter((l) => status === 'all' || l.status === status).sort((a, b) => a.date.localeCompare(b.date));
  return {
    accounts: [...new Set(statements.map((s) => s.account || ''))],
    lines: wanted.slice(0, 500).map((l) => ({
      ...l,
      suggestions: l.status === 'open'
        ? bank.suggestFor(l, entries, used).slice(0, 3).map((e) => ({ key: e.key, kind: e.kind, label: labelOf(bank, e), amount: e.amount, date: e.date, record: e.record, why: e.why }))
        : []
    })),
    counts: {
      open: all.filter((l) => l.status === 'open').length,
      matched: all.filter((l) => l.status === 'matched').length,
      ignored: all.filter((l) => l.status === 'ignored').length
    }
  };
}

async function findLine(req, statementId, lineId) {
  const q = model(req, 'BankStatement').findOne({ tenantId: tenantOf(req), _id: String(statementId) });
  const doc = q && typeof q.lean === 'function' ? await q.lean() : await q;
  const line = doc && (doc.lines || []).find((l) => l.id === String(lineId));
  if (!line) throw appError('Bank line not found', 404);
  return { statement: doc, line };
}

/** Manual search for one line. */
async function pick(req, { statementId, lineId, search = '' } = {}) {
  const bank = await loadGstModule('bankMatch');
  const { line } = await findLine(req, statementId, lineId);
  const all = (await allStatements(req)).flatMap((s) => s.lines || []);
  const list = bank.pickList(line, await bookEntries(req), bank.usedKeys(all), String(search || '').slice(0, 60), 15);
  return list.map((e) => ({ key: e.key, kind: e.kind, label: labelOf(bank, e), amount: e.amount, date: e.date, record: e.record }));
}

/**
 * Atomically move a line from `from` status to a new status / match. Two users matching one line at the
 * same time: one wins, the other gets 409.
 */
async function setLine(req, statementId, lineId, from, status, match) {
  const q = model(req, 'BankStatement').findOneAndUpdate(
    { tenantId: tenantOf(req), _id: String(statementId), lines: { $elemMatch: { id: String(lineId), status: from } } },
    { $set: { 'lines.$.status': status, 'lines.$.match': match } },
    { new: true }
  );
  const doc = q && typeof q.lean === 'function' ? await q.lean() : await q;
  if (!doc) throw appError(`This bank line is no longer ${from}: reload and try again`, 409, 'LINE_CHANGED');
  return doc;
}

/** Confirm a match. Recording a payment needs crm.finance.write (route). */
async function match(req, { statementId, lineId, entryKey } = {}) {
  const bank = await loadGstModule('bankMatch');
  const { line } = await findLine(req, statementId, lineId);
  if (line.status !== 'open') throw appError('This bank line is already matched or ignored', 409, 'LINE_CHANGED');
  const all = (await allStatements(req)).flatMap((s) => s.lines || []);
  const used = bank.usedKeys(all);
  const entry = (await bookEntries(req)).find((e) => e.key === String(entryKey || ''));
  if (!entry || used.has(entry.key)) throw appError('That record is not available for this line any more', 409, 'ENTRY_USED');
  const side = line.credit > 0 ? 'credit' : 'debit';
  if (entry.side !== side) throw appError(side === 'credit' ? 'Money in can only match money received' : 'Money out can only match money paid');

  const by = resolveUserId(req);
  const label = labelOf(bank, entry);
  if (entry.kind === 'settlement') {
    const m = { key: entry.key, kind: 'settlement', id: entry.id, paymentId: '', recorded: false, label, at: new Date().toISOString(), by };
    await setLine(req, statementId, lineId, 'open', 'matched', m);
    await GatewayFees.setSettlementBankLine(req, entry.id, lineId);
    return { status: 'matched', match: m };
  }
  if (!entry.record) {
    const done = bank.matchedLine(line, entry);
    const m = { ...done.match, key: entry.key, label, by };
    await setLine(req, statementId, lineId, 'open', 'matched', m);
    return { status: 'matched', match: m };
  }

  // An open balance: hold the line first (no double match), then record the payment through PaymentService.
  const hold = { key: entry.key, kind: entry.kind, id: entry.id, paymentId: '', recorded: true, label, at: new Date().toISOString(), by, pending: true };
  await setLine(req, statementId, lineId, 'open', 'matched', hold);
  let payment;
  try {
    const amount = r2(Math.min(r2(line.credit), entry.amount));
    payment = await require('./payment.service').create(req, {
      invoiceId: entry.id,
      amount,
      mode: 'Bank Transfer',
      paymentDate: line.date,
      transactionId: String(line.reference || '').slice(0, 120),
      remark: `Bank statement: ${String(line.description || '').slice(0, 200)}`
    });
  } catch (error) {
    await setLine(req, statementId, lineId, 'matched', 'open', null).catch(() => {});
    throw error;
  }
  const paymentId = String((payment && (payment._id || (payment.payments && payment.payments[0] && payment.payments[0]._id))) || '');
  const m = { ...hold, key: `invoice:${entry.id}:${paymentId}`, paymentId, pending: false };
  await setLine(req, statementId, lineId, 'matched', 'matched', m);
  return { status: 'matched', match: m, paymentId };
}

/** Undo a match (or an ignore). A payment recorded by the match is deleted (route checks crm.finance.delete). */
async function unmatch(req, { statementId, lineId } = {}) {
  const { line } = await findLine(req, statementId, lineId);
  if (line.status === 'open') return { status: 'open' };
  const m = line.match || {};
  await setLine(req, statementId, lineId, line.status, 'open', null);
  if (m.kind === 'settlement' && m.id) await GatewayFees.setSettlementBankLine(req, m.id, '');
  if (m.recorded && m.paymentId) {
    try {
      await require('./payment.service').remove(req, m.paymentId);
    } catch (error) {
      // Put the match back: the payment is still there.
      await setLine(req, statementId, lineId, 'open', line.status, m).catch(() => {});
      throw error;
    }
  }
  return { status: 'open', removedPayment: Boolean(m.recorded && m.paymentId) };
}

/** Bank charges, transfers between own accounts…: not in the books. */
async function ignore(req, { statementId, lineId } = {}) {
  await setLine(req, statementId, lineId, 'open', 'ignored', null);
  return { status: 'ignored' };
}

/** Does undoing this line delete a payment? (the route needs crm.finance.delete then) */
async function unmatchDeletesPayment(req, { statementId, lineId } = {}) {
  const { line } = await findLine(req, statementId, lineId);
  return Boolean(line.match && line.match.recorded && line.match.paymentId);
}

module.exports = { importStatement, bookEntries, lines, pick, match, unmatch, ignore, unmatchDeletesPayment };
