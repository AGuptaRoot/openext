'use strict';

/**
 * Service invoice PDF: the invoice drawn in the branded document layout (pdf-document.util) when the active
 * extension asks for it (salesFlow.invoicePrint = { layout: 'service', title?, summaryTitle?, linesTitle?,
 * footer? }). For businesses that sell services, not goods:
 *   - lines print Service / Rate / Tax / Amount — no quantity, unit, product code or shipping;
 *   - the extension's read-only summary of the invoice's quotation (salesFlow.invoicePrefillRoute) is printed
 *     under `summaryTitle`; wording comes from salesFlow.terms (lines, subtotal);
 *   - money from verified payments: Subtotal, Discount, Tax, Grand Total, Advance Paid, Amount Paid (the other
 *     payments), Credits, Balance Due — Grand Total − Advance − Amount Paid − Credits = Balance Due;
 *   - Payment status: Paid when nothing is left to pay (Balance Due 0), else Partially Paid / Unpaid / Overdue,
 *     or the invoice's own Draft / Cancelled / Written Off / Converted.
 * payload = generateFinanceDocumentPdf's payload plus `servicePrint` (finance-document.util withServicePrint).
 */

const { renderDocumentPdf } = require('./pdf-document.util');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const t = (v, max = 300) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, max);

function money(currency, value) {
  const n = round2(value);
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${currency} ${n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return t(value, 40);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** { label, tone } of the payment status printed on the invoice. */
function paymentStatus(invoice, money) {
  const own = t(invoice.status, 40);
  if (['Cancelled', 'Written Off', 'Converted', 'Draft'].includes(own)) return { label: own, tone: own === 'Draft' ? 'neutral' : 'danger' };
  if (money.total > 0 && money.balance <= 0.005) return { label: 'Paid', tone: 'success' };
  if (money.paid > 0) return { label: 'Partially Paid', tone: 'warning' };
  if (own === 'Overdue') return { label: 'Overdue', tone: 'danger' };
  return { label: 'Unpaid', tone: 'info' };
}

function addressText(address) {
  if (!address) return '';
  if (typeof address === 'string') return t(address, 200);
  return ['street', 'line1', 'line2', 'city', 'state', 'postalCode', 'zip', 'country']
    .map((k) => t(address[k], 80))
    .filter(Boolean)
    .join(', ')
    .slice(0, 200);
}

/** The branded document (pdf-document.util) of a service invoice. */
function serviceInvoiceDocument(payload) {
  const print = payload.servicePrint || {};
  const doc = payload.document || {};
  const client = payload.client || {};
  const currency = t(doc.currency || (payload.company && payload.company.currency) || 'INR', 10);
  const total = round2(doc.grandTotal);
  const p = print.payments || {};
  const paid = round2(p.paid !== undefined ? p.paid : doc.amountPaid);
  const advance = Math.min(round2(p.advancePaid !== undefined ? p.advancePaid : doc.advancePaid), paid);
  const credit = round2(p.credit !== undefined ? p.credit : doc.creditAmount);
  const balance = round2(Math.max(0, p.balance !== undefined ? p.balance : doc.balanceDue !== undefined && doc.balanceDue !== null ? doc.balanceDue : total - paid - credit));
  const status = paymentStatus(doc, { total, paid, balance });
  const shownBalance = status.label === 'Paid' ? 0 : balance;
  const proforma = doc.documentType === 'proforma';

  const lines = (Array.isArray(doc.lineItems) ? doc.lineItems : []).slice(0, 100).map((line) => {
    const name = t(line.name, 200) || t(line.description, 200) || 'Service';
    const description = t(line.description, 300);
    const tax = Number(line.tax) || 0;
    // No quantity column: a line of several units (e.g. room-nights) shows "rate x units" so Rate and Amount agree.
    const units = Number(line.qty ?? line.quantity);
    const rate = Number.isFinite(units) && units > 0 && units !== 1 ? `${money(currency, line.rate)} x ${round2(units)}` : money(currency, line.rate);
    return {
      cells: [name, rate, tax ? `${round2(tax)}%` : '-', money(currency, line.amount)],
      note: description && description !== name ? description : ''
    };
  });

  const discount = round2(doc.discountAmount);
  const discountLabel = doc.discountType === 'percent' && Number(doc.discountPercent) > 0 ? `Discount (${round2(doc.discountPercent)}%)` : 'Discount';
  const totals = [
    { label: t(print.subtotalLabel, 40) || 'Subtotal', value: money(currency, doc.subtotal) },
    discount > 0 ? { label: discountLabel, value: `- ${money(currency, discount)}` } : null,
    { label: 'Tax', value: money(currency, doc.taxTotal) },
    { label: 'Grand Total', value: money(currency, total), strong: true },
    advance > 0 ? { label: 'Advance Paid', value: `- ${money(currency, advance)}`, tone: 'success', divider: true } : null,
    { label: 'Amount Paid', value: `- ${money(currency, round2(paid - advance))}`, tone: paid - advance > 0 ? 'success' : '', divider: !(advance > 0) },
    credit > 0 ? { label: 'Credits Applied', value: `- ${money(currency, credit)}` } : null,
    { label: 'Balance Due', value: money(currency, shownBalance), strong: true, tone: shownBalance > 0 ? 'danger' : 'success' }
  ].filter(Boolean);

  const sections = (Array.isArray(doc.sections) ? doc.sections : [])
    .filter((s) => s && t(s.title) && t(s.body))
    .slice(0, 10)
    .map((s) => ({ type: 'text', heading: t(s.title, 80), text: t(s.body, 3000) }));

  return {
    title: print.title || (proforma ? 'Proforma Invoice' : 'Invoice'),
    reference: t(doc.invoiceNo, 60),
    date: doc.issueDate ? `Issued ${formatDate(doc.issueDate)}` : '',
    layout: 'branded',
    blocks: [
      {
        type: 'hero',
        eyebrow: 'Billed to',
        title: t(client.name, 120) || 'Customer',
        subtitle: [t(client.email, 80), t(client.phone, 40)].filter(Boolean).join('  |  '),
        badge: { text: status.label, tone: status.tone }
      },
      {
        type: 'facts',
        heading: proforma ? 'Payment request details' : 'Invoice details',
        columns: 4,
        items: [
          { label: proforma ? 'Number' : 'Invoice number', value: t(doc.invoiceNo, 60) },
          { label: 'Invoice date', value: formatDate(doc.issueDate) },
          { label: 'Due date', value: formatDate(doc.dueDate) },
          { label: 'Quotation reference', value: t(print.quotationNo, 60) },
          { label: 'Payment status', value: status.label },
          { label: 'Billing address', value: addressText(client.billingAddress) || t(doc.billingAddress, 200) },
          { label: 'Tax ID', value: t(client.taxId, 60) }
        ]
      },
      { type: 'facts', heading: t(print.summaryTitle, 40) || 'Summary', columns: 4, items: (Array.isArray(print.summary) ? print.summary : []).slice(0, 12).map((s) => ({ label: t(s.label, 40), value: t(s.value, 120) })) },
      {
        type: 'table',
        heading: t(print.linesTitle, 40) || 'Services',
        columns: [
          { label: 'Service', width: 4.5 },
          { label: 'Rate', align: 'right', width: 2.2 },
          { label: 'Tax', align: 'right', width: 0.8 },
          { label: 'Amount', align: 'right', width: 1.8 }
        ],
        rows: lines
      },
      { type: 'totals', rows: totals },
      { type: 'note', heading: 'Notes', text: t(doc.notes, 1000), tone: 'info' },
      { type: 'text', heading: 'Payment details', text: t(doc.paymentDetails, 1000) },
      { type: 'text', heading: 'Terms & conditions', text: t(doc.terms, 3000) },
      ...sections
    ],
    footer: t(print.footer, 200) || 'Thank you for your business.',
    watermark: doc.status === 'Cancelled' ? 'CANCELLED' : ''
  };
}

/** @returns {Buffer} */
function renderServiceInvoicePdf(payload) {
  const print = payload.servicePrint || {};
  const company = { name: payload.company && payload.company.name, ...(print.company || {}) };
  return renderDocumentPdf(serviceInvoiceDocument(payload), company);
}

module.exports = { renderServiceInvoicePdf, serviceInvoiceDocument, paymentStatus };
