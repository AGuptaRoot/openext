/**
 * <x-travel-lead-bookings-v1>: "Bookings" tab on a CRM lead (json/tabs.json → leadDetail): the lead's
 * bookings and itineraries, each opening its page. On a client (clientDetail, slot client.tab.bookings):
 * every booking of the client, also the ones made while it was a lead or an opportunity.
 *
 * Backend: GET /leads/:lead_id/bookings · GET /clients/:client_id/bookings
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import * as ui from '../../shared/booking-ui.js';

useStyles(new URL('./lead-bookings.css', import.meta.url));

function renderLeadBookings(root, ctx) {
  root.classList.add('tvx-bx', 'tvx-lb');
  const leadId = String((ctx.record && ctx.record.id) || '');
  const forClient = ctx.slot === 'client.tab.bookings' || (ctx.record && ctx.record.type === 'client');
  const go = (path) => {
    if (typeof ctx.navigate === 'function') ctx.navigate(path);
  };

  const row = (title, pill, meta, path, label) =>
    // The whole row opens the booking / itinerary page (the Open button too).
    h('li', { class: 'tvx-lb-row', style: 'cursor:pointer', onclick: (e) => { if (!(e.target && e.target.closest && e.target.closest('button'))) go(path); } }, [
      h('div', { class: 'tvx-lb-text' }, [
        h('span', { class: 'tvx-lb-title' }, [h('span', { class: 'tvx-lb-name', text: title }), pill]),
        meta ? h('span', { class: 'tvx-muted', text: meta }) : null
      ]),
      h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Open', 'aria-label': label, onclick: () => go(path) })
    ]);

  async function load() {
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading bookings…' }));
    let data;
    try {
      data = await ctx.api.get(forClient ? `/clients/${encodeURIComponent(leadId)}/bookings` : `/leads/${encodeURIComponent(leadId)}/bookings`);
    } catch (err) {
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load() })
      );
      return;
    }
    const bookings = data.bookings || [];
    const itineraries = data.itineraries || [];
    root.replaceChildren(
      h('section', { class: 'tvx-card' }, [
        h('h3', { class: 'tvx-h3', text: `Bookings (${bookings.length})` }),
        bookings.length
          ? h('ul', { class: 'tvx-lb-list' }, bookings.map((b) => row(
            b.number,
            ui.statusPill(b.status),
            [
              b.title,
              ui.fmtRange(b.travel_start_date, b.travel_end_date),
              b.quotation_no ? `from ${b.quotation_no}` : '',
              // Client tab: the lead / opportunity the booking was made for.
              forClient && b.lead_title ? `lead: ${b.lead_title}` : '',
              forClient && b.opportunity_title ? `opportunity: ${b.opportunity_title}` : ''
            ].filter(Boolean).join(' · '),
            `/ext/travel/bookings?id=${b.id}`,
            `Open booking ${b.number}`
          )))
          : h('p', { class: 'tvx-muted', text: forClient ? 'No bookings yet for this client or its leads.' : 'No bookings yet. An accepted quotation of this lead gets a “Create Booking” button.' })
      ]),
      forClient ? null : h('section', { class: 'tvx-card' }, [
        h('h3', { class: 'tvx-h3', text: `Itineraries (${itineraries.length})` }),
        itineraries.length
          ? h('ul', { class: 'tvx-lb-list' }, itineraries.map((it) => row(
            `Itinerary v${it.version}${it.quotation_no ? ` · ${it.quotation_no}` : ''}`,
            ui.statusPill(it.status),
            [it.title, ui.fmtRange(it.start_date, it.end_date)].filter(Boolean).join(' · '),
            `/ext/travel/itinerary?id=${it.id}`,
            `Open itinerary v${it.version}`
          )))
          : h('p', { class: 'tvx-muted', text: 'No itinerary yet. Generate one from a quotation.' })
      ])
    );
  }
  load();
}

class LeadBookings extends TravelElement {
  start(ctx) {
    renderLeadBookings(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-lead-bookings-v1', LeadBookings);
