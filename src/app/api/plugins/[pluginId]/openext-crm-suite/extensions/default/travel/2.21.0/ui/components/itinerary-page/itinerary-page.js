/**
 * <x-travel-itinerary-page-v1>: the Itinerary page (navigation page.itinerary, not in the sidebar),
 * opened with ?id=<itinerary id> from a quotation, a booking or a lead.
 *
 * Layout (2.13.0): a header card (title, status, Save Draft / Publish / PDF), a trip summary strip
 * (from, to, destination, dates, nights, travellers, booking), a row of metric cards side by side
 * (progress, trip overview, linked records, services by kind), then the plan full width and below it
 * notes and other versions:
 *   - tabs "Itinerary (N days)" and "Included services"; each day is a card that opens and closes
 *     (Expand all), its items on a timeline (time, kind icon, title, details, kind badge) with edit,
 *     duplicate and delete; editing an item opens its form in place (time, title, kind, details, order,
 *     move to another day or Included services);
 * Draft: editable; Final / Superseded: read-only with Download PDF and New version.
 * Unsaved changes are kept from being lost: the browser asks before leaving the page, and in-page
 * navigation asks first.
 *
 * Backend: GET/PUT /itineraries/:id, POST /itineraries/:id/finalize, GET /itineraries/:id/file,
 *          POST /itineraries/from-quotation (replace / from_itinerary_id)
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import * as ui from '../../shared/booking-ui.js';

useStyles(new URL('./itinerary-page.css', import.meta.url));

const PAGE = '/ext/travel/itinerary';
const ID_RE = /^[a-f0-9]{24}$/i;
const KINDS = [
  { value: 'travel', label: 'Travel' },
  { value: 'stay', label: 'Stay' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'activity', label: 'Activity' },
  { value: 'note', label: 'Note' }
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
const SERVICE_LABEL = { travel: 'Flight / Travel', stay: 'Hotel / Stay', transfer: 'Transfer', activity: 'Sightseeing / Activity', note: 'Other' };
const MAX_ITEMS = 30;
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
let newItem = 0;

// Line icons (24 × 24, stroke = currentColor): fixed strings, never user text.
const ICONS = {
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  travel: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  stay: '<path d="M2 18V6M2 14h20v4M22 18v-5a3 3 0 0 0-3-3h-8v4"/><circle cx="7" cy="11" r="2"/>',
  transfer: '<path d="M5 17h14M6 17v2M18 17v2M4 13l2-6h12l2 6v4H4z"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/>',
  activity: '<circle cx="6" cy="16" r="3"/><circle cx="18" cy="16" r="3"/><path d="M9 16h6M6 13V7l3-2M18 13V7l-3-2"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 0 0-4V4H3z"/><path d="M13 4v16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};

function icon(name, cls = '') {
  const span = h('span', { class: `tvx-it-ico${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.note}</svg>`;
  return span;
}

const kindIcon = (kind) => (ICONS[kind] ? kind : 'note');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function travellersText(trip) {
  if (!trip) return '';
  const parts = [];
  if (trip.adults) parts.push(plural(trip.adults, 'Adult', 'Adults'));
  if (trip.children) parts.push(plural(trip.children, 'Child', 'Children'));
  if (trip.infants) parts.push(plural(trip.infants, 'Infant', 'Infants'));
  return parts.join(', ');
}

function renderItineraryPage(root, ctx) {
  root.classList.add('tvx-bx', 'tvx-it');
  const state = {
    id: '', data: null, days: [], included: [], notes: '', title: '', dirty: false, seq: 0, message: null,
    tab: 'days', open: new Set([0]), editing: new WeakSet()
  };
  let saveBtn = null;
  let dirtyEl = null;
  let messageEl = null;

  const go = (path) => {
    if (typeof ctx.navigate === 'function') ctx.navigate(path);
  };

  // Leaving the page (reload, close, typed URL) with unsaved changes: the browser asks first.
  const beforeUnload = (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  if (typeof root.onCleanup === 'function') root.onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));

  /** Runs `next` now, or after the user agrees to drop unsaved changes. */
  function leave(next) {
    if (!state.dirty) return next();
    ui.openDialog(root, {
      title: 'Unsaved changes',
      intro: 'Your changes to this itinerary are not saved yet.',
      cancelLabel: 'Stay here',
      actions: [
        { label: 'Leave without saving', kind: 'danger', onClick: async () => { setDirty(false); next(); } }
      ]
    });
    return undefined;
  }

  function route(query) {
    const id = String((query && query.id) || '');
    if (!ID_RE.test(id)) {
      state.id = '';
      root.replaceChildren(
        h('section', { class: 'tvx-card tvx-empty' }, [
          h('p', { class: 'tvx-empty-title', text: 'No itinerary chosen' }),
          h('p', { class: 'tvx-muted', text: 'Open an itinerary from a quotation (Generate itinerary), a booking or a lead.' })
        ])
      );
      return;
    }
    if (id !== state.id) load(id);
  }

  async function load(id, message) {
    const fresh = id !== state.id;
    state.id = id;
    const seq = ++state.seq;
    if (!state.data || state.data.itinerary.id !== id) root.replaceChildren(h('section', { class: 'tvx-card' }, [h('p', { class: 'tvx-loading', text: 'Loading itinerary…' })]));
    try {
      const data = await ctx.api.get(`/itineraries/${encodeURIComponent(id)}`);
      if (seq !== state.seq) return;
      state.data = data;
      resetFrom(data.itinerary);
      if (fresh) {
        state.open = new Set([0]);
        state.tab = 'days';
      }
      state.message = message || null;
      render();
    } catch (err) {
      if (seq !== state.seq) return;
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load(id) })
      );
    }
  }

  function resetFrom(it) {
    state.days = clone(it.days || []);
    state.included = clone(it.unscheduled || []);
    state.notes = it.notes || '';
    state.title = it.title || '';
    state.dirty = false;
    state.editing = new WeakSet();
  }

  function open(id) {
    leave(() => {
      go(`${PAGE}?id=${id}`);
      if (state.id !== id) load(id);
    });
  }

  const editable = () => Boolean(state.data && state.data.itinerary.status === 'Draft' && state.data.can && state.data.can.edit);

  function setDirty(value) {
    state.dirty = value;
    if (value) state.editSeq = (state.editSeq || 0) + 1;
    // Save stays disabled while a save is running (typing meanwhile must not start a second PUT).
    if (saveBtn) saveBtn.disabled = !value || Boolean(state.saving);
    if (dirtyEl) dirtyEl.hidden = !value;
  }

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
    if (!messageEl) return;
    messageEl.className = `tvx-msg tvx-msg-${kind === 'error' ? 'error' : 'success'}`;
    messageEl.textContent = text || '';
    messageEl.hidden = !text;
  }

  /* ------------------------------------------------------------- render */

  function render() {
    const { itinerary: it, versions = [], booking, trip } = state.data;
    const canEdit = editable();
    saveBtn = null;
    dirtyEl = h('span', { class: 'tvx-dirty', text: 'Unsaved changes', hidden: !state.dirty });
    messageEl = h('div', { class: 'tvx-msg tvx-msg-success', role: 'status', hidden: true });
    root.replaceChildren(
      headerCard(it, booking, trip, canEdit),
      summaryStrip(it, booking, trip),
      messageEl,
      h('div', { class: 'tvx-it-metrics', role: 'region', 'aria-label': 'Itinerary metrics' }, [
        progressCard(it),
        overviewCard(trip),
        servicesCard(),
        linksCard(it, booking)
      ]),
      planCard(canEdit),
      h('div', { class: 'tvx-it-footer' }, [notesCard(canEdit), versionsCard(it, versions)])
    );
    if (state.message) setMessage(state.message.kind, state.message.text);
  }

  function headerCard(it, booking, trip, canEdit) {
    const can = state.data.can || {};
    const draftOther = (state.data.versions || []).find((v) => v.status === 'Draft' && v.id !== it.id);
    const actions = [];
    if (it.has_file) actions.push(busyButton('Download PDF', 'ghost', () => ui.downloadFile(ctx, `/itineraries/${it.id}/file`, `${it.reference}.pdf`)));
    if (canEdit) {
      actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Regenerate', onclick: () => regenerateDialog(it) }));
      saveBtn = h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost tvx-it-save', text: 'Save Draft', disabled: !state.dirty, onclick: () => save() });
      actions.push(saveBtn);
      actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary tvx-it-publish', text: 'Publish & PDF', onclick: () => finalizeDialog(it) }));
    } else if (can.edit && it.status !== 'Draft') {
      if (draftOther) actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: `Open draft v${draftOther.version}`, onclick: () => open(draftOther.id) }));
      else actions.push(busyButton('New version', 'primary', () => newVersion(it)));
    }
    const statusText = {
      Final: 'This plan is published — the PDF is what the customer gets. Start a new version to change it.',
      Superseded: 'A newer version replaced this plan.'
    }[it.status];
    let titleNode;
    if (canEdit) {
      titleNode = h('input', { type: 'text', value: state.title, maxlength: 120, 'aria-label': 'Itinerary title', placeholder: 'Itinerary title', class: 'tvx-input tvx-it-title-input' });
      titleNode.addEventListener('input', () => {
        state.title = titleNode.value;
        setDirty(true);
      });
    } else {
      titleNode = h('h2', { class: 'tvx-it-title', text: it.title || 'Itinerary' });
    }
    const days = (trip && trip.days) || state.days.length;
    const meta = [
      it.quotation_no ? h('span', { class: 'tvx-it-meta' }, [icon('note'), `Quotation: ${it.quotation_no}`]) : null,
      it.start_date ? h('span', { class: 'tvx-it-meta' }, [icon('calendar'), `${ui.fmtRange(it.start_date, it.end_date)}${days ? ` (${plural(days, 'day', 'days')})` : ''}`]) : null,
      travellersText(trip) ? h('span', { class: 'tvx-it-meta' }, [icon('users'), travellersText(trip)]) : null,
      h('span', { class: 'tvx-it-meta tvx-muted', text: it.edited ? 'Edited' : 'As generated' })
    ];
    return h('section', { class: 'tvx-card tvx-it-hero' }, [
      h('div', { class: 'tvx-it-hero-top' }, [
        h('span', { class: 'tvx-it-hero-tile' }, [icon('briefcase')]),
        h('div', { class: 'tvx-it-hero-text' }, [
          h('h1', { class: 'tvx-it-h1', text: 'Itinerary' }),
          h('p', { class: 'tvx-muted', text: 'Create and manage the day-by-day travel itinerary for a quotation or booking.' })
        ])
      ]),
      h('div', { class: 'tvx-it-hero-row' }, [
        h('div', { class: 'tvx-it-hero-title' }, [
          titleNode,
          h('span', { class: 'tvx-it-version', text: `v${it.version}` }),
          ui.statusPill(it.status)
        ]),
        h('div', { class: 'tvx-it-actions' }, actions)
      ]),
      h('div', { class: 'tvx-it-metas' }, [...meta, dirtyEl]),
      statusText ? h('p', { class: `tvx-msg ${it.status === 'Final' ? 'tvx-msg-success' : 'tvx-msg-warn'}`, text: statusText }) : null
    ]);
  }

  function summaryStrip(it, booking, trip) {
    const t = trip || {};
    const cells = [
      ['travel', 'From', t.from],
      ['pin', 'To', t.to],
      ['pin', 'Destination', t.destination],
      ['calendar', 'Travel Dates', ui.fmtRange(it.start_date, it.end_date)],
      ['moon', 'Nights', it.start_date ? String(t.nights || 0) : ''],
      ['users', 'Travellers', travellersText(t)]
    ].filter((c) => c[2]);
    const items = cells.map(([ico, label, value]) =>
      h('div', { class: 'tvx-it-strip-cell' }, [
        h('span', { class: 'tvx-it-strip-label' }, [icon(ico), label]),
        h('span', { class: 'tvx-it-strip-value', text: value })
      ])
    );
    if (booking) {
      items.push(h('div', { class: 'tvx-it-strip-cell' }, [
        h('span', { class: 'tvx-it-strip-label' }, [icon('ticket'), 'Booking Ref.']),
        h('button', { type: 'button', class: 'tvx-link-btn tvx-it-strip-value', text: booking.number || 'Open', onclick: () => leave(() => go(`/ext/travel/bookings?id=${booking.id}`)) })
      ]));
    }
    return items.length ? h('section', { class: 'tvx-card tvx-it-strip', 'aria-label': 'Trip summary' }, items) : null;
  }

  function busyButton(label, kind, run) {
    const b = h('button', { type: 'button', class: `tvx-btn ${kind === 'primary' ? 'tvx-btn-primary' : 'tvx-btn-ghost'}`, text: label });
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      try {
        await run();
      } catch (err) {
        setMessage('error', errorText(err));
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    });
    return b;
  }

  /* --------------------------------------------------------------- plan */

  function planCard(canEdit) {
    const tabs = [
      ['days', `Itinerary (${plural(state.days.length, 'Day', 'Days')})`],
      ['services', `Included services (${state.included.length})`]
    ];
    const allOpen = state.days.length > 0 && state.days.every((_, i) => state.open.has(i));
    return h('section', { class: 'tvx-card tvx-it-plan' }, [
      h('div', { class: 'tvx-it-plan-head' }, [
        h('div', { class: 'tvx-it-tabs', role: 'tablist' }, tabs.map(([key, label]) =>
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': state.tab === key ? 'true' : 'false',
            class: `tvx-it-tab${state.tab === key ? ' is-on' : ''}`,
            text: label,
            onclick: () => {
              state.tab = key;
              render();
            }
          })
        )),
        state.tab === 'days' && state.days.length
          ? h('button', {
              type: 'button',
              class: 'tvx-btn tvx-btn-ghost tvx-it-expand',
              onclick: () => {
                state.open = allOpen ? new Set() : new Set(state.days.map((_, i) => i));
                render();
              }
            }, [icon('expand'), allOpen ? 'Collapse all' : 'Expand all'])
          : null
      ]),
      state.tab === 'days'
        ? h('div', { class: 'tvx-it-days' }, state.days.length ? state.days.map((d, i) => dayCard(d, i, canEdit)) : [h('p', { class: 'tvx-muted', text: 'No days in this plan.' })])
        : includedPanel(canEdit)
    ]);
  }

  function moveOptions(fromDay) {
    const opts = [{ value: '', label: 'Move to…' }];
    state.days.forEach((d, i) => {
      if (i !== fromDay) opts.push({ value: String(i), label: `Day ${d.day || i + 1}${d.date ? ` · ${ui.fmtDay(d.date)}` : ''}` });
    });
    if (fromDay !== -1) opts.push({ value: '-1', label: 'Included services' });
    return opts;
  }

  const listOf = (dayIndex) => (dayIndex === -1 ? state.included : state.days[dayIndex].items);

  function newId() {
    newItem += 1;
    return `n${Date.now().toString(36)}${newItem}`.slice(0, 20);
  }

  function itemEditor(item, dayIndex, index) {
    const items = listOf(dayIndex);
    const time = h('input', { type: 'time', class: 'tvx-input tvx-it-time-input', value: item.time || '', 'aria-label': 'Time' });
    time.addEventListener('input', () => {
      item.time = time.value;
      setDirty(true);
    });
    const title = h('input', { type: 'text', class: 'tvx-input tvx-it-item-title', value: item.title || '', maxlength: 160, 'aria-label': 'What happens', placeholder: 'What happens, e.g. Check-in: Hilton' });
    title.addEventListener('input', () => {
      item.title = title.value;
      setDirty(true);
    });
    const kind = ui.select(KINDS, item.kind || 'note', { class: 'tvx-input tvx-it-kind', 'aria-label': 'Kind' });
    kind.addEventListener('change', () => {
      item.kind = kind.value;
      setDirty(true);
    });
    const details = h('textarea', { class: 'tvx-input tvx-textarea tvx-it-details', rows: 2, maxlength: 600, 'aria-label': 'Details', placeholder: 'Details (optional)' });
    details.value = item.details || '';
    details.addEventListener('input', () => {
      item.details = details.value;
      setDirty(true);
    });
    const move = ui.select(moveOptions(dayIndex), '', { class: 'tvx-input tvx-it-move', 'aria-label': 'Move to another day' });
    move.addEventListener('change', () => {
      if (move.value === '') return;
      const target = Number(move.value);
      const to = listOf(target);
      if (target !== -1 && to.length >= MAX_ITEMS) {
        setMessage('error', `That day already has ${MAX_ITEMS} items`);
        move.value = '';
        return;
      }
      items.splice(index, 1);
      to.push(item);
      if (target !== -1) state.open.add(target);
      setDirty(true);
      render();
    });
    const shift = (delta) => {
      const j = index + delta;
      if (j < 0 || j >= items.length) return;
      [items[index], items[j]] = [items[j], items[index]];
      setDirty(true);
      render();
    };
    return h('div', { class: 'tvx-it-editor' }, [
      h('div', { class: 'tvx-it-editor-grid' }, [
        ui.field('Time', time),
        ui.field('Title', title),
        ui.field('Kind', kind)
      ]),
      ui.field('Details', details),
      h('div', { class: 'tvx-it-editor-tools' }, [
        h('button', { type: 'button', class: 'tvx-icon-btn', text: '↑', 'aria-label': 'Move up', disabled: index === 0, onclick: () => shift(-1) }),
        h('button', { type: 'button', class: 'tvx-icon-btn', text: '↓', 'aria-label': 'Move down', disabled: index === items.length - 1, onclick: () => shift(1) }),
        move,
        h('button', {
          type: 'button',
          class: 'tvx-btn tvx-btn-ghost tvx-it-done',
          text: 'Done',
          onclick: () => {
            state.editing.delete(item);
            render();
          }
        })
      ])
    ]);
  }

  function itemRow(item, dayIndex, index, canEdit) {
    const items = listOf(dayIndex);
    const kind = kindIcon(item.kind);
    const editing = canEdit && state.editing.has(item);
    const tools = canEdit
      ? h('div', { class: 'tvx-it-item-tools' }, [
          h('button', {
            type: 'button',
            class: `tvx-it-tool${editing ? ' is-on' : ''}`,
            'aria-label': `Edit ${item.title || 'item'}`,
            'aria-pressed': editing ? 'true' : 'false',
            onclick: () => {
              if (editing) state.editing.delete(item);
              else state.editing.add(item);
              render();
            }
          }, [icon('edit')]),
          h('button', {
            type: 'button',
            class: 'tvx-it-tool',
            'aria-label': `Duplicate ${item.title || 'item'}`,
            disabled: dayIndex !== -1 && items.length >= MAX_ITEMS,
            onclick: () => {
              items.splice(index + 1, 0, { ...clone(item), id: newId(), source_ref: '' });
              setDirty(true);
              render();
            }
          }, [icon('copy')]),
          h('button', {
            type: 'button',
            class: 'tvx-it-tool is-danger',
            'aria-label': `Remove ${item.title || 'item'}`,
            onclick: () => {
              items.splice(index, 1);
              setDirty(true);
              render();
            }
          }, [icon('trash')])
        ])
      : null;
    return h('li', { class: `tvx-it-item${editing ? ' is-editing' : ''}${canEdit ? '' : ' is-readonly'}` }, [
      h('span', { class: 'tvx-it-dot', 'aria-hidden': 'true' }),
      h('span', { class: `tvx-it-time${item.time ? '' : ' is-empty'}`, text: item.time || '—' }),
      h('div', { class: 'tvx-it-item-card' }, [
        h('div', { class: 'tvx-it-item-row' }, [
          icon(kind, `tvx-it-kind-ico is-${kind}`),
          h('div', { class: 'tvx-it-text' }, [
            h('span', { class: 'tvx-it-item-name', text: item.title || 'Untitled item' }),
            item.details ? h('span', { class: 'tvx-it-item-details', text: item.details }) : null
          ]),
          h('span', { class: `tvx-it-badge is-${kind}` }, [icon(kind), KIND_LABEL[item.kind] || 'Note']),
          tools
        ]),
        editing ? itemEditor(item, dayIndex, index) : null
      ])
    ]);
  }

  function addButton(dayIndex) {
    const items = listOf(dayIndex);
    return h('button', {
      type: 'button',
      class: 'tvx-btn tvx-btn-ghost tvx-it-add',
      disabled: dayIndex !== -1 && items.length >= MAX_ITEMS,
      onclick: () => {
        const item = { id: newId(), time: '', kind: dayIndex === -1 ? 'note' : 'activity', title: '', details: '', source_ref: '' };
        items.push(item);
        state.editing.add(item);
        setDirty(true);
        render();
        const inputs = root.querySelectorAll('.tvx-it-item.is-editing .tvx-it-item-title');
        if (inputs.length) inputs[inputs.length - 1].focus();
      }
    }, [icon('plus'), 'Add item']);
  }

  function dayCard(d, i, canEdit) {
    const isOpen = state.open.has(i);
    const heading = `Day ${d.day || i + 1}${d.date ? ` · ${ui.fmtDay(d.date, { weekday: true })}` : ''}`;
    const bodyId = `tvx-it-day-${i}`;
    const toggle = h('button', {
      type: 'button',
      class: 'tvx-it-day-toggle',
      'aria-expanded': isOpen ? 'true' : 'false',
      'aria-controls': bodyId,
      onclick: () => {
        if (isOpen) state.open.delete(i);
        else state.open.add(i);
        render();
      }
    }, [
      icon('calendar', 'tvx-it-day-ico'),
      h('span', { class: 'tvx-it-day-text' }, [
        h('span', { class: 'tvx-it-day-label', text: heading }),
        d.title ? h('span', { class: 'tvx-it-day-sub', text: d.title }) : null
      ]),
      h('span', { class: 'tvx-it-count', text: d.items.length ? plural(d.items.length, 'item', 'items') : 'Free day' }),
      icon('chevron', `tvx-it-chevron${isOpen ? ' is-open' : ''}`)
    ]);
    let body = null;
    if (isOpen) {
      let titleNode = null;
      if (canEdit) {
        const input = h('input', { type: 'text', value: d.title || '', maxlength: 120, class: 'tvx-input tvx-it-day-title', 'aria-label': `${heading} title`, placeholder: 'What this day is about' });
        input.addEventListener('input', () => {
          d.title = input.value;
          setDirty(true);
        });
        titleNode = h('label', { class: 'tvx-it-day-title-wrap' }, [icon('edit'), input]);
      }
      body = h('div', { class: 'tvx-it-day-body', id: bodyId }, [
        titleNode,
        d.items.length
          ? h('ul', { class: 'tvx-it-items' }, d.items.map((item, j) => itemRow(item, i, j, canEdit)))
          : h('p', { class: 'tvx-muted', text: canEdit ? 'Free day — add an item or leave it free.' : 'Free day' }),
        canEdit ? addButton(i) : null
      ]);
    }
    return h('section', { class: `tvx-it-day${isOpen ? ' is-open' : ''}` }, [toggle, body]);
  }

  function includedPanel(canEdit) {
    return h('div', { class: 'tvx-it-day is-open is-included' }, [
      h('p', { class: 'tvx-muted tvx-it-included-intro', text: 'Services without a day (visa, insurance, …). They are listed after the days in the PDF.' }),
      state.included.length
        ? h('ul', { class: 'tvx-it-items' }, state.included.map((item, j) => itemRow(item, -1, j, canEdit)))
        : h('p', { class: 'tvx-muted', text: 'Nothing here.' }),
      canEdit ? addButton(-1) : null
    ]);
  }

  /* --------------------------------------------------------------- side */

  function sideCard(title, ico, children, extraClass = '') {
    return h('section', { class: `tvx-card tvx-it-side${extraClass ? ` ${extraClass}` : ''}` }, [
      h('h3', { class: 'tvx-it-side-title' }, [icon(ico), title]),
      ...children
    ]);
  }

  function progressCard(it) {
    const daysWithItems = state.days.filter((d) => d.items.length).length;
    const services = state.days.reduce((n, d) => n + d.items.filter((x) => x.kind !== 'note').length, 0) + state.included.length;
    const steps = [
      { label: 'Trip details', done: Boolean(it.start_date && it.end_date) },
      { label: `Itinerary days (${daysWithItems}/${state.days.length})`, done: state.days.length > 0 && daysWithItems === state.days.length },
      { label: `Travel services (${services})`, done: services > 0 },
      { label: 'Review & publish', done: it.status === 'Final' }
    ];
    const pct = Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
    return sideCard('Itinerary Progress', 'layers', [
      h('p', { class: 'tvx-muted tvx-it-side-sub', text: 'Build the plan, add all travel services, then publish.' }),
      h('div', { class: 'tvx-it-progress' }, [
        h('div', { class: 'tvx-it-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Itinerary progress' }, [
          h('span', { class: 'tvx-it-bar-fill', style: `width:${pct}%` })
        ]),
        h('span', { class: 'tvx-it-pct', text: `${pct}%` })
      ]),
      h('ul', { class: 'tvx-it-steps' }, steps.map((s) =>
        h('li', { class: `tvx-it-step${s.done ? ' is-done' : ''}` }, [
          h('span', { class: 'tvx-it-step-mark' }, s.done ? [icon('check')] : []),
          h('span', { text: s.label })
        ])
      ))
    ]);
  }

  function overviewCard(trip) {
    const t = trip || {};
    return sideCard('Trip Overview', 'calendar', [
      h('div', { class: 'tvx-it-stats' }, [
        h('div', { class: 'tvx-it-stat' }, [h('span', { class: 'tvx-muted', text: 'Days' }), h('strong', { text: String(t.days || state.days.length || 0) })]),
        h('div', { class: 'tvx-it-stat' }, [h('span', { class: 'tvx-muted', text: 'Nights' }), h('strong', { text: String(t.nights || 0) })]),
        h('div', { class: 'tvx-it-stat' }, [h('span', { class: 'tvx-muted', text: 'Travellers' }), h('strong', { text: String((t.adults || 0) + (t.children || 0) + (t.infants || 0)) })])
      ]),
      travellersText(t) ? h('p', { class: 'tvx-muted tvx-it-side-sub', text: travellersText(t) }) : null
    ]);
  }

  function linksCard(it, booking) {
    const rows = [];
    if (it.quotation_id) {
      rows.push(h('li', {}, [
        h('span', { class: 'tvx-muted', text: 'Quotation' }),
        h('button', { type: 'button', class: 'tvx-link-btn', text: it.quotation_no || 'Open', onclick: () => leave(() => go(`/quotations/${it.quotation_id}`)) })
      ]));
    }
    if (booking) {
      rows.push(h('li', {}, [
        h('span', { class: 'tvx-muted', text: 'Booking' }),
        h('button', { type: 'button', class: 'tvx-link-btn', text: booking.number || 'Open', onclick: () => leave(() => go(`/ext/travel/bookings?id=${booking.id}`)) })
      ]));
    }
    return rows.length ? sideCard('Linked Records', 'link', [h('ul', { class: 'tvx-it-kv' }, rows)]) : null;
  }

  function servicesCard() {
    const counts = new Map();
    for (const item of [...state.days.flatMap((d) => d.items), ...state.included]) {
      const k = KIND_LABEL[item.kind] ? item.kind : 'note';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const order = ['travel', 'stay', 'transfer', 'activity', 'note'].filter((k) => counts.get(k));
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return sideCard(`Included Services (${total})`, 'layers', [
      order.length
        ? h('ul', { class: 'tvx-it-kv' }, order.map((k) => h('li', {}, [
            h('span', { class: 'tvx-it-kv-label' }, [icon(k), SERVICE_LABEL[k]]),
            h('strong', { text: String(counts.get(k)) })
          ])))
        : h('p', { class: 'tvx-muted', text: 'No services yet.' })
    ]);
  }

  function notesCard(canEdit) {
    if (!canEdit) {
      return state.notes ? sideCard('Notes', 'note', [h('p', { class: 'tvx-it-notes', text: state.notes })]) : null;
    }
    const notes = ui.textarea({ maxlength: 3000, rows: 5, 'aria-label': 'Notes for the customer', placeholder: 'Printed at the end of the itinerary, e.g. hotel check-in from 3:00 PM' });
    notes.value = state.notes;
    notes.addEventListener('input', () => {
      state.notes = notes.value;
      setDirty(true);
    });
    return sideCard('Notes & Reminders', 'note', [notes]);
  }

  function versionsCard(it, versions) {
    const others = versions.filter((v) => v.id !== it.id);
    if (!others.length) return null;
    return sideCard('Other versions', 'copy', [
      h('ul', { class: 'tvx-it-version-list' }, others.map((v) => h('li', {}, [
        h('span', { class: 'tvx-it-version-name', text: `v${v.version}` }),
        ui.statusPill(v.status),
        h('span', { class: 'tvx-muted tvx-it-version-when', text: v.finalized_at ? `published ${ui.fmtMoment(v.finalized_at)}` : v.updatedAt ? `changed ${ui.fmtMoment(v.updatedAt)}` : '' }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Open', 'aria-label': `Open version ${v.version}`, onclick: () => open(v.id) })
      ])))
    ], 'tvx-it-versions');
  }

  /* ------------------------------------------------------------ actions */

  function payload() {
    return { title: state.title, days: state.days, unscheduled: state.included, notes: state.notes };
  }

  async function save() {
    if (!saveBtn || saveBtn.disabled || state.saving) return false;
    state.saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const id = state.id;
    const editsAtStart = state.editSeq || 0;
    try {
      const res = await ctx.api.put(`/itineraries/${id}`, payload());
      state.saving = false;
      if (state.id !== id) return true; // another itinerary is open now
      state.data.itinerary = res.itinerary;
      if ((state.editSeq || 0) === editsAtStart) {
        resetFrom(res.itinerary);
        state.message = { kind: 'success', text: 'Saved' };
      } else {
        // Typed while saving: those edits stay on screen, still unsaved.
        state.message = { kind: 'success', text: 'Saved — newer changes are not saved yet' };
      }
      render();
      return true;
    } catch (err) {
      state.saving = false;
      setMessage('error', errorText(err));
      if (saveBtn) {
        saveBtn.textContent = 'Save Draft';
        saveBtn.disabled = !state.dirty;
      }
      return false;
    }
  }

  function regenerateDialog(it) {
    ui.openDialog(root, {
      title: 'Regenerate the itinerary?',
      intro: 'Replace your edits with a fresh plan from the quotation? Notes are kept.',
      actions: [{
        label: 'Regenerate',
        onClick: async () => {
          await ctx.api.post('/itineraries/from-quotation', { recordId: it.quotation_id, recordType: 'quotation', replace: true });
          setDirty(false);
          await load(it.id, { kind: 'success', text: 'A fresh plan was generated from the quotation' });
        }
      }]
    });
  }

  function finalizeDialog(it) {
    ui.openDialog(root, {
      title: 'Publish & PDF',
      intro: `${state.dirty ? 'Your changes are saved first. ' : ''}The PDF is drawn with the guest and travellers as they are now. A published plan cannot be edited; an earlier published version is marked Superseded.`,
      actions: [{
        label: 'Publish & PDF',
        onClick: async () => {
          if (state.dirty) {
            const res = await ctx.api.put(`/itineraries/${state.id}`, payload());
            state.data.itinerary = res.itinerary;
            setDirty(false);
          }
          await ctx.api.post(`/itineraries/${it.id}/finalize`, {});
          await load(it.id, { kind: 'success', text: 'Published — the PDF is ready' });
        }
      }]
    });
  }

  async function newVersion(it) {
    const res = await ctx.api.post('/itineraries/from-quotation', { recordId: it.quotation_id, recordType: 'quotation', from_itinerary_id: it.id });
    const next = res && res.itinerary;
    if (!next) return;
    go(`${PAGE}?id=${next.id}`);
    if (state.id !== next.id) await load(next.id, { kind: 'success', text: res.message || `Itinerary v${next.version} created` });
  }

  // In-app navigation to another itinerary (or away from this one) with unsaved edits: ask first; "Stay
  // here" puts the address back on this itinerary.
  subscribe(root, ctx, 'onQueryChange', (q) => {
    const id = String((q && q.id) || '');
    if (id === state.id) return;
    if (!state.dirty) {
      route(q);
      return;
    }
    const keepId = state.id;
    let left = false;
    ui.openDialog(root, {
      title: 'Unsaved changes',
      intro: 'Your changes to this itinerary are not saved yet.',
      cancelLabel: 'Stay here',
      onClose: () => {
        if (!left && keepId) go(`${PAGE}?id=${keepId}`);
      },
      actions: [{
        label: 'Leave without saving',
        kind: 'danger',
        onClick: async () => {
          left = true;
          setDirty(false);
          route(q);
        }
      }]
    });
  });
  route(ctx.query || {});
}

class ItineraryPage extends TravelElement {
  start(ctx) {
    renderItineraryPage(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-itinerary-page-v1', ItineraryPage);
