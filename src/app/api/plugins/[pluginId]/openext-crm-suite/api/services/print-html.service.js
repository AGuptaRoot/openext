'use strict';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Printed document dates read `27-10-2026`, or `27-10-2026 & 14-30` when the
 * value carries a real time of day.
 *
 * Issue dates and due dates are usually stored as a plain date (midnight UTC);
 * printing `& 00-00` next to those would be noise, and reading them in the
 * server's timezone can slide the day, so a date-only value is read back in UTC.
 */
function formatDate(value) {
  if (!value) return '—';
  try {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');

    const dateOnly =
      parsed.getUTCHours() === 0 &&
      parsed.getUTCMinutes() === 0 &&
      parsed.getUTCSeconds() === 0 &&
      parsed.getUTCMilliseconds() === 0;

    if (dateOnly) {
      return `${pad(parsed.getUTCDate())}-${pad(parsed.getUTCMonth() + 1)}-${parsed.getUTCFullYear()}`;
    }
    const date = `${pad(parsed.getDate())}-${pad(parsed.getMonth() + 1)}-${parsed.getFullYear()}`;
    return `${date} & ${pad(parsed.getHours())}-${pad(parsed.getMinutes())}`;
  } catch {
    return String(value);
  }
}

function formatMoney(amount, currency = 'INR') {
  const value = Number(amount) || 0;
  return `${escapeHtml(currency)} ${value.toFixed(2)}`;
}

function formatAddress(address) {
  if (!address || typeof address !== 'object') return '';
  return [address.street, address.city, address.state, address.zip, address.country]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}

function renderLineItemsRows(lineItems, currency) {
  const rows = Array.isArray(lineItems) ? lineItems : [];
  if (!rows.length) {
    return '<tr><td colspan="5" class="empty-row">No line items</td></tr>';
  }

  return rows
    .map(
      (line) => `
        <tr>
          <td>${escapeHtml(line.description || '—')}${line.printNote ? `<div class="line-note">${escapeHtml(line.printNote)}</div>` : ''}</td>
          <td class="num">${escapeHtml(String(line.qty ?? 0))}</td>
          <td class="num">${Number(line.rate || 0).toFixed(2)}</td>
          <td class="num">${escapeHtml(String(line.tax ?? 0))}</td>
          <td class="num">${Number(line.amount || 0).toFixed(2)}</td>
        </tr>
      `
    )
    .join('');
}

/**
 * Shared quotation/invoice body (print + email).
 */
