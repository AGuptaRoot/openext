/**
 * Shared UI for bookings, vouchers and itineraries (bookings-page, itinerary-page, quotation-travel,
 * lead-bookings): an accessible dialog, status pills, date / money formatting, file upload and download.
 *
 * Dialog: role="dialog", focus moves in and is trapped (Tab / Shift+Tab cycle), Escape or a click on the
 * overlay closes it — except while a request is in flight (the dialog is busy), so a save is never lost
 * half way. Focus returns to the button that opened it.
 */

import { h, errorText } from './dom.js';
import { useStyles } from './styles.js';
import { shrinkImageFile } from './image-shrink.js';

useStyles(new URL('./booking-ui.css', import.meta.url));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export const PDF_LIMIT = 700 * 1024;

let uid = 0;
export const nextId = (prefix = 'tvx-bx') => `${prefix}-${++uid}`;

/* ----------------------------------------------------------------- dates */

export function fmtDay(iso, { weekday = false } = {}) {
  const d = String(iso || '').slice(0, 10);
  if (!ISO_DAY.test(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${weekday ? `${wd}, ` : ''}${day} ${MONTHS[m - 1]} ${y}`;
}

export function fmtRange(a, b) {
  const x = fmtDay(a);
  const y = fmtDay(b);
  if (x && y && x !== y) return `${x} – ${y}`;
  return x || y || '';
}

/** Local date and time of an ISO moment ("12 Jun 2027, 14:30"). */
export function fmtMoment(iso) {
  const t = Date.parse(String(iso || ''));
  if (Number.isNaN(t)) return fmtDay(iso);
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO moment → value of an <input type="datetime-local"> (local time). */
export function toLocalInput(iso) {
  const t = Date.parse(String(iso || ''));
  const d = Number.isNaN(t) ? new Date() : new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

export function money(n, currency = 'INR') {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${currency || ''} ${v.toFixed(2)}`.trim();
  }
}

/* ------------------------------------------------------------------ pills */

const TONES = {
  Pending: 'warn',
  'Partially Confirmed': 'info',
  Confirmed: 'ok',
  Cancelled: 'danger',
  Completed: 'neutral',
  'Not Requested': 'neutral',
  Requested: 'info',
  Unavailable: 'danger',
  Draft: 'warn',
  Issued: 'info',
  Sent: 'ok',
  Used: 'neutral',
  Superseded: 'neutral',
  Final: 'ok',
  Available: 'ok',
  Held: 'info',
  'On Request': 'warn',
  Expired: 'warn',
  Unpaid: 'warn',
  'Partially Paid': 'info',
  Paid: 'ok'
};

export function statusPill(status, extraClass = '') {
  const tone = TONES[status] || 'neutral';
  return h('span', { class: `tvx-bx-pill is-${tone}${extraClass ? ` ${extraClass}` : ''}`, text: status || '—' });
}

/* ----------------------------------------------------------------- fields */

export function field(label, control, { help = '', required = false, full = false } = {}) {
  if (control && !control.id) control.id = nextId('tvx-bx-f');
  return h('div', { class: `tvx-field${full ? ' tvx-col-full' : ''}` }, [
    h('label', { class: 'tvx-label', for: control && control.id }, [label, required ? h('span', { class: 'tvx-req', 'aria-hidden': 'true', text: '*' }) : null]),
    control,
    help ? h('p', { class: 'tvx-help', text: help }) : null
  ]);
}

export function input(attrs = {}) {
  return h('input', { class: 'tvx-input', type: 'text', ...attrs });
}

export function textarea(attrs = {}) {
  return h('textarea', { class: 'tvx-input tvx-textarea', rows: 3, ...attrs });
}

export function select(options, value, attrs = {}) {
  const el = h('select', { class: 'tvx-input', ...attrs }, options.map((o) => {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    return h('option', { value: opt.value, text: opt.label });
  }));
  if (value !== undefined) el.value = value;
  return el;
}

/* ----------------------------------------------------------------- dialog */

/**
 * @param {HTMLElement} root  the component element (theme variables apply inside it)
 * @param {object} opts
 *   title, intro, content (Node | Node[]), actions [{ label, kind: 'primary'|'danger'|'ghost', onClick(api) }],
 *   cancelLabel ('Cancel'), onClose()
 * onClick may return false to keep the dialog open; a thrown error is shown in the dialog.
 */
const OPEN = new Set();

/**
 * Removes every dialog opened on `root` (or on any root) at once, without their onClose — for a query /
 * route change or an unmount, where the page they belonged to is no longer shown.
 */
export function closeDialogs(root) {
  for (const entry of [...OPEN]) if (!root || entry.root === root) entry.teardown();
}

export function openDialog(root, opts = {}) {
  const titleId = nextId('tvx-bx-title');
  const opener = document.activeElement;
  let busy = false;
  let closed = false;
  const error = h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', hidden: true });
  const body = h('div', { class: 'tvx-bx-dialog-body' });
  const footer = h('div', { class: 'tvx-bx-dialog-actions' });
  const closeBtn = h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: opts.cancelLabel || 'Cancel', onclick: () => api.close() });
  const dialog = h('div', { class: `tvx-bx-dialog${opts.wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
    h('h2', { class: 'tvx-bx-dialog-title', id: titleId, text: opts.title || '' }),
    opts.intro ? h('p', { class: 'tvx-muted', text: opts.intro }) : null,
    body,
    error,
    footer
  ]);
  const overlay = h('div', { class: 'tvx-bx-overlay' }, [dialog]);

  const actionButtons = [];
  function renderActions(actions) {
    actionButtons.length = 0;
    const buttons = (actions || []).map((a) => {
      const b = h('button', {
        type: 'button',
        class: `tvx-btn ${a.kind === 'danger' ? 'tvx-btn-danger' : a.kind === 'ghost' ? 'tvx-btn-ghost' : 'tvx-btn-primary'}`,
        text: a.label,
        onclick: () => run(a)
      });
      actionButtons.push(b);
      return b;
    });
    footer.replaceChildren(closeBtn, ...buttons);
  }

  async function run(action) {
    if (busy || closed) return;
    api.setError('');
    api.setBusy(true);
    let keep;
    try {
      keep = await action.onClick(api);
    } catch (err) {
      api.setBusy(false);
      api.setError(errorText(err));
      return;
    }
    api.setBusy(false);
    if (keep !== false) api.close();
  }

  /** Removes the dialog without its onClose (the page it belonged to is gone or changed). */
  function teardown() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    OPEN.delete(entry);
  }

  function onKey(event) {
    if (closed) return;
    // The component re-drew its root with the dialog open: the overlay is gone, so is the dialog
    // (otherwise this capture listener would keep trapping Tab page-wide).
    if (!overlay.isConnected) {
      teardown();
      return;
    }
    if (event.key === 'Escape') {
      if (busy) return;
      event.stopPropagation();
      api.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  const api = {
    el: dialog,
    body,
    setContent(nodes) {
      body.replaceChildren(...[].concat(nodes).filter(Boolean));
    },
    setActions(actions) {
      renderActions(actions);
    },
    showFooter(show) {
      footer.hidden = !show;
    },
    setError(message) {
      error.textContent = message || '';
      error.hidden = !message;
    },
    setBusy(value) {
      busy = Boolean(value);
      dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
      for (const b of [closeBtn, ...actionButtons]) b.disabled = busy;
    },
    isBusy: () => busy,
    isOpen: () => !closed && overlay.isConnected,
    close() {
      if (closed || busy) return;
      teardown();
      if (typeof opts.onClose === 'function') opts.onClose();
      if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    }
  };

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && !busy) api.close();
  });
  document.addEventListener('keydown', onKey, true);
  const entry = { root, teardown };
  OPEN.add(entry);
  if (typeof root.onCleanup === 'function' && !root.__tvxDialogCleanup) {
    root.__tvxDialogCleanup = true;
    root.onCleanup(() => closeDialogs(root));
  }
  api.setContent(opts.content || []);
  renderActions(opts.actions);
  root.append(overlay);
  const firstField = dialog.querySelector('input:not([type="hidden"]):not([disabled]), select, textarea') || actionButtons[0] || closeBtn;
  if (firstField && typeof firstField.focus === 'function') firstField.focus();
  return api;
}

/* ---------------------------------------------------------- files, links */

/** A chosen file → { data, name } within the CRM's 1 MB request limit (images shrunk; PDFs ≤ 700 KB). */
export async function readUpload(file) {
  if (!file) throw new Error('Choose a file');
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || 'document');
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > PDF_LIMIT) throw new Error(`${name} is ${Math.round(file.size / 1024)} KB — PDFs up to 700 KB can be uploaded. Save a smaller copy or upload a photo.`);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('The file could not be read'));
      reader.readAsDataURL(file);
    });
    return { data: data.replace(/^data:[^;]*;/, 'data:application/pdf;'), name };
  }
  const shrunk = await shrinkImageFile(file);
  return { data: shrunk.dataUrl, name: shrunk.name || name };
}

/** Downloads a private file served by one of our routes ({ dataUrl, name }). */
export async function downloadFile(ctx, path, fallbackName) {
  const file = await ctx.api.get(path);
  if (!file || !file.dataUrl) throw new Error('The file is not available');
  const a = document.createElement('a');
  a.href = file.dataUrl;
  a.download = file.name || fallbackName || 'document.pdf';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return file;
}

/** Full URL of an /ext/travel/… page in this CRM (kept behind its login). */
export function pageUrl(path) {
  const loc = typeof window !== 'undefined' ? window.location : null;
  if (!loc) return path;
  const base = String(loc.pathname || '').split('/ext/')[0].replace(/\/$/, '');
  return `${loc.origin}${base}${path}`;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back to showing the text */
  }
  return false;
}

export function errorMessage(err) {
  return errorText(err && err.code === 'BOOKING_EXISTS' ? { message: err.message } : err);
}

/**
 * "<qty> <unit>" for a quantity — once: a unit saved with its own number (before 2.19.4, e.g.
 * "2 Adults" for 2) is shown as "2 Adults", never "2 2 Adults" (which reads like "22").
 */
export function qtyWithUnit(qty, unit) {
  if (qty === null || qty === undefined || qty === '') return '';
  const q = String(qty).trim();
  let u = String(unit || '').trim();
  const lead = u.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (lead && Number(lead[1]) === Number(q)) u = lead[2];
  return u ? `${q} ${u}` : q;
}
