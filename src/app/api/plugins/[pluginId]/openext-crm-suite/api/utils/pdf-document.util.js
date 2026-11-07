'use strict';

/**
 * Structured documents drawn as PDF (extension SDK `documents.pdf`, e.g. vouchers and itineraries;
 * also the CRM's service-invoice layout, see service-invoice-pdf.util.js).
 *
 * doc = {
 *   title, reference, meta: [{ label, value }],
 *   blocks: [ ...blocks below ],
 *   footer, watermark: 'CANCELLED' | 'SUPERSEDED' | 'DRAFT',
 *   layout?: 'branded',          the branded layout (implied by any block with a `type`)
 *   date?: 'Issued 12 Jun 2027'  small line under the reference (branded layout only)
 * }
 *
 * Plain blocks (no `type`):
 *   { heading, rows: [{ label, value }] } | { heading, text } | { heading, table: { columns, rows: [[cell]] } }
 * A document with plain blocks only (and no layout: 'branded') is drawn exactly as before.
 *
 * Branded layout: clean white A4, company header (monogram, name, contact line; title,
 * reference and date on the right), section headings with a hairline, the watermark under the content
 * and on every page a footer with the footer text and "Page X of Y". `meta` is shown as a facts grid,
 * plain blocks in the same style. Typed blocks (empty values, items and blocks are left out):
 *   { type: 'hero', eyebrow?, title, subtitle?, badge?: { text, tone } }       large title with a status pill
 *   { type: 'facts', heading?, columns?: 2|3|4, items: [{ label, value }] }   label / value grid on a soft panel
 *   { type: 'parties', items: [{ heading, title, lines: [text] }] }           up to 3 cards side by side
 *   { type: 'days', heading?, days: [{ label, date?, title?, empty?, items: [{ time?, title, detail?, tag? }] }] }
 *                                                                             day-wise plan ("Day 1", time, activity)
 *   { type: 'table', heading?, columns: [{ label, align?: 'left'|'right', width? }], rows: [{ cells: [..], note? } | [..]] }
 *   { type: 'totals', heading?, rows: [{ label, value, strong?, tone?, divider? }] }  right-aligned amounts
 *   { type: 'rows', heading?, rows: [{ label, value }] }
 *   { type: 'text', heading?, text }
 *   { type: 'list', heading?, items: [text] }                                 bullet list
 *   { type: 'note', heading?, text, tone? }                                   tinted call-out
 *   { type: 'contact', heading?, text? }                                      the workspace's phone and email (address when neither)
 * tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral'.
 *
 * Uses the same A4 PdfBuilder as quotations (built-in Helvetica, ASCII only; common symbols are mapped:
 * "→" prints "->", "₹" "INR", curly quotes and dashes their ASCII forms). No images, no external files.
 */

const { PdfBuilder } = require('./pdf-generator.util');

const LEFT = 36;
const RIGHT = 559;
const WIDTH = RIGHT - LEFT;
const BOTTOM = 770;
const LIMITS = { meta: 20, blocks: 40, rows: 60, columns: 6, tableRows: 100, text: 4000, cell: 300 };
const TYPED = { facts: 30, parties: 3, partyLines: 8, days: 60, dayItems: 30, totals: 20, list: 100 };
const TYPES = ['hero', 'facts', 'parties', 'days', 'table', 'totals', 'rows', 'text', 'list', 'note', 'contact'];
const TONES = ['success', 'info', 'warning', 'danger', 'neutral'];

const s = (v, max = 300) => (v === null || v === undefined ? '' : String(v)).replace(/\r\n/g, '\n').trim().slice(0, max);

function badDoc(message) {
  const error = new Error(`documents.pdf: ${message}`);
  error.status = 400;
  error.code = 'INVALID_DOCUMENT';
  return error;
}

function listOf(value, max, where) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badDoc(`${where} must be a list`);
  if (value.length > max) throw badDoc(`${where} has more than ${max} entries`);
  return value;
}

const pairs = (list, max, where) =>
  listOf(list, max, where)
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({ label: s(p.label, 60), value: s(p.value, 600) }))
    .filter((p) => p.label || p.value);

const toneOf = (v, fallback = 'neutral') => (TONES.includes(v) ? v : fallback);

