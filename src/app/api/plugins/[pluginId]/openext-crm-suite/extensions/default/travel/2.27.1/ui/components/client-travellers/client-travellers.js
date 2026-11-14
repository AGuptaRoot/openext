/**
 * <x-travel-client-travellers-v1>: Client → Travellers tab (2.14.0). Every traveller of the client, also
 * the ones added while it was still a lead, one row per person: name (opens the traveller), related
 * contact, relation, age category, nationality and passport status (Valid / Expiring Soon / Expired /
 * Missing). No document numbers.
 *
 * Backend: GET /clients/:client_id/travellers
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';

useStyles(new URL('./client-travellers.css', import.meta.url));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
const TONE = { Valid: 'is-done', 'Expiring Soon': 'is-draft', Expired: 'is-danger', Missing: 'is-none' };

function renderClientTravellers(root, ctx) {
  const clientId = String((ctx.record && ctx.record.id) || '');

  function statusPill(t) {
    const when = t.passportExpiry ? fmtDay(t.passportExpiry) : '';
    return h('span', { class: `tvx-pill ${TONE[t.passportStatus] || 'is-none'}`, title: when ? `Expiry ${when}` : '' }, [
      t.passportStatus === 'Missing' ? 'No passport' : t.passportStatus,
      when && t.passportStatus !== 'Missing' ? h('em', { text: when }) : null
    ]);
  }

  async function load() {
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading travellers…' }));
    try {
      const data = await ctx.api.get(`/clients/${encodeURIComponent(clientId)}/travellers`);
      const list = Array.isArray(data && data.travellers) ? data.travellers : [];
      if (!list.length) {
        root.replaceChildren(h('section', { class: 'tvx-card tvx-empty' }, [
          h('p', { class: 'tvx-empty-title', text: 'No travellers yet' }),
          h('p', { class: 'tvx-muted', text: 'Travellers added on this client’s leads show here.' })
        ]));
        return;
      }
      const head = ['Traveller', 'Related contact', 'Relation', 'Age category', 'Nationality', 'Passport'];
      root.replaceChildren(
        h('section', { class: 'tvx-card tvx-cl-tr' }, [
          h('div', { class: 'tvx-card-head' }, [
            h('h3', { class: 'tvx-h3', text: `Travellers (${list.length})` }),
            h('span', { class: 'tvx-muted', text: 'Also the ones added while this client was a lead.' })
          ]),
          h('div', { class: 'tvx-cl-tr-scroll' }, [
            h('table', { class: 'tvx-cl-tr-table' }, [
              h('thead', {}, [h('tr', {}, head.map((t) => h('th', { scope: 'col', text: t })))]),
              h('tbody', {}, list.map((t) =>
                h('tr', {}, [
                  h('td', { 'data-label': 'Traveller' }, [
                    h('button', { type: 'button', class: 'tvx-link-btn tvx-cl-tr-name', text: t.name || 'Traveller', 'aria-label': `View traveller ${t.name || ''}`.trim(), onclick: () => ctx.navigate(t.link) })
                  ]),
                  h('td', { 'data-label': 'Related contact', text: t.contact || '—' }),
                  h('td', { 'data-label': 'Relation', text: t.relation || '—' }),
                  h('td', { 'data-label': 'Age category', text: t.ageCategory || '—' }),
                  h('td', { 'data-label': 'Nationality', text: t.nationality || '—' }),
                  h('td', { 'data-label': 'Passport' }, [statusPill(t)])
                ])
              ))
            ])
          ])
        ])
      );
    } catch (err) {
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load() })
      );
    }
  }
  load();
}

class ClientTravellers extends TravelElement {
  start(ctx) {
    renderClientTravellers(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-client-travellers-v1', ClientTravellers);
