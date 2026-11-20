/**
 * <x-travel-contact-travellers-v1>: "Travellers" section on a CRM contact's page
 * (json/tabs.json → contactDetail). Shows how many travellers have this contact
 * as their contact person, across how many leads, with a short list.
 *
 * Backend: GET /contacts/:contact_id/travellers
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';

useStyles(new URL('./contact-travellers.css', import.meta.url));

const SHOWN = 8;

function renderContactTravellers(root, ctx) {
  const contactId = String((ctx.record && ctx.record.id) || '');
  const openLead = (leadId) => ctx.navigate(`/leads/${encodeURIComponent(leadId)}`);

  async function load() {
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading travellers…' }));
    try {
      const data = await ctx.api.get(`/contacts/${encodeURIComponent(contactId)}/travellers`);
      const list = Array.isArray(data && data.travellers) ? data.travellers : [];
      const count = Number(data && data.count) || 0;
      const leads = Number(data && data.leadCount) || 0;
      const parts = [
        h('div', { class: 'tvx-ct-head' }, [
          h('span', { class: 'tvx-ct-count', text: String(count) }),
          h('span', { class: 'tvx-ct-label', text: count === 1 ? 'traveller connected' : 'travellers connected' }),
          count ? h('span', { class: 'tvx-muted', text: `on ${leads} lead${leads === 1 ? '' : 's'}` }) : null
        ].filter(Boolean))
      ];
      if (!count) {
        parts.push(h('p', { class: 'tvx-muted', text: 'No traveller has this contact as their contact person yet.' }));
      } else {
        parts.push(
          h('ul', { class: 'tvx-ct-list' }, list.slice(0, SHOWN).map((t) =>
            h('li', { class: 'tvx-ct-item' }, [
              h('div', { class: 'tvx-ct-text' }, [
                h('span', { class: 'tvx-ct-name', text: t.fullName || t.firstName || '—' }),
                h('span', { class: 'tvx-muted', text: [t.relation, t.ageCategory, t.leadName].filter(Boolean).join(' · ') })
              ]),
              h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost tvx-ct-open', text: 'Open lead', 'aria-label': `Open lead ${t.leadName || ''} for ${t.fullName || t.firstName || 'traveller'}`.trim(), onclick: () => openLead(t.leadId) })
            ])
          ))
        );
        if (list.length > SHOWN) parts.push(h('p', { class: 'tvx-muted', text: `…and ${list.length - SHOWN} more on the Travellers page.` }));
      }
      root.replaceChildren(...parts);
    } catch (err) {
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load() })
      );
    }
  }
  load();
}

class ContactTravellers extends TravelElement {
  start(ctx) {
    renderContactTravellers(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-contact-travellers-v1', ContactTravellers);
