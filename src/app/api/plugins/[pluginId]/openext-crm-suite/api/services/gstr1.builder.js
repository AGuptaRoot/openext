'use strict';

/**
 * GSTR-1 builder (GST suite, Step 5; documentation/gst-planning/03 §3–4).
 *
 * PORTED, not redesigned: the body of `exportGSTR1JSON`, `validateGSTR1`, the classification it reads and
 * the CSV exporters of the GST app's src/components/GSTReturns.jsx (free-gst-billing-software 1.10.85).
 * Only these changes (03 §3):
 *   - no browser code (Blob, URL.createObjectURL, document.createElement, toast);
 *   - returns { json, warnings, blocked, ... } instead of downloading;
 *   - `profile`, `fp` and the filter mode are arguments instead of component state;
 *   - validateGSTR1 runs first; a non-empty `blocked` list means no JSON is returned;
 *   - messages point at the CRM's screens (Settings → GST) instead of the app's.
 * New for the CRM (not in the GST app): Table 11A `at` and 11B `txpd` from advance receipt vouchers.
 *
 * Input bills are in the GST app's shape (lib/gst-adapter toGstBill). Pure apart from loading the copied
 * modules: no database, no request, nothing logged.
 */

const { loadGstModule } = require('../lib/gst-core');

function round2(n) { return Math.round(n * 100) / 100; }

// GSTReturns.jsx: SEZ "without payment" (SEWOP) only when the invoice charged no tax.
const TAX_KEYS = ['igst', 'cgst', 'sgst', 'utgst', 'rcmTaxIgst', 'rcmTaxCgst', 'rcmTaxSgst', 'rcmTaxUtgst'];
const billIsLut = (bill) => (!!bill?.data?.invoiceOptions?.isLUT || /\bLUT\b|Letter of Undertaking/i.test(bill?.data?.customTerms || ''))
  && !TAX_KEYS.some((k) => Number(bill?.data?.totals?.[k]) > 0);

function getTaxableAmount(totals) {
  return totals?.taxableAmount ?? ((totals?.subtotal || 0) - (totals?.totalDiscount || 0));
}

const GST_TYPES = ['tax-invoice', 'credit-note'];
const INUM_REGEX = /^[A-Za-z0-9\-/]{1,16}$/;

async function modules() {
  const [utils, g] = await Promise.all([loadGstModule('utils'), loadGstModule('gstr1')]);
  return { utils, g };
}

/**
 * The classification the GST Returns screen works out from its period's bills (GSTReturns.jsx
 * "Classification" … "Validation Warnings"). `bills`: the period's bills that are not cancelled
 * (tax invoices, credit notes, bills of supply); `cancelledBills`: the period's cancelled ones.
 */
