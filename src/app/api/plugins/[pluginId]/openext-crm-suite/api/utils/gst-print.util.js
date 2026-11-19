'use strict';

/**
 * GST facts for printing a quotation, proforma or tax invoice (GST suite, CRM 3.53.0;
 * documentation/gst-planning/01 §9). One place builds them; every renderer (print page, standard PDF,
 * service-invoice PDF) only prints them.
 *
 * - Tax invoice: from its frozen `gst` snapshot (never worked out again). An invoice made before GST was
 *   set up has no snapshot and prints as before (null).
 * - Quotation: worked out now by the engine, for display; "This is not a tax invoice".
 * - Proforma: the seller's GST identity and "This is not a tax invoice" (its lines are payment requests).
 * Wording of export declarations comes from the GST app (lut.js exportDeclaration), never written here.
 */

const { loadGstModule } = require('../lib/gst-core');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function stateLabel(utils, code) {
  const c = String(code || '').trim();
  if (!c) return '';
  const name = utils.stateNameForCode(c);
  return name ? `${name} (${c})` : c;
}

/** Tax summary grouped by rate, from snapshot lines. */
function rowsByRate(lines) {
  const map = new Map();
  for (const l of lines || []) {
    const rate = Number(l.taxPercent) || 0;
    const row = map.get(rate) || { rate, taxable: 0, cgst: 0, sgst: 0, utgst: 0, igst: 0, cess: 0 };
    row.taxable += Number(l.taxable) || 0;
    row.cgst += Number(l.cgst) || 0;
    row.sgst += Number(l.sgst) || 0;
    row.utgst += Number(l.utgst) || 0;
    row.igst += Number(l.igst) || 0;
    row.cess += Number(l.cess) || 0;
    map.set(rate, row);
  }
  return [...map.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((row) => ({
      rate: row.rate,
      taxable: r2(row.taxable),
      cgst: r2(row.cgst),
      sgst: r2(row.sgst),
      utgst: r2(row.utgst),
      igst: r2(row.igst),
      cess: r2(row.cess)
    }));
}

/**
 * Pure: the printable facts from the tenant's GST settings and a snapshot.
 * kind: 'tax-invoice' | 'quotation' | 'proforma'.
 */
function gstPrintFacts({ settings, snapshot, kind, client = {}, utils, lut, upiLink, docNo, amountDue }) {
  const notTaxInvoice = kind !== 'tax-invoice';
  const seller = {
    name: settings.tradeName || settings.legalName || '',
    legalName: settings.legalName || '',
    gstin: settings.gstin || '',
    pan: settings.pan || '',
    state: stateLabel(utils, settings.stateCode),
    address: [settings.address?.line1, settings.address?.line2, [settings.address?.city, settings.address?.pincode].filter(Boolean).join(' ')]
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  };
  const facts = {
    kind,
    title: kind === 'tax-invoice' ? (settings.compositionScheme ? 'Bill of Supply' : 'Tax Invoice') : kind === 'proforma' ? 'Proforma Invoice' : 'Quotation',
    notTaxInvoice,
    notTaxInvoiceText: notTaxInvoice ? 'This is not a tax invoice.' : '',
    compositionText: settings.compositionScheme ? 'Composition taxable person, not eligible to collect tax on supplies.' : '',
    seller,
    clientGstin: '',
    placeOfSupply: '',
    interstate: false,
    rows: [],
    totals: null,
    amountInWords: '',
    reverseChargeText: '',
    declaration: '',
    upi: settings.upiId ? { id: settings.upiId, link: upiLink({ upiId: settings.upiId, payeeName: seller.name, amount: amountDue, docNo }) } : null
  };
  if (!snapshot || !snapshot.engine) return facts;

  facts.clientGstin = snapshot.clientGstin || '';
  facts.placeOfSupply = snapshot.isExport && !snapshot.posCode ? 'Outside India (export)' : stateLabel(utils, snapshot.posCode);
  facts.interstate = snapshot.isInterstate === true;
  facts.rows = rowsByRate(snapshot.lines);
  facts.totals = {
    taxable: r2(snapshot.taxableAmount),
    cgst: r2(snapshot.cgst),
    sgst: r2(snapshot.sgst),
    utgst: r2(snapshot.utgst),
    igst: r2(snapshot.igst),
    cess: r2(snapshot.cess),
    totalTax: r2(snapshot.totalTax),
    otherCharges: r2(snapshot.otherCharges),
    roundOff: r2(snapshot.roundOff),
    total: r2(snapshot.total)
  };
  facts.amountInWords = snapshot.amountInWords || '';
  facts.reverseChargeText = snapshot.reverseCharge ? 'Tax payable on reverse charge: Yes' : '';
  facts.declaration = lut.exportDeclaration({
    profile: { country: 'India' },
    client: { country: snapshot.isExport ? client.country || 'Outside India' : 'India', isSEZ: snapshot.isSEZ === true },
    details: { placeOfSupply: snapshot.placeOfSupply || '' },
    totals: { lutZeroRated: snapshot.isLUT === true },
    options: { lutArn: settings.lut?.number || '', lutFy: settings.lut?.fy || '' },
    showGST: !snapshot.compositionScheme
  });
  return facts;
}

/**
 * The GST facts of a document for printing, or null when GST is not set up (or a tax invoice has no
 * snapshot). Never throws: a print must always work.
 * @param {'quotation'|'invoice'} type
 */
async function gstPrintFor(req, type, doc) {
  try {
    const GstService = require('../services/gst.service');
    const { settings, ready } = await GstService.context(req);
    if (!ready || !doc) return null;
    if (String(doc.currency || 'INR').toUpperCase() !== 'INR') return null;
    const [utils, lut] = await Promise.all([loadGstModule('utils'), loadGstModule('lut')]);
    const common = { settings, utils, lut, upiLink: GstService.upiLink };

    if (type === 'invoice' && doc.documentType === 'proforma') {
      return gstPrintFacts({ ...common, snapshot: null, kind: 'proforma', docNo: doc.invoiceNo, amountDue: doc.balanceDue ?? doc.grandTotal });
    }
    if (type === 'invoice') {
      if (!doc.gst || !doc.gst.engine) return null;
      return gstPrintFacts({ ...common, snapshot: doc.gst, kind: 'tax-invoice', docNo: doc.invoiceNo, amountDue: doc.balanceDue ?? doc.grandTotal });
    }
    // Quotation: worked out now, for display only.
    let snapshot = null;
    try {
      snapshot = (await GstService.calculate(req, {
        clientId: doc.clientId,
        lines: doc.lineItems,
        placeOfSupply: doc.placeOfSupply,
        issueDate: doc.issueDate,
        discountAmount: doc.discountAmount,
        taxCalculation: doc.taxCalculation,
        otherCharges: GstService.otherChargesOf(doc)
      })).snapshot;
    } catch {
      snapshot = null;
    }
    return gstPrintFacts({ ...common, snapshot, kind: 'quotation', docNo: doc.quotationNo, amountDue: doc.grandTotal });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] GST print details unavailable:', error?.message || error);
    return null;
  }
}

module.exports = { gstPrintFor, gstPrintFacts, rowsByRate, stateLabel };