/** One typed block, checked and trimmed; null when it has nothing to show. */
function normalizeTyped(b) {
  const type = String(b.type);
  if (!TYPES.includes(type)) throw badDoc(`unknown block type "${type.slice(0, 20)}"`);
  const heading = s(b.heading, 100);
  const where = `${type} block`;
  if (type === 'hero') {
    const title = s(b.title, 120);
    if (!title) return null;
    const badge = b.badge && typeof b.badge === 'object' && s(b.badge.text, 24) ? { text: s(b.badge.text, 24), tone: toneOf(b.badge.tone) } : null;
    return { type, eyebrow: s(b.eyebrow, 40), title, subtitle: s(b.subtitle, 200), badge };
  }
  if (type === 'facts') {
    const items = listOf(b.items, TYPED.facts, `${where} items`)
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({ label: s(p.label, 60), value: s(p.value, 300) }))
      .filter((p) => p.value);
    const columns = [2, 3, 4].includes(Number(b.columns)) ? Number(b.columns) : 3;
    return items.length ? { type, heading, columns, items } : null;
  }
  if (type === 'parties') {
    const items = listOf(b.items, TYPED.parties, `${where} items`)
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        heading: s(p.heading, 40),
        title: s(p.title, 120),
        lines: listOf(p.lines, TYPED.partyLines, `${where} lines`).map((l) => s(l, 160)).filter(Boolean)
      }))
      .filter((p) => p.title || p.lines.length);
    return items.length ? { type, items } : null;
  }
  if (type === 'days') {
    const days = listOf(b.days, TYPED.days, `${where} days`)
      .filter((d) => d && typeof d === 'object')
      .map((d, i) => ({
        label: s(d.label, 20) || `Day ${i + 1}`,
        date: s(d.date, 40),
        title: s(d.title, 120),
        empty: s(d.empty, 120),
        items: listOf(d.items, TYPED.dayItems, `${where} items`)
          .filter((it) => it && typeof it === 'object')
          .map((it) => ({ time: s(it.time, 12), title: s(it.title, 160), detail: s(it.detail, 600), tag: s(it.tag, 16) }))
          .filter((it) => it.title)
      }));
    return days.length ? { type, heading, days } : null;
  }
  if (type === 'table') {
    const columns = listOf(b.columns, LIMITS.columns, `${where} columns`)
      .map((c) => (c && typeof c === 'object' ? c : { label: c }))
      .map((c) => ({
        label: s(c.label, 40),
        align: c.align === 'right' ? 'right' : 'left',
        width: Number.isFinite(Number(c.width)) && Number(c.width) > 0 ? Math.min(100, Number(c.width)) : 1
      }));
    if (!columns.length) throw badDoc('a table needs columns');
    const rows = listOf(b.rows, LIMITS.tableRows, `${where} rows`).map((r) => {
      const cells = Array.isArray(r) ? r : r && typeof r === 'object' && Array.isArray(r.cells) ? r.cells : [];
      return { cells: columns.map((_, i) => s(cells[i], LIMITS.cell)), note: Array.isArray(r) ? '' : s(r && r.note, LIMITS.cell) };
    });
    return rows.length ? { type, heading, columns, rows } : null;
  }
  if (type === 'totals') {
    const rows = listOf(b.rows, TYPED.totals, `${where} rows`)
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ label: s(r.label, 60), value: s(r.value, 40), strong: r.strong === true, divider: r.divider === true, tone: TONES.includes(r.tone) ? r.tone : '' }))
      .filter((r) => r.label && r.value);
    return rows.length ? { type, heading, rows } : null;
  }
  if (type === 'rows') {
    const rows = pairs(b.rows, LIMITS.rows, `${where} rows`).filter((p) => p.value);
    return rows.length ? { type, heading, rows } : null;
  }
  if (type === 'list') {
    const items = listOf(b.items, TYPED.list, `${where} items`).map((t) => s(t, 600)).filter(Boolean);
    return items.length ? { type, heading, items } : null;
  }
  if (type === 'note') {
    const text = s(b.text, 1000);
    return text ? { type, heading, text, tone: toneOf(b.tone, 'info') } : null;
  }
  if (type === 'contact') return { type, heading, text: s(b.text, 300) };
  const text = s(b.text, LIMITS.text); // 'text'
  return text ? { type, heading, text } : null;
}

/** Checks and trims the document description (throws 400 on a wrong shape). */
function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badDoc('a document object is required');
  const title = s(raw.title, 80);
  if (!title) throw badDoc('title is required');
  const blocks = [];
  if (raw.blocks !== undefined && !Array.isArray(raw.blocks)) throw badDoc('blocks must be a list');
  if ((raw.blocks || []).length > LIMITS.blocks) throw badDoc(`more than ${LIMITS.blocks} blocks`);
  let typed = false;
  for (const b of raw.blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type !== undefined) {
      typed = true;
      const block = normalizeTyped(b);
      if (block) blocks.push(block);
      continue;
    }
    const heading = s(b.heading, 100);
    if (b.table) {
      const columns = Array.isArray(b.table.columns) ? b.table.columns.map((c) => s(c, 40)).slice(0, LIMITS.columns) : [];
      if (!columns.length) throw badDoc('a table needs columns');
      const rows = Array.isArray(b.table.rows) ? b.table.rows.slice(0, LIMITS.tableRows) : [];
      blocks.push({ heading, table: { columns, rows: rows.map((r) => columns.map((_, i) => s(Array.isArray(r) ? r[i] : '', LIMITS.cell))) } });
    } else if (b.rows) {
      blocks.push({ heading, rows: pairs(b.rows, LIMITS.rows, 'block rows') });
    } else {
      blocks.push({ heading, text: s(b.text, LIMITS.text) });
    }
  }
  const watermark = ['CANCELLED', 'SUPERSEDED', 'DRAFT'].includes(String(raw.watermark || '').toUpperCase())
    ? String(raw.watermark).toUpperCase()
    : '';
  return {
    title,
    reference: s(raw.reference, 60),
    meta: pairs(raw.meta, LIMITS.meta, 'meta'),
    blocks,
    footer: s(raw.footer, 300),
    watermark,
    layout: typed || raw.layout === 'branded' ? 'branded' : '',
    date: s(raw.date, 60)
  };
}

