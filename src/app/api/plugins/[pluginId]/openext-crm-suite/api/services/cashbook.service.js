'use strict';

/**
 * Cash book (GST suite, CRM 3.53.0; documentation/gst-planning/02).
 *
 * Built every time it is read, from:
 *   - CRM Payments with mode Cash (INR, verified)             → in   (key payment:<id>)
 *   - cash refunds of those payments (Processed)               → out  (key refund:<paymentId>:<n>)
 *   - Expenses paid in Cash and Approved (INR)                 → out  (key expense:<id>)
 *   - manual CashEntry rows (opening balance, petty cash, …)  → in/out (key own:<id>)
 * so a cash payment is never written twice and back-dated entries or deletes never leave a wrong balance.
 * The sorting, running balance, totals and entry checks are the GST app's (lib/gst-core cashBook.js).
 * Writes are refused on or before Settings → GST "Books locked up to" (the GST app's periodLock).
 * Generic: categories and record links of an extension come from its manifest (salesFlow.gst).
 */

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { loadGstModule } = require('../lib/gst-core');
const Adapter = require('../lib/gst-adapter');
const { BASE_CASH_CATEGORIES } = require('../utils/cash-categories.util');
const AuditService = require('./audit.service');

const UNVERIFIED_PAYMENT_STATUSES = ['Pending', 'Failed', 'Cancelled'];
const ID_RE = /^[a-f0-9]{24}$/i;
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

function optionalModel(req, name) {
  return req.cms?.models?.get?.(name) || null;
}

function tenantOf(req) {
  return req.tenantId || resolveTenantId(req);
}

async function rows(query) {
  if (!query) return [];
  const out = typeof query.lean === 'function' ? await query.lean() : await query;
  return Array.isArray(out) ? out : [];
}

/** The enabled extension: its id, its cash categories and its record links. */
async function extensionContract(req) {
  try {
    const CrmExtensionService = require('./crm-extension.service');
    const def = await CrmExtensionService.getActive(req);
    if (!def || def.isInternal !== false) return { id: '', categories: [], refTypes: [] };
    const gst = (def.salesFlow && def.salesFlow.gst) || {};
    return {
      id: String(def.id || ''),
      categories: Array.isArray(gst.cashCategories) ? gst.cashCategories.map(String) : [],
      refTypes: Array.isArray(gst.cashRefTypes) ? gst.cashRefTypes.map((r) => ({ refType: String(r.refType), label: String(r.label || r.refType) })) : []
    };
  } catch {
    return { id: '', categories: [], refTypes: [] };
  }
}

/** Base categories plus the enabled extension's. */
async function categories(req) {
  const ext = await extensionContract(req);
  const seen = new Set();
  const list = [];
  for (const c of [...BASE_CASH_CATEGORIES, ...ext.categories]) {
    const key = c.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      list.push(c);
    }
  }
  return { categories: list, extension: ext.id ? { id: ext.id, categories: ext.categories, refTypes: ext.refTypes } : null };
}

async function lockedUpTo(req) {
  try {
    const { settings, ready } = await require('./gst.service').context(req);
    return ready ? String(settings.lockedUpTo || '') : '';
  } catch {
    return '';
  }
}

/** Refuse a write that touches a locked date (the GST app's rule). `before` / `after`: { date, amount, type }. */
async function assertNotLocked(req, before, after) {
  const upTo = await lockedUpTo(req);
  if (!upTo) return;
  const periodLock = await loadGstModule('periodLock');
  const problem = periodLock.lockProblem('cash-book', before, after, upTo);
  if (problem) throw appError(problem.replace('Settings -> Data', 'Settings → GST'), 409, 'BOOKS_LOCKED');
}

/** Client names for payment lines, one query for all. */
async function clientNames(req, ids) {
  const list = [...new Set(ids.filter((id) => ID_RE.test(String(id || ''))).map(String))];
  const Company = optionalModel(req, 'Company');
  if (!list.length || !Company) return new Map();
  let q = Company.find({ tenantId: tenantOf(req), _id: { $in: list } });
  if (q && typeof q.select === 'function') q = q.select('name');
  return new Map((await rows(q)).map((c) => [String(c._id), c.name || '']));
}