function buildFinanceDocumentBody(payload) {
  const { type, company, client, document: docData } = payload;
  const isQuotation = type === 'quotation';
  const title = isQuotation ? 'Quotation' : 'Invoice';
  const docNo = isQuotation ? docData.quotationNo : docData.invoiceNo;
  const currency = docData.currency || company.currency || 'INR';
  const address = formatAddress(client.billingAddress);

  const extraDates = isQuotation
    ? docData.expiryDate
      ? `<div><dt>Valid until</dt><dd>${escapeHtml(formatDate(docData.expiryDate))}</dd></div>`
      : ''
    : docData.dueDate
      ? `<div><dt>Due date</dt><dd>${escapeHtml(formatDate(docData.dueDate))}</dd></div>`
      : '';

  const invoiceTotals = !isQuotation
    ? `
      <div class="totals-row"><span>Amount paid</span><strong>${formatMoney(docData.amountPaid, currency)}</strong></div>
      <div class="totals-row balance"><span>Balance due</span><strong>${formatMoney(docData.balanceDue, currency)}</strong></div>
    `
    : '';

  const notes = docData.notes
    ? `<section class="notes"><h2>Notes</h2><p>${escapeHtml(docData.notes)}</p></section>`
    : '';

  // Titled sections (inclusions, cancellation policy, ...)
  const sections = (Array.isArray(docData.sections) ? docData.sections : [])
    .filter((s) => s && String(s.title || '').trim() && String(s.body || '').trim())
    .map((s) => `<section class="notes doc-section"><h2>${escapeHtml(s.title)}</h2><p>${escapeHtml(s.body)}</p></section>`)
    .join('');

  return {
    title,
    docNo,
    html: `
    <header class="header">
      <div>
        <p class="company-name">${escapeHtml(company.name || 'Company')}</p>
      </div>
      <div>
        <h1 class="doc-title">${escapeHtml(title.toUpperCase())}</h1>
        <dl class="meta">
          <div><dt>${escapeHtml(title)} No</dt><dd>${escapeHtml(docNo || '—')}</dd></div>
          <div><dt>Issue date</dt><dd>${escapeHtml(formatDate(docData.issueDate))}</dd></div>
          ${extraDates}
          <div><dt>Status</dt><dd>${escapeHtml(docData.status || '—')}</dd></div>
        </dl>
      </div>
    </header>

    <section class="bill-to">
      <h2>Bill To</h2>
      <p><strong>${escapeHtml(client.name || '—')}</strong></p>
      ${client.taxId ? `<p>Tax ID: ${escapeHtml(client.taxId)}</p>` : ''}
      ${client.email ? `<p>${escapeHtml(client.email)}</p>` : ''}
      ${client.phone ? `<p>${escapeHtml(client.phone)}</p>` : ''}
      ${address ? `<p>${escapeHtml(address)}</p>` : ''}
    </section>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">Qty</th>
          <th class="num">Rate</th>
          <th class="num">Tax %</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${renderLineItemsRows(docData.lineItems, currency)}
      </tbody>
    </table>

    <section class="totals">
      <div class="totals-row"><span>Subtotal</span><strong>${formatMoney(docData.subtotal, currency)}</strong></div>
      ${Number(docData.discountAmount || 0) > 0 ? `
        <div class="totals-row" style="color:#0284c7;">
          <span>Discount ${docData.discountType === 'percentage' && docData.discountValue ? `(${docData.discountValue}%)` : ''}</span>
          <strong>-${formatMoney(docData.discountAmount, currency)}</strong>
        </div>
      ` : ''}
      <div class="totals-row"><span>Tax</span><strong>${formatMoney(docData.taxTotal, currency)}</strong></div>
      <div class="totals-row grand"><span>Grand total</span><strong>${formatMoney(docData.grandTotal, currency)}</strong></div>
      ${invoiceTotals}
    </section>

    ${notes}
    ${sections}

    <footer class="footer">Generated by Root CRM</footer>
  `
  };
}

const FINANCE_DOC_STYLES = `
    :root {
      color-scheme: light;
      --text: #111827;
      --muted: #6b7280;
      --border: #d1d5db;
      --accent: #2563eb;
      --panel: #f8fafc;
    }
    * { box-sizing: border-box; }
    .page {
      max-width: 900px;
      margin: 24px auto;
      padding: 40px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      font-family: "Segoe UI", Tahoma, sans-serif;
      color: var(--text);
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 28px;
    }
    .company-name { font-size: 1.5rem; font-weight: 700; margin: 0 0 4px; }
    .doc-title {
      margin: 0;
      font-size: 1.75rem;
      color: var(--accent);
      text-align: right;
    }
    .meta {
      display: grid;
      gap: 6px;
      margin-top: 8px;
      font-size: 0.92rem;
      text-align: right;
    }
    .meta div { display: flex; justify-content: flex-end; gap: 8px; }
    .meta dt { color: var(--muted); margin: 0; }
    .meta dd { margin: 0; font-weight: 600; }
    .bill-to {
      margin-bottom: 24px;
      padding: 16px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .bill-to h2, .notes h2 {
      margin: 0 0 8px;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 0.92rem;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    td.num, th.num { text-align: right; white-space: nowrap; }
    .empty-row { text-align: center; color: var(--muted); }
    .totals {
      margin-left: auto;
      width: min(100%, 320px);
      display: grid;
      gap: 8px;
    }
    .totals-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      font-size: 0.95rem;
    }
    .totals-row.grand {
      font-size: 1.05rem;
      font-weight: 700;
      padding-top: 8px;
      border-top: 2px solid var(--border);
    }
    .totals-row.balance strong { color: #b45309; }
    .notes { margin-top: 24px; }
    .doc-section p { white-space: pre-line; }
    .line-note { font-size: 11px; color: #64748b; margin-top: 2px; }
    .doc-section { break-inside: avoid; }
    .footer {
      margin-top: 32px;
      text-align: center;
      color: var(--muted);
      font-size: 0.82rem;
    }
`;