/**
 * @param {object} rawDoc  see the header comment
 * @param {{ name?: string, address?: string, phone?: string, email?: string }} company
 * @returns {Buffer}
 */
function renderDocumentPdf(rawDoc, company = {}) {
  const doc = normalizeDocument(rawDoc);
  if (doc.layout === 'branded') return renderBranded(doc, company);
  const pdf = new PdfBuilder();
  const ink = [0.06, 0.09, 0.16];
  const soft = [0.4, 0.45, 0.55];
  const body = [0.2, 0.25, 0.35];
  let y = 0;

  const footer = () => {
    pdf.setStrokeColor(0.9, 0.92, 0.95);
    pdf.line(LEFT, 780, RIGHT, 780);
    if (doc.footer) pdf.drawText(pdf.wrapText(doc.footer, WIDTH - 60, { size: 7.5 })[0] || '', LEFT, 794, { font: 'regular', size: 7.5, color: soft });
    pdf.drawTextRight(`Page ${pdf.pages.length}`, RIGHT, 794, { font: 'regular', size: 7.5, color: soft });
    if (doc.watermark) pdf.drawTextCenter(doc.watermark, 297, 430, { font: 'bold', size: 64, color: [0.92, 0.88, 0.88] });
  };
  const header = (first) => {
    if (first) {
      pdf.setFillColor(0.96, 0.97, 0.98);
      pdf.rect(LEFT, 36, WIDTH, 70, true, false);
      pdf.drawText(s(company.name, 80) || ' ', LEFT + 12, 58, { font: 'bold', size: 12, color: ink });
      const contact = [s(company.address, 120), [s(company.phone, 40), s(company.email, 80)].filter(Boolean).join('  |  ')].filter(Boolean);
      contact.forEach((line, i) => pdf.drawText(line, LEFT + 12, 74 + i * 11, { font: 'regular', size: 8, color: soft }));
      pdf.drawTextRight(doc.title.toUpperCase(), RIGHT - 12, 60, { font: 'bold', size: 14, color: ink });
      if (doc.reference) pdf.drawTextRight(doc.reference, RIGHT - 12, 78, { font: 'regular', size: 9, color: soft });
      y = 126;
    } else {
      pdf.drawText(`${doc.title}${doc.reference ? ` - ${doc.reference}` : ''}`, LEFT, 56, { font: 'bold', size: 10, color: ink });
      pdf.setStrokeColor(0.9, 0.92, 0.95);
      pdf.line(LEFT, 64, RIGHT, 64);
      y = 84;
    }
  };
  const ensure = (needed) => {
    if (y + needed <= BOTTOM) return;
    footer();
    pdf.addPage();
    header(false);
  };
  const labelValueRows = (rows) => {
    for (const row of rows) {
      const lines = pdf.wrapText(row.value || '-', WIDTH - 150, { size: 9 });
      ensure(13 * lines.length + 2);
      pdf.drawText(row.label, LEFT, y, { font: 'bold', size: 8.5, color: soft });
      lines.forEach((line, i) => pdf.drawText(line, LEFT + 150, y + i * 13, { font: 'regular', size: 9, color: body }));
      y += 13 * lines.length + 3;
    }
  };

  header(true);
  if (doc.meta.length) {
    labelValueRows(doc.meta);
    y += 8;
  }
  for (const block of doc.blocks) {
    ensure(40);
    if (block.heading) {
      pdf.drawText(block.heading.toUpperCase(), LEFT, y, { font: 'bold', size: 9, color: [0.15, 0.39, 0.92] });
      pdf.setStrokeColor(0.9, 0.92, 0.95);
      pdf.line(LEFT, y + 5, RIGHT, y + 5);
      y += 18;
    }
    if (block.rows) labelValueRows(block.rows);
    else if (block.table) {
      const colW = WIDTH / block.table.columns.length;
      const chars = Math.max(4, Math.floor(colW / (0.52 * 8.5)) - 1);
      ensure(30);
      block.table.columns.forEach((c, i) => pdf.drawText(c.slice(0, chars), LEFT + i * colW, y, { font: 'bold', size: 8, color: soft }));
      y += 14;
      for (const row of block.table.rows) {
        const cells = row.map((cell) => pdf.wrapText(cell || '', colW - 6, { size: 8.5 }).slice(0, 4));
        const height = 12 * Math.max(1, ...cells.map((c) => c.length)) + 4;
        ensure(height);
        cells.forEach((lines, i) => lines.forEach((line, j) => pdf.drawText(line, LEFT + i * colW, y + j * 12, { font: 'regular', size: 8.5, color: body })));
        y += height;
      }
    } else if (block.text) {
      for (const line of pdf.wrapText(block.text, WIDTH, { size: 9 })) {
        ensure(13);
        if (line) pdf.drawText(line, LEFT, y, { font: 'regular', size: 9, color: body });
        y += 13;
      }
    }
    y += 12;
  }
  footer();
  return pdf.build();
}

/* ------------------------------------------------------------------ branded layout */

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126, from the standard AFM files.
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 222, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 278, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 278, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

