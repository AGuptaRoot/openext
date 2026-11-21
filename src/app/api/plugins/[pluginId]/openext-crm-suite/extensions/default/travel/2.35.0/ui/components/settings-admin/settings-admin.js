/**
 * <x-travel-settings-admin-v1>: Settings → Travel, below the settings form (json/settings.json tab.slot
 * "settings.travel.admin"). Admins only (crm.settings.manage); others see nothing.
 *
 * Import From / To locations (CSV): see location-import.js (POST /locations/import, GET /locations).
 *
 * Orphaned travellers (E9): travellers whose lead was deleted. They never show in lists or metrics;
 * here an admin sees how many there are and deletes them with their document photos (after a
 * confirmation; audited on the server). Travellers a booking still lists are kept.
 *
 * Backend: GET /admin/orphaned-travellers, POST /admin/orphaned-travellers/cleanup { confirm: true }
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import { locationImportCard } from './location-import.js';

useStyles(new URL('./settings-admin.css', import.meta.url));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderSettingsAdmin(root, ctx) {
  const isAdmin = typeof ctx.can === 'function' && ctx.can('crm.settings.manage');
  if (!isAdmin) {
    root.replaceChildren();
    return;
  }
  const state = { loading: true, error: '', info: null, running: false, result: null };
  const importCard = locationImportCard(ctx);

  async function load() {
    state.loading = true;
    render();
    try {
      state.info = await ctx.api.get('/admin/orphaned-travellers');
      state.error = '';
    } catch (err) {
      state.error = errorText(err);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function cleanup() {
    const info = state.info || {};
    const n = Number(info.count) || 0;
    if (!n || state.running) return;
    if (!window.confirm(`Delete ${plural(n, 'orphaned traveller', 'orphaned travellers')} and their document photos? This cannot be undone.`)) return;
    state.running = true;
    state.result = null;
    render();
    try {
      state.result = await ctx.api.post('/admin/orphaned-travellers/cleanup', { confirm: true });
      if (typeof ctx.toast === 'function') ctx.toast(`${plural(Number(state.result.deleted) || 0, 'orphaned traveller', 'orphaned travellers')} deleted`, 'success');
    } catch (err) {
      state.result = { error: errorText(err) };
    } finally {
      state.running = false;
    }
    await load();
  }

  function summary(info) {
    const n = Number(info.count) || 0;
    if (!n) return h('p', { class: 'tvx-muted', text: 'No orphaned travellers. Every traveller belongs to a lead that still exists.' });
    const leads = Number(info.leadCount) || 0;
    const photos = Number(info.withPhotos) || 0;
    return h('p', {
      class: 'tvx-sa-count',
      text: `${plural(n, 'traveller', 'travellers')} of ${plural(leads, 'deleted lead', 'deleted leads')}${photos ? ` (${photos} with document photos)` : ''}.`
    });
  }

  function render() {
    const info = state.info || {};
    const n = Number(info.count) || 0;
    const parts = [
      h('div', {}, [
        h('h3', { class: 'tvx-h3', text: 'Orphaned travellers' }),
        h('p', { class: 'tvx-sub', text: 'Travellers whose lead was deleted. They are not shown anywhere; delete them to remove their personal details and document photos.' })
      ])
    ];
    if (state.loading && !state.info) parts.push(h('p', { class: 'tvx-loading', text: 'Checking travellers…' }));
    else if (state.error) {
      parts.push(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: state.error }));
      parts.push(h('div', {}, [h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: load })]));
    } else {
      parts.push(summary(info));
      if (Number(info.onBooking) > 0) {
        parts.push(h('p', { class: 'tvx-muted', text: `${plural(Number(info.onBooking), 'more is', 'more are')} kept because a booking still lists them.` }));
      }
      if (info.complete === false) {
        parts.push(h('p', { class: 'tvx-muted', text: `Checked the newest ${info.scanned} travellers; run it again after deleting to check the rest.` }));
      }
      if (n) {
        parts.push(h('div', { class: 'tvx-row-gap' }, [
          h('button', {
            type: 'button',
            class: 'tvx-btn tvx-btn-danger',
            disabled: state.running,
            text: state.running ? 'Deleting…' : 'Delete them',
            onclick: cleanup
          })
        ]));
      }
    }
    const r = state.result;
    if (r && r.error) parts.push(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: r.error }));
    else if (r) {
      const skipped = Number(r.skipped) || 0;
      parts.push(h('div', {
        class: 'tvx-msg tvx-msg-success',
        role: 'status',
        text: `Deleted ${plural(Number(r.deleted) || 0, 'traveller', 'travellers')} and ${plural(Number(r.photos) || 0, 'photo', 'photos')}.${skipped ? ` ${skipped} kept (on a booking).` : ''}`
      }));
    }
    root.replaceChildren(importCard, h('section', { class: 'tvx-card tvx-sa' }, parts));
  }

  load();
}

class SettingsAdmin extends TravelElement {
  start(ctx) {
    renderSettingsAdmin(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-settings-admin-v1', SettingsAdmin);