/**
 * Render a printable HTML page for a quotation or invoice.
 * User can Print → Save as PDF from the browser (zero npm dependencies).
 */
function renderFinancePrintHtml(payload) {
  const { title, docNo, html } = buildFinanceDocumentBody(payload);
  const safeDocTitle = JSON.stringify(String(title || 'Document'));
  const safeDocNo = JSON.stringify(String(docNo || ''));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} ${escapeHtml(docNo || '')}</title>
  <style>
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, sans-serif;
      color: #111827;
      background: #eef2f7;
      line-height: 1.5;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 20px;
      background: #fff;
      border-bottom: 1px solid #d1d5db;
    }
    .toolbar h1 { margin: 0; font-size: 1rem; font-weight: 600; }
    .toolbar-actions { display: flex; gap: 8px; }
    button {
      border: 1px solid #d1d5db;
      background: #fff;
      color: #111827;
      border-radius: 8px;
      padding: 8px 14px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      background: #2563eb;
      border-color: #2563eb;
      color: #fff;
    }
    ${FINANCE_DOC_STYLES}
    @media print {
      body { background: #fff; }
      .toolbar { display: none !important; }
      .page {
        margin: 0;
        border: 0;
        border-radius: 0;
        max-width: none;
        padding: 0;
      }
    }
  </style>
  <script>
    function handleDownloadPdf() {
      try {
        var currentPath = window.location.pathname;
        var search = window.location.search || '';
        var pdfUrl = currentPath.replace(/\\/print\\/?$/, '/pdf') + search;
        var docTitle = ${safeDocTitle};
        var docNum = ${safeDocNo};
        var filename = (docTitle + (docNum ? '-' + docNum : '') + '.pdf').replace(/[/\\\\?%*:|"<>]/g, '_');
        var a = document.createElement('a');
        a.href = pdfUrl;
        a.setAttribute('download', filename);
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
          try { document.body.removeChild(a); } catch (_) {}
        }, 300);
      } catch (err) {
        console.error('PDF download error:', err);
      }
    }
    window.handleDownloadPdf = handleDownloadPdf;

    function handleSafePrint() {
      try {
        window.print();
      } catch (e) {
        console.warn('window.print() not permitted or blocked, downloading PDF fallback...');
        handleDownloadPdf();
      }
    }
    window.handleSafePrint = handleSafePrint;

    document.addEventListener('DOMContentLoaded', function() {
      var btnPdf = document.getElementById('btn-print-save-pdf');
      if (btnPdf) {
        btnPdf.addEventListener('click', handleDownloadPdf);
      }
      var btnPrint = document.getElementById('btn-print-dialog');
      if (btnPrint) {
        btnPrint.addEventListener('click', handleSafePrint);
      }
      var btnClose = document.getElementById('btn-close-window');
      if (btnClose) {
        btnClose.addEventListener('click', function() { window.close(); });
      }
    });
  </script>
</head>
<body>
  <div class="toolbar">
    <h1>${escapeHtml(title)} · ${escapeHtml(docNo || '')}</h1>
    <div class="toolbar-actions">
      <button type="button" id="btn-print-dialog" onclick="handleSafePrint()">🖨️ Print Dialog</button>
      <button type="button" id="btn-close-window" onclick="window.close()">Close</button>
    </div>
  </div>

  <main class="page">${html}</main>
</body>
</html>`;
}

function isValidPayUrl(url) {
  const text = String(url || '').trim();
  if (!text) return false;
  if (text.startsWith('/')) return true;
  try {
    const parsed = new URL(text);
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function renderPayNowCta(payUrl, balanceDue, currency) {
  const url = String(payUrl || '').trim();
  if (!isValidPayUrl(url) || Number(balanceDue) <= 0) return '';

  return `
    <div style="max-width:900px;margin:0 auto 20px;padding:0 8px;text-align:center;">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;">
        Pay Now — ${escapeHtml(formatMoney(balanceDue, currency))}
      </a>
      <p style="color:#64748b;font-size:0.88rem;margin-top:10px;">Secure online payment. You can also view and download your invoice from the payment page.</p>
    </div>
  `;
}

function renderFinanceEmailHtml(payload, options = {}) {
  const { type, company, client, document: docData } = payload;
  const isInvoice = type === 'invoice';
  const title = isInvoice ? 'Invoice' : 'Quotation';
  const docNo = isInvoice ? (docData?.invoiceNo || '—') : (docData?.quotationNo || '—');
  const currency = docData?.currency || company?.currency || 'INR';
  const balanceDue = Number(docData?.balanceDue != null ? docData.balanceDue : (docData?.grandTotal || 0));
  const grandTotal = Number(docData?.grandTotal || 0);
  const amountPaid = Number(docData?.amountPaid || 0);
  const discountAmount = Number(docData?.discountAmount || 0);
  const discountValue = Number(docData?.discountValue || 0);
  const discountType = docData?.discountType || 'flat';
  const creditAmount = Number(docData?.creditAmount || 0);
  const subtotal = Number(docData?.subtotal || 0);
  const taxTotal = Number(docData?.taxTotal || 0);
  const payUrl = String(options.payUrl || '').trim();
  const portalUrl = String(options.portalUrl || options.payUrl || '').trim();
  const canPayOnline = isInvoice && isValidPayUrl(payUrl) && balanceDue > 0;
  const address = formatAddress(client?.billingAddress);

  const intro = options.intro
    ? `<div style="font-size:14px; color:#334155; line-height:1.6; margin-bottom:18px;">${escapeHtml(options.intro)}</div>`
    : '';

  const lineItems = Array.isArray(docData?.lineItems) ? docData.lineItems : [];
  const lineItemRowsHtml = lineItems.map((li) => {
    const name = escapeHtml(li.name || li.description || 'Item');
    const desc = (li.description && li.description !== li.name ? `<div style="font-size:12px; color:#64748b; margin-top:2px;">${escapeHtml(li.description)}</div>` : '')
      + (li.printNote ? `<div style="font-size:11px; color:#64748b; margin-top:2px;">${escapeHtml(li.printNote)}</div>` : '');
    const qty = escapeHtml(String(li.qty ?? 1));
    const rate = formatMoney(li.rate || 0, currency);
    const amount = formatMoney(Number(li.amount || (Number(li.qty || 1) * Number(li.rate || 0))), currency);
    return `
      <tr>
        <td style="padding:12px 14px; border-bottom:1px solid #f1f5f9; color:#1e293b; font-size:13px; text-align:left;">
          <strong>${name}</strong>
          ${desc}
        </td>
        <td style="padding:12px 14px; border-bottom:1px solid #f1f5f9; color:#475569; font-size:13px; text-align:center;">${qty}</td>
        <td style="padding:12px 14px; border-bottom:1px solid #f1f5f9; color:#475569; font-size:13px; text-align:right;">${rate}</td>
        <td style="padding:12px 14px; border-bottom:1px solid #f1f5f9; color:#0f172a; font-weight:600; font-size:13px; text-align:right;">${amount}</td>
      </tr>
    `;
  }).join('') || '<tr><td colspan="4" style="padding:16px; text-align:center; color:#94a3b8; font-size:13px;">No line items</td></tr>';

  const notesHtml = docData?.notes
    ? `<div style="margin-top:20px; padding:12px 16px; background:#f8fafc; border-left:4px solid #3b82f6; border-radius:6px; font-size:13px; color:#475569; line-height:1.5;">
        <strong style="color:#1e293b;">Notes:</strong><br>${escapeHtml(docData.notes)}
       </div>`
    : '';

  const bankHtml = docData?.bankAccount || docData?.paymentDetails
    ? `<div style="margin-top:14px; padding:12px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; color:#475569; line-height:1.5;">
        <strong style="color:#1e293b;">Payment / Bank Details:</strong><br>${escapeHtml(docData.bankAccount || docData.paymentDetails)}
       </div>`
    : '';

  const payButtonBlock = canPayOnline
    ? `
      <div style="text-align:center; margin:24px 0 20px;">
        <a href="${escapeHtml(payUrl)}" target="_blank" style="display:inline-block; background:#2563eb; color:#ffffff; font-family:'Segoe UI', Helvetica, Arial, sans-serif; font-size:15px; font-weight:700; text-decoration:none; padding:14px 34px; border-radius:8px; box-shadow:0 4px 6px -1px rgba(37, 99, 235, 0.25);">
          💳 Pay Invoice Online (${escapeHtml(formatMoney(balanceDue, currency))}) →
        </a>
        <div style="font-size:12px; color:#64748b; margin-top:8px;">
          Instant secure online payment via UPI, Credit/Debit Card, Net Banking &amp; Wallets.
        </div>
        <div style="margin-top:10px;">
          <span style="display:inline-block; font-size:12px; color:#047857; background:#ecfdf5; border:1px solid #a7f3d0; padding:4px 12px; border-radius:6px;">
            📎 A PDF copy is attached to this email for your records.
          </span>
        </div>
      </div>
    `
    : (!isInvoice && portalUrl ? `
      <div style="text-align:center; margin:24px 0 20px;">
        <a href="${escapeHtml(portalUrl)}" target="_blank" style="display:inline-block; background:#2563eb; color:#ffffff; font-family:'Segoe UI', Helvetica, Arial, sans-serif; font-size:15px; font-weight:700; text-decoration:none; padding:14px 34px; border-radius:8px; box-shadow:0 4px 6px -1px rgba(37, 99, 235, 0.25);">
          📄 View &amp; Accept Proposal in Client Portal →
        </a>
        <div style="font-size:12px; color:#64748b; margin-top:8px;">
          Review terms, accept proposal with digital signature, or download PDF directly from your portal.
        </div>
        <div style="margin-top:10px;">
          <span style="display:inline-block; font-size:12px; color:#047857; background:#ecfdf5; border:1px solid #a7f3d0; padding:4px 12px; border-radius:6px;">
            📎 A PDF copy is attached to this email for your records.
          </span>
        </div>
      </div>
    ` : (portalUrl ? `
      <div style="text-align:center; margin:20px 0;">
        <a href="${escapeHtml(portalUrl)}" target="_blank" style="display:inline-block; background:#0f172a; color:#ffffff; font-family:'Segoe UI', Helvetica, Arial, sans-serif; font-size:14px; font-weight:700; text-decoration:none; padding:12px 26px; border-radius:8px;">
          View ${escapeHtml(title)} Online →
        </a>
        <div style="margin-top:8px;">
          <span style="display:inline-block; font-size:12px; color:#047857; background:#ecfdf5; border:1px solid #a7f3d0; padding:4px 12px; border-radius:6px;">
            📎 A PDF copy is attached to this email.
          </span>
        </div>
      </div>
    ` : `
      <div style="text-align:center; margin:14px 0;">
        <span style="display:inline-block; font-size:12px; color:#047857; background:#ecfdf5; border:1px solid #a7f3d0; padding:4px 12px; border-radius:6px;">
          📎 A PDF copy is attached to this email.
        </span>
      </div>
    `));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} ${escapeHtml(docNo)}</title>
</head>
<body style="margin:0; padding:24px 8px; background-color:#f1f5f9; font-family:'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased; color:#0f172a;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:620px; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.04);">
          
          <!-- Brand Header -->
          <tr>
            <td style="padding:28px 28px 20px; background:#ffffff; border-bottom:1px solid #f1f5f9;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td valign="middle" align="left">
                    <div style="font-size:22px; font-weight:800; color:#0f172a; letter-spacing:-0.02em;">
                      ${escapeHtml(company?.name || 'Root CRM')}
                    </div>
                  </td>
                  <td valign="middle" align="right">
                    <span style="display:inline-block; background:${isInvoice ? '#eff6ff' : '#ecfdf5'}; color:${isInvoice ? '#1d4ed8' : '#047857'}; border:1px solid ${isInvoice ? '#bfdbfe' : '#a7f3d0'}; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; padding:4px 12px; border-radius:9999px;">
                      ${escapeHtml(title)} #${escapeHtml(docNo)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero Amount Card -->
          <tr>
            <td style="padding:24px 28px 20px; text-align:center;">
              ${intro}
              <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:20px 16px; margin-bottom:12px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; margin-bottom:6px;">
                  ${isInvoice ? (balanceDue > 0 ? 'Total Balance Due' : 'Invoice Total') : 'Quotation Total'}
                </div>
                <div style="font-size:32px; font-weight:800; color:${isInvoice && balanceDue > 0 ? '#0f172a' : '#15803d'}; letter-spacing:-0.03em; line-height:1.1;">
                  ${escapeHtml(formatMoney(isInvoice ? balanceDue : grandTotal, currency))}
                </div>
                ${isInvoice && docData?.dueDate ? (
                  new Date(docData.dueDate) < new Date() && balanceDue > 0 ? `
                  <div style="margin-top:8px;">
                    <span style="display:inline-block; font-size:11px; font-weight:700; color:#b91c1c; background:#fee2e2; padding:3px 10px; border-radius:9999px;">
                      ⚠️ Payment Due: ${escapeHtml(formatDate(docData.dueDate))} (Overdue)
                    </span>
                  </div>
                ` : `
                  <div style="margin-top:6px; font-size:12px; color:#64748b;">
                    Payment Due by <strong>${escapeHtml(formatDate(docData.dueDate))}</strong>
                  </div>
                `) : (!isInvoice && docData?.expiryDate ? `
                  <div style="margin-top:6px; font-size:12px; color:#64748b;">
                    Valid until <strong>${escapeHtml(formatDate(docData.expiryDate))}</strong>
                  </div>
                ` : '')}
              </div>
            </td>
          </tr>

          <!-- Pay CTA Button -->
          ${payButtonBlock ? `
          <tr>
            <td style="padding:0 28px;">
              ${payButtonBlock}
            </td>
          </tr>` : ''}

          <!-- Bill To & Summary Grid -->
          <tr>
            <td style="padding:16px 28px 14px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="border-top:1px solid #f1f5f9; padding-top:16px;">
                <tr>
                  <td valign="top" width="55%" style="text-align:left; font-size:13px; line-height:1.5;">
                    <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#94a3b8; margin-bottom:4px;">
                      Billed To
                    </div>
                    <div style="font-size:14px; font-weight:700; color:#0f172a; margin-bottom:2px;">
                      ${escapeHtml(client?.name || 'Customer')}
                    </div>
                    ${client?.email ? `<div style="color:#475569;">${escapeHtml(client.email)}</div>` : ''}
                    ${client?.phone ? `<div style="color:#475569;">${escapeHtml(client.phone)}</div>` : ''}
                    ${address ? `<div style="color:#64748b; margin-top:3px;">${escapeHtml(address)}</div>` : ''}
                    ${client?.taxId ? `<div style="color:#64748b; margin-top:2px;">Tax ID: ${escapeHtml(client.taxId)}</div>` : ''}
                  </td>
                  <td valign="top" width="45%" style="text-align:right; font-size:12px; line-height:1.6;">
                    <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#94a3b8; margin-bottom:4px;">
                      ${escapeHtml(title)} Details
                    </div>
                    <div><span style="color:#64748b;">${escapeHtml(title)} #:</span> <strong style="color:#0f172a;">${escapeHtml(docNo)}</strong></div>
                    <div><span style="color:#64748b;">Issue Date:</span> <strong style="color:#0f172a;">${escapeHtml(formatDate(docData?.issueDate))}</strong></div>
                    ${docData?.dueDate ? `<div><span style="color:#64748b;">Due Date:</span> <strong style="color:#0f172a;">${escapeHtml(formatDate(docData.dueDate))}</strong></div>` : ''}
                    ${docData?.status ? `<div><span style="color:#64748b;">Status:</span> <strong style="color:#0f172a;">${escapeHtml(docData.status)}</strong></div>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Items Table -->
          <tr>
            <td style="padding:8px 28px 16px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse; width:100%; border:1px solid #f1f5f9; border-radius:8px; overflow:hidden;">
                <thead>
                  <tr style="background:#f8fafc;">
                    <th style="padding:10px 12px; font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; text-align:left; border-bottom:1px solid #e2e8f0;">Item / Description</th>
                    <th style="padding:10px 12px; font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; text-align:center; border-bottom:1px solid #e2e8f0;">Qty</th>
                    <th style="padding:10px 12px; font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; text-align:right; border-bottom:1px solid #e2e8f0;">Rate</th>
                    <th style="padding:10px 12px; font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; text-align:right; border-bottom:1px solid #e2e8f0;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${lineItemRowsHtml}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Totals Section -->
          <tr>
            <td style="padding:0 28px 20px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="35%">&nbsp;</td>
                  <td width="65%">
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="font-size:13px; line-height:1.8;">
                      <tr>
                        <td style="color:#64748b; text-align:left;">Subtotal</td>
                        <td style="color:#0f172a; text-align:right; font-weight:600;">${escapeHtml(formatMoney(subtotal, currency))}</td>
                      </tr>
                      ${discountAmount > 0 ? `
                      <tr>
                        <td style="color:#0284c7; text-align:left;">Discount ${discountType === 'percentage' && discountValue ? `(${discountValue}%)` : ''}</td>
                        <td style="color:#0284c7; text-align:right; font-weight:600;">-${escapeHtml(formatMoney(discountAmount, currency))}</td>
                      </tr>` : ''}
                      ${taxTotal > 0 ? `
                      <tr>
                        <td style="color:#64748b; text-align:left;">Tax Total</td>
                        <td style="color:#0f172a; text-align:right; font-weight:600;">${escapeHtml(formatMoney(taxTotal, currency))}</td>
                      </tr>` : ''}
                      <tr style="border-top:1px solid #e2e8f0;">
                        <td style="color:#0f172a; text-align:left; font-size:14px; font-weight:700; padding-top:6px;">Total Amount</td>
                        <td style="color:#0f172a; text-align:right; font-size:14px; font-weight:800; padding-top:6px;">${escapeHtml(formatMoney(grandTotal, currency))}</td>
                      </tr>
                      ${isInvoice && amountPaid > 0 ? `
                      <tr>
                        <td style="color:#059669; text-align:left;">Amount Paid</td>
                        <td style="color:#059669; text-align:right; font-weight:600;">-${escapeHtml(formatMoney(amountPaid, currency))}</td>
                      </tr>` : ''}
                      ${isInvoice && creditAmount > 0 ? `
                      <tr>
                        <td style="color:#0284c7; text-align:left;">Credits Allocated</td>
                        <td style="color:#0284c7; text-align:right; font-weight:600;">-${escapeHtml(formatMoney(creditAmount, currency))}</td>
                      </tr>` : ''}
                      ${isInvoice ? `
                      <tr style="border-top:2px solid #0f172a;">
                        <td style="color:#0f172a; text-align:left; font-size:15px; font-weight:800; padding-top:8px;">Balance Due</td>
                        <td style="color:${balanceDue > 0 ? '#2563eb' : '#059669'}; text-align:right; font-size:16px; font-weight:800; padding-top:8px;">${escapeHtml(formatMoney(balanceDue, currency))}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Notes / Bank Details -->
          ${notesHtml || bankHtml ? `
          <tr>
            <td style="padding:0 28px 20px;">
              ${notesHtml}
              ${bankHtml}
            </td>
          </tr>` : ''}

          <!-- Footer -->
          <tr>
            <td style="padding:20px 28px; background:#f8fafc; border-top:1px solid #e2e8f0; text-align:center; font-size:12px; color:#64748b; line-height:1.6;">
              <div style="font-weight:700; color:#334155; margin-bottom:4px;">
                Thank you for your business!
              </div>
              ${portalUrl ? `
              <div style="margin-bottom:8px; font-size:13px;">
                <a href="${escapeHtml(portalUrl)}" target="_blank" style="color:#2563eb; font-weight:600; text-decoration:underline;">🔗 Open Proposal in Client Portal</a>
              </div>` : ''}
              <div>
                ${company?.name ? `${escapeHtml(company.name)}` : ''}
                ${company?.email ? ` · <a href="mailto:${escapeHtml(company.email)}" style="color:#2563eb; text-decoration:none;">${escapeHtml(company.email)}</a>` : ''}
                ${company?.phone ? ` · ${escapeHtml(company.phone)}` : ''}
              </div>
              <div style="margin-top:6px; font-size:11px; color:#94a3b8;">
                Powered by Root CRM
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  renderFinancePrintHtml,
  renderFinanceEmailHtml,
  escapeHtml,
  formatDate,
  formatMoney
};
