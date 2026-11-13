/**
 * Check availability dialog (T3), opened from a requirement card on the lead's Travel Requirement tab.
 *
 *   GET  /requirements/:id/availability     requirement, pricing, settings, history (newest first)
 *   POST /requirements/:id/availability     a new check
 *   PUT  /availability/:id                  "Correct this check" (author, within 15 minutes)
 *   GET  /availability/:id/evidence         evidence file
 *   GET  /providers?service_key=&q=         provider suggestions (datalist)
 *
 * Form: provider, response (segmented), prices by the service's pricing, currency, checked at, valid until
 * (pre-filled from Settings → Travel → Availability; required for Held), channel, contact person, notes,
 * evidence (images shrunk in the browser, PDFs up to 700 KB). Read-only users see the history only.
 * Escape closes, Tab stays inside the dialog, full screen on phones. "Available does not mean booked."
 *
 * The overlay is placed inside the component root so the --tvx-* theme variables apply.
 */

import { h, errorText } from '../../shared/dom.js';
import { useStyles } from '../../shared/styles.js';
import { shrinkImageFile } from '../../shared/image-shrink.js';

useStyles(new URL('./availability-dialog.css', import.meta.url));

export const STATUSES = ['Available', 'Held', 'On Request', 'Unavailable'];
const CHANNELS = ['Phone', 'WhatsApp', 'Email', 'Website', 'Other'];
const PDF_LIMIT = 700 * 1024;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let uid = 0;

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

