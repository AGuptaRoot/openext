'use strict';

/**
 * CRM 3.60.0 — the employee work report (Tasks → Reports → Download PDF) as a clean landscape A4 report:
 * the title, employee and period at the top left, the summary at the top right, and one table with every
 * time-log entry (date, task, project, status, in - out, hours, approval, billable, work done) and a totals
 * row. A short report fits on one page; a long table continues with its header repeated. Footer: Page X of Y.
 *
 * Drawn with the CRM's own PdfBuilder (built-in Helvetica, no images, no external files): text is ASCII
 * (the builder maps the common symbols); widths use the Helvetica metrics, long cells are cut with "...".
 */

const { PdfBuilder } = require('./pdf-generator.util');

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const M = 30; // page margin
const CW = PAGE_W - M * 2; // content width
const FOOTER_Y = PAGE_H - 22;
const BODY_BOTTOM = PAGE_H - 40;
const MAX_LOG_ROWS = 2000;

const hex = (h) => {
  const v = String(h).replace('#', '');
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
};
const C = {
  navy: hex('0f172a'),
  ink: hex('1e293b'),
  text: hex('334155'),
  muted: hex('64748b'),
  faint: hex('94a3b8'),
  line: hex('e2e8f0'),
  soft: hex('f1f5f9'),
  zebra: hex('f8fafc'),
  white: [1, 1, 1],
  blue: hex('2563eb'),
  blueSoft: hex('dbeafe'),
  blueInk: hex('1d4ed8'),
  green: hex('059669'),
  greenSoft: hex('d1fae5'),
  amber: hex('d97706'),
  amberSoft: hex('fef3c7'),
  red: hex('dc2626'),
  redSoft: hex('fee2e2'),
  violet: hex('7c3aed'),
  violetSoft: hex('ede9fe'),
  slateSoft: hex('e2e8f0')
};

const str = (v, max = 400) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hrs = (n) => `${round2(n).toFixed(2)} h`;
/** "INR 12,450.00" (the built-in font has no rupee sign). */
const money = (n, currency) => {
  const num = round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // '' = the number only (the column header already names the currency).
  return currency === '' ? num : `${currency || 'INR'} ${num}`;
};

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126 (standard AFM metrics).
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** The width the builder will draw (after its ASCII mapping: "₹" prints "INR ", other symbols one character). */
function textWidth(t, size, bold = false) {
  const table = bold ? W_BOLD : W_REG;
  let units = 0;
  for (const ch of String(t || '').replace(/₹/g, 'INR ')) {
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (units / 1000) * size;
}

function fit(text, width, size, bold = false) {
  const t = str(text, 600);
  if (textWidth(t, size, bold) <= width) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${t.slice(0, mid).trimEnd()}...`, size, bold) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${t.slice(0, Math.max(1, lo)).trimEnd()}...`;
}

function wrap(text, width, size, maxLines = 3) {
  const words = str(text, 2000).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const w0 of words) {
    let w = w0;
    while (textWidth(w, size) > width) {
      if (line) { lines.push(line); line = ''; }
      let n = w.length;
      while (n > 1 && textWidth(w.slice(0, n), size) > width) n -= 1;
      lines.push(w.slice(0, n));
      w = w.slice(n);
    }
    if (!line) line = w;
    else if (textWidth(`${line} ${w}`, size) <= width) line = `${line} ${w}`;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = fit(`${cut[maxLines - 1]} ...`, width, size);
    return cut;
  }
  return lines.length ? lines : [''];
}

function timeLabel(value, timeZone) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

