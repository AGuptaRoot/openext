'use strict';

/**
 * GST reports (GST suite, Step 5; documentation/gst-planning/03).
 *
 *   gstr1(req, { fy, period })        GSTR-1 for a month ('1'..'12') or quarter ('Q1'..'Q4'): portal JSON,
 *                                     summary, warnings, blocked list (gstr1.builder.js, the GST app's code)
 *   gstr1Csv(req, { fy, period, table }) one GSTR-1 table as CSV, in the offline-tool layout
 *   advances(req, { from, to })       Table 11A / 11B from advance receipt vouchers
 *   creditNotes(req, { from, to })    credit notes with their GST, and the GSTR-1 table each goes to
 *   tcs(req, { fy, quarter, rule })   TCS register (the GST app's tdsTcs.js), by rule key
 *
 * Read-only. Reads the ISSUED source documents and their frozen `gst` snapshot only (no ledger copy): each
 * document is counted once. One query per model, always on the tenant and the date range. Only tax
 * invoices (never proformas). Nothing is logged; the full client PAN is returned only by the TCS register,
 * which the TCS return needs. Generic: no industry words; TCS rules are named by the tenant's settings.
 */

const { resolveTenantId } = require('../utils/tenant.util');
const { loadGstModule } = require('../lib/gst-core');
const Adapter = require('../lib/gst-adapter');
const Builder = require('./gstr1.builder');
const TcsService = require('./tcs.service');

const FY_RE = /^(\d{4})-(\d{2}|\d{4})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
const ID_RE = /^[a-f0-9]{24}$/i;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function appError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function tenantOf(req) {
  return req.tenantId || resolveTenantId(req);
}

function optionalModel(req, name) {
  return req.cms?.models?.get?.(name) || null;
}

async function rows(query) {
  if (!query) return [];
  const out = typeof query.lean === 'function' ? await query.lean() : await query;
  return Array.isArray(out) ? out : [];
}

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** '2026-27' (or '2026-2027') → 2026. */
function fyStartOf(fy) {
  const m = FY_RE.exec(String(fy || '').trim());
  if (!m) throw appError('Choose a financial year like 2026-27');
  const start = Number(m[1]);
  const end = m[2].length === 2 ? Number(m[2]) : Number(m[2]) % 100;
  if (end !== (start + 1) % 100) throw appError('Choose a financial year like 2026-27');
  return start;
}

/**
 * The return period: { mode: 'month' | 'quarter', from, to, fp, label }. `period` is a calendar month
 * number ('11' = November) or a quarter ('Q3'). fp is MMYYYY; a quarterly return uses its last month.
 */