/** Every cash line of the tenant (unsorted; the GST app's cashBookView sorts). */
async function allLines(req) {
  const tenantId = tenantOf(req);
  const Payment = optionalModel(req, 'Payment');
  const Expense = optionalModel(req, 'Expense');
  const [payments, expenses, own] = await Promise.all([
    Payment ? rows(Payment.find({ tenantId, mode: 'Cash', isDeleted: { $ne: true } })) : [],
    Expense ? rows(Expense.find({ tenantId, paymentMode: 'Cash', status: 'Approved', isDeleted: { $ne: true } })) : [],
    rows(model(req, 'CashEntry').find({ tenantId, isDeleted: { $ne: true } }))
  ]);
  const inr = (doc) => String(doc.currency || 'INR').toUpperCase() === 'INR';
  const names = await clientNames(req, payments.map((p) => p.clientId));
  const lines = [];

  for (const p of payments) {
    if (!inr(p) || UNVERIFIED_PAYMENT_STATUSES.includes(String(p.status || ''))) continue;
    const amount = r2(p.amount);
    if (amount <= 0) continue;
    lines.push({
      key: `payment:${p._id}`,
      source: 'payment',
      label: `Payment ${p.paymentNo || ''}`.trim(),
      type: 'in',
      date: Adapter.localIsoDate(p.paymentDate || p.createdAt),
      amount,
      name: names.get(String(p.clientId)) || '',
      note: p.remark || p.notes || '',
      category: p.proformaInvoiceId ? 'Customer advance' : 'Balance payment',
      at: String(p.createdAt || ''),
      link: { kind: 'invoice', id: String(p.invoiceId || '') }
    });
    (Array.isArray(p.refunds) ? p.refunds : []).forEach((rf, n) => {
      const cashRefund = rf && (rf.mode === 'Cash' || rf.mode === 'Original Payment Method');
      if (!cashRefund || rf.status !== 'Processed' || r2(rf.amount) <= 0) return;
      lines.push({
        key: `refund:${p._id}:${n}`,
        source: 'refund',
        label: `Refund ${rf.refundNo || ''}`.trim(),
        type: 'out',
        date: Adapter.localIsoDate(rf.processedAt || rf.approvedAt || rf.requestedAt || p.updatedAt),
        amount: r2(rf.amount),
        name: names.get(String(p.clientId)) || '',
        note: rf.reason || '',
        category: 'Refund',
        at: String(rf.processedAt || ''),
        link: { kind: 'invoice', id: String(p.invoiceId || '') }
      });
    });
  }

  for (const e of expenses) {
    if (!inr(e) || r2(e.amount) <= 0) continue;
    lines.push({
      key: `expense:${e._id}`,
      source: 'expense',
      label: `Expense ${e.expenseNo || ''}`.trim(),
      type: 'out',
      date: Adapter.localIsoDate(e.expenseDate || e.createdAt),
      amount: r2(e.amount),
      name: e.purchasedFrom || e.employeeName || '',
      note: e.title || '',
      category: e.category || 'Other',
      at: String(e.createdAt || ''),
      link: { kind: 'expense', id: String(e._id) }
    });
  }

  for (const c of own) {
    lines.push({
      key: `own:${c._id}`,
      source: 'own',
      label: '',
      type: c.type,
      date: c.date,
      amount: r2(c.amount),
      name: c.name || '',
      note: c.note || '',
      category: c.category || 'Other',
      at: String(c.createdAt || ''),
      ...(c.refType ? { link: { kind: 'record', refType: c.refType, id: c.refId } } : {}),
      entry: { id: String(c._id), refType: c.refType || '', refId: c.refId || '' }
    });
  }
  return lines.filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(String(l.date || '')));
}

/** { opening, rows (each with balance), totals, closing } for a period (YYYY-MM-DD, '' = open). */
async function book(req, { from = '', to = '', search = '' } = {}) {
  const cashBook = await loadGstModule('cashBook');
  const clean = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : '');
  return cashBook.cashBookView(await allLines(req), { from: clean(from), to: clean(to), search: String(search || '').slice(0, 100) });
}

/** { inHand, today: {in,out,net}, month: {in,out,net}, lockedUpTo }. */
async function summary(req) {
  const cashBook = await loadGstModule('cashBook');
  const out = cashBook.cashSummary(await allLines(req), Adapter.localIsoDate(new Date()));
  return { ...out, lockedUpTo: await lockedUpTo(req) };
}

/** Checked and cleaned manual entry fields (the GST app's rules + the allowed categories). */
async function cleanInput(req, input) {
  const cashBook = await loadGstModule('cashBook');
  const src = input && typeof input === 'object' ? input : {};
  const entry = {
    type: src.type,
    date: typeof src.date === 'string' ? src.date.trim() : src.date,
    amount: src.amount,
    name: typeof src.name === 'string' ? src.name : src.name === undefined ? undefined : src.name,
    note: typeof src.note === 'string' ? src.note : src.note === undefined ? undefined : src.note,
    category: typeof src.category === 'string' && src.category.trim() ? src.category : 'Other'
  };
  const problem = cashBook.validateCashEntry(entry);
  if (problem) throw appError(problem, 400);
  const clean = cashBook.cleanCashEntry(entry);
  const { categories: allowed } = await categories(req);
  const match = allowed.find((c) => c.toLowerCase() === clean.category.toLowerCase());
  if (!match) throw appError(`Unknown cash category "${clean.category}"`, 400);
  return { type: clean.type, date: clean.date, amount: clean.amount, name: clean.name, note: clean.note, category: match };
}

