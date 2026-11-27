/**
 * <x-travel-quotation-travel-v1>: "Booking & itinerary" section on a CRM quotation (json/tabs.json →
 * quotationDetail). The booking made from this quotation ("Booking BK-0007 →") or a Create booking
 * button once it is accepted, and the quotation's itinerary versions (open the draft, generate one).
 *
 * Backend: GET /quotations/:quotation_id/travel, POST /bookings/from-quotation, POST /itineraries/from-quotation
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import * as ui from '../../shared/booking-ui.js';

useStyles(new URL('./quotation-travel.css', import.meta.url));

function renderQuotationTravel(root, ctx) {
  root.classList.add('tvx-bx', 'tvx-qt');
  const quotationId = String((ctx.record && ctx.record.id) || '');
  const go = (path) => {
    if (typeof ctx.navigate === 'function') ctx.navigate(path);
  };
  const message = h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', hidden: true });

  function busy(label, kind, run) {
    const b = h('button', { type: 'button', class: `tvx-btn ${kind === 'primary' ? 'tvx-btn-primary' : 'tvx-btn-ghost'}`, text: label });
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      message.hidden = true;
      try {
        await run();
      } catch (err) {
        message.textContent = errorText(err && err.code === 'BOOKING_EXISTS' ? { message: err.message } : err);
        message.hidden = false;
        if (err && err.code === 'BOOKING_EXISTS') load();
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    });
    return b;
  }

  async function load() {
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading…' }));
    let data;
    try {
      data = await ctx.api.get(`/quotations/${encodeURIComponent(quotationId)}/travel`);
    } catch (err) {
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load() })
      );
      return;
    }
    const { booking, itineraries = [], quotation = {} } = data;
    const draft = itineraries.find((i) => i.status === 'Draft');

    const bookingPart = booking
      ? h('div', { class: 'tvx-qt-line' }, [
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: `Booking ${booking.number} →`, onclick: () => go(`/ext/travel/bookings?id=${booking.id}`) }),
        ui.statusPill(booking.status)
      ])
      : data.canCreateBooking
        ? h('div', { class: 'tvx-qt-line' }, [
          busy('Create booking', 'primary', async () => {
            const res = await ctx.api.post('/bookings/from-quotation', { recordId: quotationId, recordType: 'quotation' });
            if (typeof ctx.recordChanged === 'function') ctx.recordChanged();
            if (res && res.navigate) go(res.navigate);
            else load();
          }),
          h('span', { class: 'tvx-muted', text: 'One booking service per quotation line.' })
        ])
        : h('p', { class: 'tvx-muted', text: quotation.status === 'Accepted' ? 'No booking yet.' : 'A booking can be made once the quotation is accepted.' });

    const itineraryActions = [];
    if (draft) itineraryActions.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Open draft itinerary', onclick: () => go(`/ext/travel/itinerary?id=${draft.id}`) }));
    else if (data.canGenerate) {
      itineraryActions.push(busy('Generate itinerary', 'ghost', async () => {
        const res = await ctx.api.post('/itineraries/from-quotation', { recordId: quotationId, recordType: 'quotation' });
        go(res && res.navigate ? res.navigate : `/ext/travel/itinerary?id=${res.itinerary.id}`);
      }));
    }

    root.replaceChildren(
      h('div', { class: 'tvx-qt-section' }, [h('h3', { class: 'tvx-h4', text: 'Booking' }), bookingPart]),
      h('div', { class: 'tvx-qt-section' }, [
        h('div', { class: 'tvx-qt-head' }, [h('h3', { class: 'tvx-h4', text: 'Itinerary' }), ...itineraryActions]),
        itineraries.length
          ? h('ul', { class: 'tvx-qt-list' }, itineraries.map((it) => h('li', {}, [
            h('span', { class: 'tvx-qt-name', text: `Itinerary v${it.version}` }),
            ui.statusPill(it.status),
            h('span', { class: 'tvx-muted', text: ui.fmtRange(it.start_date, it.end_date) }),
            h('button', { type: 'button', class: 'tvx-link-btn', text: 'Open', 'aria-label': `Open itinerary v${it.version}`, onclick: () => go(`/ext/travel/itinerary?id=${it.id}`) })
          ])))
          : h('p', { class: 'tvx-muted', text: data.canGenerate ? 'No itinerary yet — generate a day-by-day plan from this quotation.' : 'No itinerary.' })
      ]),
      message
    );
  }
  load();
}

class QuotationTravel extends TravelElement {
  start(ctx) {
    renderQuotationTravel(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-quotation-travel-v1', QuotationTravel);
