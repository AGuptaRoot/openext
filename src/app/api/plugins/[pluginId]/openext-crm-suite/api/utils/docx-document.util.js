'use strict';

/**
 * Structured documents written as Word (.docx): the same description as pdf-document.util
 * ({ title, reference, meta, blocks: rows | text | table, footer }) so a report can be offered as
 * PDF and as an editable Word file from one builder. Dependency-free (stored zip + WordprocessingML).
 */

const { normalizeDocument } = require('./pdf-document.util');
const { writeStoredZip } = require('./zip-reader.util');

const xml = (v) =>
  String(v ?? '')
    // Characters XML 1.0 does not allow.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function run(text, { bold = false, size = 20, color = '1F2937' } = {}) {
  const props = `<w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  // Line breaks inside a value stay line breaks.
  return String(text ?? '')
    .split('\n')
    .map((line, i) => `${i ? '<w:r><w:br/></w:r>' : ''}<w:r>${props}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`)
    .join('');
}

function paragraph(content, { align = '', after = 80 } = {}) {
  const jc = align ? `<w:jc w:val="${align}"/>` : '';
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}"/>${jc}</w:pPr>${content}</w:p>`;
}

function cell(content, widthTwips, { shade = '' } = {}) {
  const fill = shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/>${fill}</w:tcPr>${paragraph(content, { after: 0 })}</w:tc>`;
}

function table(columns, rows, totalWidth) {
  const width = Math.floor(totalWidth / columns.length);
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>`)
    .join('');
  const grid = columns.map(() => `<w:gridCol w:w="${width}"/>`).join('');
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${columns.map((c) => cell(run(c, { bold: true, size: 17, color: '374151' }), width, { shade: 'F3F4F6' })).join('')}</w:tr>`;
  const body = rows.map((r) => `<w:tr>${columns.map((_, i) => cell(run(r[i] || '', { size: 17 }), width)).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${head}${body}</w:tbl>`;
}

function labelValueTable(rows, totalWidth) {
  const labelW = 2600;
  const valueW = totalWidth - labelW;
  const body = rows
    .map((r) => `<w:tr>${cell(run(r.label, { bold: true, size: 18, color: '6B7280' }), labelW)}${cell(run(r.value || '-', { size: 19 }), valueW)}</w:tr>`)
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${labelW}"/><w:gridCol w:w="${valueW}"/></w:tblGrid>${body}</w:tbl>`;
}

/**
 * @param {object} rawDoc  see pdf-document.util
 * @param {{ name?: string, address?: string, phone?: string, email?: string }} company
 * @returns {Buffer} a .docx file
 */
function renderDocumentDocx(rawDoc, company = {}) {
  const doc = normalizeDocument(rawDoc);
  // A4 with 0.75in margins: 11906 - 2 * 1080 twips of text width.
  const textWidth = 11906 - 2 * 1080;
  const parts = [];

  if (company.name) parts.push(paragraph(run(company.name, { bold: true, size: 24 }), { after: 0 }));
  const contact = [company.address, [company.phone, company.email].filter(Boolean).join('  |  ')].filter(Boolean);
  contact.forEach((line) => parts.push(paragraph(run(line, { size: 16, color: '6B7280' }), { after: 0 })));
  parts.push(paragraph(run(doc.title, { bold: true, size: 32, color: '111827' }), { after: 40 }));
  if (doc.reference) parts.push(paragraph(run(doc.reference, { size: 18, color: '6B7280' }), { after: 200 }));
  if (doc.meta.length) {
    parts.push(labelValueTable(doc.meta, textWidth));
    parts.push(paragraph('', { after: 120 }));
  }

  for (const block of doc.blocks) {
    if (block.heading) parts.push(paragraph(run(block.heading.toUpperCase(), { bold: true, size: 19, color: '2563EB' }), { after: 80 }));
    if (block.rows) parts.push(labelValueTable(block.rows, textWidth));
    else if (block.table) parts.push(table(block.table.columns, block.table.rows, textWidth));
    else if (block.text) parts.push(paragraph(run(block.text, { size: 19 })));
    parts.push(paragraph('', { after: 160 }));
  }
  if (doc.footer) parts.push(paragraph(run(doc.footer, { size: 15, color: '6B7280' })));

  const body = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  return writeStoredZip([
    {
      path: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    },
    {
      path: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    },
    { path: 'word/document.xml', data: body }
  ]);
}

module.exports = { renderDocumentDocx };
