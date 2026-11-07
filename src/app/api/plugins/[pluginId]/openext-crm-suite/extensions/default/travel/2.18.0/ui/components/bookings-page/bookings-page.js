/**
 * <x-travel-bookings-page-v1>: the Bookings page (navigation page.bookings).
 *
 *   /ext/travel/bookings              list: status tabs with counts, search (300 ms debounce, stale answers
 *                                     ignored), travel date filter, load more
 *   /ext/travel/bookings?id=<id>      one booking: header (Cancel / Mark completed), travellers (choose from the
 *                                     lead and the contact's other trips, or add a new one), services (Request /
 *                                     Confirm Service / Cancel, history, evidence, vouchers or provider documents),
 *                                     itinerary, notes. &voucher=<id> highlights a voucher (copied links).
 *
 * Write buttons follow the server's answer (`can`), never only ctx.can.
 * Backend: /bookings…, /booking-services…, /vouchers…, /itineraries/from-quotation.
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import * as ui from '../../shared/booking-ui.js';

useStyles(new URL('./bookings-page.css', import.meta.url));

const PAGE = '/ext/travel/bookings';
const ITINERARY_PAGE = '/ext/travel/itinerary';
const TABS = [
  ['', 'All'],
  ['Pending', 'Pending'],
  ['Partially Confirmed', 'Partially Confirmed'],
  ['Confirmed', 'Confirmed'],
  ['Cancelled', 'Cancelled'],
  ['Completed', 'Completed']
];
const ISSUABLE = ['hotel', 'transport', 'excursion'];
const STATUS_FILTERS = ['Pending', 'Partially Confirmed', 'Confirmed', 'Cancelled', 'Completed'];
const CHANNELS = ['WhatsApp', 'Email', 'Printed', 'In person', 'Other'];
const CONFIRM_STATUSES = ['Confirmed', 'Requested', 'Unavailable', 'Cancelled'];
const TYPE_LABEL = { hotel: 'hotel', transport: 'transport', excursion: 'excursion' };
const ID_RE = /^[a-f0-9]{24}$/i;

const isOpen = (b) => b && b.status !== 'Cancelled' && b.status !== 'Completed';
const liveVoucher = (v) => v.status === 'Issued' || v.status === 'Sent' || v.status === 'Draft';

function renderBookingsPage(root, ctx) {
  root.classList.add('tvx-bx', 'tvx-bk');
  const state = { view: '', id: '', status: '', q: '', from: '', to: '', rows: [], counts: null, next: null, listSeq: 0, detailSeq: 0, data: null, focusVoucher: '' };
  let searchTimer = null;
  let list = null; // list view elements
  let noticeEl = null;
  if (typeof root.onCleanup === 'function') root.onCleanup(() => clearTimeout(searchTimer));

  const go = (path) => {
    if (typeof ctx.navigate === 'function') ctx.navigate(path);
  };
  const toast = (text, kind) => {
    if (typeof ctx.toast === 'function') ctx.toast(text, kind);
  };

  function route(query) {
    const q = query || {};
    const id = String(q.id || '');
    if (ID_RE.test(id)) {
      if (state.view !== 'detail' || state.id !== id) showDetail(id, String(q.voucher || ''));
    } else {
      // ?status= (e.g. from Reports): the list opens on that status.
      const wanted = STATUS_FILTERS.includes(String(q.status || '')) ? String(q.status) : '';
      if (state.view !== 'list' || (q.status !== undefined && wanted !== state.status)) {
        if (q.status !== undefined) state.status = wanted;
        showList();
      }
    }
  }

  /* ================================================================ list */

  function showList() {
    ui.closeDialogs(root); // dialogs of the booking that was shown
    state.view = 'list';
    state.id = '';
    state.data = null;
    noticeEl = null;
    const search = h('input', { type: 'search', class: 'tvx-input tvx-bk-search', placeholder: 'Search number, guest, destination, quotation…', 'aria-label': 'Search bookings', value: state.q });
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = search.value.trim();
        loadList();
      }, 300);
    });
    const from = h('input', { type: 'date', class: 'tvx-input', value: state.from, 'aria-label': 'Travel from' });
    const to = h('input', { type: 'date', class: 'tvx-input', value: state.to, 'aria-label': 'Travel until' });
    const onDate = () => {
      state.from = from.value;
      state.to = to.value;
      loadList();
    };
    from.addEventListener('change', onDate);
    to.addEventListener('change', onDate);
    const clear = h('button', {
      type: 'button',
      class: 'tvx-btn tvx-btn-ghost',
      text: 'Clear',
      onclick: () => {
        clearTimeout(searchTimer);
        state.q = '';
        state.from = '';
        state.to = '';
        state.status = '';
        search.value = '';
        from.value = '';
        to.value = '';
        loadList();
      }
    });
    const tabs = h('div', { class: 'tvx-bk-tabs', role: 'group', 'aria-label': 'Booking status' });
    const results = h('div', { class: 'tvx-bk-results', 'aria-live': 'polite' }, [h('p', { class: 'tvx-loading', text: 'Loading bookings…' })]);
    list = { search, from, to, clear, tabs, results };
    root.replaceChildren(
      h('section', { class: 'tvx-card tvx-bk-list-card' }, [
        h('div', { class: 'tvx-card-head' }, [
          h('div', {}, [
            h('h2', { class: 'tvx-h3 tvx-bk-page-title', text: 'Bookings' }),
            h('p', { class: 'tvx-sub', text: 'Made from accepted quotations. Confirm every service with the provider, then issue vouchers.' })
          ])
        ]),
        h('div', { class: 'tvx-bk-toolbar' }, [
          h('div', { class: 'tvx-bk-search-wrap' }, [search]),
          h('label', { class: 'tvx-bk-date' }, [h('span', { class: 'tvx-label', text: 'Travel from' }), from]),
          h('label', { class: 'tvx-bk-date' }, [h('span', { class: 'tvx-label', text: 'until' }), to]),
          clear
        ]),
        tabs,
        results
      ])
    );
    renderTabs();
    loadList();
  }

  const filtersOn = () => Boolean(state.q || state.from || state.to || state.status);

  function renderTabs() {
    if (!list) return;
    list.clear.hidden = !filtersOn();
    list.tabs.replaceChildren(
      ...TABS.map(([value, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: `tvx-chip${state.status === value ? ' is-on' : ''}`,
            'aria-pressed': state.status === value ? 'true' : 'false',
            onclick: () => {
              state.status = value;
              renderTabs();
              loadList();
            }
          },
          [label, h('span', { class: 'tvx-bk-count', text: state.counts ? String(state.counts[value || 'All'] || 0) : '' })]
        )
      )
    );
  }

  async function loadList({ append = false } = {}) {
    if (!list) return;
    const seq = ++state.listSeq;
    const params = new URLSearchParams();
    if (state.status) params.set('status', state.status);
    if (state.q) params.set('q', state.q);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    if (append && state.next) params.set('after', state.next);
    if (!append) list.results.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading bookings…' }));
    let data;
    try {
      data = await ctx.api.get(`/bookings${params.toString() ? `?${params}` : ''}`);
    } catch (err) {
      if (seq !== state.listSeq || state.view !== 'list') return;
      if (append) {
        // "Load more" failed: the rows already shown stay, with the error and the button to try again.
        renderRows();
        list.results.append(h('div', { class: 'tvx-msg tvx-msg-error tvx-bk-more-error', role: 'alert', text: `Could not load more bookings: ${errorText(err)}` }));
        return;
      }
      list.results.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => loadList() })
      );
      return;
    }
    // Only the answer to the newest request is shown (typing fast fires several).
    if (seq !== state.listSeq || state.view !== 'list') return;
    state.rows = append ? [...state.rows, ...(data.bookings || [])] : data.bookings || [];
    state.counts = data.counts || {};
    state.next = data.next || null;
    renderTabs();
    renderRows();
  }

  function renderRows() {
    if (!state.rows.length) {
      list.results.replaceChildren(
        h('div', { class: 'tvx-bk-empty' }, [
          h('p', { class: 'tvx-empty-title', text: filtersOn() ? 'No bookings match these filters.' : 'No bookings yet.' }),
          h('p', { class: 'tvx-muted', text: filtersOn() ? 'Change the search or the dates, or press Clear.' : 'An accepted quotation gets a “Create Booking” button.' })
        ])
      );
      return;
    }
    list.results.replaceChildren(
      h('ul', { class: 'tvx-bk-list' }, state.rows.map((b) => h('li', {}, [
        h('button', { type: 'button', class: 'tvx-bk-row', onclick: () => openBooking(b.id) }, [
          h('span', { class: 'tvx-bk-row-top' }, [h('span', { class: 'tvx-bk-row-number', text: b.number }), ui.statusPill(b.status)]),
          h('span', { class: 'tvx-bk-row-title', text: b.title || 'Booking' }),
          h('span', { class: 'tvx-bk-row-meta', text: [b.guest_name, b.destination, ui.fmtRange(b.travel_start_date, b.travel_end_date), b.quotation_no].filter(Boolean).join(' · ') })
        ])
      ]))),
      state.next
        ? h('button', {
          type: 'button',
          class: 'tvx-btn tvx-btn-ghost tvx-bk-more',
          text: 'Load more',
          onclick: (e) => {
            e.currentTarget.disabled = true;
            e.currentTarget.textContent = 'Loading…';
            loadList({ append: true });
          }
        })
        : null
    );
  }

  function openBooking(id) {
    go(`${PAGE}?id=${id}`);
    if (state.view !== 'detail' || state.id !== id) showDetail(id, '');
  }

  /* ============================================================== detail */

  function backBar() {
    return h('div', { class: 'tvx-bk-bar' }, [
      h('button', {
        type: 'button',
        class: 'tvx-btn tvx-btn-ghost',
        text: '← All bookings',
        onclick: () => {
          go(PAGE);
          if (state.view !== 'list') showList();
        }
      })
    ]);
  }

  async function showDetail(id, voucherId) {
    ui.closeDialogs(root); // dialogs of the booking that was shown
    state.view = 'detail';
    state.id = id;
    state.focusVoucher = voucherId || '';
    list = null;
    const seq = ++state.detailSeq;
    root.replaceChildren(backBar(), h('section', { class: 'tvx-card' }, [h('p', { class: 'tvx-loading', text: 'Loading booking…' })]));
    try {
      const data = await ctx.api.get(`/bookings/${encodeURIComponent(id)}`);
      if (seq !== state.detailSeq || state.id !== id) return;
      state.data = data;
      renderDetail();
    } catch (err) {
      if (seq !== state.detailSeq || state.id !== id) return;
      root.replaceChildren(
        backBar(),
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => showDetail(id, voucherId) })
      );
    }
  }

  /**
   * Re-reads the booking after a successful write. Never throws: the write is done, so its dialog closes
   * either way. When the re-read fails the page is out of date — every write control is disabled
   * (a second "Issue voucher" would make another version) until "Reload booking".
   */
  async function reload(notice) {
    const id = state.id;
    const seq = ++state.detailSeq;
    let data;
    try {
      data = await ctx.api.get(`/bookings/${encodeURIComponent(id)}`);
    } catch (err) {
      if (seq !== state.detailSeq || state.id !== id) return;
      markStale(notice, err);
      return;
    }
    if (seq !== state.detailSeq || state.id !== id) return;
    state.data = data;
    renderDetail();
    if (notice) showNotice(notice.kind || 'success', notice.text);
  }

  function markStale(notice, err) {
    state.stale = true;
    for (const el of root.querySelectorAll('button, input, select, textarea')) {
      if (!el.closest('.tvx-bk-bar') && !el.closest('.tvx-bx-overlay')) el.disabled = true;
    }
    const text = `${notice && notice.text ? `${notice.text}. ` : 'Saved. '}The booking could not be reloaded (${errorText(err)}) — reload it before changing anything else.`;
    showNotice('warn', text);
    toast(text, 'warning');
    if (noticeEl && noticeEl.isConnected) {
      noticeEl.after(h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary tvx-bk-reload', text: 'Reload booking', onclick: () => showDetail(state.id, '') }));
    }
  }

  function showNotice(kind, text) {
    if (!noticeEl) return;
    noticeEl.className = `tvx-msg tvx-msg-${kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'success'}`;
    noticeEl.textContent = text;
    noticeEl.hidden = !text;
  }

  /** A write button that runs once at a time and reports errors in the notice line. */
  function actionButton(label, kind, run, extra = {}) {
    const b = h('button', { type: 'button', class: `tvx-btn ${kind === 'primary' ? 'tvx-btn-primary' : kind === 'danger' ? 'tvx-btn-danger' : 'tvx-btn-ghost'}`, text: label, ...extra });
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      try {
        await run(b);
      } catch (err) {
        showNotice('error', errorText(err));
        toast(errorText(err), 'error');
      } finally {
        if (b.isConnected && !state.stale) b.disabled = false;
      }
    });
    return b;
  }

  function renderDetail() {
    const { booking, travellers = [], services = [], itineraries = [], can = {} } = state.data;
    const open = isOpen(booking);
    state.stale = false;
    noticeEl = h('div', { class: 'tvx-msg tvx-msg-success', role: 'status', hidden: true });
    root.replaceChildren(
      backBar(),
      headerCard(booking, can, open, services),
      noticeEl,
      travellersCard(booking, travellers, can, open),
      servicesCard(booking, services, can, open),
      itineraryCard(booking, itineraries, can),
      notesCard(booking, can)
    );
    if (state.focusVoucher) {
      // The id comes from the address bar (?voucher=…): escaped before it goes into a selector.
      const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(state.focusVoucher) : state.focusVoucher.replace(/[^a-zA-Z0-9_-]/g, '');
      const row = root.querySelector(`[data-voucher-id="${esc}"]`);
      if (row) {
        row.classList.add('is-focus');
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
      }
      state.focusVoucher = '';
    }
  }

  /* -------------------------------------------------------------- header */

  function headerCard(b, can, open, services) {
    const facts = [
      ['Guest', b.guest_name],
      ...(b.company_name ? [['Company', b.company_name]] : []),
      ['Travel dates', ui.fmtRange(b.travel_start_date, b.travel_end_date)],
      ['Destination', b.destination],
      ['Services', `${services.filter((s) => s.status === 'Confirmed').length} of ${services.filter((s) => s.status !== 'Cancelled').length} confirmed`]
    ];
    if (b.total !== undefined) facts.push(['Agreed total', ui.money(b.total, b.currency)]);
    const actions = [];
    if (can.write && open) {
      if (b.status === 'Confirmed') actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: 'Mark completed', onclick: () => completeDialog(b) }));
      actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-danger', text: 'Cancel booking', onclick: () => cancelBookingDialog(b) }));
    }
    return h('section', { class: 'tvx-card tvx-bk-header' }, [
      h('div', { class: 'tvx-bk-head-row' }, [
        h('div', { class: 'tvx-bk-head-text' }, [
          h('span', { class: 'tvx-eyebrow', text: 'Booking' }),
          h('h2', { class: 'tvx-bk-number', text: b.number }),
          h('p', { class: 'tvx-bk-title', text: b.title })
        ]),
        ui.statusPill(b.status, 'tvx-bk-status')
      ]),
      h('dl', { class: 'tvx-bk-facts' }, facts.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      h('div', { class: 'tvx-row-gap' }, [
        b.quotation_id ? h('button', { type: 'button', class: 'tvx-link-btn', text: `Quotation ${b.quotation_no || ''} v${b.quotation_version || 1}`.replace('  ', ' '), onclick: () => go(`/quotations/${b.quotation_id}`) }) : null,
        b.lead_id ? h('button', { type: 'button', class: 'tvx-link-btn', text: 'Lead', onclick: () => go(`/leads/${b.lead_id}`) }) : null,
        // The quotation's tax invoice (sent by the server only to users who may see finance).
        state.data && state.data.invoice && state.data.invoice.id
          ? h('button', {
            type: 'button',
            class: 'tvx-btn tvx-btn-ghost',
            'data-testid': 'booking-open-invoice',
            text: `Open Invoice${state.data.invoice.number ? ` ${state.data.invoice.number}` : ''}${state.data.invoice.status ? ` (${state.data.invoice.status})` : ''}`,
            onclick: () => go(`/invoices/${state.data.invoice.id}`)
          })
          : null
      ]),
      b.status === 'Cancelled' ? h('p', { class: 'tvx-msg tvx-msg-error', text: `Cancelled${b.cancelled_at ? ` on ${ui.fmtMoment(b.cancelled_at)}` : ''}: ${b.cancel_reason || 'no reason given'}` }) : null,
      b.status === 'Completed' ? h('p', { class: 'tvx-msg tvx-msg-success', text: `Completed${b.completed_at ? ` on ${ui.fmtMoment(b.completed_at)}` : ''}.` }) : null,
      actions.length ? h('div', { class: 'tvx-bk-actions' }, actions) : null
    ]);
  }

  function cancelBookingDialog(b) {
    const reason = ui.textarea({ maxlength: 1000, rows: 3 });
    ui.openDialog(root, {
      title: `Cancel booking ${b.number}`,
      intro: 'Every service is cancelled and issued vouchers become Cancelled. This cannot be undone.',
      content: [ui.field('Reason', reason, { required: true })],
      cancelLabel: 'Keep booking',
      actions: [{
        label: 'Cancel booking',
        kind: 'danger',
        onClick: async () => {
          if (!reason.value.trim()) throw new Error('A reason is required to cancel the booking');
          await ctx.api.post(`/bookings/${b.id}/cancel`, { reason: reason.value.trim() });
          await reload({ kind: 'success', text: `Booking ${b.number} cancelled` });
        }
      }]
    });
  }

  function completeDialog(b) {
    ui.openDialog(root, {
      title: `Mark ${b.number} completed`,
      intro: 'The trip is over and every service was delivered. A completed booking can no longer be changed.',
      actions: [{
        label: 'Mark completed',
        onClick: async () => {
          await ctx.api.post(`/bookings/${b.id}/complete`, {});
          await reload({ kind: 'success', text: `Booking ${b.number} completed` });
        }
      }]
    });
  }

  /* ----------------------------------------------------------- travellers */

  function travellersCard(b, travellers, can, open) {
    return h('section', { class: 'tvx-card tvx-bk-travellers' }, [
      h('div', { class: 'tvx-card-head' }, [
        h('h3', { class: 'tvx-h3', text: `Travellers (${travellers.length})` }),
        can.write && open ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Choose travellers', onclick: () => travellersDialog(b) }) : null
      ]),
      travellers.length
        ? h('ul', { class: 'tvx-bk-traveller-list' }, travellers.map((t) => h('li', { class: 'tvx-bk-traveller' }, [
          h('span', { class: 'tvx-bk-traveller-name', text: t.fullName }),
          h('span', { class: 'tvx-muted', text: [t.ageCategory, t.age !== null && t.age !== undefined ? `${t.age} yrs` : '', t.relation, t.nationality].filter(Boolean).join(' · ') }),
          t.passport && t.passport.numberMasked
            ? h('span', { class: 'tvx-muted tvx-mono', text: `Passport ${t.passport.numberMasked}${t.passport.expiryDate ? ` · expires ${ui.fmtDay(t.passport.expiryDate)}` : ''}` })
            : null,
          t.passport && t.passport.expiryWarning ? h('span', { class: 'tvx-warn', text: t.passport.expiryWarning === 'expired' ? 'Passport expired' : t.passport.expiryWarning === 'before_travel' ? 'Passport expires before the trip' : 'Passport valid < 6 months after the trip' }) : null
        ])))
        : h('p', { class: 'tvx-muted', text: 'No travellers on this booking yet.' })
    ]);
  }

  function travellersDialog(b) {
    let options = [];
    const chosen = new Set(b.traveller_ids || []);
    const added = new Set();
    let dlg;

    const listView = () => {
      if (!options.length) return [h('p', { class: 'tvx-muted', text: 'The lead has no travellers yet.' }), addButton()];
      return [
        h('ul', { class: 'tvx-bx-checks' }, options.map((t) => {
          const box = h('input', { type: 'checkbox', id: ui.nextId('tvx-bk-t'), checked: chosen.has(t.id) });
          box.addEventListener('change', () => {
            if (box.checked) chosen.add(t.id);
            else chosen.delete(t.id);
          });
          return h('li', {}, [
            box,
            h('label', { for: box.id }, [
              h('span', { text: t.fullName }),
              h('span', { class: 'tvx-muted', text: [t.ageCategory, t.relation, t.current ? '' : `from ${t.lead_title || 'another trip'}`, t.passport && t.passport.numberMasked ? `Passport ${t.passport.numberMasked}` : ''].filter(Boolean).join(' · ') })
            ])
          ]);
        })),
        addButton()
      ];
    };
    const addButton = () => h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost tvx-bk-add-traveller', text: '+ Add new traveller', onclick: () => showAddForm() });

    async function loadOptions() {
      const before = new Set(options.map((t) => t.id));
      const data = await ctx.api.get(`/bookings/${b.id}/traveller-options`);
      options = data.travellers || [];
      // A traveller added in the form below is ticked (ctx.onSaved, or anything new since the last load).
      for (const t of options) if (added.has(t.id) || (before.size && !before.has(t.id) && t.current)) chosen.add(t.id);
    }

    async function showAddForm() {
      dlg.setError('');
      dlg.showFooter(false);
      dlg.setContent([h('p', { class: 'tvx-loading', text: 'Opening the traveller form…' })]);
      try {
        const mod = await import('../lead-travellers/lead-travellers.js');
        useStyles(new URL('../lead-travellers/lead-travellers.css', import.meta.url));
        const form = document.createElement(mod.TAG);
        form.className = 'tvx-root tvx-bk-embed';
        form.ctx = {
          ...ctx,
          slot: 'lead.tab.travellers',
          record: { type: 'lead', id: b.lead_id, name: b.guest_name || '' },
          startWith: 'add',
          onSaved: (travellerId) => {
            if (travellerId) added.add(String(travellerId));
          },
          onDone: () => backToList(),
          onValuesChanged: () => () => {},
          onSettingsChanged: () => () => {}
        };
        dlg.setContent([
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: '← Back to the list', onclick: () => backToList() }),
          form
        ]);
      } catch (err) {
        dlg.showFooter(true);
        dlg.setContent(listView());
        dlg.setError(errorText(err));
      }
    }

    async function backToList() {
      dlg.setContent([h('p', { class: 'tvx-loading', text: 'Loading travellers…' })]);
      try {
        await loadOptions();
        dlg.setContent(listView());
      } catch (err) {
        dlg.setError(errorText(err));
      }
      dlg.showFooter(true);
    }

    dlg = ui.openDialog(root, {
      title: 'Choose travellers',
      intro: 'Travellers of this lead and of the contact’s other trips. Document numbers stay masked.',
      wide: true,
      content: [h('p', { class: 'tvx-loading', text: 'Loading travellers…' })],
      actions: [{
        label: 'Save travellers',
        onClick: async () => {
          const ids = options.filter((t) => chosen.has(t.id)).map((t) => t.id);
          await ctx.api.put(`/bookings/${b.id}`, { traveller_ids: ids });
          await reload({ kind: 'success', text: `${ids.length} traveller${ids.length === 1 ? '' : 's'} on the booking` });
        }
      }]
    });
    loadOptions()
      .then(() => dlg.setContent(listView()))
      .catch((err) => {
        dlg.setContent([]);
        dlg.setError(errorText(err));
      });
  }

  /* ------------------------------------------------------------- services */

  function servicesCard(b, services, can, open) {
    return h('section', { class: 'tvx-card tvx-bk-services' }, [
      h('div', { class: 'tvx-card-head' }, [
        h('div', {}, [
          h('h3', { class: 'tvx-h3', text: `Services (${services.length})` }),
          h('p', { class: 'tvx-sub', text: 'Confirm each service with its provider. Changing one service never changes another.' })
        ])
      ]),
      h('div', { class: 'tvx-bk-service-list' }, services.map((s) => serviceCard(b, s, can, open)))
    ]);
  }

  function serviceCard(b, s, can, open) {
    const facts = [
      ['Dates', ui.fmtRange(s.start_date, s.end_date)],
      ['Quantity', s.quantity !== null && s.quantity !== undefined ? `${s.quantity}${s.unit ? ` ${s.unit}` : ''}` : ''],
      ['Provider', s.provider],
      ['When quoted', s.availability && (s.availability.status || s.availability.provider)
        ? [s.availability.status, s.availability.provider, s.availability.valid_until ? `valid until ${ui.fmtMoment(s.availability.valid_until)}` : ''].filter(Boolean).join(' · ')
        : ''],
      ['Requested', s.requested_at ? ui.fmtMoment(s.requested_at) : ''],
      ['Confirmation ref.', s.status === 'Confirmed' ? s.confirmation_ref : ''],
      ['Confirmed at', s.status === 'Confirmed' && s.confirmed_at ? ui.fmtMoment(s.confirmed_at) : ''],
      ['Final details', s.status === 'Confirmed' ? s.final_details : ''],
      ['Cancel reason', s.status === 'Cancelled' ? s.cancel_reason : '']
    ];
    if (s.rate !== undefined) facts.push(['Rate / amount', `${ui.money(s.rate, b.currency)} · ${ui.money(s.amount, b.currency)}`]);
    const editable = can.write && open && s.status !== 'Cancelled';
    const actions = [];
    if (editable) {
      if (s.status === 'Not Requested' || s.status === 'Unavailable') {
        actions.push(actionButton('Mark requested', 'ghost', async () => {
          await ctx.api.post(`/booking-services/${s.id}/request`, {});
          await reload({ kind: 'success', text: `${s.name}: requested from the provider` });
        }));
      }
      actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: 'Confirm service', onclick: () => confirmDialog(b, s) }));
      actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-danger', text: 'Cancel service', onclick: () => cancelServiceDialog(s) }));
    }
    const history = s.confirmations || [];
    return h('article', { class: `tvx-bk-service${s.status === 'Cancelled' ? ' is-cancelled' : ''}`, 'data-service-id': s.id }, [
      h('div', { class: 'tvx-bk-service-head' }, [
        h('div', { class: 'tvx-bk-service-title' }, [
          h('h4', { class: 'tvx-h4', text: s.name }),
          s.description ? h('p', { class: 'tvx-muted', text: s.description }) : null
        ]),
        ui.statusPill(s.status)
      ]),
      h('dl', { class: 'tvx-bk-facts' }, facts.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      s.evidence_file_id && s.status === 'Confirmed'
        ? h('div', {}, [actionButton('View evidence', 'link', () => ui.downloadFile(ctx, `/booking-services/${s.id}/files/${s.evidence_file_id}`, 'evidence'), { class: 'tvx-link-btn' })])
        : null,
      s.details && s.details.length
        ? h('details', { class: 'tvx-bk-more-info' }, [
          h('summary', { text: 'Service details' }),
          h('dl', { class: 'tvx-bk-facts' }, s.details.flatMap((d) => [h('dt', { text: d.label }), h('dd', { text: d.value })]))
        ])
        : null,
      actions.length ? h('div', { class: 'tvx-bk-actions' }, actions) : null,
      history.length
        ? h('details', { class: 'tvx-bk-history' }, [
          h('summary', { text: `Confirmation history (${history.length})` }),
          h('ol', {}, history.map((c) => h('li', {}, [
            h('span', { class: 'tvx-bk-history-head' }, [ui.statusPill(c.status), h('span', { class: 'tvx-muted', text: `${ui.fmtMoment(c.at)}${c.by ? ` · ${c.by}` : ''}` })]),
            h('span', { class: 'tvx-bk-history-text', text: [c.provider, c.confirmation_ref ? `ref ${c.confirmation_ref}` : '', c.final_details, c.notes].filter(Boolean).join(' · ') || historyLabel(c.action) }),
            c.evidence_file_id ? actionButton('Evidence', 'link', () => ui.downloadFile(ctx, `/booking-services/${s.id}/files/${c.evidence_file_id}`, 'evidence'), { class: 'tvx-link-btn' }) : null
          ])))
        ])
        : null,
      ISSUABLE.includes(s.voucher_type) ? vouchersBlock(b, s, can, open) : documentsBlock(b, s, can, open)
    ]);
  }

  function historyLabel(action) {
    return { request: 'Requested from the provider', cancel: 'Cancelled', confirm: 'Updated' }[action] || '';
  }

  function confirmDialog(b, s) {
    const status = ui.select(CONFIRM_STATUSES, s.status === 'Confirmed' || s.status === 'Not Requested' || s.status === 'Requested' || s.status === 'Unavailable' ? 'Confirmed' : 'Confirmed', { 'aria-label': 'Status' });
    const provider = ui.input({ value: s.provider || (s.availability && s.availability.provider) || '', maxlength: 120 });
    const ref = ui.input({ value: s.status === 'Confirmed' ? s.confirmation_ref : '', maxlength: 80, placeholder: 'e.g. HX123' });
    const at = ui.input({ type: 'datetime-local', value: ui.toLocalInput(s.status === 'Confirmed' && s.confirmed_at ? s.confirmed_at : '') });
    const details = ui.textarea({ maxlength: 2000, value: s.status === 'Confirmed' ? s.final_details : '', placeholder: 'Room type, meal plan, pick-up time…' });
    const evidence = h('input', { type: 'file', class: 'tvx-input tvx-bk-file', accept: 'application/pdf,image/jpeg,image/png,image/webp' });
    const notes = ui.textarea({ maxlength: 2000 });
    const confirmedOnly = [
      ui.field('Confirmation reference', ref),
      ui.field('Confirmed at', at),
      ui.field('Final confirmed details', details, { full: true }),
      ui.field('Evidence file', evidence, { full: true, help: s.has_evidence && s.status === 'Confirmed' ? 'Evidence is on file — choose a file only to replace it. PDF up to 700 KB or a photo.' : 'The provider’s confirmation: PDF up to 700 KB or a photo.' })
    ];
    const notesField = ui.field('Notes', notes, { full: true, help: 'Internal — never printed on vouchers.' });
    const sync = () => {
      const confirmed = status.value === 'Confirmed';
      for (const f of confirmedOnly) f.hidden = !confirmed;
      notesField.querySelector('.tvx-label').firstChild.textContent = confirmed ? 'Notes' : 'Notes (required)';
    };
    status.addEventListener('change', sync);
    sync();
    ui.openDialog(root, {
      title: `Confirm service — ${s.name}`,
      wide: true,
      content: [
        h('dl', { class: 'tvx-bx-readonly' }, [
          ['Service', s.name],
          ['Dates', ui.fmtRange(s.start_date, s.end_date)],
          ['Quantity', s.quantity !== null && s.quantity !== undefined ? `${s.quantity}${s.unit ? ` ${s.unit}` : ''}` : ''],
          ['When quoted', s.availability ? [s.availability.status, s.availability.provider].filter(Boolean).join(' · ') : '']
        ].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
        h('div', { class: 'tvx-grid tvx-grid-2' }, [ui.field('Status', status), ui.field('Provider', provider), ...confirmedOnly, notesField])
      ],
      actions: [{
        label: 'Save',
        onClick: async () => {
          const value = status.value;
          if ((value === 'Unavailable' || value === 'Cancelled') && !notes.value.trim()) {
            throw new Error(`Add a note: why is the service ${value.toLowerCase()}?`);
          }
          const file = evidence.files && evidence.files[0];
          if (value === 'Confirmed') {
            const rule = (state.data.rules && state.data.rules.confirmation_evidence) || 'reference_or_file';
            const hasRef = Boolean(ref.value.trim());
            const hasFile = Boolean(file) || (s.status === 'Confirmed' && s.has_evidence);
            if (rule === 'reference_or_file' && !hasRef && !hasFile) throw new Error('Add the provider’s confirmation reference or an evidence file');
            if (rule === 'reference' && !hasRef) throw new Error('Add the provider’s confirmation reference');
            if (rule === 'file' && !hasFile) throw new Error('Attach an evidence file (the provider’s confirmation)');
          }
          const body = { status: value, provider: provider.value.trim(), notes: notes.value.trim() };
          if (value === 'Confirmed') {
            body.confirmation_ref = ref.value.trim();
            body.confirmed_at = ui.fromLocalInput(at.value);
            body.final_details = details.value.trim();
            if (file) body.evidence = await ui.readUpload(file);
          }
          const res = await ctx.api.post(`/booking-services/${s.id}/confirm`, body);
          const outdated = res && res.vouchers && res.vouchers.outdated;
          await reload({
            kind: outdated ? 'warn' : 'success',
            text: outdated ? `${s.name}: ${value}. The details changed — reissue the voucher.` : `${s.name}: ${value}`
          });
        }
      }]
    });
  }

  function cancelServiceDialog(s) {
    const reason = ui.textarea({ maxlength: 1000 });
    ui.openDialog(root, {
      title: `Cancel ${s.name}`,
      intro: 'Only this service is cancelled; its issued vouchers become Cancelled.',
      content: [ui.field('Reason', reason, { required: true })],
      cancelLabel: 'Keep service',
      actions: [{
        label: 'Cancel service',
        kind: 'danger',
        onClick: async () => {
          if (!reason.value.trim()) throw new Error('A reason is required to cancel this service');
          await ctx.api.post(`/booking-services/${s.id}/cancel`, { reason: reason.value.trim() });
          await reload({ kind: 'success', text: `${s.name} cancelled` });
        }
      }]
    });
  }

  /* ------------------------------------------------------------- vouchers */

  function vouchersBlock(b, s, can, open) {
    const vouchers = s.vouchers || [];
    const live = vouchers.find(liveVoucher);
    // Server rule: a Confirmed service and the full payment verified (the server checks it again).
    const gate = (state.data && state.data.voucher_gate) || {};
    const paid = !gate.requires_full_payment || gate.paid_in_full === true;
    const canIssue = can.issue && open && s.status === 'Confirmed' && paid;
    const waiting = s.status !== 'Confirmed'
      ? 'A voucher can be issued once the service is Confirmed.'
      : !paid
        ? 'A voucher can be issued once the full payment is verified.'
        : 'No voucher issued yet.';
    return h('div', { class: 'tvx-bk-block' }, [
      h('div', { class: 'tvx-bk-block-head' }, [
        h('h5', { class: 'tvx-bk-block-title', text: 'Voucher' }),
        canIssue ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: live ? 'Reissue voucher' : 'Issue voucher', onclick: () => issueDialog(b, s, live) }) : null
      ]),
      vouchers.length
        ? h('ul', { class: 'tvx-bk-vouchers' }, vouchers.map((v) => voucherRow(b, s, v, can)))
        : h('p', { class: 'tvx-muted', text: waiting })
    ]);
  }

  function whatsappText(b, s, v) {
    const when = ui.fmtRange(s.start_date, s.end_date);
    return `Your ${TYPE_LABEL[v.type] || 'service'} voucher ${v.number} (v${v.version}) for booking ${b.number}: ${s.name}${when ? `, ${when}` : ''}${s.confirmation_ref ? `, confirmation ${s.confirmation_ref}` : ''}.`;
  }

  function voucherRow(b, s, v, can) {
    const live = v.status === 'Issued' || v.status === 'Sent';
    const meta = [
      v.issued_at ? `Issued ${ui.fmtMoment(v.issued_at)}${v.issued_by ? ` by ${v.issued_by}` : ''}` : '',
      v.status === 'Sent' && v.sent_channel ? `via ${v.sent_channel}${v.sent_to ? ` to ${v.sent_to}` : ''}` : '',
      v.status === 'Used' && v.used_at ? `used ${ui.fmtMoment(v.used_at)}` : '',
      v.status === 'Cancelled' ? v.cancel_reason : ''
    ].filter(Boolean);
    const actions = [];
    if (v.has_file) actions.push(actionButton('Download PDF', 'ghost', () => ui.downloadFile(ctx, `/vouchers/${v.id}/file`, `${v.number}-v${v.version}.pdf`)));
    if (live) {
      actions.push(actionButton('Copy link', 'ghost', async () => {
        const url = ui.pageUrl(`${PAGE}?id=${b.id}&voucher=${v.id}`);
        const copied = await ui.copyText(url);
        showNotice('success', copied ? `Link copied: ${url}` : `Copy this link: ${url}`);
      }));
      actions.push(h('a', { class: 'tvx-btn tvx-btn-ghost', href: `https://wa.me/?text=${encodeURIComponent(whatsappText(b, s, v))}`, target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp' }));
      if (can.issue) {
        if (v.status === 'Issued') actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Mark sent', onclick: () => sentDialog(v) }));
        actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Mark used', onclick: () => usedDialog(v) }));
        actions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-danger', text: 'Cancel voucher', onclick: () => cancelVoucherDialog(v) }));
      }
    }
    return h('li', { class: 'tvx-bk-voucher', 'data-voucher-id': v.id }, [
      h('div', { class: 'tvx-bk-voucher-main' }, [
        h('span', { class: 'tvx-bk-voucher-no', text: `${v.number} · v${v.version}` }),
        ui.statusPill(v.status),
        v.outdated && live ? h('span', { class: 'tvx-bx-pill is-warn tvx-bk-outdated', text: 'Details changed — reissue' }) : null,
        meta.length ? h('span', { class: 'tvx-muted', text: meta.join(' · ') }) : null
      ]),
      actions.length ? h('div', { class: 'tvx-bk-voucher-actions' }, actions) : null
    ]);
  }

  function issueDialog(b, s, live) {
    const label = live ? 'Reissue voucher' : 'Issue voucher';
    ui.openDialog(root, {
      title: label,
      intro: live
        ? `A new version of ${live.number} is drawn from the current details; v${live.version} is marked Superseded.`
        : 'The voucher PDF is drawn from the confirmed details. Prices are never printed.',
      content: [
        h('dl', { class: 'tvx-bx-readonly' }, [
          ['Service', s.name],
          ['Dates', ui.fmtRange(s.start_date, s.end_date)],
          ['Provider', s.provider],
          ['Confirmation ref.', s.confirmation_ref],
          ['Travellers', String((state.data.travellers || []).length)]
        ].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))
      ],
      actions: [{
        label,
        onClick: async () => {
          const res = await ctx.api.post(`/booking-services/${s.id}/vouchers`, {});
          const v = res && res.voucher;
          await reload({ kind: 'success', text: v ? `Voucher ${v.number} v${v.version} issued` : 'Voucher issued' });
        }
      }]
    });
  }

  function sentDialog(v) {
    const channel = ui.select(CHANNELS, 'WhatsApp');
    const to = ui.input({ maxlength: 120, placeholder: 'Phone or email (optional)' });
    ui.openDialog(root, {
      title: `Mark ${v.number} v${v.version} sent`,
      content: [h('div', { class: 'tvx-grid tvx-grid-2' }, [ui.field('Sent by', channel), ui.field('Sent to', to)])],
      actions: [{
        label: 'Mark sent',
        onClick: async () => {
          await ctx.api.post(`/vouchers/${v.id}/sent`, { channel: channel.value, to: to.value.trim() });
          await reload({ kind: 'success', text: `${v.number} v${v.version} marked sent` });
        }
      }]
    });
  }

  function usedDialog(v) {
    ui.openDialog(root, {
      title: `Mark ${v.number} v${v.version} used`,
      intro: 'The service was delivered against this voucher.',
      actions: [{
        label: 'Mark used',
        onClick: async () => {
          await ctx.api.post(`/vouchers/${v.id}/used`, {});
          await reload({ kind: 'success', text: `${v.number} v${v.version} marked used` });
        }
      }]
    });
  }

  function cancelVoucherDialog(v) {
    const reason = ui.textarea({ maxlength: 500 });
    ui.openDialog(root, {
      title: `Cancel ${v.number} v${v.version}`,
      intro: 'The PDF is redrawn with a CANCELLED watermark.',
      content: [ui.field('Reason', reason, { required: true })],
      cancelLabel: 'Keep voucher',
      actions: [{
        label: 'Cancel voucher',
        kind: 'danger',
        onClick: async () => {
          if (!reason.value.trim()) throw new Error('A reason is required to cancel the voucher');
          await ctx.api.post(`/vouchers/${v.id}/cancel`, { reason: reason.value.trim() });
          await reload({ kind: 'success', text: `${v.number} v${v.version} cancelled` });
        }
      }]
    });
  }

  /* ---------------------------------------------------- provider documents */

  function documentsBlock(b, s, can, open) {
    const docs = s.documents || [];
    const editable = can.write && open && s.status !== 'Cancelled';
    const upload = editable ? h('input', { type: 'file', class: 'tvx-input tvx-bk-file', accept: 'application/pdf,image/jpeg,image/png,image/webp', 'aria-label': `Upload a document for ${s.name}` }) : null;
    const status = h('p', { class: 'tvx-muted', role: 'status' });
    if (upload) {
      upload.addEventListener('change', async () => {
        const file = upload.files && upload.files[0];
        if (!file || upload.disabled) return;
        upload.disabled = true;
        status.textContent = `Uploading ${file.name}…`;
        try {
          const add = await ui.readUpload(file);
          await ctx.api.put(`/booking-services/${s.id}/documents`, { add });
          await reload({ kind: 'success', text: `${file.name} added to ${s.name}` });
          status.textContent = '';
        } catch (err) {
          status.textContent = '';
          showNotice('error', errorText(err));
          if (upload.isConnected) {
            upload.disabled = false;
            upload.value = '';
          }
        }
      });
    }
    return h('div', { class: 'tvx-bk-block' }, [
      h('div', { class: 'tvx-bk-block-head' }, [h('h5', { class: 'tvx-bk-block-title', text: s.voucher_type === 'ticket' ? 'Tickets from the provider' : 'Provider documents' })]),
      docs.length
        ? h('ul', { class: 'tvx-bk-docs' }, docs.map((d) => h('li', {}, [
          h('span', { class: 'tvx-bk-doc-name', text: d.name }),
          h('span', { class: 'tvx-muted', text: [d.size ? `${Math.max(1, Math.round(d.size / 1024))} KB` : '', d.added_at ? ui.fmtMoment(d.added_at) : '', d.added_by].filter(Boolean).join(' · ') }),
          h('span', { class: 'tvx-bk-doc-actions' }, [
            actionButton('Download', 'ghost', () => ui.downloadFile(ctx, `/booking-services/${s.id}/files/${d.id}`, d.name)),
            editable ? removeButton(s, d) : null
          ])
        ])))
        : h('p', { class: 'tvx-muted', text: s.voucher_type === 'ticket' ? 'Tickets are issued by the airline / operator — upload them here.' : 'No documents yet.' }),
      upload ? ui.field('Upload ticket / confirmation (PDF up to 700 KB or a photo)', upload) : null,
      status
    ]);
  }

  /** Remove asks once more (second click), ignores a fast double click, and runs one request at a time. */
  function removeButton(s, d) {
    const b = h('button', { type: 'button', class: 'tvx-btn tvx-btn-danger', text: 'Remove', 'aria-label': `Remove ${d.name}` });
    let armedAt = 0;
    let timer = null;
    const disarm = () => {
      armedAt = 0;
      b.textContent = 'Remove';
    };
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      const now = Date.now();
      if (!armedAt) {
        armedAt = now;
        b.textContent = 'Click again to remove';
        clearTimeout(timer);
        timer = setTimeout(disarm, 4000);
        return;
      }
      if (now - armedAt < 400) return; // the second half of a double click is not a confirmation
      clearTimeout(timer);
      b.disabled = true;
      try {
        await ctx.api.put(`/booking-services/${s.id}/documents`, { remove: d.id });
        await reload({ kind: 'success', text: `${d.name} removed (kept in the history)` });
      } catch (err) {
        showNotice('error', errorText(err));
        if (b.isConnected) {
          b.disabled = false;
          disarm();
        }
      }
    });
    return b;
  }

  /* ------------------------------------------------------ itinerary, notes */

  function itineraryCard(b, itineraries, can) {
    const draft = itineraries.find((i) => i.status === 'Draft');
    return h('section', { class: 'tvx-card tvx-bk-itinerary' }, [
      h('div', { class: 'tvx-card-head' }, [
        h('div', {}, [h('h3', { class: 'tvx-h3', text: 'Itinerary' }), h('p', { class: 'tvx-sub', text: 'Day-by-day plan generated from the quotation.' })]),
        can.itinerary && !itineraries.length
          ? actionButton('Generate itinerary', 'primary', async () => {
            const res = await ctx.api.post('/itineraries/from-quotation', { recordId: b.quotation_id, recordType: 'quotation' });
            go(res && res.navigate ? res.navigate : `${ITINERARY_PAGE}?id=${res.itinerary.id}`);
          })
          : null
      ]),
      itineraries.length
        ? h('ul', { class: 'tvx-bk-itins' }, itineraries.map((it) => h('li', {}, [
          h('span', { class: 'tvx-bk-itin-name', text: `Itinerary v${it.version}` }),
          ui.statusPill(it.status),
          h('span', { class: 'tvx-muted', text: [it.title, ui.fmtRange(it.start_date, it.end_date)].filter(Boolean).join(' · ') }),
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: it === draft ? 'Open draft' : 'Open', 'aria-label': `Open itinerary v${it.version}`, onclick: () => go(`${ITINERARY_PAGE}?id=${it.id}`) })
        ])))
        : h('p', { class: 'tvx-muted', text: 'No itinerary yet.' })
    ]);
  }

  function notesCard(b, can) {
    if (!can.write) {
      return h('section', { class: 'tvx-card' }, [h('h3', { class: 'tvx-h3', text: 'Notes' }), h('p', { class: 'tvx-muted tvx-bk-notes-text', text: b.notes || 'No notes.' })]);
    }
    const notes = ui.textarea({ maxlength: 3000, rows: 4, value: b.notes || '', 'aria-label': 'Booking notes' });
    return h('section', { class: 'tvx-card' }, [
      h('h3', { class: 'tvx-h3', text: 'Notes' }),
      notes,
      h('div', { class: 'tvx-bk-actions' }, [
        actionButton('Save notes', 'ghost', async () => {
          await ctx.api.put(`/bookings/${b.id}`, { notes: notes.value });
          state.data.booking.notes = notes.value;
          showNotice('success', 'Notes saved');
        })
      ])
    ]);
  }

  subscribe(root, ctx, 'onQueryChange', (q) => route(q || {}));
  route(ctx.query || {});
}

class BookingsPage extends TravelElement {
  start(ctx) {
    renderBookingsPage(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-bookings-page-v1', BookingsPage);