/** Text the built-in fonts can show: common symbols mapped, everything else non-ASCII dropped. */
function ascii(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/₹/g, 'INR ')
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/…/g, '...')
    .replace(/×/g, 'x')
    .replace(/[·•]/g, '|')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ ]/g, ' ')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/[ \t]+/g, ' ');
}

function textWidth(text, size, bold) {
  const table = bold ? W_BOLD : W_REGULAR;
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? table[c - 32] : 556;
  }
  return (w * size) / 1000;
}

/** Lines of `text` (already ASCII) that fit `width`; the text's own line breaks are kept. */
function wrap(text, width, size, bold = false) {
  const lines = [];
  for (const paragraph of ascii(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ').filter(Boolean)) {
      let rest = word;
      while (textWidth(rest, size, bold) > width) {
        let n = rest.length - 1;
        while (n > 1 && textWidth(rest.slice(0, n), size, bold) > width) n -= 1;
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      const next = line ? `${line} ${rest}` : rest;
      if (textWidth(next, size, bold) <= width) line = next;
      else {
        lines.push(line);
        line = rest;
      }
    }
    lines.push(line);
  }
  while (lines.length > 1 && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/** One line cut to `width` with "...". */
function fit(text, width, size, bold = false) {
  const t = ascii(text).replace(/\n/g, ' ').trim();
  if (textWidth(t, size, bold) <= width) return t;
  let n = t.length;
  while (n > 0 && textWidth(`${t.slice(0, n)}...`, size, bold) > width) n -= 1;
  return `${t.slice(0, n).trimEnd()}...`;
}

const C = {
  ink: [0.09, 0.11, 0.16],
  body: [0.25, 0.28, 0.34],
  soft: [0.43, 0.47, 0.54],
  faint: [0.6, 0.63, 0.68],
  rule: [0.87, 0.89, 0.92],
  hair: [0.92, 0.93, 0.95],
  panel: [0.965, 0.972, 0.98],
  accent: [0.11, 0.3, 0.6],
  accentTint: [0.93, 0.95, 0.99],
  white: [1, 1, 1]
};
const TONE = {
  success: { fg: [0.03, 0.47, 0.3], bg: [0.88, 0.96, 0.91] },
  info: { fg: [0.11, 0.3, 0.6], bg: [0.92, 0.95, 0.99] },
  warning: { fg: [0.62, 0.36, 0.02], bg: [1, 0.95, 0.85] },
  danger: { fg: [0.7, 0.13, 0.13], bg: [0.99, 0.91, 0.91] },
  neutral: { fg: [0.36, 0.4, 0.47], bg: [0.94, 0.95, 0.96] }
};
const FOOT_RULE = 800;
const BRANDED_BOTTOM = 784;

function renderBranded(doc, company) {
  const pdf = new PdfBuilder();
  const f = (n) => Number(n).toFixed(2);
  const H = pdf.height;
  let y = 0;

  const text = (t, x, top, size, { bold = false, color = C.body } = {}) => {
    if (t) pdf.drawText(ascii(t), x, top + size * 0.76, { font: bold ? 'bold' : 'regular', size, color });
  };
  const textRight = (t, right, top, size, opts = {}) => text(t, right - textWidth(ascii(t), size, opts.bold), top, size, opts);
  const fill = (rgb) => pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
  const hline = (x1, x2, at, rgb = C.rule, width = 0.6) => {
    pdf.setStrokeColor(rgb[0], rgb[1], rgb[2]);
    pdf.setLineWidth(width);
    pdf.line(x1, at, x2, at);
    pdf.setLineWidth(1);
  };
  const vline = (x, y1, y2, rgb = C.rule, width = 0.8) => {
    pdf.setStrokeColor(rgb[0], rgb[1], rgb[2]);
    pdf.setLineWidth(width);
    pdf.line(x, y1, x, y2);
    pdf.setLineWidth(1);
  };
  const roundRect = (x, top, w, h, r, rgb) => {
    fill(rgb);
    const x0 = x;
    const x1 = x + w;
    const y0 = H - top - h;
    const y1 = H - top;
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    const k = rr * 0.5523;
    pdf.commands.push(
      [
        `${f(x0 + rr)} ${f(y0)} m`,
        `${f(x1 - rr)} ${f(y0)} l`,
        `${f(x1 - rr + k)} ${f(y0)} ${f(x1)} ${f(y0 + rr - k)} ${f(x1)} ${f(y0 + rr)} c`,
        `${f(x1)} ${f(y1 - rr)} l`,
        `${f(x1)} ${f(y1 - rr + k)} ${f(x1 - rr + k)} ${f(y1)} ${f(x1 - rr)} ${f(y1)} c`,
        `${f(x0 + rr)} ${f(y1)} l`,
        `${f(x0 + rr - k)} ${f(y1)} ${f(x0)} ${f(y1 - rr + k)} ${f(x0)} ${f(y1 - rr)} c`,
        `${f(x0)} ${f(y0 + rr)} l`,
        `${f(x0)} ${f(y0 + rr - k)} ${f(x0 + rr - k)} ${f(y0)} ${f(x0 + rr)} ${f(y0)} c`,
        'h f'
      ].join(' ')
    );
  };
  const dot = (cx, cy, r, rgb) => roundRect(cx - r, cy - r, r * 2, r * 2, r, rgb);

  const name = fit(s(company.name, 80), WIDTH * 0.55, 15, true);
  const contactLines = [
    fit(s(company.address, 160), WIDTH * 0.55, 8),
    fit([s(company.phone, 40), s(company.email, 80)].filter(Boolean).join('   |   '), WIDTH * 0.55, 8)
  ].filter(Boolean);
  const title = ascii(doc.title).toUpperCase();

  const firstHeader = () => {
    let x = LEFT;
    if (name) {
      // Text monogram (no logo image is stored by the CRM): the first letters of the company name.
      const initials = ascii(name).split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || name[0];
      roundRect(LEFT, 38, 34, 34, 7, C.accent);
      const iw = textWidth(initials, 12, true);
      text(initials, LEFT + 17 - iw / 2, 49.5, 12, { bold: true, color: C.white });
      x = LEFT + 46;
      text(name, x, 38, 15, { bold: true, color: C.ink });
      contactLines.forEach((line, i) => text(line, x, 58 + i * 11, 8, { color: C.soft }));
    }
    textRight(fit(title, WIDTH * 0.4, 15, true), RIGHT, 38, 15, { bold: true, color: C.accent });
    if (doc.reference) textRight(fit(doc.reference, WIDTH * 0.4, 9.5, true), RIGHT, 58, 9.5, { bold: true, color: C.ink });
    if (doc.date) textRight(fit(doc.date, WIDTH * 0.4, 8, false), RIGHT, 71, 8, { color: C.soft });
    hline(LEFT, RIGHT, 92, C.rule, 0.6);
    pdf.setStrokeColor(C.accent[0], C.accent[1], C.accent[2]);
    pdf.setLineWidth(2);
    pdf.line(LEFT, 92, LEFT + 56, 92);
    pdf.setLineWidth(1);
    y = 112;
  };
  const nextHeader = () => {
    if (name) text(name, LEFT, 36, 8.5, { bold: true, color: C.soft });
    textRight(fit(`${title}${doc.reference ? `  ${ascii(doc.reference)}` : ''}`, WIDTH * 0.6, 8.5, true), RIGHT, 36, 8.5, { bold: true, color: C.soft });
    hline(LEFT, RIGHT, 52, C.rule, 0.6);
    y = 70;
  };
  /** Starts a new page when `needed` points do not fit; true when it did. */
  const ensure = (needed) => {
    if (y + needed <= BRANDED_BOTTOM) return false;
    pdf.addPage();
    nextHeader();
    return true;
  };
  const room = () => BRANDED_BOTTOM - y;
  const heading = (label, firstNeeded = 30) => {
    if (!label) return;
    ensure(24 + firstNeeded);
    text(ascii(label).toUpperCase(), LEFT, y, 8, { bold: true, color: C.accent });
    hline(LEFT, RIGHT, y + 13, C.hair, 0.6);
    y += 22;
  };

  /** Rows of a panel drawn page by page: each chunk gets its own soft background. */
  const panelRows = (heights, drawRow, { pad = 12, color = C.panel, x = LEFT, w = WIDTH, bar = null } = {}) => {
    let i = 0;
    while (i < heights.length) {
      ensure(heights[i] + pad * 2);
      let used = 0;
      let j = i;
      while (j < heights.length && (j === i || used + heights[j] + pad * 2 <= room())) used += heights[j++];
      roundRect(x, y, w, used + pad * 2, 6, color);
      if (bar) {
        fill(bar);
        pdf.rect(x, y + 4, 3, used + pad * 2 - 8, true, false);
      }
      let top = y + pad;
      for (let k = i; k < j; k++) {
        drawRow(k, top);
        top += heights[k];
      }
      y += used + pad * 2;
      i = j;
    }
  };

  const draw = {
    hero(b) {
      const badgeText = b.badge ? ascii(b.badge.text).toUpperCase() : '';
      const badgeW = badgeText ? textWidth(badgeText, 8, true) + 24 : 0;
      const lines = wrap(b.title, WIDTH - badgeW - 16, 19, true).slice(0, 3);
      const sub = b.subtitle ? wrap(b.subtitle, WIDTH - badgeW - 16, 10).slice(0, 3) : [];
      ensure((b.eyebrow ? 15 : 0) + lines.length * 23 + sub.length * 14 + 8);
      if (b.eyebrow) {
        text(ascii(b.eyebrow).toUpperCase(), LEFT, y, 8, { bold: true, color: C.soft });
        y += 15;
      }
      if (badgeText) {
        const tone = TONE[b.badge.tone];
        roundRect(RIGHT - badgeW, y + 1, badgeW, 20, 10, tone.bg);
        text(badgeText, RIGHT - badgeW + 12, y + 7, 8, { bold: true, color: tone.fg });
      }
      lines.forEach((line) => {
        text(line, LEFT, y, 19, { bold: true, color: C.ink });
        y += 23;
      });
      sub.forEach((line) => {
        text(line, LEFT, y, 10, { color: C.soft });
        y += 14;
      });
      y += 4;
    },
    facts(b) {
      const cols = b.columns;
      const pad = 14;
      const colW = (WIDTH - pad * 2) / cols;
      const rows = [];
      for (let i = 0; i < b.items.length; i += cols) rows.push(b.items.slice(i, i + cols));
      const laid = rows.map((row) => row.map((it) => ({ label: fit(ascii(it.label).toUpperCase(), colW - 12, 7, true), lines: wrap(it.value, colW - 12, 9.5).slice(0, 6) })));
      const heights = laid.map((row, i) => 13 + Math.max(...row.map((c) => c.lines.length)) * 13 + (i < laid.length - 1 ? 10 : 0));
      heading(b.heading, heights[0] + 24);
      panelRows(heights, (k, top) => {
        laid[k].forEach((cell, c) => {
          const x = LEFT + pad + c * colW;
          text(cell.label, x, top, 7, { bold: true, color: C.soft });
          cell.lines.forEach((line, n) => text(line, x, top + 12 + n * 13, 9.5, { color: C.ink }));
        });
      }, { pad: 12 });
    },
    parties(b) {
      const gap = 12;
      const n = b.items.length;
      const w = (WIDTH - gap * (n - 1)) / n;
      const laid = b.items.map((p) => ({
        heading: fit(ascii(p.heading).toUpperCase(), w - 24, 7, true),
        title: p.title ? wrap(p.title, w - 24, 11, true).slice(0, 2) : [],
        lines: p.lines.flatMap((l) => wrap(l, w - 24, 8.5).slice(0, 2)).slice(0, 10)
      }));
      const h = Math.max(...laid.map((p) => (p.heading ? 13 : 0) + p.title.length * 14 + p.lines.length * 12)) + 24;
      ensure(h);
      laid.forEach((p, i) => {
        const x = LEFT + i * (w + gap);
        roundRect(x, y, w, h, 6, C.panel);
        let top = y + 12;
        if (p.heading) {
          text(p.heading, x + 12, top, 7, { bold: true, color: C.soft });
          top += 13;
        }
        p.title.forEach((line) => {
          text(line, x + 12, top, 11, { bold: true, color: C.ink });
          top += 14;
        });
        p.lines.forEach((line) => {
          text(line, x + 12, top, 8.5, { color: C.body });
          top += 12;
        });
      });
      y += h;
    },
    days(b) {
      const anyTime = b.days.some((d) => d.items.some((it) => it.time));
      const PILL_X = LEFT;
      const LINE_X = LEFT + 24;
      const TIME_X = LEFT + 66;
      const CX = anyTime ? LEFT + 112 : LEFT + 66;
      const layoutItem = (it) => {
        const tag = it.tag ? ascii(it.tag).toUpperCase() : '';
        const tagW = tag ? textWidth(tag, 6.5, true) + 14 : 0;
        const titleLines = wrap(it.title, RIGHT - CX - tagW - 6, 9.5, true).slice(0, 3);
        const detailLines = it.detail ? wrap(it.detail, RIGHT - CX - 6, 8.5).slice(0, 6) : [];
        return { ...it, tag, tagW, titleLines, detailLines, h: titleLines.length * 13 + detailLines.length * 11.5 + 9 };
      };
      let firstDay = true;
      for (const day of b.days) {
        const items = day.items.map(layoutItem);
        const label = ascii(day.label).toUpperCase();
        const pillW = Math.max(48, textWidth(label, 7.5, true) + 16);
        const dateText = day.date ? fit(day.date, 140, 8.5) : '';
        const dateW = dateText ? textWidth(dateText, 8.5) + 12 : 0;
        const titleLines = day.title ? wrap(day.title, RIGHT - TIME_X - dateW, 11, true).slice(0, 2) : [];
        const headH = Math.max(20, titleLines.length * 14) + 10;
        const firstH = items.length ? items[0].h : 18;
        if (firstDay) heading(b.heading, headH + firstH);
        else ensure(headH + firstH);
        firstDay = false;
        const top = y;
        roundRect(PILL_X, top, pillW, 18, 9, C.accent);
        text(label, PILL_X + (pillW - textWidth(label, 7.5, true)) / 2, top + 5.2, 7.5, { bold: true, color: C.white });
        titleLines.forEach((line, i) => text(line, TIME_X, top + 2 + i * 14, 11, { bold: true, color: C.ink }));
        if (dateText) textRight(dateText, RIGHT, top + 4, 8.5, { color: C.soft });
        y += headH;
        let prevDot = top + 18;
        if (!items.length) {
          text(fit(day.empty || 'Free day', RIGHT - TIME_X, 9), TIME_X, y, 9, { color: C.soft });
          y += 18;
        }
        for (const it of items) {
          if (ensure(it.h)) {
            text(`${label} (CONTINUED)`, LEFT, y, 7, { bold: true, color: C.faint });
            y += 16;
            prevDot = null;
          }
          const dotY = y + 4;
          if (prevDot !== null) vline(LINE_X, prevDot, dotY - 3);
          dot(LINE_X, dotY, 2.6, C.accent);
          prevDot = dotY + 3;
          if (it.time) text(it.time, TIME_X, y, 9, { bold: true, color: C.accent });
          if (it.tag) {
            roundRect(RIGHT - it.tagW, y - 1, it.tagW, 12, 6, C.panel);
            text(it.tag, RIGHT - it.tagW + 7, y + 1.8, 6.5, { bold: true, color: C.soft });
          }
          let lineTop = y;
          it.titleLines.forEach((line) => {
            text(line, CX, lineTop, 9.5, { bold: true, color: C.ink });
            lineTop += 13;
          });
          it.detailLines.forEach((line) => {
            text(line, CX, lineTop, 8.5, { color: C.soft });
            lineTop += 11.5;
          });
          y += it.h;
        }
        y += 4;
        if (day !== b.days[b.days.length - 1]) {
          hline(LEFT, RIGHT, y, C.hair, 0.6);
          y += 14;
        }
      }
    },
    table(b) {
      const total = b.columns.reduce((sum, c) => sum + c.width, 0);
      const cols = [];
      let x = LEFT;
      for (const c of b.columns) {
        const w = (WIDTH * c.width) / total;
        cols.push({ ...c, x, w });
        x += w;
      }
      const head = () => {
        cols.forEach((c, i) => {
          const label = fit(ascii(c.label).toUpperCase(), c.w - 10, 7, true);
          if (c.align === 'right') textRight(label, c.x + c.w - (i === cols.length - 1 ? 0 : 8), y, 7, { bold: true, color: C.soft });
          else text(label, c.x + (i === 0 ? 0 : 4), y, 7, { bold: true, color: C.soft });
        });
        hline(LEFT, RIGHT, y + 14, C.rule, 0.6);
        y += 22;
      };
      const laid = b.rows.map((r) => {
        const cells = r.cells.map((cell, i) => wrap(cell, cols[i].w - 12, 9, i === 0).slice(0, i === 0 ? 3 : 2));
        const note = r.note ? wrap(r.note, cols[0].w - 12, 8).slice(0, 3) : [];
        const h = Math.max(cells[0].length * 12.5 + note.length * 11, ...cells.slice(1).map((c) => c.length * 12.5)) + 12;
        return { cells, note, h };
      });
      heading(b.heading, 22 + laid[0].h);
      ensure(22 + laid[0].h);
      head();
      laid.forEach((row, n) => {
        if (ensure(row.h)) head();
        row.cells.forEach((lines, i) => {
          const c = cols[i];
          lines.forEach((line, j) => {
            const opts = { bold: i === 0, color: i === 0 ? C.ink : C.body };
            if (c.align === 'right') textRight(line, c.x + c.w - (i === cols.length - 1 ? 0 : 8), y + j * 12.5, 9, opts);
            else text(line, c.x + (i === 0 ? 0 : 4), y + j * 12.5, 9, opts);
          });
        });
        row.note.forEach((line, j) => text(line, cols[0].x, y + row.cells[0].length * 12.5 + j * 11, 8, { color: C.soft }));
        y += row.h;
        if (n < laid.length - 1) hline(LEFT, RIGHT, y - 6, C.hair, 0.5);
      });
    },
    totals(b) {
      const boxW = 270;
      const x0 = RIGHT - boxW;
      const heights = b.rows.map((r) => (r.strong ? 30 : 17) + (r.divider ? 6 : 0));
      heading(b.heading, 10);
      ensure(heights.reduce((a, v) => a + v, 0) + 4);
      for (const r of b.rows) {
        if (r.divider) {
          hline(x0, RIGHT, y + 1, C.rule, 0.6);
          y += 6;
        }
        const tone = r.tone ? TONE[r.tone] : null;
        if (r.strong) {
          roundRect(x0, y + 2, boxW, 24, 5, tone ? tone.bg : C.accentTint);
          text(fit(r.label, boxW - 140, 10.5, true), x0 + 12, y + 8.5, 10.5, { bold: true, color: C.ink });
          textRight(r.value, RIGHT - 12, y + 8.5, 10.5, { bold: true, color: tone ? tone.fg : C.accent });
          y += 30;
        } else {
          text(fit(r.label, boxW - 130, 9), x0 + 12, y + 3, 9, { color: C.body });
          textRight(r.value, RIGHT - 12, y + 3, 9, { bold: Boolean(tone), color: tone ? tone.fg : C.ink });
          y += 17;
        }
      }
    },
    rows(b) {
      const rows = b.rows.map((r) => ({ label: wrap(r.label, 130, 8.5).slice(0, 2), lines: wrap(r.value, WIDTH - 150, 9.5).slice(0, 20) }));
      const hOf = (r) => Math.max(r.label.length * 11.5, r.lines.length * 13.5) + 5;
      heading(b.heading, hOf(rows[0]));
      for (const r of rows) {
        ensure(hOf(r));
        r.label.forEach((line, i) => text(line, LEFT, y + 1 + i * 11.5, 8.5, { color: C.soft }));
        r.lines.forEach((line, i) => text(line, LEFT + 150, y + i * 13.5, 9.5, { color: C.ink }));
        y += hOf(r);
      }
    },
    text(b) {
      const lines = wrap(b.text, WIDTH, 9.5);
      heading(b.heading, 28);
      for (const line of lines) {
        ensure(14);
        text(line, LEFT, y, 9.5, { color: C.body });
        y += 14;
      }
    },
    list(b) {
      const items = b.items.map((t) => wrap(t, WIDTH - 16, 9.5).slice(0, 12));
      heading(b.heading, items[0].length * 13.5 + 4);
      for (const lines of items) {
        ensure(lines.length * 13.5 + 4);
        dot(LEFT + 4, y + 5.5, 1.8, C.accent);
        lines.forEach((line, i) => text(line, LEFT + 14, y + i * 13.5, 9.5, { color: C.body }));
        y += lines.length * 13.5 + 4;
      }
    },
    note(b) {
      const tone = TONE[b.tone];
      const lines = wrap(b.text, WIDTH - 34, 9);
      heading(b.heading, Math.min(lines.length, 4) * 13 + 20);
      panelRows(lines.map(() => 13), (k, top) => text(lines[k], LEFT + 18, top, 9, { color: C.body }), { pad: 10, color: tone.bg, bar: tone.fg });
    },
    contact(b) {
      const phone = s(company.phone, 40);
      const email = s(company.email, 80);
      const address = s(company.address, 200);
      const parts = phone || email
        ? [phone ? { label: 'Phone', value: phone } : null, email ? { label: 'Email', value: email } : null].filter(Boolean)
        : address ? [{ label: 'Address', value: address }] : [];
      if (!parts.length) return;
      const intro = b.text ? wrap(b.text, WIDTH - 28, 9).slice(0, 3) : [];
      const laid = parts.map((p) => {
        const label = p.label.toUpperCase();
        const value = fit(p.value, WIDTH - 90, 9.5, true);
        return { label, value, w: textWidth(label, 7, true) + 8 + textWidth(value, 9.5, true) };
      });
      const oneRow = laid.reduce((a, p) => a + p.w, 0) + 28 * (laid.length - 1) <= WIDTH - 28;
      const heights = [...intro.map(() => 13), ...(oneRow ? [17] : laid.map(() => 15))];
      heading(b.heading, heights.reduce((a, v) => a + v, 0) + 20);
      panelRows(heights, (k, top) => {
        if (k < intro.length) {
          text(intro[k], LEFT + 14, top, 9, { color: C.body });
          return;
        }
        let x = LEFT + 14;
        for (const p of oneRow ? laid : [laid[k - intro.length]]) {
          text(p.label, x, top + 6, 7, { bold: true, color: C.soft });
          text(p.value, x + textWidth(p.label, 7, true) + 8, top + 4, 9.5, { bold: true, color: C.ink });
          x += p.w + 28;
        }
      }, { pad: 10 });
    }
  };

  firstHeader();
  if (doc.meta.length) draw.facts({ columns: 3, items: doc.meta.filter((m) => m.value) });
  let first = !doc.meta.length;
  for (const block of doc.blocks) {
    if (!first) y += block.type === 'hero' ? 4 : 16;
    first = false;
    if (block.type) draw[block.type](block);
    else if (block.rows) {
      if (block.rows.some((r) => r.value)) draw.rows({ heading: block.heading, rows: block.rows.filter((r) => r.value) });
    } else if (block.table) {
      if (block.table.rows.length) draw.table({ heading: block.heading, columns: block.table.columns.map((label) => ({ label, align: 'left', width: 1 })), rows: block.table.rows.map((cells) => ({ cells, note: '' })) });
    } else if (block.text) draw.text({ heading: block.heading, text: block.text });
  }

  // Footer, page numbers and the watermark on every page. The watermark is outlined text on top (soft
  // panels would hide a filled one underneath), so the content stays readable through it.
  const count = pdf.pages.length;
  const footerText = doc.footer || [s(company.name, 80), s(company.phone, 40), s(company.email, 80)].filter(Boolean).join('   |   ');
  const footLines = footerText ? wrap(footerText, WIDTH - 90, 7.5).slice(0, 2) : [];
  pdf.pages.forEach((commands, i) => {
    pdf.commands = commands;
    hline(LEFT, RIGHT, FOOT_RULE, C.rule, 0.6);
    footLines.forEach((line, n) => text(line, LEFT, FOOT_RULE + 8 + n * 10, 7.5, { color: C.faint }));
    textRight(`Page ${i + 1} of ${count}`, RIGHT, FOOT_RULE + 8, 7.5, { color: C.soft });
    if (doc.watermark) {
      const size = 78;
      const w = textWidth(doc.watermark, size, true);
      const cos = Math.cos(Math.PI / 6);
      const sin = Math.sin(Math.PI / 6);
      const cx = pdf.width / 2;
      const cy = H / 2;
      const x = cx - (w / 2) * cos + (size * 0.35) * sin;
      const yy = cy - (w / 2) * sin - (size * 0.35) * cos;
      const tint = doc.watermark === 'CANCELLED' ? [0.9, 0.55, 0.55] : [0.7, 0.73, 0.78];
      commands.push(`q 1.2 w ${tint.map((v) => v.toFixed(3)).join(' ')} RG BT 1 Tr /F2 ${size} Tf ${f(cos)} ${f(sin)} ${f(-sin)} ${f(cos)} ${f(x)} ${f(yy)} Tm (${doc.watermark}) Tj 0 Tr ET Q`);
    }
  });
  pdf.commands = pdf.pages[count - 1];
  return pdf.build();
}

module.exports = { renderDocumentPdf, normalizeDocument, textWidth, wrapText: wrap };