function span(first, last, timeZone) {
  if (!first && !last) return 'Manual';
  return `${timeLabel(first, timeZone) || '--'} - ${timeLabel(last, timeZone) || '--'}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), wd: d.getUTCDay() };
}

function prettyDay(iso, withWeekday = true) {
  const p = dayParts(iso);
  if (!p) return str(iso) || '-';
  return `${withWeekday ? `${WEEKDAYS[p.wd]} ` : ''}${p.d} ${MONTHS[p.mo - 1]} ${p.y}`;
}

/* ===================================================================== drawing */

/**
 * The simple layout: title and employee at the top left, the summary at the top right, then ONE table
 * (every time-log entry, many columns) with a totals row. A short report fits on one page; a long table
 * continues on the next pages under its repeated header. A footer with "Page X of Y" on every page.
 */
class Report {
  constructor({ company, report, generatedBy }) {
    this.b = new PdfBuilder();
    this.b.width = PAGE_W;
    this.b.height = PAGE_H;
    this.company = company || {};
    this.report = report;
    this.generatedBy = generatedBy || '';
    this.daily = report.period === 'day';
    this.title = this.daily ? 'Daily Work Report' : 'Monthly Work Report';
    this.y = 0;
  }

  fill(color) { this.b.setFillColor(...color); }
  box(x, y, w, h, color) { this.fill(color); this.b.rect(x, y, w, h, true, false); }
  frame(x, y, w, h, color = C.line) { this.b.setStrokeColor(...color); this.b.setLineWidth(0.6); this.b.rect(x, y, w, h, false, true); }
  hline(x1, x2, y, color = C.line, width = 0.6) { this.b.setStrokeColor(...color); this.b.setLineWidth(width); this.b.line(x1, y, x2, y); }
  text(t, x, y, size, color = C.text, bold = false) { this.b.drawText(t, x, y, { size, font: bold ? 'bold' : 'regular', color }); }
  right(t, rx, y, size, color = C.text, bold = false) { this.b.drawText(t, Math.max(0, rx - textWidth(t, size, bold)), y, { size, font: bold ? 'bold' : 'regular', color }); }

  dayWindow() {
    const logs = (this.report.logs || []).filter((l) => l.checkInTime);
    if (!logs.length) return 'Manual only';
    const first = logs.reduce((a, l) => (!a || new Date(l.checkInTime) < new Date(a) ? l.checkInTime : a), null);
    const last = logs.reduce((a, l) => (l.checkOutTime && (!a || new Date(l.checkOutTime) > new Date(a)) ? l.checkOutTime : a), null);
    return span(first, last, this.report.timeZone);
  }

  /** Page 1: left — company, title, employee, period; right — the summary box. */
  header() {
    const r = this.report;
    const s = r.summary || {};
    const company = str(this.company.name) || 'Workspace';
    this.text(fit(company, 420, 10, true), M, 40, 10, C.muted, true);
    const contact = [this.company.email, this.company.phone].map((v) => str(v)).filter(Boolean).join('  |  ');
    if (contact) this.text(fit(contact, 420, 7.5), M, 51, 7.5, C.faint);
    this.text(this.title, M, 78, 18, C.navy, true);
    this.text(fit(r.employee.name, 420, 12, true), M, 98, 12, C.ink, true);
    this.text(`${this.daily ? 'Day' : 'Month'}: ${r.label}`, M, 114, 9, C.text);
    const generated = `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${this.generatedBy ? ` by ${this.generatedBy}` : ''}`;
    this.text(fit(`Times in ${r.timeZone}  |  ${generated}`, 420, 7.5), M, 127, 7.5, C.muted);

    const rows = [
      ['Total hours', hrs(s.hours)],
      ['Approved', hrs(s.approvedHours)],
      ['Pending / rejected', `${hrs(s.pendingHours)} / ${hrs(s.rejectedHours)}`],
      ['Billable hours', hrs(s.billableHours)],
      ...(r.showAmounts ? [['Billable amount', money(s.billableAmount, r.currency)]] : []),
      ['Entries', String(s.entries || 0)],
      ['Tasks / projects', `${s.tasks || 0} / ${s.projects || 0}`],
      this.daily ? ['First in - last out', this.dayWindow()] : ['Days worked', `${s.daysWorked || 0} (${hrs(s.averageHoursPerDay)} / day)`]
    ];
    const boxW = 270;
    const boxX = PAGE_W - M - boxW;
    const rowH = 14;
    const boxY = 28;
    const boxH = 12 + rows.length * rowH;
    this.box(boxX, boxY, boxW, boxH, C.zebra);
    this.frame(boxX, boxY, boxW, boxH);
    rows.forEach(([k, v], i) => {
      const y = boxY + 16 + i * rowH;
      this.text(k, boxX + 12, y, 8, C.muted);
      this.right(fit(v, boxW * 0.55, 8.5, true), boxX + boxW - 12, y, 8.5, C.navy, true);
    });
    this.y = Math.max(140, boxY + boxH + 12);
    this.hline(M, PAGE_W - M, this.y, C.line, 0.8);
    this.y += 14;
  }

  /** Later pages: one line with the report and employee. */
  smallHeader() {
    this.text(`${this.title}  |  ${fit(this.report.employee.name, 260, 9, true)}  |  ${this.report.label}`, M, 30, 9, C.muted, true);
    this.hline(M, PAGE_W - M, 38, C.line, 0.8);
    this.y = 50;
  }

  /** The one table: every time-log entry. */
  table() {
    const r = this.report;
    const s = r.summary || {};
    const tz = r.timeZone;
    const amounts = Boolean(r.showAmounts);
    const cols = [
      { key: 'date', label: 'Date', w: 0.095 },
      { key: 'task', label: 'Task', w: amounts ? 0.15 : 0.17, bold: true },
      { key: 'project', label: 'Project', w: amounts ? 0.11 : 0.12 },
      { key: 'status', label: 'Status', w: 0.075 },
      { key: 'inout', label: 'In - out', w: 0.085 },
      { key: 'hours', label: 'Hours', w: 0.06, align: 'right', bold: true },
      { key: 'approval', label: 'Approval', w: 0.07 },
      { key: 'billable', label: 'Billable', w: 0.055 },
      ...(amounts ? [{ key: 'amount', label: `Amount (${r.currency || 'INR'})`, w: 0.085, align: 'right' }] : []),
      { key: 'work', label: 'Work done', w: 0, wrap: true }
    ];
    // Work done takes the rest of the width.
    cols[cols.length - 1].w = 1 - cols.slice(0, -1).reduce((a, c) => a + c.w, 0);
    const xs = [];
    let acc = M;
    for (const c of cols) {
      xs.push(acc);
      acc += c.w * CW;
    }
    const pad = 5;
    const size = 7.8;
    const statusOf = {};
    for (const t of r.tasks || []) statusOf[t.taskId] = t.status;

    const head = () => {
      this.box(M, this.y, CW, 18, C.soft);
      cols.forEach((c, i) => {
        const cw = c.w * CW;
        if (c.align === 'right') this.right(c.label, xs[i] + cw - pad, this.y + 12, 7.5, C.ink, true);
        else this.text(c.label, xs[i] + pad, this.y + 12, 7.5, C.ink, true);
      });
      this.hline(M, M + CW, this.y + 18, C.faint, 0.6);
      this.y += 18;
    };

    const logs = (r.logs || []).slice(0, MAX_LOG_ROWS);
    if (!logs.length) {
      head();
      this.text(`No time logged ${this.daily ? 'on this day' : 'in this month'}.`, M + pad, this.y + 16, 8.5, C.muted);
      this.y += 28;
      return;
    }
    head();
    logs.forEach((l, ri) => {
      const cellOf = {
        date: prettyDay(l.date),
        task: l.taskTitle || 'Task',
        project: l.projectName || '-',
        status: statusOf[l.taskId] || '-',
        inout: l.status === 'Running' ? `${timeLabel(l.checkInTime, tz)} - running` : l.checkInTime ? `${timeLabel(l.checkInTime, tz)} - ${timeLabel(l.checkOutTime, tz)}` : 'Manual',
        hours: l.status === 'Running' ? '-' : hrs(l.hours),
        approval: l.approvalStatus || 'Approved',
        billable: l.isBillable === false ? 'No' : 'Yes',
        amount: l.isBillable === false || l.status === 'Running' ? '-' : money(l.billableAmount, '').trim(),
        work: l.description || '-'
      };
      const cells = cols.map((c) => cellOf[c.key]);
      const workCol = cols.length - 1;
      const workLines = wrap(cells[workCol], cols[workCol].w * CW - pad * 2, size, 2);
      const rh = Math.max(17, 7 + workLines.length * 9.5);
      if (this.y + rh > BODY_BOTTOM - 20) {
        this.b.addPage();
        this.smallHeader();
        head();
      }
      if (ri % 2 === 1) this.box(M, this.y, CW, rh, C.zebra);
      const baseY = this.y + 11.5;
      cols.forEach((c, i) => {
        const cw = c.w * CW;
        if (c.wrap) {
          workLines.forEach((line, li) => this.text(line, xs[i] + pad, baseY + li * 9.5, size, C.text));
          return;
        }
        const color = c.label === 'Approval' && cells[i] === 'Rejected' ? C.red : c.label === 'Approval' && cells[i] === 'Pending' ? C.amber : c.bold ? C.navy : C.text;
        if (c.align === 'right') this.right(cells[i], xs[i] + cw - pad, baseY, size, color, Boolean(c.bold));
        else this.text(fit(cells[i], cw - pad * 2, size, Boolean(c.bold)), xs[i] + pad, baseY, size, color, Boolean(c.bold));
      });
      this.hline(M, M + CW, this.y + rh, C.line, 0.4);
      this.y += rh;
    });
    // Totals.
    if (this.y + 20 > BODY_BOTTOM - 20) {
      this.b.addPage();
      this.smallHeader();
    }
    this.hline(M, M + CW, this.y, C.ink, 0.8);
    this.text(`Total  (${(r.logs || []).length} entries)`, M + pad, this.y + 13, 8, C.navy, true);
    this.right(hrs(s.hours), xs[5] + cols[5].w * CW - pad, this.y + 13, 8, C.navy, true);
    if (amounts) {
      const ai = cols.findIndex((c) => c.key === 'amount');
      this.right(money(s.billableAmount, '').trim(), xs[ai] + cols[ai].w * CW - pad, this.y + 13, 8, C.navy, true);
    }
    this.text(`Approved ${hrs(s.approvedHours)}  |  Billable ${hrs(s.billableHours)}`, xs[cols.length - 1] + pad, this.y + 13, 8, C.text);
    this.y += 24;
    if ((r.logs || []).length > logs.length || r.truncated) {
      this.text(`Only the first ${logs.length} entries are shown. Choose a shorter period to see every entry.`, M, this.y + 6, 7.5, C.amber);
      this.y += 14;
    }
  }

  footers() {
    const total = this.b.pages.length;
    const saved = this.b.commands;
    const name = str(this.company.name) || 'Workspace';
    this.b.pages.forEach((page, i) => {
      this.b.commands = page;
      this.hline(M, PAGE_W - M, FOOTER_Y - 9, C.line, 0.6);
      this.text(fit(`${name}  |  ${this.title}  |  ${this.report.employee.name}  |  ${this.report.label}`, 520, 7), M, FOOTER_Y, 7, C.muted);
      this.right(`Page ${i + 1} of ${total}`, PAGE_W - M, FOOTER_Y, 7, C.muted, true);
    });
    this.b.commands = saved;
  }

  render() {
    this.header();
    this.table();
    this.footers();
    return this.b.build();
  }
}

/**
 * @param report   WorkReportService.getEmployeeReport() result
 * @param company  { name, address, phone, email }
 * @returns Buffer (application/pdf, landscape A4)
 */
function renderWorkReportPdf(report, company = {}, { generatedBy = '' } = {}) {
  if (!report || !report.employee) throw new Error('renderWorkReportPdf: report is required');
  const out = new Report({ company, report, generatedBy }).render();
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

module.exports = { renderWorkReportPdf, _internal: { fit, wrap, prettyDay } };