function presentEntry(doc) {
  if (!doc) return null;
  const d = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(d._id),
    type: d.type,
    date: d.date,
    amount: r2(d.amount),
    category: d.category || 'Other',
    name: d.name || '',
    note: d.note || '',
    refType: d.refType || '',
    refId: d.refId || ''
  };
}

/** Add a manual entry. `ref` = { refType, refId } (only from sdk.finance.addCashEntry, already namespaced). */
async function addEntry(req, input, ref = null) {
  const clean = await cleanInput(req, input);
  await assertNotLocked(req, null, clean);
  const userId = resolveUserId(req);
  const created = await model(req, 'CashEntry').create({
    tenantId: tenantOf(req),
    ...clean,
    refType: ref ? ref.refType : '',
    refId: ref ? ref.refId : '',
    createdBy: userId,
    updatedBy: userId
  });
  const entry = presentEntry(created);
  await AuditService.log(req, {
    action: 'created',
    module: 'cash_book',
    recordId: entry.id,
    description: `Cash ${entry.type === 'in' ? 'in' : 'out'} ${entry.amount} (${entry.category}) on ${entry.date}`,
    metadata: { type: entry.type, amount: entry.amount, date: entry.date, category: entry.category, refType: entry.refType }
  });
  return entry;
}

async function findOwn(req, id) {
  if (!ID_RE.test(String(id || ''))) throw appError('Cash entry not found', 404);
  let q = model(req, 'CashEntry').findOne({ tenantId: tenantOf(req), _id: String(id), isDeleted: { $ne: true } });
  const doc = q && typeof q.lean === 'function' ? await q.lean() : await q;
  if (!doc) throw appError('Cash entry not found', 404);
  return doc;
}

/** Edit a manual entry (payment / expense lines are edited at their source). */
async function updateEntry(req, id, input) {
  const before = await findOwn(req, id);
  const clean = await cleanInput(req, { ...presentEntry(before), ...(input || {}) });
  await assertNotLocked(req, before, clean);
  const q = model(req, 'CashEntry').findOneAndUpdate(
    { tenantId: tenantOf(req), _id: String(id), isDeleted: { $ne: true } },
    { $set: { ...clean, updatedBy: resolveUserId(req) } },
    { new: true, runValidators: true }
  );
  const updated = presentEntry(q && typeof q.lean === 'function' ? await q.lean() : await q);
  await AuditService.log(req, {
    action: 'updated',
    module: 'cash_book',
    recordId: String(id),
    description: `Cash entry changed: ${updated.type} ${updated.amount} on ${updated.date}`,
    metadata: { before: { type: before.type, amount: r2(before.amount), date: before.date }, after: { type: updated.type, amount: updated.amount, date: updated.date } }
  });
  return updated;
}

/** Soft delete a manual entry. */
async function removeEntry(req, id) {
  const before = await findOwn(req, id);
  await assertNotLocked(req, before, null);
  const userId = resolveUserId(req);
  await model(req, 'CashEntry').updateOne(
    { tenantId: tenantOf(req), _id: String(id) },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId, updatedBy: userId } }
  );
  await AuditService.log(req, {
    action: 'deleted',
    module: 'cash_book',
    recordId: String(id),
    description: `Cash entry removed: ${before.type} ${r2(before.amount)} on ${before.date}`,
    metadata: { type: before.type, amount: r2(before.amount), date: before.date, category: before.category }
  });
  return { id: String(id), deleted: true };
}

/** Cash taken to the bank (deposit: cash out) or brought from it (withdraw: cash in). */
async function contra(req, input) {
  const src = input && typeof input === 'object' ? input : {};
  if (src.direction !== 'deposit' && src.direction !== 'withdraw') throw appError('Choose deposit or withdraw', 400);
  return addEntry(req, {
    type: src.direction === 'deposit' ? 'out' : 'in',
    category: src.direction === 'deposit' ? 'Deposit to bank' : 'Withdrawal from bank',
    date: src.date,
    amount: src.amount,
    name: typeof src.name === 'string' ? src.name : '',
    note: typeof src.note === 'string' ? src.note : ''
  });
}

/** Manual lines of one extension record (sdk.finance.cashLines). refType already namespaced. */
async function linesForRef(req, refType, refId) {
  const list = await rows(model(req, 'CashEntry').find({ tenantId: tenantOf(req), refType, refId, isDeleted: { $ne: true } }));
  const lines = list.map(presentEntry).sort((a, b) => a.date.localeCompare(b.date));
  const tIn = r2(lines.filter((l) => l.type === 'in').reduce((s, l) => s + l.amount, 0));
  const tOut = r2(lines.filter((l) => l.type === 'out').reduce((s, l) => s + l.amount, 0));
  return { lines, totals: { in: tIn, out: tOut, net: r2(tIn - tOut) } };
}

module.exports = {
  allLines,
  book,
  summary,
  categories,
  addEntry,
  updateEntry,
  removeEntry,
  contra,
  linesForRef,
  extensionContract
};
