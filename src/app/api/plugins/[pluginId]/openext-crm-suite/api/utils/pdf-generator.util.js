'use strict';

/**
 * Lightweight, zero-dependency PDF 1.4 document generator for CRM invoices and quotations.
 * Generates standards-compliant, vector-accurate PDF files supported natively in all PDF viewers.
 */

function escapePdfText(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function sanitizeAscii(text) {
  if (text == null) return '';
  return String(text)
    .replace(/₹/g, 'INR ')
    // Common typographic characters the built-in Helvetica cannot show.
    .replace(/×/g, 'x')
    .replace(/[·•–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\n\r\t]/g, ' ');
}

class PdfBuilder {
  constructor() {
    this.width = 595.28; // A4 width (points)
    this.height = 841.89; // A4 height (points)
    this.commands = [];
    /** One command list per page; `commands` is always the current page's. */
    this.pages = [this.commands];
    this.currentFont = 'F1';
    this.currentFontSize = 10;
  }

  // Color operations (RGB in range 0.0 - 1.0)
  setFillColor(r, g, b) {
    this.commands.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
  }

  setStrokeColor(r, g, b) {
    this.commands.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
  }

  setLineWidth(w) {
    this.commands.push(`${Number(w).toFixed(2)} w`);
  }

  // Shapes
  rect(x, y, w, h, fill = false, stroke = true) {
    // PDF coordinate system: origin (0,0) at bottom-left
    const pdfY = this.height - y - h;
    let op = 'S';
    if (fill && stroke) op = 'B';
    else if (fill) op = 'f';
    else if (stroke) op = 'S';
    this.commands.push(`${x.toFixed(2)} ${pdfY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${op}`);
  }

  roundedRect(x, y, w, h, fill = true, stroke = false) {
    this.rect(x, y, w, h, fill, stroke);
  }

  line(x1, y1, x2, y2) {
    const py1 = this.height - y1;
    const py2 = this.height - y2;
    this.commands.push(`${x1.toFixed(2)} ${py1.toFixed(2)} m ${x2.toFixed(2)} ${py2.toFixed(2)} l S`);
  }

  // Text
  setFont(fontName, size) {
    this.currentFont = fontName === 'bold' ? 'F2' : (fontName === 'italic' ? 'F3' : 'F1');
    this.currentFontSize = size;
  }

  drawText(text, x, y, options = {}) {
    const safeText = escapePdfText(sanitizeAscii(text));
    const size = options.size || this.currentFontSize;
    const font = options.font ? (options.font === 'bold' ? 'F2' : 'F1') : this.currentFont;
    const pdfY = this.height - y;

    this.commands.push('BT');
    this.commands.push(`/${font} ${size} Tf`);
    if (options.color) {
      const [r, g, b] = options.color;
      this.commands.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    }
    this.commands.push(`${x.toFixed(2)} ${pdfY.toFixed(2)} Td`);
    this.commands.push(`(${safeText}) Tj`);
    this.commands.push('ET');
  }

  drawTextRight(text, rightX, y, options = {}) {
    const safe = sanitizeAscii(text);
    const size = options.size || this.currentFontSize;
    const widthFactor = (options.font === 'bold' ? 0.58 : 0.52) * size;
    const approxWidth = safe.length * widthFactor;
    const x = Math.max(0, rightX - approxWidth);
    this.drawText(safe, x, y, options);
  }

  drawTextCenter(text, centerX, y, options = {}) {
    const safe = sanitizeAscii(text);
    const size = options.size || this.currentFontSize;
    const widthFactor = (options.font === 'bold' ? 0.58 : 0.52) * size;
    const approxWidth = safe.length * widthFactor;
    const x = Math.max(0, centerX - (approxWidth / 2));
    this.drawText(safe, x, y, options);
  }

  /** Starts a new page; drawing continues on it. */
  addPage() {
    this.commands = [];
    this.pages.push(this.commands);
  }

  /** Splits text into lines that fit maxWidth (approximate Helvetica widths); keeps the text's own line breaks. */
  wrapText(text, maxWidth, options = {}) {
    const size = options.size || this.currentFontSize;
    const widthFactor = (options.font === 'bold' ? 0.58 : 0.52) * size;
    const maxChars = Math.max(10, Math.floor(maxWidth / widthFactor));
    const lines = [];
    for (const paragraph of sanitizeAscii(text).replace(/\r/g, '').split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        let rest = word;
        while (rest.length > maxChars) {
          if (line) { lines.push(line); line = ''; }
          lines.push(rest.slice(0, maxChars));
          rest = rest.slice(maxChars);
        }
        if (!line) line = rest;
        else if ((line + ' ' + rest).length <= maxChars) line += ' ' + rest;
        else { lines.push(line); line = rest; }
      }
      lines.push(line);
    }
    return lines;
  }

  build() {
    const objects = [];
    const addObject = (body) => {
      objects.push(body);
      return objects.length;
    };

    // Object 1: Catalog
    addObject('<< /Type /Catalog /Pages 2 0 R >>');

    // Object 2: Pages; 3 and 4: the shared fonts (Helvetica, Helvetica-Bold); then a page + content stream per page.
    const pageIds = this.pages.map((_, i) => 5 + i * 2);
    addObject(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

    this.pages.forEach((commands, i) => {
      const contentStream = commands.join('\n');
      const streamLength = Buffer.byteLength(contentStream, 'utf8');
      addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
      addObject(`<< /Length ${streamLength} >>\nstream\n${contentStream}\nendstream`);
    });

    let output = '%PDF-1.4\n';
    const xrefOffsets = [0];

    for (let i = 0; i < objects.length; i++) {
      xrefOffsets.push(Buffer.byteLength(output, 'utf8'));
      output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }

    const startXref = Buffer.byteLength(output, 'utf8');
    output += `xref\n0 ${objects.length + 1}\n`;
    output += '0000000000 65535 f \n';

    for (let i = 1; i <= objects.length; i++) {
      const offset = String(xrefOffsets[i]).padStart(10, '0');
      output += `${offset} 00000 n \n`;
    }

    output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;

    return Buffer.from(output, 'utf8');
  }
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('en-IN');
  } catch {
    return String(value);
  }
}

