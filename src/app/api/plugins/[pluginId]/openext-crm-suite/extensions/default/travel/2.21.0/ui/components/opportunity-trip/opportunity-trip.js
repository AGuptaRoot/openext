/**
 * <x-travel-opportunity-trip-v1>: "Trip" tab on a CRM opportunity (json/tabs.json → opportunityDetail).
 * Read-only: the trip saved with the opportunity (2.1.0 TripPlan; older opportunities: their own values,
 * else the lead's trip: destination, dates, travellers, budget), the lead's travel services and travellers —
 * the same panels the opportunity form starts with. Nothing here can be edited.
 *
 * Backend: GET /opportunities/:opportunity_id/trip
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import * as ui from '../../shared/booking-ui.js';

useStyles(new URL('./opportunity-trip.css', import.meta.url));

function renderOpportunityTrip(root, ctx) {
  root.classList.add('tvx-bx', 'tvx-ot');
  const opportunityId = String((ctx.record && ctx.record.id) || '');

  async function load() {
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading trip…' }));
    let data;
    try {
      data = await ctx.api.get(`/opportunities/${encodeURIComponent(opportunityId)}/trip`);
    } catch (err) {
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load() })
      );
      return;
    }
    if (!data || data.available === false) {
      root.replaceChildren(h('p', { class: 'tvx-muted', text: (data && data.message) || 'No trip to show.' }));
      return;
    }
    const v = data.values || {};
    const who = [['adults', 'Adult', 'Adults'], ['children', 'Child', 'Children'], ['infants', 'Infant', 'Infants']]
      .map(([k, one, many]) => (Number(v[k]) ? `${v[k]} ${Number(v[k]) === 1 ? one : many}` : ''))
      .filter(Boolean)
      .join(', ');
    // 2.1.0: the trip saved with the opportunity (TripPlan / its own values); older ones show the lead's trip.
    const money = (n) => (n === undefined || n === null || n === '' || !Number.isFinite(Number(n)) ? '' : `${data.currency ? `${data.currency} ` : ''}${Number(n).toLocaleString()}`);
    const budget = [money(v.budget_min), money(v.budget_max)].filter(Boolean).join(' – ');
    const length = [Number(v.nights) ? `${v.nights} ${Number(v.nights) === 1 ? 'night' : 'nights'}` : '', Number(v.days) ? `${v.days} ${Number(v.days) === 1 ? 'day' : 'days'}` : ''].filter(Boolean).join(' / ');
    const facts = [
      ['From', v.from_city],
      ['Destination', v.destination],
      ['Trip purpose', v.trip_purpose],
      ['Travel dates', ui.fmtRange(v.travel_start_date, v.travel_end_date)],
      ['Length', length],
      ['Date flexibility', v.date_flexibility],
      ['Travellers', who],
      ['Trip type', v.trip_type],
      ['Budget', budget],
      ['Special requests', v.special_requests]
    ].filter(([, x]) => x);
    root.replaceChildren(
      h('section', { class: 'tvx-card' }, [
        h('div', {}, [h('span', { class: 'tvx-eyebrow', text: 'Trip' }), h('h3', { class: 'tvx-h3', text: data.title || 'Trip' })]),
        facts.length ? h('dl', { class: 'tvx-ot-facts' }, facts.flatMap(([k, x]) => [h('dt', { text: k }), h('dd', { text: String(x) })])) : null,
        data.source === 'lead' ? h('p', { class: 'tvx-muted', text: 'From the lead: this opportunity has no trip details of its own yet.' }) : null,
        ...(data.warnings || []).slice(0, 6).map((w) => h('p', { class: 'tvx-msg tvx-msg-warn', text: w }))
      ]),
      ...(data.panels || []).map((panel) => h('section', { class: 'tvx-card' }, [
        h('h3', { class: 'tvx-h3', text: panel.title }),
        panel.items && panel.items.length
          ? h('ul', { class: 'tvx-ot-list' }, panel.items.map((item) => h('li', {}, [
            h('div', { class: 'tvx-ot-item-head' }, [
              h('span', { class: 'tvx-ot-name', text: item.title }),
              item.badge ? ui.statusPill(item.badge) : null
            ]),
            item.subtitle ? h('span', { class: 'tvx-muted', text: item.subtitle }) : null,
            item.details && item.details.length
              ? h('details', {}, [
                h('summary', { text: 'Details' }),
                h('dl', { class: 'tvx-ot-facts' }, item.details.flatMap((d) => [h('dt', { text: d.label }), h('dd', { text: d.value })]))
              ])
              : null
          ])))
          : h('p', { class: 'tvx-muted', text: panel.empty || 'Nothing yet.' })
      ]))
    );
  }
  load();
}

class OpportunityTrip extends TravelElement {
  start(ctx) {
    renderOpportunityTrip(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-opportunity-trip-v1', OpportunityTrip);
