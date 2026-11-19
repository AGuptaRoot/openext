'use strict';

/**
 * Period lock for GST documents (GST suite, Step 5; documentation/gst-planning/03 §6).
 *
 * After the CA files a return the admin sets Settings → GST "Books locked up to" (GstSettings.lockedUpTo).
 * From then on, issuing, editing, cancelling or deleting a tax invoice, credit note or advance receipt
 * dated on or before that day is refused (409). The rule is the GST app's copied periodLock.lockProblem
 * ('bills': which fields count as a change), not a new one. Recording a payment against an old invoice,
 * printing, notes and the like stay allowed. Cash entries have their own check in cashbook.service.js.
 * Without GST set up there is no lock.
 */

const { loadGstModule } = require('../lib/gst-core');
const Adapter = require('../lib/gst-adapter');

function lockedError(message) {
  const error = new Error(String(message).replace('Settings -> Data', 'Settings → GST'));
  error.status = 409;
  error.code = 'BOOKS_LOCKED';
  return error;
}

/** The tenant's lock date ('' = not locked). Never throws. */
async function lockedUpTo(req) {
  try {
    const { settings, ready } = await require('./gst.service').context(req);
    return ready ? String(settings.lockedUpTo || '') : '';
  } catch {
    return '';
  }
}

/**
 * A CRM invoice or credit note in the fields periodLock fingerprints for 'bills' (date, number, type,
 * amounts, cancellation, client GSTIN, place of supply, items, GST split). `kind`: 'invoice' | 'credit-note'.
 */
function lockShape(doc, kind = 'invoice') {
  if (!doc) return null;
  const isNote = kind === 'credit-note';
  const gst = doc.gst || {};
  const lines = (isNote ? doc.items : doc.lineItems) || [];
  return {
    invoiceDate: Adapter.localIsoDate(isNote ? doc.creditDate : doc.issueDate),
    invoiceNumber: String((isNote ? doc.creditNoteNumber : doc.invoiceNo) || ''),
    invoiceType: isNote ? 'credit-note' : 'tax-invoice',
    totalAmount: Number(isNote ? doc.totalAmount : doc.grandTotal) || 0,
    totalTaxAmount: Number(doc.taxTotal) || 0,
    status: (isNote ? doc.status === 'Void' : doc.status === 'Cancelled') ? 'cancelled' : '',
    clientName: String(doc.clientId || ''),
    data: {
      client: { gstin: String(gst.clientGstin || ''), isSEZ: gst.isSEZ === true },
      details: { placeOfSupply: String(doc.placeOfSupply || gst.placeOfSupply || '') },
      items: lines.map((l) => ({
        d: String(l.description || l.name || ''),
        q: Number(isNote ? l.quantity : l.qty) || 0,
        r: Number(isNote ? l.unitPrice : l.rate) || 0,
        t: Number(l.tax) || 0,
        s: String(l.sac || '')
      })),
      invoiceOptions: { isLUT: gst.isLUT === true, reverseCharge: gst.reverseCharge === true },
      totals: {
        total: Number(gst.total) || 0, taxableAmount: Number(gst.taxableAmount) || 0,
        cgst: Number(gst.cgst) || 0, sgst: Number(gst.sgst) || 0, utgst: Number(gst.utgst) || 0, igst: Number(gst.igst) || 0, cess: Number(gst.cess) || 0
      }
    }
  };
}

/**
 * Refuse (409) a change to a GST document on a locked date. `before`: the document on file (null for a
 * new one); `after`: the document as it would be saved (null = delete). Both in CRM form.
 */
async function assertDocumentNotLocked(req, before, after, kind = 'invoice') {
  if (kind === 'invoice' && ((before && before.documentType === 'proforma') || (after && after.documentType === 'proforma'))) return;
  const upTo = await lockedUpTo(req);
  if (!upTo) return;
  const periodLock = await loadGstModule('periodLock');
  const problem = periodLock.lockProblem('bills', lockShape(before, kind), lockShape(after, kind), upTo);
  if (problem) throw lockedError(problem);
}

/**
 * Issuing a document: a draft becomes a GST document (or a new one is made already issued). Treated as a
 * new bill for the lock (periodLock: a new or back-dated entry on a locked date is refused).
 */
async function assertIssueNotLocked(req, doc, kind = 'invoice') {
  return assertDocumentNotLocked(req, null, doc, kind);
}

/** True when `date` ('YYYY-MM-DD' or a Date) is on or before the lock date (for automatic documents). */
async function isLocked(req, date) {
  const upTo = await lockedUpTo(req);
  if (!upTo) return false;
  const periodLock = await loadGstModule('periodLock');
  return Boolean(periodLock.lockProblem('bills', null, { invoiceDate: Adapter.localIsoDate(date) }, upTo));
}

module.exports = { lockedUpTo, lockShape, assertDocumentNotLocked, assertIssueNotLocked, isLocked };