function parsePeriod({ fy, period } = {}) {
  const start = fyStartOf(fy);
  const p = String(period || '').trim().toUpperCase();
  const q = /^Q([1-4])$/.exec(p);
  if (q) {
    const months = { 1: [4, 6], 2: [7, 9], 3: [10, 12], 4: [1, 3] }[q[1]];
    const year = q[1] === '4' ? start + 1 : start;
    return {
      mode: 'quarter',
      from: `${year}-${pad(months[0])}-01`,
      to: `${year}-${pad(months[1])}-${pad(lastDay(year, months[1]))}`,
      fp: `${pad(months[1])}${year}`,
      label: `Q${q[1]} ${start}-${String((start + 1) % 100).padStart(2, '0')}`
    };
  }
  const month = Number(p);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !/^\d{1,2}$/.test(p)) throw appError('Choose a month (1-12) or a quarter (Q1-Q4)');
  const year = month >= 4 ? start : start + 1;
  return {
    mode: 'month',
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay(year, month))}`,
    fp: `${pad(month)}${year}`,
    label: `${year}-${pad(month)}`
  };
}

/** A from / to range of 'YYYY-MM-DD' days (both included), at most 366 days. */
function parseRange({ from, to } = {}) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!DATE_RE.test(f) || !DATE_RE.test(t) || Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(t))) {
    throw appError('Give from and to dates as YYYY-MM-DD');
  }
  if (f > t) throw appError('The from date is after the to date');
  if ((Date.parse(t) - Date.parse(f)) / 86400000 > 366) throw appError('Choose at most one year');
  return { from: f, to: t };
}

/** Settings → GST, which every report needs (the seller GSTIN and state). */
async function sellerContext(req) {
  const { settings, ready } = await require('./gst.service').context(req);
  return { settings, ready };
}

/** Clients of these ids (one query). `withPan`: also the encrypted typed PAN (TCS register only). */
async function clientsById(req, ids, { withPan = false } = {}) {
  const list = [...new Set((ids || []).map(String).filter((id) => ID_RE.test(id)))];
  const Company = optionalModel(req, 'Company');
  if (!list.length || !Company) return new Map();
  let q = Company.find({ tenantId: tenantOf(req), _id: { $in: list } });
  if (q && typeof q.select === 'function') q = q.select(withPan ? 'name billingAddress gst +gst.panEnc' : 'name billingAddress gst');
  return new Map((await rows(q)).map((c) => [String(c._id), c]));
}

function clientInfo(company, fallbackName) {
  const c = company || {};
  return {
    name: c.name || fallbackName || '',
    state: (c.billingAddress && c.billingAddress.state) || '',
    country: (c.billingAddress && c.billingAddress.country) || '',
    isDeemedExport: Boolean(c.gst && c.gst.isDeemedExport)
  };
}

const hasSnapshot = (doc) => Boolean(doc && doc.gst && doc.gst.engine);
const inDays = (iso, { from, to }) => Boolean(iso) && iso >= from && iso <= to;

/**
 * The period's documents, one query per model (Invoice, CreditNote, then Company for names), sorted into:
 *   bills          issued tax invoices and credit notes (not cancelled) → the return
 *   cancelledBills cancelled invoices, void notes and deleted drafts that took a GST number → Table 13 only
 * and the documents that cannot be reported (no snapshot, another GSTIN, still a draft) for warnings.
 */
async function periodDocuments(req, range, settings) {
  const tenantId = tenantOf(req);
  const Invoice = optionalModel(req, 'Invoice');
  const CreditNote = optionalModel(req, 'CreditNote');
  const between = TcsService.instantRange(range);
  const [invoices, notes] = await Promise.all([
    Invoice ? rows(Invoice.find({ tenantId, documentType: { $ne: 'proforma' }, issueDate: between })) : [],
    CreditNote ? rows(CreditNote.find({ tenantId, creditDate: between })) : []
  ]);
  const companies = await clientsById(req, [...invoices, ...notes].map((d) => d.clientId));
  const seller = { gstin: settings.gstin, state: settings.stateName };
  const out = { bills: [], cancelledBills: [], noSnapshot: [], otherGstin: [], drafts: [], invoices: [], notes: [] };

  for (const inv of invoices) {
    if (inv.documentType === 'proforma') continue;
    const date = Adapter.localIsoDate(inv.issueDate);
    if (!inDays(date, range)) continue;
    const snap = hasSnapshot(inv);
    if (!snap) {
      if (!inv.isDeleted && !['Draft', 'Cancelled'].includes(inv.status)) out.noSnapshot.push(inv.invoiceNo);
      continue;
    }
    if (String(inv.gst.sellerGstin || '').toUpperCase() !== String(settings.gstin || '').toUpperCase()) {
      if (!inv.isDeleted) out.otherGstin.push(inv.invoiceNo);
      continue;
    }
    const cancelled = inv.isDeleted === true || inv.status === 'Cancelled';
    if (!cancelled && inv.status === 'Draft') {
      out.drafts.push(inv.invoiceNo);
      continue;
    }
    const bill = Adapter.toGstBill(inv, { kind: 'invoice', seller, client: clientInfo(companies.get(String(inv.clientId))), cancelled });
    (cancelled ? out.cancelledBills : out.bills).push(bill);
    out.invoices.push({ doc: inv, bill, cancelled });
  }

  for (const note of notes) {
    const date = Adapter.localIsoDate(note.creditDate);
    if (!inDays(date, range)) continue;
    const snap = hasSnapshot(note);
    if (!snap) {
      if (!note.isDeleted && !['Draft', 'Void'].includes(note.status) && String(note.currency || 'INR').toUpperCase() === 'INR') out.noSnapshot.push(note.creditNoteNumber);
      out.notes.push({ doc: note, bill: null, cancelled: note.status === 'Void' || note.isDeleted === true });
      continue;
    }
    if (String(note.gst.sellerGstin || '').toUpperCase() !== String(settings.gstin || '').toUpperCase()) {
      if (!note.isDeleted) out.otherGstin.push(note.creditNoteNumber);
      continue;
    }
    const cancelled = note.isDeleted === true || note.status === 'Void';
    if (!cancelled && note.status === 'Draft') continue;
    const bill = Adapter.toGstBill(note, { kind: 'credit-note', seller, client: clientInfo(companies.get(String(note.clientId)), note.clientName), cancelled });
    (cancelled ? out.cancelledBills : out.bills).push(bill);
    out.notes.push({ doc: note, bill, cancelled });
  }
  return out;
}

/** Warnings about documents the return cannot include (CRM-side, not in the GST app). */
function documentWarnings(docs) {
  const list = (nos) => nos.slice(0, 5).join(', ') + (nos.length > 5 ? ', …' : '');
  const out = [];
  if (docs.noSnapshot.length) {
    out.push({ type: 'error', msg: `${docs.noSnapshot.length} issued document(s) in this period have no GST figures (made before Settings → GST was saved, in another currency, or converted at an agreed amount that differed from the GST total): ${list(docs.noSnapshot)}. They are NOT in this return; ask your CA how to report them.` });
  }
  if (docs.otherGstin.length) {
    out.push({ type: 'warning', msg: `${docs.otherGstin.length} document(s) were issued under another GSTIN and are left out: ${list(docs.otherGstin)}.` });
  }
  if (docs.drafts.length) {
    out.push({ type: 'warning', msg: `${docs.drafts.length} draft tax invoice(s) dated in this period are not issued yet and are not in the return: ${list(docs.drafts)}.` });
  }
  return out;
}

/** The advance receipt vouchers that touch this range (received or adjusted in it). One query. */
async function periodAdvances(req, range) {
  const Receipt = optionalModel(req, 'AdvanceReceipt');
  if (!Receipt) return [];
  const days = { $gte: range.from, $lte: range.to };
  let q = Receipt.find({ tenantId: tenantOf(req), $or: [{ receiptDate: days }, { adjustedOn: days }] });
  if (q && typeof q.sort === 'function') q = q.sort({ receiptDate: 1, receiptNo: 1 });
  return rows(q);
}

async function buildFor(req, { fy, period }) {
  const p = parsePeriod({ fy, period });
  const { settings, ready } = await sellerContext(req);
  if (!ready) {
    return {
      period: p, ready: false, json: null, empty: true,
      blocked: ['Your business GSTIN is not set (Settings → GST).'],
      warnings: [], summary: null, built: null, filename: ''
    };
  }
  const [docs, receipts] = await Promise.all([periodDocuments(req, p, settings), periodAdvances(req, p)]);
  const built = await Builder.buildGstr1({
    bills: docs.bills,
    cancelledBills: docs.cancelledBills,
    profile: { gstin: settings.gstin, state: settings.stateName, aatoAbove5Cr: false },
    fp: p.fp,
    filterMode: p.mode,
    advances: { receipts, range: { from: p.from, to: p.to } }
  });
  const warnings = [
    ...documentWarnings(docs),
    ...built.checks,
    ...built.warnings.map((msg) => ({ type: 'warning', msg }))
  ];
  return {
    period: p,
    ready: true,
    json: built.json,
    empty: built.empty,
    blocked: built.blocked,
    warnings,
    summary: built.summary,
    built,
    filename: `GSTR1_${settings.gstin}_${p.fp}.json`
  };
}

/** GET /gst/reports/gstr1: summary, warnings and the blocked list (no file). */
async function gstr1(req, { fy, period } = {}) {
  const r = await buildFor(req, { fy, period });
  return {
    period: r.period,
    ready: r.ready,
    empty: r.empty,
    canDownload: r.ready && !r.empty && r.blocked.length === 0,
    blocked: r.blocked,
    warnings: r.warnings,
    summary: r.summary,
    hsnSplit: r.built ? Boolean(r.built.tables.hsn && (r.built.tables.hsn.hsn_b2b || r.built.tables.hsn.hsn_b2c)) : false,
    csvTables: Builder.CSV_TABLES,
    filename: r.filename
  };
}

/** The portal JSON file. Refused while anything is blocked (as the GST app refuses the download). */
async function gstr1Json(req, { fy, period } = {}) {
  const r = await buildFor(req, { fy, period });
  if (r.blocked.length) throw appError(`GSTR-1 export blocked — fix these first: ${r.blocked.join(' · ')}`, 409, 'GSTR1_BLOCKED');
  if (r.empty || !r.json) throw appError('No invoices to export for this period', 409, 'GSTR1_EMPTY');
  return { filename: r.filename, body: JSON.stringify(r.json, null, 2) };
}

/** One GSTR-1 table as CSV (allowed while blocked, as in the GST app). */
async function gstr1Csv(req, { fy, period, table } = {}) {
  const name = String(table || '').trim();
  if (!Builder.CSV_TABLES.includes(name)) throw appError(`Choose a table: ${Builder.CSV_TABLES.join(', ')}`);
  const r = await buildFor(req, { fy, period });
  if (!r.ready) throw appError('Set your GSTIN and state in Settings → GST first', 409, 'GST_SELLER_NOT_READY');
  const out = await Builder.csvText(r.built, name, { fp: r.period.fp });
  return { filename: out.filename.replace(/\.csv$/, `_${r.period.fp}.csv`), body: out.csv, rows: out.rows };
}

/** GET /gst/reports/advances: Table 11A / 11B rows with the vouchers behind them. */
async function advances(req, { from, to } = {}) {
  const range = parseRange({ from, to });
  const receipts = await periodAdvances(req, range);
  const t = Builder.advanceTables(receipts, range);
  const voucher = (r) => ({
    receiptNo: r.receiptNo || '',
    receiptDate: r.receiptDate || '',
    placeOfSupply: r.placeOfSupply || '',
    posCode: r.posCode || '',
    supplyType: r.isInterstate ? 'INTER' : 'INTRA',
    amount: r2(r.amount),
    taxable: r2(r.taxable),
    totalTax: r2(r.totalTax),
    status: r.status || 'open',
    adjustedInvoiceNo: r.adjustedInvoiceNo || '',
    adjustedOn: r.adjustedOn || ''
  });
  return {
    range,
    at: t.at,
    txpd: t.txpd,
    received: t.atReceipts.map(voucher),
    adjusted: t.txpdReceipts.map(voucher),
    note: 'An advance received and adjusted in the same period is in neither table: its invoice reports it in full.'
  };
}

/** GET /gst/reports/credit-notes: credit notes of the range with their GST and GSTR-1 table. */
async function creditNotes(req, { from, to } = {}) {
  const range = parseRange({ from, to });
  const { settings, ready } = await sellerContext(req);
  const empty = { range, ready, notes: [], totals: { count: 0, taxable: 0, tax: 0, total: 0 } };
  if (!ready) return empty;
  const docs = await periodDocuments(req, range, settings);
  const [utils, g] = await Promise.all([loadGstModule('utils'), loadGstModule('gstr1')]);
  const notes = docs.notes.map(({ doc, bill, cancelled }) => {
    const gst = doc.gst || {};
    let table = 'not reported (no GST figures)';
    if (bill && cancelled) table = 'cancelled (Table 13 only)';
    else if (bill) {
      const gstin = bill.data.client.gstin;
      if (g.isExportBill(bill)) table = 'CDNUR (export)';
      else if (gstin) table = 'CDNR';
      else if (g.billIsInterstate(bill) && (bill.totalAmount || 0) > utils.b2clThreshold(bill.invoiceDate)) table = 'CDNUR (B2CL)';
      else table = 'B2CS (reduces)';
    }
    const tax = r2((gst.cgst || 0) + (gst.sgst || 0) + (gst.utgst || 0) + (gst.igst || 0) + (gst.cess || 0));
    return {
      id: String(doc._id || ''),
      creditNoteNumber: doc.creditNoteNumber || '',
      date: Adapter.localIsoDate(doc.creditDate),
      clientName: doc.clientName || '',
      clientGstin: gst.clientGstin || '',
      invoiceNumber: doc.invoiceNumber || '',
      reason: doc.reason || '',
      status: doc.isDeleted ? 'Deleted' : doc.status || '',
      placeOfSupply: gst.placeOfSupply || doc.placeOfSupply || '',
      taxable: bill ? r2(gst.taxableAmount) : r2(doc.subtotal),
      cgst: r2(gst.cgst), sgst: r2((gst.sgst || 0) + (gst.utgst || 0)), igst: r2(gst.igst), cess: r2(gst.cess),
      tax: bill ? tax : r2(doc.taxTotal),
      total: bill ? r2(gst.total) : r2(doc.totalAmount),
      hasGst: Boolean(bill),
      table
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.creditNoteNumber.localeCompare(b.creditNoteNumber));
  const live = notes.filter((n) => n.hasGst && !/^cancelled/.test(n.table));
  return {
    range,
    ready,
    notes,
    totals: {
      count: live.length,
      taxable: r2(live.reduce((s, n) => s + n.taxable, 0)),
      tax: r2(live.reduce((s, n) => s + n.tax, 0)),
      total: r2(live.reduce((s, n) => s + n.total, 0))
    }
  };
}

const CREDIT_NOTE_CSV = ['Credit Note', 'Date', 'Client', 'Client GSTIN', 'Against Invoice', 'Reason', 'Status', 'Place of Supply', 'Taxable Value', 'CGST', 'SGST/UTGST', 'IGST', 'Cess', 'Total', 'GSTR-1 Table'];

async function creditNotesCsv(req, query) {
  const r = await creditNotes(req, query);
  const utils = await loadGstModule('utils');
  const lines = [utils.toCsvLine(CREDIT_NOTE_CSV)];
  for (const n of r.notes) {
    lines.push(utils.toCsvLine([n.creditNoteNumber, utils.formatDateGST(n.date), n.clientName, n.clientGstin, n.invoiceNumber, n.reason, n.status, n.placeOfSupply,
      n.taxable.toFixed(2), n.cgst.toFixed(2), n.sgst.toFixed(2), n.igst.toFixed(2), n.cess.toFixed(2), n.total.toFixed(2), n.table]));
  }
  return { filename: `Credit_Notes_${r.range.from}_${r.range.to}.csv`, body: lines.join('\n') };
}

/**
 * GET /gst/reports/tcs: the TCS register of a quarter (or the whole year with no quarter), optionally one
 * rule. Built with the GST app's tdsTcs.js (fyQuarterRange, salesTaxRows, totalsBy, panFromGstin). The
 * full PAN is shown (needed for the TCS return) only when it is still the PAN the invoice was issued with.
 */
async function tcs(req, { fy, quarter, rule } = {}) {
  const fyStart = fyStartOf(fy);
  const q = String(quarter || '').trim().toUpperCase();
  if (q && !/^Q[1-4]$/.test(q)) throw appError('Choose a quarter Q1-Q4, or none for the whole year');
  const ruleKey = String(rule || '').trim();
  if (ruleKey && !KEY_RE.test(ruleKey)) throw appError('Unknown TCS rule');
  const tdsTcs = await loadGstModule('tdsTcs');
  const range = tdsTcs.fyQuarterRange(fyStart, q);
  const { settings } = await sellerContext(req);
  const rules = ((settings && settings.tcsRules) || []).map((r) => ({ key: r.key, label: r.label || r.key, enabled: r.enabled === true, sectionLabel: r.sectionLabel || '' }));

  const Invoice = optionalModel(req, 'Invoice');
  const filter = {
    tenantId: tenantOf(req),
    documentType: { $ne: 'proforma' },
    isDeleted: { $ne: true },
    'gst.tcs.applicable': true,
    issueDate: TcsService.instantRange(range)
  };
  if (ruleKey) filter['gst.tcs.ruleKey'] = ruleKey;
  const invoices = Invoice ? (await rows(Invoice.find(filter))).filter((inv) => inv.status !== 'Draft' && inDays(Adapter.localIsoDate(inv.issueDate), range)) : [];
  const companies = await clientsById(req, invoices.map((i) => i.clientId), { withPan: true });
  const ClientGst = require('./client-gst.service');
  const warnings = [];
  const byId = new Map();
  const bills = [];
  let panChanged = 0;
  for (const inv of invoices) {
    const company = companies.get(String(inv.clientId));
    const stored = (inv.gst && inv.gst.tcs) || {};
    let pan = '';
    if (stored.panHash) {
      // The PAN the invoice was issued with: the client's PAN now, or the one inside the issued GSTIN.
      const candidates = [company ? await ClientGst.clientPan(req, company) : '', tdsTcs.panFromGstin(inv.gst && inv.gst.clientGstin)];
      pan = candidates.find((c) => c && TcsService.panFingerprint(req, c) === stored.panHash) || '';
      if (!pan) panChanged += 1;
    }
    const bill = Adapter.toGstBill(inv, {
      kind: 'invoice',
      seller: { gstin: settings.gstin, state: settings.stateName },
      client: { ...clientInfo(company), pan },
      cancelled: inv.status === 'Cancelled'
    });
    // Only the PAN the invoice was issued with (above): salesTaxRows must not derive another from the GSTIN.
    bill.data.client.gstin = '';
    byId.set(bill.id, inv);
    bills.push(bill);
  }
  if (panChanged) warnings.push(`${panChanged} invoice(s) were issued with a PAN that is no longer on the client record: their PAN is left blank here. Check the client.`);

  const ruleLabel = new Map(rules.map((r) => [r.key, r.label]));
  const list = tdsTcs.salesTaxRows(bills, 'tcs', range).map((row) => {
    const inv = byId.get(row.id) || {};
    const t = (inv.gst && inv.gst.tcs) || {};
    return {
      ...row,
      gstin: (inv.gst && inv.gst.clientGstin) || '',
      rate: Math.round((Number(row.rate) || 0) * 10000) / 10000,
      ruleKey: t.ruleKey || '',
      rule: ruleLabel.get(t.ruleKey) || t.ruleKey || '',
      section: t.section || row.section || '',
      base: r2(t.base),
      cumulativeBefore: r2(t.cumulativeBefore),
      panGiven: Boolean(t.panHash)
    };
  });
  const totals = {
    byRate: tdsTcs.totalsBy(list, (r) => `${r.rate}%`),
    byRule: tdsTcs.totalsBy(list, (r) => r.rule),
    all: { count: list.length, base: r2(list.reduce((s, r) => s + r.base, 0)), amount: r2(list.reduce((s, r) => s + r.amount, 0)) }
  };
  return { fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`, quarter: q, range, rule: ruleKey, rules, rows: list, totals, warnings };
}

const TCS_CSV = ['Date', 'Invoice Number', 'Quarter', 'Buyer', 'PAN', 'PAN Given', 'Rule', 'Section', 'Base', 'Cumulative Before', 'Rate %', 'TCS'];

async function tcsCsv(req, query) {
  const r = await tcs(req, query);
  const utils = await loadGstModule('utils');
  const lines = [utils.toCsvLine(TCS_CSV)];
  for (const row of r.rows) {
    lines.push(utils.toCsvLine([utils.formatDateGST(row.date), row.invoiceNumber, row.quarter, row.party, row.pan, row.panGiven ? 'Y' : 'N', row.rule, row.section,
      row.base.toFixed(2), row.cumulativeBefore.toFixed(2), row.rate, row.amount.toFixed(2)]));
  }
  return { filename: `TCS_Register_${r.fy}${r.quarter ? `_${r.quarter}` : ''}.csv`, body: lines.join('\n') };
}

module.exports = {
  parsePeriod,
  parseRange,
  fyStartOf,
  periodDocuments,
  gstr1,
  gstr1Json,
  gstr1Csv,
  advances,
  creditNotes,
  creditNotesCsv,
  tcs,
  tcsCsv
};