/** YYYY-MM-DD of a moment in a time zone. */
export function dayIn(moment, timeZone) {
  const d = moment instanceof Date ? moment : new Date(moment);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function addDays(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? '' : new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** "14 Jun" (or "14 Jun 2027" when not this year) of a moment, in the time zone. */
export function shortDay(moment, timeZone) {
  const day = dayIn(moment, timeZone);
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ''}`;
}

function when(moment) {
  const d = new Date(moment);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function toLocalInput(moment) {
  const d = moment ? new Date(moment) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function money(n, currency = 'INR') {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `${currency || 'INR'} ${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

const PRICE_LABEL = { adult: 'Adult price', child: 'Child price', infant: 'Infant price' };
function priceLabel(key, pricing) {
  if (key !== 'unit') return PRICE_LABEL[key] || key;
  return pricing === 'per_room_night' ? 'Price per room-night' : 'Price per unit (vehicle / service)';
}

function pricesText(prices, currency) {
  const p = prices && typeof prices === 'object' ? prices : {};
  if (p.unit !== undefined) return money(p.unit, currency);
  return ['adult', 'child', 'infant']
    .filter((k) => p[k] !== undefined)
    .map((k) => `${k[0].toUpperCase()}${k.slice(1)} ${money(p[k], currency)}`)
    .join(' · ');
}

/**
 * The badge of a requirement's latest check: { text, cls } or null.
 *   Held · valid till 14 Jun (info) · Available (ok) · On Request · valid till … (warn)
 *   Expired — recheck (bad) · Unavailable — propose an alternative (bad)
 */
export function availabilityBadge(av, timeZone) {
  if (!av || !av.status) return null;
  if (av.status === 'Unavailable') return { text: 'Unavailable — propose an alternative', cls: 'is-av-bad' };
  if (av.expired || av.effective === 'Expired') return { text: 'Expired — recheck', cls: 'is-av-bad' };
  const till = av.valid_until ? ` · valid till ${shortDay(av.valid_until, timeZone)}` : '';
  const cls = av.status === 'Available' ? 'is-av-ok' : av.status === 'Held' ? 'is-av-info' : 'is-av-warn';
  return { text: `${av.status}${till}`, cls };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Opens the dialog.
 * @param {HTMLElement} root  the component root (the overlay goes inside it)
 * @param {object} ctx        mount ctx (api, toast)
 * @param {{ requirementId: string, title?: string, canEdit: boolean, onChange?: (latest) => void, onClose?: () => void }} opts
 */
export function openAvailabilityDialog(root, ctx, opts) {
  const id = String(opts.requirementId || '');
  const n = ++uid;
  const titleId = `tvx-av-title-${n}`;
  const listId = `tvx-av-providers-${n}`;
  const state = { loading: true, error: '', data: null, editing: null, saving: false, message: null, evidence: null, form: null };
  const opener = document.activeElement;

  const panel = h('div', { class: 'tvx-av-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' });
  const overlay = h('div', { class: 'tvx-av-overlay' }, [panel]);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...panel.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  root.appendChild(overlay);
  // Escape also when focus left the dialog (e.g. the focused button was re-drawn after a save).
  const onDocKey = (e) => {
    if (e.key === 'Escape' && overlay.isConnected) close();
  };
  document.addEventListener('keydown', onDocKey);

  let closed = false;
  function close() {
    if (closed) return;
    // A save in flight finishes first (its answer re-draws the dialog); closing now would hide the result.
    if (state.saving) return;
    closed = true;
    document.removeEventListener('keydown', onDocKey);
    overlay.remove();
    if (typeof opts.onClose === 'function') opts.onClose();
    if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
  }
  if (typeof root.onCleanup === 'function') {
    root.onCleanup(() => {
      document.removeEventListener('keydown', onDocKey);
      overlay.remove();
    });
  }

  const tz = () => (state.data && state.data.settings && state.data.settings.timezone) || 'Asia/Kolkata';
  const canWrite = () => Boolean(opts.canEdit && state.data && state.data.can && state.data.can.write);

  async function load() {
    try {
      state.data = await ctx.api.get(`/requirements/${encodeURIComponent(id)}/availability`);
      state.error = '';
      state.reloadFailed = false;
    } catch (err) {
      if (state.reloadFailed) state.message = { kind: 'error', text: `Could not reload: ${errorText(err)}` };
      else state.error = errorText(err);
    } finally {
      state.loading = false;
      render();
    }
  }

  let providerTimer = null;
  let providerSeq = 0;
  async function suggest(datalist, q) {
    const seq = ++providerSeq;
    try {
      const key = state.data && state.data.requirement ? state.data.requirement.service_key : '';
      const res = await ctx.api.get(`/providers?service_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q || '')}`);
      // Only the newest answer, and only into the list still on screen (an older, slower answer is dropped).
      if (seq !== providerSeq || closed || !datalist.isConnected) return;
      const list = Array.isArray(res && res.providers) ? res.providers : [];
      datalist.replaceChildren(...list.map((p) => h('option', { value: p })));
    } catch {
      /* suggestions are optional */
    }
  }

  /** Initial form values: a check being corrected, or a fresh check. */
  function startValues() {
    // What was typed survives a re-draw (a refused or failed save).
    if (state.draft) return { ...state.draft, checked_at: toLocalInput(state.draft.checked_at) };
    const c = state.editing;
    const days = (state.data && state.data.settings && state.data.settings.validityDays) || 3;
    if (c) {
      return {
        provider: c.provider,
        status: c.status,
        prices: { ...(c.prices || {}) },
        currency: c.currency || 'INR',
        checked_at: toLocalInput(c.checked_at),
        valid_until: c.valid_until ? dayIn(c.valid_until, tz()) : '',
        channel: c.channel || '',
        contact_person: c.contact_person || '',
        notes: c.notes || ''
      };
    }
    return { provider: '', status: 'Available', prices: {}, currency: 'INR', checked_at: toLocalInput(), valid_until: addDays(dayIn(new Date(), tz()), days), channel: '', contact_person: '', notes: '' };
  }

  function formView() {
    const v = startValues();
    const datalist = h('datalist', { id: listId });
    const provider = h('input', { class: 'tvx-input', list: listId, maxlength: '120', value: v.provider, placeholder: 'Hotel, operator or airline', autocomplete: 'off' });
    provider.addEventListener('input', () => {
      clearTimeout(providerTimer);
      providerTimer = setTimeout(() => suggest(datalist, provider.value.trim()), 250);
    });
    suggest(datalist, '');
    const radioName = `tvx-av-status-${n}`;
    const seg = h('div', { class: 'tvx-av-seg', role: 'radiogroup', 'aria-label': 'Response' }, STATUSES.map((s) => {
      const input = h('input', { type: 'radio', name: radioName, value: s, checked: v.status === s });
      return h('label', { class: `tvx-av-seg-item tvx-av-seg-${s.replace(/\s+/g, '-').toLowerCase()}` }, [input, h('span', { text: s })]);
    }));
    const pricing = state.data.pricing || 'per_unit';
    // Prices only for users who may see money (can.prices = crm.finance.read); a correction by anyone
    // else sends no prices and the server keeps the stored ones.
    const showPrices = Boolean(state.data.can && state.data.can.prices);
    const keys = !showPrices ? [] : Array.isArray(state.data.priceKeys) && state.data.priceKeys.length ? state.data.priceKeys : ['unit'];
    const priceInputs = keys.map((k) => {
      const inputId = `tvx-av-price-${k}-${n}`;
      const input = h('input', { id: inputId, class: 'tvx-input', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: v.prices[k] === undefined ? '' : String(v.prices[k]) });
      return { key: k, input, el: h('div', { class: 'tvx-field' }, [h('label', { class: 'tvx-label', for: inputId, text: priceLabel(k, pricing) }), input]) };
    });
    const currencyId = `tvx-av-cur-${n}`;
    const currency = h('input', { id: currencyId, class: 'tvx-input tvx-av-currency', maxlength: '3', value: v.currency, autocomplete: 'off' });
    const checkedId = `tvx-av-at-${n}`;
    const checkedAt = h('input', { id: checkedId, class: 'tvx-input', type: 'datetime-local', value: v.checked_at });
    const untilId = `tvx-av-until-${n}`;
    const validUntil = h('input', { id: untilId, class: 'tvx-input', type: 'date', value: v.valid_until });
    const channelId = `tvx-av-ch-${n}`;
    const channel = h('select', { id: channelId, class: 'tvx-input' }, [h('option', { value: '', text: '—' }), ...CHANNELS.map((c) => h('option', { value: c, text: c }))]);
    channel.value = v.channel;
    const contactId = `tvx-av-contact-${n}`;
    const contact = h('input', { id: contactId, class: 'tvx-input', maxlength: '80', value: v.contact_person });
    const notesId = `tvx-av-notes-${n}`;
    const notes = h('textarea', { id: notesId, class: 'tvx-input tvx-textarea', maxlength: '2000' });
    notes.value = v.notes;
    const fileId = `tvx-av-file-${n}`;
    const file = h('input', { id: fileId, class: 'tvx-av-file', type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf' });
    const fileNote = h('span', { class: 'tvx-muted', text: state.editing && state.editing.evidence_name ? `Current: ${state.editing.evidence_name}` : 'Optional: photo or PDF (up to 700 KB) of the provider’s reply' });
    if (!state.draft) state.evidence = null;
    else if (state.evidence && state.evidence.name) fileNote.textContent = `Attached: ${state.evidence.name}`;
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      state.evidence = null;
      if (!f) return;
      try {
        if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
          if (f.size > PDF_LIMIT) throw new Error('The PDF is larger than 700 KB — attach a smaller PDF or a photo of it');
          state.evidence = { name: f.name, data: await readFileAsDataUrl(f) };
        } else {
          const shrunk = await shrinkImageFile(f);
          state.evidence = { name: f.name, data: typeof shrunk === 'string' ? shrunk : shrunk && (shrunk.dataUrl || shrunk.data) };
        }
        fileNote.textContent = `Attached: ${f.name}`;
      } catch (err) {
        file.value = '';
        fileNote.textContent = errorText(err);
      }
    });

    const read = () => {
      const picked = seg.querySelector('input:checked');
      const prices = {};
      for (const p of priceInputs) if (p.input.value.trim() !== '') prices[p.key] = Number(p.input.value);
      const at = checkedAt.value ? new Date(checkedAt.value) : new Date();
      return {
        provider: provider.value.trim(),
        status: picked ? picked.value : '',
        ...(showPrices ? { prices, currency: currency.value.trim().toUpperCase() || 'INR' } : {}),
        checked_at: Number.isNaN(at.getTime()) ? '' : at.toISOString(),
        valid_until: validUntil.value,
        channel: channel.value,
        contact_person: contact.value.trim(),
        notes: notes.value.trim()
      };
    };
    const msgHost = h('div', { class: 'tvx-av-msg' }, state.message ? [h('div', { class: `tvx-msg tvx-msg-${state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text })] : []);
    const cancelBtn = state.editing
      ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', disabled: state.saving, onclick: () => { state.editing = null; state.draft = null; state.message = null; render(); }, text: 'Cancel correction' })
      : null;
    const saveBtn = h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', disabled: state.saving, onclick: save, text: state.saving ? 'Saving…' : state.editing ? 'Save correction' : 'Save check' });
    state.form = { read, msgHost, saveBtn, cancelBtn };

    const field = (label, control, { forId, help, full } = {}) =>
      h('div', { class: `tvx-field${full ? ' tvx-col-full' : ''}` }, [h('label', { class: 'tvx-label', for: forId, text: label }), control, help ? h('p', { class: 'tvx-help', text: help }) : null]);

    return h('div', { class: 'tvx-av-form' }, [
      state.editing ? h('p', { class: 'tvx-msg tvx-msg-warn', text: 'Correcting the latest check. Save to replace what was entered.' }) : null,
      h('div', { class: 'tvx-grid tvx-grid-2' }, [
        h('div', { class: 'tvx-field tvx-col-full' }, [h('label', { class: 'tvx-label', text: 'Provider / property' }), provider, datalist]),
        h('div', { class: 'tvx-field tvx-col-full' }, [h('span', { class: 'tvx-label', text: 'Response' }), seg]),
        ...priceInputs.map((p) => p.el),
        showPrices ? field('Currency', currency, { forId: currencyId }) : null,
        field('Checked at', checkedAt, { forId: checkedId }),
        field('Valid until', validUntil, { forId: untilId, help: 'Required for Held. A quote past this date shows as Expired.' }),
        field('Contact channel', channel, { forId: channelId }),
        field('Contact person', contact, { forId: contactId }),
        field('Notes', notes, { forId: notesId, full: true }),
        h('div', { class: 'tvx-field tvx-col-full' }, [h('label', { class: 'tvx-label', for: fileId, text: 'Evidence' }), file, fileNote])
      ]),
      msgHost,
      h('div', { class: 'tvx-av-actions' }, [cancelBtn, saveBtn].filter(Boolean))
    ]);
  }

  /** A message under the form, without re-drawing it (what is typed stays where it is). */
  function say(message) {
    state.message = message;
    const host = state.form && state.form.msgHost;
    if (!host || !host.isConnected) {
      render();
      return;
    }
    host.replaceChildren(...(message ? [h('div', { class: `tvx-msg tvx-msg-${message.kind}`, role: message.kind === 'error' ? 'alert' : 'status', text: message.text })] : []));
  }

  function busy(on) {
    state.saving = on;
    const f = state.form || {};
    if (f.saveBtn) {
      f.saveBtn.disabled = on;
      f.saveBtn.textContent = on ? 'Saving…' : state.editing ? 'Save correction' : 'Save check';
    }
    if (f.cancelBtn) f.cancelBtn.disabled = on;
  }

  async function save() {
    const body = state.form.read();
    state.draft = { ...body };
    if (!body.provider) return say({ kind: 'error', text: 'Enter the provider / property name' });
    if (!body.status) return say({ kind: 'error', text: 'Choose the response' });
    if (body.status === 'Held' && !body.valid_until) return say({ kind: 'error', text: 'A hold needs a "valid until" date' });
    if (state.evidence && state.evidence.data) body.evidence = state.evidence;
    say(null);
    busy(true);
    let res;
    try {
      res = state.editing
        ? await ctx.api.put(`/availability/${encodeURIComponent(state.editing.id)}`, body)
        : await ctx.api.post(`/requirements/${encodeURIComponent(id)}/availability`, body);
    } catch (err) {
      busy(false);
      say({ kind: 'error', text: errorText(err) });
      return;
    }
    // Saved: the form is cleared whatever happens next, so the same check is never sent twice.
    const corrected = Boolean(state.editing);
    state.editing = null;
    state.draft = null;
    state.evidence = null;
    try {
      state.data = await ctx.api.get(`/requirements/${encodeURIComponent(id)}/availability`);
      state.reloadFailed = false;
      state.message = { kind: 'success', text: corrected ? 'Check corrected.' : 'Check saved.' };
    } catch (err) {
      // The history on screen is out of date: no new check until it is reloaded.
      state.reloadFailed = true;
      state.message = { kind: 'warn', text: `${corrected ? 'Check corrected' : 'Check saved'}, but the history could not be reloaded (${errorText(err)}). Reload before adding another check.` };
    }
    state.saving = false;
    if (typeof opts.onChange === 'function') opts.onChange((!state.reloadFailed && state.data && state.data.latest) || (res && res.availability) || null);
    render();
    panel.focus(); // the focused button was re-drawn: keep focus (Tab, Escape) inside the dialog
  }

  /** After a save whose reload failed: only "Reload" (the form would offer a duplicate check). */
  function reloadView() {
    const btn = h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: 'Reload' });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Reloading…';
      load();
    });
    return h('div', { class: 'tvx-av-form tvx-av-reload' }, [
      state.message ? h('div', { class: `tvx-msg tvx-msg-${state.message.kind}`, role: 'status', text: state.message.text }) : null,
      h('div', { class: 'tvx-av-actions' }, [btn])
    ]);
  }

  async function openEvidence(check) {
    try {
      const file = await ctx.api.get(`/availability/${encodeURIComponent(check.id)}/evidence`);
      if (!file || !file.dataUrl) return;
      const a = h('a', { href: file.dataUrl, download: file.name || 'evidence', target: '_blank', rel: 'noopener' });
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      state.message = { kind: 'error', text: errorText(err) };
      render();
    }
  }

  function historyView() {
    const checks = (state.data && state.data.checks) || [];
    if (!checks.length) return h('div', { class: 'tvx-av-history' }, [h('h4', { class: 'tvx-h4', text: 'History' }), h('p', { class: 'tvx-muted', text: 'No availability checks yet.' })]);
    return h('div', { class: 'tvx-av-history' }, [
      h('h4', { class: 'tvx-h4', text: `History (${checks.length})` }),
      h('ol', { class: 'tvx-av-list' }, checks.map((c, i) => {
        const badge = availabilityBadge(c, tz());
        const price = pricesText(c.prices, c.currency);
        const meta = [
          `Checked ${when(c.checked_at)}`,
          c.checked_by_name ? `by ${c.checked_by_name}` : '',
          c.channel ? `via ${c.channel}` : '',
          c.contact_person ? `(${c.contact_person})` : ''
        ].filter(Boolean).join(' ');
        return h('li', { class: `tvx-av-item${i === 0 ? ' is-latest' : ''}` }, [
          h('div', { class: 'tvx-av-item-head' }, [
            h('span', { class: 'tvx-av-provider', text: c.provider }),
            i === 0 ? h('span', { class: 'tvx-pill is-none', text: 'Latest' }) : null,
            badge ? h('span', { class: `tvx-pill ${badge.cls}`, text: badge.text }) : null
          ]),
          price ? h('p', { class: 'tvx-av-price', text: price }) : null,
          h('p', { class: 'tvx-muted', text: meta }),
          c.notes ? h('p', { class: 'tvx-av-notes', text: c.notes }) : null,
          h('div', { class: 'tvx-row-gap' }, [
            c.has_evidence ? h('button', { type: 'button', class: 'tvx-link-btn', onclick: () => openEvidence(c), text: `Evidence${c.evidence_name ? `: ${c.evidence_name}` : ''}` }) : null,
            i === 0 && c.editable && canWrite() && !state.editing
              ? h('button', { type: 'button', class: 'tvx-link-btn', onclick: () => { state.editing = c; state.draft = null; state.message = null; render(); }, text: 'Correct this check' })
              : null
          ])
        ]);
      }))
    ]);
  }

  function summaryView() {
    const r = state.data.requirement || {};
    const fields = Array.isArray(r.fields) ? r.fields : [];
    const values = r.values || {};
    const shown = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
    const items = fields
      .filter((f) => f.type !== 'textarea')
      .map((f) => [f.label || f.key, values[f.key]])
      .filter(([, v]) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)))
      .slice(0, 8);
    return h('div', { class: 'tvx-av-summary' }, [
      h('div', { class: 'tvx-row-gap' }, [h('span', { class: 'tvx-eyebrow', text: r.service_name || 'Requirement' }), h('span', { class: `tvx-pill ${r.status === 'Complete' ? 'is-done' : 'is-draft'}`, text: r.status || 'Draft' })]),
      items.length ? h('dl', { class: 'tvx-av-dl' }, items.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: shown(v) })])) : null
    ]);
  }

  function render() {
    if (closed) return;
    const title = (state.data && state.data.requirement && state.data.requirement.label) || opts.title || 'Requirement';
    const head = h('div', { class: 'tvx-av-head' }, [
      h('div', {}, [h('h3', { class: 'tvx-h3', id: titleId, text: `Availability — ${title}` }), h('p', { class: 'tvx-sub', text: 'What the provider said, recorded for the quotation.' })]),
      h('button', { type: 'button', class: 'tvx-icon-btn', 'aria-label': 'Close dialog', onclick: close, text: '×' })
    ]);
    let body;
    if (state.loading) body = [h('p', { class: 'tvx-loading', text: 'Loading availability…' })];
    else if (state.error) body = [h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: state.error })];
    else {
      const writable = canWrite() && state.data.requirement && state.data.requirement.status === 'Complete';
      body = [
        summaryView(),
        writable && state.reloadFailed ? reloadView() : writable ? formView() : null,
        !writable && canWrite() ? h('p', { class: 'tvx-msg tvx-msg-warn', text: 'Complete the requirement first' }) : null,
        !writable && state.message ? h('div', { class: `tvx-msg tvx-msg-${state.message.kind}`, text: state.message.text }) : null,
        historyView()
      ];
    }
    panel.replaceChildren(
      head,
      h('div', { class: 'tvx-av-body' }, body.filter(Boolean)),
      h('div', { class: 'tvx-av-foot' }, [
        h('p', { class: 'tvx-muted', text: 'Available does not mean booked.' }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', onclick: close, text: 'Close' })
      ])
    );
  }

  render();
  load().then(() => {
    const first = panel.querySelector('input:not([type="radio"]), button');
    if (first && typeof first.focus === 'function') first.focus();
  });
  return { close };
}
