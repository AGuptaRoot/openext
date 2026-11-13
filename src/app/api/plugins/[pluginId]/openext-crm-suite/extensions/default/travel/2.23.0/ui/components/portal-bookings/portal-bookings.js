/**
 * <x-travel-portal-bookings-v1>: "Bookings" in the client portal (json/navigation.json, audience "portal").
 *
 * The client's own bookings: destination, dates, travellers, booking and payment status, the quotation;
 * a booking (?id=) shows its services, tickets / confirmation documents and vouchers. Downloads are
 * offered only when the server says the booking is paid in full — and the server checks again on
 * every download, so a disabled button is never the only guard.
 *
 * Backend: GET /portal/bookings, GET /portal/bookings/:id,
 *          GET /portal/vouchers/:id/file, GET /portal/booking-services/:id/files/:file_id
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import * as ui from '../../shared/booking-ui.js';

useStyles(new URL('./portal-bookings.css', import.meta.url));

const ID_RE = /^[a-f0-9]{24}$/i;
const PAYMENT_NOTE = 'Complete the remaining payment to download tickets and vouchers.';
const VOUCHER_LABEL = { hotel: 'Hotel voucher', transport: 'Transport voucher', excursion: 'Excursion voucher' };

function renderPortalBookings(root, ctx) {
  root.classList.add('tvx-bx', 'tvx-pb');
  const state = { view: '', id: '' };
  const go = (path) => {
    if (typeof ctx.navigate === 'function') ctx.navigate(path);
  };

  const errorBox = (err, retry) => [
    h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
    h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: retry })
  ];

  const paymentBlock = (p) =>
    h('dl', { class: 'tvx-pb-pay' }, [
      h('div', {}, [h('dt', { text: 'Payment' }), h('dd', {}, [ui.statusPill(p.status)])]),
      h('div', {}, [h('dt', { text: 'Total' }), h('dd', { text: ui.money(p.total, p.currency) })]),
      h('div', {}, [h('dt', { text: 'Paid' }), h('dd', { text: ui.money(p.paid, p.currency) })]),
      h('div', {}, [h('dt', { text: 'Balance' }), h('dd', { text: ui.money(p.balance, p.currency) })])
    ]);

  /* ---------------------------------------------------------------- list */

  async function showList() {
    state.view = 'list';
    state.id = '';
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading your bookings…' }));
    let data;
    try {
      data = await ctx.api.get('/portal/bookings');
    } catch (err) {
      root.replaceChildren(...errorBox(err, () => showList()));
      return;
    }
    const items = data.items || [];
    root.replaceChildren(
      h('section', { class: 'tvx-card' }, [
        h('h3', { class: 'tvx-h3', text: `Your bookings (${items.length})` }),
        items.length
          ? h('ul', { class: 'tvx-pb-list' }, items.map((b) =>
            h('li', { class: 'tvx-pb-row' }, [
              h('div', { class: 'tvx-pb-main' }, [
                h('span', { class: 'tvx-pb-title' }, [
                  h('span', { class: 'tvx-pb-number', text: b.number }),
                  ui.statusPill(b.status),
                  ui.statusPill(b.payment.status)
                ]),
                h('span', { class: 'tvx-pb-dest', text: [b.destination || b.title, b.dates].filter(Boolean).join(' · ') }),
                h('span', {
                  class: 'tvx-muted',
                  text: [
                    b.travellers.length ? `Travellers: ${b.travellers.join(', ')}` : '',
                    b.quotation_no ? `Quotation ${b.quotation_no}` : ''
                  ].filter(Boolean).join(' · ')
                }),
                b.payment.status !== 'Paid'
                  ? h('span', { class: 'tvx-pb-note', text: `Balance ${ui.money(b.payment.balance, b.payment.currency)} — ${PAYMENT_NOTE}` })
                  : null
              ]),
              h('button', {
                type: 'button',
                class: 'tvx-btn tvx-btn-ghost',
                text: 'View',
                'aria-label': `View booking ${b.number}`,
                onclick: () => go(`/ext/travel/my-bookings?id=${b.id}`)
              })
            ])))
          : h('p', { class: 'tvx-muted', text: 'No bookings yet. A booking appears here once your quotation is confirmed by payment.' })
      ])
    );
  }

  /* -------------------------------------------------------------- detail */

  async function download(btn, path, name) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Preparing…';
    try {
      await ui.downloadFile(ctx, path, name);
    } catch (err) {
      if (typeof ctx.toast === 'function') ctx.toast(errorText(err), 'error');
      else root.prepend(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function downloadButton(text, allowed, path, name) {
    const btn = h('button', {
      type: 'button',
      class: allowed ? 'tvx-btn' : 'tvx-btn tvx-btn-ghost',
      text,
      disabled: !allowed,
      'aria-disabled': allowed ? 'false' : 'true',
      title: allowed ? '' : PAYMENT_NOTE
    });
    if (allowed) btn.addEventListener('click', () => download(btn, path, name));
    return btn;
  }

  async function showDetail(id) {
    state.view = 'detail';
    state.id = id;
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading booking…' }));
    let data;
    try {
      data = await ctx.api.get(`/portal/bookings/${encodeURIComponent(id)}`);
    } catch (err) {
      root.replaceChildren(...errorBox(err, () => showDetail(id)));
      return;
    }
    const b = data.booking;
    const allowed = Boolean(b.downloads_allowed);
    const serviceName = new Map((b.services || []).map((s) => [s.id, s.name]));

    root.replaceChildren(
      h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost tvx-pb-back', text: '← All bookings', onclick: () => go('/ext/travel/my-bookings') }),
      h('section', { class: 'tvx-card' }, [
        h('div', { class: 'tvx-pb-head' }, [
          h('h3', { class: 'tvx-h3', text: `Booking ${b.number}` }),
          ui.statusPill(b.status)
        ]),
        h('p', { class: 'tvx-pb-dest', text: [b.destination || b.title, b.dates].filter(Boolean).join(' · ') }),
        b.travellers.length ? h('p', { class: 'tvx-muted', text: `Travellers: ${b.travellers.join(', ')}` }) : null,
        b.quotation_no ? h('p', { class: 'tvx-muted', text: `Quotation ${b.quotation_no}` }) : null,
        paymentBlock(b.payment),
        allowed
          ? h('p', { class: 'tvx-msg tvx-msg-success', text: 'Paid in full — your tickets and vouchers are ready to download.' })
          : h('p', { class: 'tvx-msg tvx-msg-warn', role: 'status', text: b.downloads_note || PAYMENT_NOTE })
      ]),
      h('section', { class: 'tvx-card' }, [
        h('h3', { class: 'tvx-h3', text: 'Services' }),
        (b.services || []).length
          ? h('ul', { class: 'tvx-pb-list' }, b.services.map((s) =>
            h('li', { class: 'tvx-pb-row' }, [
              h('div', { class: 'tvx-pb-main' }, [
                h('span', { class: 'tvx-pb-title' }, [h('span', { class: 'tvx-pb-number', text: s.name }), ui.statusPill(s.status)]),
                s.dates ? h('span', { class: 'tvx-muted', text: s.dates }) : null,
                s.reference ? h('span', { class: 'tvx-muted', text: `Reference: ${s.reference}` }) : null
              ]),
              s.documents.length
                ? h('div', { class: 'tvx-pb-actions' }, s.documents.map((d) =>
                  downloadButton(
                    d.kind === 'ticket' ? `Download Ticket — ${d.name}` : `Download Confirmation — ${d.name}`,
                    allowed && d.downloadable,
                    `/portal/booking-services/${encodeURIComponent(s.id)}/files/${encodeURIComponent(d.id)}`,
                    d.name
                  )))
                : null
            ])))
          : h('p', { class: 'tvx-muted', text: 'No services on this booking yet.' })
      ]),
      h('section', { class: 'tvx-card' }, [
        h('h3', { class: 'tvx-h3', text: 'Vouchers' }),
        (b.vouchers || []).length
          ? h('ul', { class: 'tvx-pb-list' }, b.vouchers.map((v) =>
            h('li', { class: 'tvx-pb-row' }, [
              h('div', { class: 'tvx-pb-main' }, [
                h('span', { class: 'tvx-pb-title' }, [h('span', { class: 'tvx-pb-number', text: v.number }), ui.statusPill(v.status)]),
                h('span', { class: 'tvx-muted', text: [VOUCHER_LABEL[v.type] || 'Voucher', serviceName.get(v.service_id)].filter(Boolean).join(' · ') })
              ]),
              downloadButton('Download Voucher', allowed && v.downloadable, `/portal/vouchers/${encodeURIComponent(v.id)}/file`, `${v.number}.pdf`)
            ])))
          : h('p', { class: 'tvx-muted', text: 'Your vouchers appear here once the services are confirmed.' })
      ])
    );
  }

  function route(query) {
    const id = String((query || {}).id || '');
    if (ID_RE.test(id)) {
      if (state.view !== 'detail' || state.id !== id) showDetail(id);
    } else if (state.view !== 'list') {
      showList();
    }
  }

  subscribe(root, ctx, 'onQueryChange', (q) => route(q || {}));
  route(ctx.query || {});
}

class PortalBookings extends TravelElement {
  start(ctx) {
    renderPortalBookings(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-portal-bookings-v1', PortalBookings);