function classify({ utils, g }, { bills, cancelledBills, profile }) {
  const { getStateCode, b2clThreshold, countsAsSales } = utils;
  const { billIsInterstate, billSplit, isExportBill, lineTreatment, hsnSign, hsnSummary, docIssueSummary, gstinFormatOk, cleanGstin } = g;

  // #141 - every table, file and check below reads this cleaned GSTIN.
  const withCleanGstin = (bill) => (bill.data?.client?.gstin
    ? { ...bill, data: { ...bill.data, client: { ...bill.data.client, gstin: cleanGstin(bill.data.client.gstin) } } }
    : bill);
  const all = (bills || []).map(withCleanGstin);
  const periodGstBills = all.filter((bill) => GST_TYPES.includes(bill.invoiceType || 'tax-invoice') && !!bill.data);
  const filteredBills = periodGstBills.filter((b) => !b.fxMissing);
  const noRateBills = periodGstBills.filter((b) => b.fxMissing);
  const allFilteredBills = all.filter((bill) => bill.data);
  const cancelledInPeriod = (cancelledBills || []).filter((bill) => bill.data);

  // ========== Classification ==========
  const creditNotes = filteredBills.filter((b) => (b.invoiceType || 'tax-invoice') === 'credit-note');
  const regularBills = filteredBills.filter((b) => (b.invoiceType || 'tax-invoice') !== 'credit-note');
  const exportBills = regularBills.filter(isExportBill);
  const exportWopay = (bill) => !!bill.data?.totals?.lutZeroRated || billIsLut(bill);
  const exportRows = [...exportBills, ...noRateBills.filter(isExportBill)].map((b) => {
    const t = b.data?.totals || {};
    const rates = [...new Set((b.data?.items || []).map((i) => Number(i.taxPercent) || 0))];
    return {
      id: b.id, invoiceNo: b.invoiceNumber || '', date: b.invoiceDate || '',
      client: b.data?.client?.name || b.clientName || '', country: b.data?.client?.country || '',
      type: exportWopay(b) ? 'WOPAY' : 'WPAY', rates: rates.join(', '),
      currency: b.fxFrom?.currency || b.currency || 'INR', fxRate: b.fxFrom?.rate || (b.fxMissing ? 0 : 1),
      value: t.total || 0, taxable: getTaxableAmount(t), igst: t.igst || 0, cess: t.cess || 0, missing: !!b.fxMissing
    };
  });
  const b2bRegular = regularBills.filter((b) => b.data?.client?.gstin && !isExportBill(b));
  const b2cRegular = regularBills.filter((b) => !b.data?.client?.gstin && !isExportBill(b));
  const b2cLarge = b2cRegular.filter((b) => {
    const isInter = billIsInterstate(b);
    return isInter && (b.totalAmount || 0) > b2clThreshold(b.invoiceDate);
  });
  const b2cSmall = b2cRegular.filter((b) => {
    const isInter = billIsInterstate(b);
    return !(isInter && (b.totalAmount || 0) > b2clThreshold(b.invoiceDate));
  });
  const billIsIntraUT = (bill) => {
    if (bill?.data?.totals?.isIntraUT) return true;
    return false; // Legacy bills default to false — will treat as SGST which is safe
  };

  const treatmentOf = (bill, item) => lineTreatment({
    invoiceType: bill.invoiceType || 'tax-invoice', isExport: isExportBill(bill),
    taxPercent: item.taxPercent, gstTreatment: item.gstTreatment
  });
  const taxableLine = (bill) => (item) => treatmentOf(bill, item) === 'taxable';
  const supplyBills = allFilteredBills.filter((b) => b.invoiceType === 'bill-of-supply' && !b.fxMissing);
  const nilRows = [...filteredBills, ...supplyBills].flatMap((bill) => (bill.data?.items || []).map((item) => {
    const treatment = treatmentOf(bill, item);
    if (treatment === 'taxable') return null;
    const isInter = billIsInterstate(bill);
    const split = billSplit(bill, item, isInter, !!bill.data?.taxInclusive, billIsIntraUT(bill));
    return {
      interstate: isInter, b2b: !!bill.data?.client?.gstin, treatment,
      txval: hsnSign(bill) * split.taxable, onTaxInvoice: bill.invoiceType !== 'bill-of-supply'
    };
  }).filter(Boolean));

  // ========== HSN Summary ==========
  const hsnSum = hsnSummary([...filteredBills, ...supplyBills]);
  const hsnRows = hsnSum.rows;

  // ========== Document Summary ==========
  const docSummary = docIssueSummary([...allFilteredBills, ...cancelledInPeriod]);

  // ========== Validation Warnings ==========
  const warnings = [];
  noRateBills.forEach((bill) => {
    warnings.push({ type: 'error', msg: `Invoice ${bill.invoiceNumber} is in ${bill.currency || bill.data?.invoiceOptions?.currency} with no exchange rate, so it is left out of this return until you add the rate.` });
  });
  filteredBills.forEach((bill) => {
    const { client, items } = bill.data;
    if (isExportBill(bill)) {
      (items || []).forEach((item) => {
        if (!item.hsn || item.hsn === 'N/A') warnings.push({ type: 'warning', msg: `Invoice ${bill.invoiceNumber}: Item "${item.name || 'Unnamed'}" has no HSN/SAC code` });
      });
      return;
    }
    if (client?.gstin && !gstinFormatOk(client.gstin)) {
      warnings.push({ type: 'error', msg: `Invoice ${bill.invoiceNumber}: Invalid client GSTIN format — ${client.gstin}` });
    }
    (items || []).forEach((item) => {
      if (!item.hsn || item.hsn === 'N/A') {
        warnings.push({ type: 'warning', msg: `Invoice ${bill.invoiceNumber}: Item "${item.name || 'Unnamed'}" has no HSN/SAC code` });
      }
    });
    if (client?.gstin && !client?.state) {
      warnings.push({ type: 'warning', msg: `Invoice ${bill.invoiceNumber}: Client ${client.name} has GSTIN but no State — Place of Supply may be wrong` });
    }
    if (!client?.gstin && billIsInterstate(bill) && !isExportBill(bill) && countsAsSales(bill)) {
      const pos = getStateCode(bill.data?.details?.placeOfSupply || client?.state || '');
      if (!pos || pos === (getStateCode(profile.gstin || '') || getStateCode(profile.state || ''))) {
        warnings.push({ type: 'error', msg: `Invoice ${bill.invoiceNumber}: inter-state sale to ${client?.name || 'an unregistered buyer'} without the buyer's state as Place of Supply. Open the invoice and set Place of Supply.` });
      }
    }
  });
  if (!profile.gstin) {
    warnings.push({ type: 'error', msg: 'Your business GSTIN is not set. Go to Settings → GST to add it.' });
  }
  if (exportBills.length > 0) {
    const listed = exportBills.slice(0, 3).map((b) => b.invoiceNumber).join(', ') + (exportBills.length > 3 ? ', …' : '');
    warnings.unshift({ type: 'warning', msg: `${exportBills.length} export invoice(s) (${listed}) are in Table 6A of the GSTR-1 file. For goods, add the shipping bill number, date and port code on the portal after uploading; their value is in GSTR-3B 3.1(b).` });
  }

  return {
    filteredBills, noRateBills, allFilteredBills, cancelledInPeriod, creditNotes, regularBills, exportBills,
    exportWopay, exportRows, b2bRegular, b2cRegular, b2cLarge, b2cSmall, billIsIntraUT, taxableLine,
    supplyBills, nilRows, hsnSum, hsnRows, docSummary, warnings
  };
}

/**
 * validateGSTR1 of GSTReturns.jsx: { blocked, warnings }. `blocked` non-empty = the portal would refuse
 * the whole file. `filterMode`: 'month' | 'quarter' ('fy' is blocked, as in the app).
 */