/**
 * Generate a clean, styled invoice or quotation PDF document.
 * 
 * @param {Object} payload Document payload containing type, company, client, and document fields.
 * @returns {Buffer} PDF binary buffer.
 */
function generateFinanceDocumentPdf(payload) {
  // The active extension's service invoice (salesFlow.invoicePrint): drawn by service-invoice-pdf.util.
  if (payload && payload.type === 'invoice' && payload.servicePrint) {
    return require('./service-invoice-pdf.util').renderServiceInvoicePdf(payload);
  }
  const { type, company, client, document: docData } = payload;
  const isInvoice = type === 'invoice';
  const title = isInvoice ? 'INVOICE' : 'QUOTATION';
  const docNo = isInvoice ? (docData?.invoiceNo || '—') : (docData?.quotationNo || '—');
  const currency = docData?.currency || company?.currency || 'INR';

  const pdf = new PdfBuilder();

  // Top header background bar
  pdf.setFillColor(0.96, 0.97, 0.98); // Light gray
  pdf.rect(36, 36, 523, 76, true, false);

  // Company details
  pdf.drawText(company?.name || 'Root CRM', 52, 60, { font: 'bold', size: 16, color: [0.06, 0.09, 0.16] });
  if (company?.email) {
    pdf.drawText(company.email, 52, 76, { font: 'regular', size: 9, color: [0.4, 0.45, 0.55] });
  }
  if (company?.phone) {
    pdf.drawText(company.phone, 52, 88, { font: 'regular', size: 9, color: [0.4, 0.45, 0.55] });
  }

  // Document Badge & Number
  pdf.setFillColor(isInvoice ? 0.15 : 0.02, isInvoice ? 0.39 : 0.59, isInvoice ? 0.92 : 0.41);
  pdf.roundedRect(440, 48, 104, 22, true, false);
  pdf.drawTextCenter(title, 492, 62, { font: 'bold', size: 10, color: [1, 1, 1] });

  pdf.drawTextRight(`#${docNo}`, 544, 86, { font: 'bold', size: 12, color: [0.2, 0.25, 0.35] });

  // Bill To & Summary Section
  let yPos = 130;
  pdf.setFillColor(0.97, 0.98, 0.99);
  pdf.rect(36, yPos, 255, 90, true, false);
  pdf.rect(304, yPos, 255, 90, true, false);

  // Bill To Box
  pdf.drawText('BILLED TO', 48, yPos + 18, { font: 'bold', size: 8, color: [0.4, 0.45, 0.55] });
  pdf.drawText(client?.name || 'Customer', 48, yPos + 34, { font: 'bold', size: 11, color: [0.06, 0.09, 0.16] });
  if (client?.email) {
    pdf.drawText(client.email, 48, yPos + 48, { font: 'regular', size: 9, color: [0.3, 0.35, 0.45] });
  }
  if (client?.phone) {
    pdf.drawText(client.phone, 48, yPos + 60, { font: 'regular', size: 9, color: [0.3, 0.35, 0.45] });
  }
  if (client?.taxId) {
    pdf.drawText(`Tax ID: ${client.taxId}`, 48, yPos + 72, { font: 'regular', size: 8, color: [0.4, 0.45, 0.55] });
  }

  // Meta Box
  pdf.drawText('DOCUMENT DETAILS', 316, yPos + 18, { font: 'bold', size: 8, color: [0.4, 0.45, 0.55] });
  pdf.drawText(`Issue Date: ${formatDate(docData?.issueDate)}`, 316, yPos + 34, { font: 'regular', size: 9, color: [0.2, 0.25, 0.35] });
  if (docData?.dueDate) {
    pdf.drawText(`Due Date: ${formatDate(docData.dueDate)}`, 316, yPos + 48, { font: 'bold', size: 9, color: [0.06, 0.09, 0.16] });
  } else if (docData?.expiryDate) {
    pdf.drawText(`Valid Until: ${formatDate(docData.expiryDate)}`, 316, yPos + 48, { font: 'bold', size: 9, color: [0.06, 0.09, 0.16] });
  }
  pdf.drawText(`Status: ${docData?.status || 'Open'}`, 316, yPos + 62, { font: 'regular', size: 9, color: [0.2, 0.25, 0.35] });
  pdf.drawText(`Currency: ${currency}`, 316, yPos + 74, { font: 'regular', size: 9, color: [0.2, 0.25, 0.35] });

  // Items Table Header
  yPos = 240;
  pdf.setFillColor(0.06, 0.09, 0.16); // Dark header
  pdf.rect(36, yPos, 523, 22, true, false);

  pdf.drawText('ITEM / DESCRIPTION', 48, yPos + 15, { font: 'bold', size: 8, color: [1, 1, 1] });
  pdf.drawTextCenter('QTY', 340, yPos + 15, { font: 'bold', size: 8, color: [1, 1, 1] });
  pdf.drawTextRight('UNIT RATE', 440, yPos + 15, { font: 'bold', size: 8, color: [1, 1, 1] });
  pdf.drawTextRight('AMOUNT', 544, yPos + 15, { font: 'bold', size: 8, color: [1, 1, 1] });

  // Items Table Rows
  yPos += 22;
  const lineItems = Array.isArray(docData?.lineItems) ? docData.lineItems : [];
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const isEven = i % 2 === 0;
    if (isEven) {
      pdf.setFillColor(0.98, 0.99, 1.0);
      pdf.rect(36, yPos, 523, 22, true, false);
    }
    pdf.setStrokeColor(0.92, 0.94, 0.96);
    pdf.line(36, yPos + 22, 559, yPos + 22);

    const name = item.name || item.description || 'Item';
    const qty = String(item.qty ?? 1);
    const rate = Number(item.rate || 0).toFixed(2);
    const amount = Number(item.amount || (Number(qty) * Number(rate))).toFixed(2);

    if (item.printNote) {
      pdf.drawText(name.slice(0, 45), 48, yPos + 10, { font: 'bold', size: 8.5, color: [0.1, 0.15, 0.2] });
      pdf.drawText(String(item.printNote).slice(0, 70), 48, yPos + 19, { font: 'regular', size: 6.5, color: [0.4, 0.45, 0.55] });
    } else {
      pdf.drawText(name.slice(0, 45), 48, yPos + 14, { font: 'bold', size: 8.5, color: [0.1, 0.15, 0.2] });
    }
    pdf.drawTextCenter(qty, 340, yPos + 14, { font: 'regular', size: 8.5, color: [0.2, 0.25, 0.35] });
    pdf.drawTextRight(rate, 440, yPos + 14, { font: 'regular', size: 8.5, color: [0.2, 0.25, 0.35] });
    pdf.drawTextRight(amount, 544, yPos + 14, { font: 'bold', size: 8.5, color: [0.06, 0.09, 0.16] });

    yPos += 22;
    if (yPos > 650) break;
  }

  // Totals Box
  yPos += 14;
  const totalsX = 330;
  const subtotal = Number(docData?.subtotal || 0).toFixed(2);
  const discountAmount = Number(docData?.discountAmount || 0);
  const discountValue = Number(docData?.discountValue || 0);
  const discountType = docData?.discountType || 'flat';
  const taxTotal = Number(docData?.taxTotal || 0).toFixed(2);
  const grandTotal = Number(docData?.grandTotal || 0).toFixed(2);
  const amountPaid = Number(docData?.amountPaid || 0).toFixed(2);
  const creditAmount = Number(docData?.creditAmount || 0).toFixed(2);
  const balanceDue = Number(docData?.balanceDue != null ? docData.balanceDue : grandTotal).toFixed(2);

  pdf.drawText('Subtotal:', totalsX, yPos, { font: 'regular', size: 9, color: [0.4, 0.45, 0.55] });
  pdf.drawTextRight(`${currency} ${subtotal}`, 544, yPos, { font: 'bold', size: 9, color: [0.1, 0.15, 0.2] });
  yPos += 16;

  if (discountAmount > 0) {
    const discountLabel = discountType === 'percentage' && discountValue > 0 ? `Discount (${discountValue}%):` : 'Discount:';
    pdf.drawText(discountLabel, totalsX, yPos, { font: 'regular', size: 9, color: [0.01, 0.52, 0.78] });
    pdf.drawTextRight(`- ${currency} ${discountAmount.toFixed(2)}`, 544, yPos, { font: 'bold', size: 9, color: [0.01, 0.52, 0.78] });
    yPos += 16;
  }

  if (Number(taxTotal) > 0) {
    pdf.drawText('Tax Total:', totalsX, yPos, { font: 'regular', size: 9, color: [0.4, 0.45, 0.55] });
    pdf.drawTextRight(`${currency} ${taxTotal}`, 544, yPos, { font: 'bold', size: 9, color: [0.1, 0.15, 0.2] });
    yPos += 16;
  }

  pdf.setStrokeColor(0.85, 0.88, 0.92);
  pdf.line(totalsX, yPos - 4, 559, yPos - 4);

  pdf.drawText('Total Amount:', totalsX, yPos + 6, { font: 'bold', size: 10, color: [0.06, 0.09, 0.16] });
  pdf.drawTextRight(`${currency} ${grandTotal}`, 544, yPos + 6, { font: 'bold', size: 10, color: [0.06, 0.09, 0.16] });
  yPos += 20;

  if (isInvoice && Number(amountPaid) > 0) {
    pdf.drawText('Amount Paid:', totalsX, yPos, { font: 'regular', size: 9, color: [0.02, 0.59, 0.41] });
    pdf.drawTextRight(`- ${currency} ${amountPaid}`, 544, yPos, { font: 'bold', size: 9, color: [0.02, 0.59, 0.41] });
    yPos += 16;
  }

  if (isInvoice && Number(creditAmount) > 0) {
    pdf.drawText('Credits Allocated:', totalsX, yPos, { font: 'regular', size: 9, color: [0.01, 0.52, 0.78] });
    pdf.drawTextRight(`- ${currency} ${creditAmount}`, 544, yPos, { font: 'bold', size: 9, color: [0.01, 0.52, 0.78] });
    yPos += 16;
  }

  if (isInvoice) {
    pdf.setFillColor(0.93, 0.96, 1.0);
    pdf.rect(totalsX - 6, yPos - 4, 235, 24, true, false);
    pdf.drawText('Balance Due:', totalsX, yPos + 12, { font: 'bold', size: 11, color: [0.06, 0.09, 0.16] });
    pdf.drawTextRight(`${currency} ${balanceDue}`, 544, yPos + 12, { font: 'bold', size: 11, color: [0.15, 0.39, 0.92] });
    yPos += 28;
  }

  // Notes / Terms Callout
  if (docData?.notes || docData?.paymentDetails) {
    yPos = Math.max(yPos + 10, 520);
    pdf.setFillColor(0.97, 0.98, 0.99);
    pdf.rect(36, yPos, 523, 46, true, false);
    pdf.drawText('NOTES & PAYMENT INSTRUCTIONS', 48, yPos + 14, { font: 'bold', size: 7.5, color: [0.4, 0.45, 0.55] });
    const noteText = String(docData.notes || docData.paymentDetails || '').slice(0, 140);
    pdf.drawText(noteText, 48, yPos + 28, { font: 'regular', size: 8, color: [0.2, 0.25, 0.35] });
  }

  drawFooter(pdf);

  // Titled sections (inclusions, cancellation policy, ...) on their own page(s)
  const sections = Array.isArray(docData?.sections)
    ? docData.sections.filter((s) => s && String(s.title || '').trim() && String(s.body || '').trim())
    : [];
  if (sections.length) {
    const startPage = () => {
      pdf.addPage();
      pdf.drawText(`${title} ${docNo} - TERMS & DETAILS`, 36, 56, { font: 'bold', size: 11, color: [0.06, 0.09, 0.16] });
      pdf.setStrokeColor(0.9, 0.92, 0.95);
      pdf.line(36, 66, 559, 66);
      return 92;
    };
    let y = startPage();
    const bottom = 760;
    for (const section of sections) {
      if (y + 40 > bottom) {
        drawFooter(pdf);
        y = startPage();
      }
      pdf.drawText(String(section.title).toUpperCase(), 36, y, { font: 'bold', size: 9, color: [0.15, 0.39, 0.92] });
      y += 16;
      for (const line of pdf.wrapText(String(section.body), 523, { size: 9 })) {
        if (y > bottom) {
          drawFooter(pdf);
          y = startPage();
        }
        if (line) pdf.drawText(line, 36, y, { font: 'regular', size: 9, color: [0.2, 0.25, 0.35] });
        y += 13;
      }
      y += 14;
    }
    drawFooter(pdf);
  }

  return pdf.build();
}

function drawFooter(pdf) {
  pdf.setStrokeColor(0.9, 0.92, 0.95);
  pdf.line(36, 780, 559, 780);
  pdf.drawTextCenter('Thank you for your business! · Generated by Root CRM', 297, 796, { font: 'regular', size: 8, color: [0.5, 0.55, 0.65] });
  if (pdf.pages.length > 1) {
    pdf.drawTextRight(`Page ${pdf.pages.length}`, 559, 796, { font: 'regular', size: 8, color: [0.5, 0.55, 0.65] });
  }
}

module.exports = {
  PdfBuilder,
  generateFinanceDocumentPdf
};