function validateGSTR1({ utils, g }, bills, { profile = {}, filterMode = 'month', noRateBills = [] } = {}) {
  const { getStateCode, GST_PORTAL_RATES } = utils;
  const { billIsInterstate, isExportBill } = g;
  const GST_STANDARD_RATES = GST_PORTAL_RATES;
  const blocked = [];
  const warnings = [];
  const aatoAbove5Cr = !!profile.aatoAbove5Cr;
  const minHsnDigits = aatoAbove5Cr ? 6 : 4;

  if (!profile.gstin) blocked.push('Your business GSTIN is not set (Settings → GST).');
  if (filterMode === 'fy') blocked.push('A GSTR-1 file is for one month (or one quarter if you file quarterly). Choose Month or Quarter above.');
  const noPos = bills.filter((b) => (b.data?.client?.gstin || billIsInterstate(b)) && !isExportBill(b)
    && !getStateCode(b.data?.details?.placeOfSupply || b.data?.client?.state || ''));
  if (noPos.length > 0) blocked.push(`${noPos.length} invoice(s) have no place of supply (${noPos.slice(0, 3).map((b) => b.invoiceNumber).join(', ')}). Open each and set the client's state or Place of Supply.`);
  const noRate = noRateBills;
  if (noRate.length > 0) {
    blocked.push(`${noRate.length} invoice(s) in a foreign currency have no exchange rate (${noRate.slice(0, 3).map((b) => b.invoiceNumber).join(', ')}). Open each: if the amounts are really in rupees, set the currency to INR; otherwise enter the exchange rate.`);
  }
  const badInums = bills.filter((b) => !INUM_REGEX.test(b.invoiceNumber || ''));
  if (badInums.length > 0) {
    blocked.push(`${badInums.length} invoice number(s) violate portal rules (≤16 chars, only letters, digits, "-" or "/"). First: ${badInums.slice(0, 3).map((b) => b.invoiceNumber).join(', ')}`);
  }

  const badRates = new Set();
  let badRateItemCount = 0;
  bills.forEach((bill) => {
    (bill.data?.items || []).forEach((item) => {
      const rate = Number(item.taxPercent) || 0;
      if (!GST_STANDARD_RATES.includes(rate)) {
        badRates.add(rate);
        badRateItemCount += 1;
      }
    });
  });
  if (badRateItemCount > 0) {
    blocked.push(`${badRateItemCount} item(s) use non-standard tax rate(s) [${Array.from(badRates).sort().join(', ')}%]. Portal accepts only ${GST_STANDARD_RATES.join(', ')}%.`);
  }

  let missingHsnItemCount = 0;
  let shortHsnItemCount = 0;
  bills.forEach((bill) => {
    (bill.data?.items || []).forEach((item) => {
      const hsn = String(item.hsn || '').trim();
      if (!hsn || hsn === 'N/A') missingHsnItemCount += 1;
      else if (hsn.replace(/\D/g, '').length < minHsnDigits) shortHsnItemCount += 1;
    });
  });
  if (missingHsnItemCount > 0) {
    warnings.push(`${missingHsnItemCount} item(s) have no HSN — dropped from HSN summary. GSTR-1 Table 12 requires an HSN per item.`);
  }
  if (shortHsnItemCount > 0) {
    warnings.push(`${shortHsnItemCount} item(s) have HSN shorter than ${minHsnDigits} digits (required for ${aatoAbove5Cr ? '>' : '≤'}₹5 Cr AATO). Portal may reject.`);
  }

  return { blocked, warnings };
}

/**
 * NEW (not in the GST app): Table 11A (`at`) and 11B (`txpd`) from advance receipt vouchers (03 §3).
 * `receipts`: AdvanceReceipt rows; `range`: the return period { from, to } ('YYYY-MM-DD').
 *   - 11A: received in the period and NOT adjusted / refunded in the same period;
 *   - 11B: adjusted (invoice issued) or refunded in the period, received in an earlier period;
 *   - received and adjusted in the same period: neither (the invoice reports it).
 * Grouped by place of supply, supply type and rate; amounts are the voucher's own split by rate.
 * Rows at 0% (charges without tax) are left out: no tax was paid on them.
 */
function advanceTables(receipts, { from, to }) {
  const inRange = (d) => !!d && d >= from && d <= to;
  const adjustedOn = (r) => (r.status === 'adjusted' || r.status === 'refunded') ? String(r.adjustedOn || '') : '';
  const at = [];
  const txpd = [];
  for (const r of receipts || []) {
    const received = String(r.receiptDate || '');
    const adj = adjustedOn(r);
    if (inRange(received) && !inRange(adj)) at.push(r);
    else if (inRange(adj) && received && received < from) txpd.push(r);
  }
  const group = (list) => {
    const by = new Map();
    for (const r of list) {
      const pos = String(r.posCode || '');
      const sply = r.isInterstate ? 'INTER' : 'INTRA';
      const key = `${pos}|${sply}`;
      if (!by.has(key)) by.set(key, { pos, sply_ty: sply, rates: new Map(), receipts: [] });
      const row = by.get(key);
      row.receipts.push(r);
      for (const x of r.rates || []) {
        const rt = Number(x.taxPercent) || 0;
        if (rt <= 0) continue;
        const it = row.rates.get(rt) || { rt, ad_amt: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
        it.ad_amt += Number(x.taxable) || 0;
        it.iamt += Number(x.igst) || 0;
        it.camt += Number(x.cgst) || 0;
        it.samt += (Number(x.sgst) || 0) + (Number(x.utgst) || 0);
        row.rates.set(rt, it);
      }
    }
    return [...by.values()]
      .map((row) => ({
        pos: row.pos,
        sply_ty: row.sply_ty,
        itms: [...row.rates.values()].sort((a, b) => a.rt - b.rt)
          .map((it) => ({ rt: it.rt, ad_amt: round2(it.ad_amt), iamt: round2(it.iamt), camt: round2(it.camt), samt: round2(it.samt), csamt: round2(it.csamt) }))
      }))
      .filter((row) => row.itms.length)
      .sort((a, b) => a.pos.localeCompare(b.pos) || a.sply_ty.localeCompare(b.sply_ty));
  };
  return { at: group(at), txpd: group(txpd), atReceipts: at, txpdReceipts: txpd };
}

/**
 * exportGSTR1JSON of GSTReturns.jsx, ported. Returns { json, warnings, blocked, checks, tables, summary }.
 *   bills / cancelledBills: the period's bills (toGstBill shapes);
 *   profile: { gstin, state, aatoAbove5Cr }; fp: 'MMYYYY'; filterMode: 'month' | 'quarter';
 *   advances: { receipts, range } for Table 11A / 11B.
 * `json` is null while `blocked` is non-empty (the app refused the download).
 */
async function buildGstr1({ bills = [], cancelledBills = [], profile = {}, fp = '', filterMode = 'month', advances = null } = {}) {
  const mods = await modules();
  const { utils, g } = mods;
  const { getStateCode, formatDateGST, b2clThreshold } = utils;
  const { hsnTable, stripEmpty, nilTable, expTable, exportNote, b2bInvType, docIssueDetails, billIsInterstate, billSplit, isExportBill } = g;

  const c = classify(mods, { bills, cancelledBills, profile });
  const { filteredBills, creditNotes, exportBills, exportWopay, b2bRegular, b2cLarge, b2cSmall, billIsIntraUT, taxableLine, nilRows, hsnSum, hsnRows, docSummary } = c;

  const { blocked, warnings } = validateGSTR1(mods, filteredBills, { profile, filterMode, noRateBills: c.noRateBills });
  const adv = advances ? advanceTables(advances.receipts, advances.range || {}) : { at: [], txpd: [], atReceipts: [], txpdReceipts: [] };
  const empty = filteredBills.length === 0 && adv.at.length === 0 && adv.txpd.length === 0 && Object.keys(docSummary).length === 0;

  const gstin = profile.gstin || '';

  const b2bMap = {};
  b2bRegular.forEach((bill) => {
    const { client, totals, items, details } = bill.data;
    const ctin = client.gstin;
    const isInter = billIsInterstate(bill);
    const isIntraUT = billIsIntraUT(bill);
    const isRcm = !!bill.data?.invoiceOptions?.reverseCharge;
    const pos = getStateCode(details?.placeOfSupply || client?.state || '');
    const rateMap = {};
    (items || []).filter(taxableLine(bill)).forEach((item) => {
      const rate = item.taxPercent || 0;
      if (!rateMap[rate]) rateMap[rate] = { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      const split = billSplit(bill, item, isInter, !!bill.data?.taxInclusive, isIntraUT);
      rateMap[rate].txval += split.taxable;
      rateMap[rate].iamt += split.igst;
      rateMap[rate].camt += split.cgst;
      rateMap[rate].samt += split.sgst + split.utgst;
      rateMap[rate].csamt += split.cess;
    });
    const rchrg = isRcm ? 'Y' : 'N';
    const isSEZ = !!client?.isSEZ;
    const isLUT = billIsLut(bill);
    const invType = b2bInvType({ deemedExport: !!client?.isDeemedExport, rcm: isRcm, sez: isSEZ, lut: isLUT });
    if (!Object.keys(rateMap).length) return;
    if (!b2bMap[ctin]) b2bMap[ctin] = { ctin, inv: [] };
    const rateTotal = Object.values(rateMap).reduce((s, d) => s + d.txval + d.iamt + d.camt + d.samt + d.csamt, 0);
    const val = isRcm ? round2(rateTotal) : round2((totals?.total || 0) - (totals?.roundOff || 0));
    b2bMap[ctin].inv.push({
      inum: bill.invoiceNumber, idt: formatDateGST(bill.invoiceDate), val, pos, rchrg, inv_typ: invType,
      itms: Object.entries(rateMap).map(([rt, d], i) => ({ num: i + 1, itm_det: { rt: Number(rt), txval: round2(d.txval), iamt: round2(d.iamt), camt: round2(d.camt), samt: round2(d.samt), csamt: round2(d.csamt) } }))
    });
  });

  const unregNotes = creditNotes.filter((b) => !b.data?.client?.gstin && !isExportBill(b));
  const isLargeNote = (b) => billIsInterstate(b) && (b.totalAmount || 0) > b2clThreshold(b.invoiceDate);
  const b2csMap = {};
  const addB2cs = (bill, sign) => {
    const { profile: prof, client, items, details } = bill.data;
    const isInter = billIsInterstate(bill);
    const isIntraUT = billIsIntraUT(bill);
    const pos = getStateCode(details?.placeOfSupply || client?.state || prof?.state || '');
    const splyTy = isInter ? 'INTER' : 'INTRA';
    (items || []).filter(taxableLine(bill)).forEach((item) => {
      const rate = Number(item.taxPercent) || 0; const key = `${splyTy}_${pos}_${rate}`;
      if (!b2csMap[key]) b2csMap[key] = { sply_ty: splyTy, pos, typ: 'OE', rt: rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      const split = billSplit(bill, item, isInter, !!bill.data?.taxInclusive, isIntraUT);
      b2csMap[key].txval += sign * split.taxable;
      b2csMap[key].iamt += sign * split.igst;
      b2csMap[key].camt += sign * split.cgst;
      b2csMap[key].samt += sign * (split.sgst + split.utgst);
      b2csMap[key].csamt += sign * split.cess;
    });
  };
  b2cSmall.forEach((bill) => addB2cs(bill, 1));
  unregNotes.filter((b) => !isLargeNote(b)).forEach((bill) => addB2cs(bill, -1));
  const cdnurArr = unregNotes.filter(isLargeNote).map((bill) => {
    const { client, totals, items, details } = bill.data;
    const rateMap = {};
    (items || []).filter(taxableLine(bill)).forEach((item) => {
      const rate = Number(item.taxPercent) || 0; if (!rateMap[rate]) rateMap[rate] = { txval: 0, iamt: 0, csamt: 0 };
      const split = billSplit(bill, item, true, !!bill.data?.taxInclusive);
      rateMap[rate].txval += split.taxable; rateMap[rate].iamt += split.igst; rateMap[rate].csamt += split.cess;
    });
    if (!Object.keys(rateMap).length) return null;
    return {
      typ: 'B2CL', ntty: 'C', nt_num: bill.invoiceNumber, nt_dt: formatDateGST(bill.invoiceDate), val: round2(totals?.total || 0),
      pos: getStateCode(details?.placeOfSupply || client?.state || ''),
      itms: Object.entries(rateMap).map(([rt, d], i) => ({ num: i + 1, itm_det: { rt: Number(rt), txval: round2(d.txval), iamt: round2(d.iamt), csamt: round2(d.csamt) } }))
    };
  }).filter(Boolean);
  const exportLines = (bill) => (bill.data?.items || []).map((item) => {
    const split = billSplit(bill, item, true, !!bill.data?.taxInclusive);
    return { rt: Number(item.taxPercent) || 0, txval: split.taxable, iamt: split.igst, csamt: split.cess };
  });
  const expArr = expTable(exportBills.map((bill) => ({
    inum: bill.invoiceNumber, idt: formatDateGST(bill.invoiceDate), val: bill.data?.totals?.total || 0,
    wopay: exportWopay(bill), lines: exportLines(bill)
  })));
  creditNotes.filter(isExportBill).forEach((bill) => cdnurArr.push(exportNote({
    nt_num: bill.invoiceNumber, nt_dt: formatDateGST(bill.invoiceDate), val: bill.data?.totals?.total || 0,
    wopay: exportWopay(bill), lines: exportLines(bill)
  })));
  const b2csArr = Object.values(b2csMap).map((d) => ({ ...d, txval: round2(d.txval), iamt: round2(d.iamt), camt: round2(d.camt), samt: round2(d.samt), csamt: round2(d.csamt) }));

  const b2clMap = {};
  b2cLarge.forEach((bill) => {
    const { client, totals, items, details } = bill.data;
    const pos = getStateCode(details?.placeOfSupply || client?.state || '');
    const rateMap = {};
    (items || []).filter(taxableLine(bill)).forEach((item) => {
      const rate = item.taxPercent || 0; if (!rateMap[rate]) rateMap[rate] = { txval: 0, iamt: 0, csamt: 0 };
      const split = billSplit(bill, item, true, !!bill.data?.taxInclusive);
      rateMap[rate].txval += split.taxable; rateMap[rate].iamt += split.igst;
      rateMap[rate].csamt += split.cess;
    });
    if (!Object.keys(rateMap).length) return;
    if (!b2clMap[pos]) b2clMap[pos] = { pos, inv: [] };
    b2clMap[pos].inv.push({ inum: bill.invoiceNumber, idt: formatDateGST(bill.invoiceDate), val: round2(totals?.total || 0), itms: Object.entries(rateMap).map(([rt, d], i) => ({ num: i + 1, itm_det: { rt: Number(rt), txval: round2(d.txval), iamt: round2(d.iamt), csamt: round2(d.csamt) } })) });
  });

  const cdnrMap = {};
  creditNotes.filter((b) => b.data?.client?.gstin && !isExportBill(b)).forEach((bill) => {
    const { client, totals, items, details } = bill.data;
    const ctin = client.gstin;
    const isInter = billIsInterstate(bill);
    const pos = getStateCode(details?.placeOfSupply || client?.state || '');
    const rateMap = {};
    (items || []).filter(taxableLine(bill)).forEach((item) => {
      const rate = item.taxPercent || 0; if (!rateMap[rate]) rateMap[rate] = { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      const split = billSplit(bill, item, isInter, !!bill.data?.taxInclusive, billIsIntraUT(bill));
      rateMap[rate].txval += split.taxable; rateMap[rate].iamt += split.igst; rateMap[rate].camt += split.cgst; rateMap[rate].samt += split.sgst + split.utgst;
      rateMap[rate].csamt += split.cess;
    });
    const rchrg = bill.data?.invoiceOptions?.reverseCharge ? 'Y' : 'N';
    const isSEZ = !!client?.isSEZ;
    const isLUT = billIsLut(bill);
    const invType = b2bInvType({ deemedExport: !!client?.isDeemedExport, rcm: rchrg === 'Y', sez: isSEZ, lut: isLUT });
    if (!Object.keys(rateMap).length) return;
    if (!cdnrMap[ctin]) cdnrMap[ctin] = { ctin, nt: [] };
    cdnrMap[ctin].nt.push({
      ntty: 'C', nt_num: bill.invoiceNumber, nt_dt: formatDateGST(bill.invoiceDate), val: round2(totals?.total || 0), pos, rchrg, inv_typ: invType,
      itms: Object.entries(rateMap).map(([rt, d], i) => ({ num: i + 1, itm_det: { rt: Number(rt), txval: round2(d.txval), iamt: round2(d.iamt), camt: round2(d.camt), samt: round2(d.samt), csamt: round2(d.csamt) } }))
    });
  });

  const unknownUnitCount = hsnSum.customUnit;
  const docDet = docIssueDetails(docSummary);

  const tables = {
    b2b: Object.values(b2bMap), b2cs: b2csArr, b2cl: Object.values(b2clMap), cdnr: Object.values(cdnrMap), cdnur: cdnurArr,
    exp: expArr, nil: nilTable(nilRows), hsn: hsnTable(hsnRows, fp), at: adv.at, txpd: adv.txpd, doc_issue: { doc_det: docDet }
  };

  const postWarnings = [...warnings];
  if (unknownUnitCount > 0) {
    postWarnings.push(`${unknownUnitCount} item(s) used a custom unit and were exported as UQC 'OTH'.`);
  }
  if (adv.at.length || adv.txpd.length) {
    postWarnings.push('Tables 11A / 11B (advances) are new in this CRM: have your CA check them against the GST offline tool before the first filing.');
  }

  // The order the GST app writes (India Compliance's, which the portal accepts), with 11A / 11B added
  // before stripEmpty (03 §3). Blank values and empty tables are removed: the portal rejects them.
  const json = blocked.length || empty ? null : (stripEmpty({
    gstin, fp,
    version: 'GST3.1.6',
    hash: 'hash',
    b2b: tables.b2b, b2cs: tables.b2cs,
    b2cl: tables.b2cl,
    cdnr: tables.cdnr,
    cdnur: tables.cdnur,
    exp: tables.exp,
    nil: tables.nil,
    hsn: tables.hsn,
    at: tables.at,
    txpd: tables.txpd,
    doc_issue: tables.doc_issue
  }) || null);

  return {
    json,
    empty,
    blocked,
    warnings: postWarnings,
    checks: c.warnings,
    tables,
    classified: c,
    advances: adv,
    summary: summarise(tables, c)
  };
}

/** Counts and totals per table for the screen (read off the tables the JSON is built from). */
function summarise(tables, c) {
  const sumItems = (list, pick) => round2((list || []).reduce((s, x) => s + pick(x), 0));
  const tax = (d) => (d.iamt || 0) + (d.camt || 0) + (d.samt || 0) + (d.csamt || 0);
  const invItems = (groups, key) => (groups || []).flatMap((g) => g[key] || []).flatMap((inv) => (inv.itms || []).map((i) => i.itm_det || i));
  const b2bItems = invItems(tables.b2b, 'inv');
  const b2clItems = invItems(tables.b2cl, 'inv');
  const cdnrItems = invItems(tables.cdnr, 'nt');
  const cdnurItems = (tables.cdnur || []).flatMap((n) => (n.itms || []).map((i) => i.itm_det || i));
  const expItems = (tables.exp || []).flatMap((e) => (e.inv || []).flatMap((i) => i.itms || []));
  const atItems = (tables.at || []).flatMap((r) => r.itms || []);
  const txpdItems = (tables.txpd || []).flatMap((r) => r.itms || []);
  const count = (groups, key) => (groups || []).reduce((s, g) => s + ((g[key] || []).length), 0);
  const line = (n, items, val = (x) => x.txval || 0) => ({ count: n, taxable: sumItems(items, val), tax: sumItems(items, tax) });
  const hsn = tables.hsn || {};
  const hsnRows = [...(hsn.data || []), ...(hsn.hsn_b2b || []), ...(hsn.hsn_b2c || [])];
  return {
    b2b: line(count(tables.b2b, 'inv'), b2bItems),
    b2cl: line(count(tables.b2cl, 'inv'), b2clItems),
    b2cs: line((tables.b2cs || []).length, tables.b2cs || []),
    cdnr: line(count(tables.cdnr, 'nt'), cdnrItems),
    cdnur: line((tables.cdnur || []).length, cdnurItems),
    exp: line((tables.exp || []).reduce((s, e) => s + (e.inv || []).length, 0), expItems),
    nil: { count: ((tables.nil && tables.nil.inv) || []).length, taxable: sumItems((tables.nil && tables.nil.inv) || [], (r) => (r.nil_amt || 0) + (r.expt_amt || 0) + (r.ngsup_amt || 0)), tax: 0 },
    hsn: { count: hsnRows.length, taxable: sumItems(hsnRows, (r) => r.txval || 0), tax: sumItems(hsnRows, tax) },
    at: line(atItems.length, atItems, (x) => x.ad_amt || 0),
    txpd: line(txpdItems.length, txpdItems, (x) => x.ad_amt || 0),
    documents: Object.values(c.docSummary || {}).reduce((acc, d) => ({ total: acc.total + d.total, cancelled: acc.cancelled + d.cancelled }), { total: 0, cancelled: 0 }),
    invoices: c.regularBills.length,
    creditNotes: c.creditNotes.length
  };
}

/* --------------------------------------------------------------- CSV (03 §4) */

// GSTReturns.jsx's CSV exporters, ported; each returns { filename, headers, rows } (no download).
const CSV_TABLES = ['b2b', 'b2cs', 'b2cl', 'hsn', 'hsn_b2b', 'hsn_b2c', 'cdnr', 'cdnur', 'exp', 'docs', 'at', 'txpd'];

async function csvTable(built, table, { fp = '' } = {}) {
  const { utils, g } = await modules();
  const { getStateCode, formatDateGST, placeOfSupplyLabel } = utils;
  const { billIsInterstate, billSplit, hsnSplitFrom, mergeHsnRows, hsnCsvRow, HSN_CSV_HEADERS } = g;
  const c = built.classified;
  const hsnSplit = hsnSplitFrom(fp);

  switch (table) {
    case 'b2b':
      return {
        filename: 'GSTR1_B2B_Invoices.csv',
        headers: ['GSTIN/UIN', 'Receiver Name', 'Invoice Number', 'Invoice Date', 'Invoice Value', 'Place of Supply', 'Reverse Charge', 'Invoice Type', 'Supply Type', 'Taxable Value', 'CGST Amount', 'SGST Amount', 'IGST Amount'],
        rows: c.b2bRegular.map((bill) => {
          const { client, totals, details } = bill.data;
          const isInter = billIsInterstate(bill);
          const pos = getStateCode(details?.placeOfSupply || client?.state || '');
          return [client.gstin, client.name || bill.clientName || '', bill.invoiceNumber || '', formatDateGST(bill.invoiceDate), (totals?.total || 0).toFixed(2), placeOfSupplyLabel(pos), 'N', 'Regular', isInter ? 'Inter State' : 'Intra State', getTaxableAmount(totals).toFixed(2), isInter ? 0 : (totals?.cgst || 0).toFixed(2), isInter ? 0 : ((totals?.sgst || 0) + (totals?.utgst || 0)).toFixed(2), isInter ? (totals?.igst || 0).toFixed(2) : 0];
        })
      };
    case 'b2cs': {
      const b2csData = {};
      c.b2cSmall.forEach((bill) => {
        const { profile: prof, client, items, details } = bill.data;
        const isInter = billIsInterstate(bill);
        const pos = getStateCode(details?.placeOfSupply || client?.state || prof?.state || '');
        const splyType = isInter ? 'INTER' : 'INTRA';
        (items || []).forEach((item) => {
          const rate = item.taxPercent || 0;
          const key = `${splyType}_${pos}_${rate}`;
          if (!b2csData[key]) b2csData[key] = { splyType, pos, rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
          const split = billSplit(bill, item, isInter, !!bill.data?.taxInclusive, c.billIsIntraUT(bill));
          b2csData[key].taxable += split.taxable; b2csData[key].cgst += split.cgst; b2csData[key].sgst += split.sgst + split.utgst; b2csData[key].igst += split.igst;
          b2csData[key].cess = (b2csData[key].cess || 0) + split.cess;
        });
      });
      return {
        filename: 'GSTR1_B2C_Small.csv',
        headers: ['Type', 'Place of Supply', 'Rate', 'Taxable Value', 'CGST Amount', 'SGST Amount', 'IGST Amount', 'Cess Amount'],
        rows: Object.values(b2csData).map((d) => [d.splyType === 'INTER' ? 'Inter State' : 'Intra State', placeOfSupplyLabel(d.pos), d.rate + '%', d.taxable.toFixed(2), d.cgst.toFixed(2), d.sgst.toFixed(2), d.igst.toFixed(2), (d.cess || 0).toFixed(2)])
      };
    }
    case 'b2cl':
      return {
        filename: 'GSTR1_B2C_Large.csv',
        headers: ['Invoice Number', 'Invoice Date', 'Invoice Value', 'Place of Supply', 'Taxable Value', 'IGST Amount', 'Cess Amount'],
        rows: c.b2cLarge.map((bill) => { const { client, totals, details } = bill.data; const pos = getStateCode(details?.placeOfSupply || client?.state || ''); return [bill.invoiceNumber, formatDateGST(bill.invoiceDate), (totals?.total || 0).toFixed(2), placeOfSupplyLabel(pos), getTaxableAmount(totals).toFixed(2), (totals?.igst || 0).toFixed(2), (totals?.cess || 0).toFixed(2)]; })
      };
    case 'hsn':
      // Before the May 2025 return: one combined file.
      return { filename: 'GSTR1_HSN_Summary.csv', headers: HSN_CSV_HEADERS, rows: mergeHsnRows(c.hsnRows).map(hsnCsvRow), note: hsnSplit ? 'From the May 2025 return the portal takes Table 12 as two lists: use hsn_b2b and hsn_b2c.' : '' };
    case 'hsn_b2b':
      return { filename: 'GSTR1_HSN_B2B.csv', headers: HSN_CSV_HEADERS, rows: c.hsnRows.filter((r) => r.b2b).map(hsnCsvRow) };
    case 'hsn_b2c':
      return { filename: 'GSTR1_HSN_B2C.csv', headers: HSN_CSV_HEADERS, rows: c.hsnRows.filter((r) => !r.b2b).map(hsnCsvRow) };
    case 'cdnr':
      return {
        filename: 'GSTR1_CDNR.csv',
        headers: ['GSTIN/UIN', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place of Supply', 'Reverse Charge', 'Note Value', 'Taxable Value', 'IGST Amount', 'CGST Amount', 'SGST Amount'],
        rows: c.creditNotes.filter((b) => b.data?.client?.gstin).map((bill) => { const { client, totals } = bill.data; const isInter = billIsInterstate(bill); const pos = getStateCode(bill.data.details?.placeOfSupply || client?.state || ''); return [client.gstin, client.name || bill.clientName, bill.invoiceNumber, formatDateGST(bill.invoiceDate), 'C', pos, 'N', (totals?.total || 0).toFixed(2), getTaxableAmount(totals).toFixed(2), isInter ? (totals?.igst || 0).toFixed(2) : '0.00', isInter ? '0.00' : (totals?.cgst || 0).toFixed(2), isInter ? '0.00' : ((totals?.sgst || 0) + (totals?.utgst || 0)).toFixed(2)]; })
      };
    case 'cdnur':
      return {
        filename: 'GSTR1_CDNUR.csv',
        headers: ['Note Number', 'Note Date', 'Note Type', 'Place of Supply', 'Note Value', 'Taxable Value', 'IGST Amount', 'Cess Amount'],
        rows: c.creditNotes.filter((b) => !b.data?.client?.gstin).map((bill) => { const { client, totals } = bill.data; const pos = getStateCode(bill.data.details?.placeOfSupply || client?.state || ''); return [bill.invoiceNumber, formatDateGST(bill.invoiceDate), 'C', pos, (totals?.total || 0).toFixed(2), getTaxableAmount(totals).toFixed(2), (totals?.igst || 0).toFixed(2), (totals?.cess || 0).toFixed(2)]; })
      };
    case 'exp':
      return {
        filename: 'GSTR1_Exports_6A.csv',
        headers: ['Export Type', 'Invoice Number', 'Invoice Date', 'Invoice Value (INR)', 'Rate', 'Taxable Value (INR)', 'IGST (INR)', 'Cess (INR)', 'Client', 'Country', 'Currency', 'Exchange Rate'],
        rows: c.exportRows.filter((r) => !r.missing).map((r) => [r.type, r.invoiceNo, formatDateGST(r.date), r.value.toFixed(2), r.rates, r.taxable.toFixed(2), r.igst.toFixed(2), r.cess.toFixed(2), r.client, r.country, r.currency, r.missing ? 'MISSING' : r.fxRate])
      };
    case 'docs':
      return {
        filename: 'GSTR1_Doc_Summary.csv',
        headers: ['Document Type', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
        rows: Object.entries(c.docSummary).map(([, d]) => [d.type, d.from, d.to, d.total, d.cancelled])
      };
    case 'at':
    case 'txpd': {
      // New (03 §4): Table 11A / 11B with the columns Place Of Supply, Rate, Gross Advance, Cess Amount.
      const list = built.tables[table] || [];
      return {
        filename: table === 'at' ? 'GSTR1_11A_Advances_Received.csv' : 'GSTR1_11B_Advances_Adjusted.csv',
        headers: ['Place Of Supply', 'Rate', table === 'at' ? 'Gross Advance Received' : 'Gross Advance Adjusted', 'Cess Amount'],
        rows: list.flatMap((r) => r.itms.map((it) => [placeOfSupplyLabel(r.pos), it.rt, it.ad_amt.toFixed(2), it.csamt.toFixed(2)]))
      };
    }
    default:
      return null;
  }
}

/** The CSV text of a table: header line then rows, through the app's formula-safe toCsvLine. */
async function csvText(built, table, opts) {
  const out = await csvTable(built, table, opts);
  if (!out) return null;
  const { utils } = await modules();
  const lines = [utils.toCsvLine(out.headers)];
  out.rows.forEach((row) => lines.push(utils.toCsvLine(row)));
  return { filename: out.filename, csv: lines.join('\n'), rows: out.rows.length };
}

module.exports = {
  CSV_TABLES,
  INUM_REGEX,
  billIsLut,
  classify: async (input) => classify(await modules(), input),
  validateGSTR1: async (bills, opts) => validateGSTR1(await modules(), bills, opts),
  advanceTables,
  buildGstr1,
  csvTable,
  csvText
};
