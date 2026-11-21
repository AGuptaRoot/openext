/**
 * <x-travel-trip-page-v1>: the Trip page (json/navigation.json → page "trip", slot page.trip; not in the sidebar).
 * Opened from Reports → Trips at /ext/travel/trip?lead=<id> or ?client_trip=<id>.
 *
 * One read-only view of a trip: details, and a count + list of its quotations, invoices, proformas,
 * bookings, itineraries, travellers, travel requirements, activities and notes. Every count jumps to its
 * section, every section has a link to the CRM page that manages it, and every row opens its own record.
 *
 * Backend: GET /trips/lead/:lead_id · GET /trips/client/:trip_id (sections the user may not read come back null).
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import * as ui from '../../shared/booking-ui.js';

useStyles(new URL('./trip-page.css', import.meta.url));

const PAGE = '/ext/travel/trip';
const REPORT = '/reports?tab=trips';

function renderTripPage(root, ctx) {
  root.classList.add('tvx-bx', 'tvx-tp');
  const go = (path) => {
    if (path && typeof ctx.navigate === 'function') ctx.navigate(path);
  };
  let current = '';

  const link = (label, path) => (path ? h('button', { type: 'button', class: 'tvx-link-btn tvx-tp-link', text: label, onclick: () => go(path) }) : null);
  const when = (iso) => (iso ? ui.fmtDay(String(iso).slice(0, 10)) : '');

  /** A clickable row: the whole row opens `path`. */
  const row = (title, pill, meta, path) =>
    h('li', { class: `tvx-tp-row${path ? ' is-link' : ''}`, onclick: path ? () => go(path) : null, role: path ? 'link' : null, tabindex: path ? '0' : null, onkeydown: path ? (e) => { if (e.key === 'Enter') go(path); } : null }, [
      h('div', { class: 'tvx-tp-row-main' }, [h('span', { class: 'tvx-tp-row-title', text: title }), pill || null]),
      meta ? h('span', { class: 'tvx-muted tvx-tp-row-meta', text: meta }) : null
    ]);

  /** One section card; `items` null = this user may not see it (not drawn at all). */
  const section = (id, title, items, makeRow, { open, openLabel = 'Open', empty = 'Nothing yet.', note = '' } = {}) => {
    if (items === null || items === undefined) return null;
    return h('section', { class: 'tvx-card tvx-tp-section', id: `tvx-tp-${id}` }, [
      h('div', { class: 'tvx-tp-section-head' }, [h('h3', { class: 'tvx-h3', text: `${title} (${items.length})` }), link(openLabel, open)]),
      note ? h('p', { class: 'tvx-muted tvx-tp-note', text: note }) : null,
      items.length ? h('ul', { class: 'tvx-tp-list' }, items.map(makeRow)) : h('p', { class: 'tvx-muted', text: empty })
    ]);
  };

  function draw(t) {
    const c = t.counts || {};
    const money = (n, cur) => ui.money(n, cur || (t.payment && t.payment.currency) || 'INR');
    const trip = t.trip || {};
    const dates = ui.fmtRange(trip.startDate, trip.endDate);
    const travellerText = trip.expectedTravellers ? `${t.travellers.length} of ${trip.expectedTravellers} travellers` : `${t.travellers.length} travellers`;

    // Counts: each jumps to its section.
    const chips = [
      ['quotations', 'Quotations'], ['invoices', 'Invoices'], ['proformas', 'Proformas'], ['bookings', 'Bookings'],
      ['travellers', 'Travellers'], ['requirements', 'Travel requirements'], ['itineraries', 'Itineraries'],
      ['activities', 'Activities'], ['notes', 'Notes']
    ].filter(([k]) => c[k] !== null && c[k] !== undefined);
    const jump = (k) => {
      const el = root.querySelector(`#tvx-tp-${k}`);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const details = h('section', { class: 'tvx-card tvx-tp-section' }, [
      h('div', { class: 'tvx-tp-section-head' }, [h('h3', { class: 'tvx-h3', text: 'Trip details' }), link(t.kind === 'lead' ? 'Open lead' : 'Open client', t.links.record)]),
      trip.details && trip.details.length
        ? h('dl', { class: 'tvx-tp-dl' }, trip.details.flatMap((d) => [h('dt', { text: d.label }), h('dd', { text: d.key.endsWith('_date') ? when(d.value) : d.value })]))
        : h('p', { class: 'tvx-muted', text: 'No travel information saved yet.' }),
      trip.services && trip.services.length ? h('p', { class: 'tvx-tp-services' }, [h('strong', { text: 'Services: ' }), trip.services.join(', ')]) : null,
      t.client && t.kind === 'lead' ? h('p', { class: 'tvx-tp-services' }, [link('Open client', t.client.link)]) : null
    ]);

    const payment = t.payment
      ? h('section', { class: 'tvx-card tvx-tp-section' }, [
        h('div', { class: 'tvx-tp-section-head' }, [h('h3', { class: 'tvx-h3', text: `Payment (${t.payment.quotationNo})` }), ui.statusPill(t.payment.status)]),
        h('dl', { class: 'tvx-tp-dl' }, [
          h('dt', { text: 'Total' }), h('dd', { text: money(t.payment.total, t.payment.currency) }),
          h('dt', { text: 'Paid' }), h('dd', { text: money(t.payment.paid, t.payment.currency) }),
          h('dt', { text: 'Balance' }), h('dd', { text: money(t.payment.balance, t.payment.currency) })
        ])
      ])
      : null;

    const bill = (kind) => (inv) => row(
      inv.number,
      ui.statusPill(inv.status),
      [when(inv.issueDate), money(inv.total, inv.currency), inv.balance ? `balance ${money(inv.balance, inv.currency)}` : '', inv.convertedTo ? `converted to ${inv.convertedTo}` : ''].filter(Boolean).join(' · '),
      inv.link
    );
    const clientNote = t.notesScope === 'client' ? 'These belong to the client, so they cover all of the client’s trips.' : '';

    root.replaceChildren(
      h('div', { class: 'tvx-tp-top' }, [
        link('← Trips report', REPORT),
        h('div', { class: 'tvx-tp-title' }, [
          h('h2', { class: 'tvx-tp-h2', text: t.title }),
          h('span', { class: 'tvx-bx-pill is-info', text: t.kind === 'lead' ? 'From lead' : 'From client' }),
          t.stage ? ui.statusPill(t.stage) : null
        ]),
        h('p', { class: 'tvx-muted', text: [trip.destination, dates, travellerText, t.createdAt ? `created ${when(t.createdAt)}` : ''].filter(Boolean).join(' · ') })
      ]),
      h('nav', { class: 'tvx-tp-counts', 'aria-label': 'Trip sections' }, chips.map(([k, label]) =>
        h('button', { type: 'button', class: 'tvx-tp-count', onclick: () => jump(k) }, [h('span', { class: 'tvx-tp-count-n', text: String(c[k]) }), h('span', { text: label })])
      )),
      details,
      payment,
      section('quotations', 'Quotations', t.quotations, (q) => row(
        q.number, ui.statusPill(q.status),
        [q.title, when(q.issueDate), money(q.total, q.currency), q.revisions > 1 ? `v${q.version}, ${q.revisions} revisions` : ''].filter(Boolean).join(' · '),
        q.link
      ), { open: t.kind === 'client' ? t.links.quotations : '/quotations', openLabel: 'All quotations', note: 'Revisions are shown once, as the latest version.' }),
      section('invoices', 'Invoices', t.invoices, bill('tax'), { open: t.kind === 'client' ? t.links.invoices : '/invoices', openLabel: 'All invoices' }),
      section('proformas', 'Proformas', t.proformas, bill('proforma'), { open: '/invoices', openLabel: 'All invoices' }),
      section('bookings', 'Bookings', t.bookings, (b) => row(
        b.number, ui.statusPill(b.status),
        [b.title, ui.fmtRange(b.startDate, b.endDate), b.quotationNo ? `from ${b.quotationNo}` : '', b.total !== undefined ? money(b.total, b.currency) : ''].filter(Boolean).join(' · '),
        b.link
      ), { open: t.links.bookings, openLabel: 'Bookings tab' }),
      section('itineraries', 'Itineraries', t.itineraries, (it) => row(
        it.title, it.status ? ui.statusPill(it.status) : null, [`v${it.version}`, it.quotationNo ? `from ${it.quotationNo}` : ''].filter(Boolean).join(' · '), it.link
      )),
      section('travellers', 'Travellers', t.travellers, (p) => row(
        p.name, p.ageCategory ? h('span', { class: 'tvx-bx-pill is-neutral', text: p.ageCategory }) : null,
        [p.relation, `Passport: ${p.passport}`, `Aadhaar: ${p.aadhaar}`].filter(Boolean).join(' · '),
        t.links.travellers
      ), { open: t.links.travellers, openLabel: 'Travellers tab', empty: 'No travellers added yet.' }),
      section('requirements', 'Travel requirements', t.requirements, (r) => row(
        r.label ? `${r.service} – ${r.label}` : r.service, ui.statusPill(r.status), '', t.links.requirements
      ), { open: t.links.requirements, openLabel: 'Travel Requirement tab' }),
      t.timelineAvailable === false
        ? h('section', { class: 'tvx-card tvx-tp-section' }, [h('p', { class: 'tvx-muted', text: 'Activities and notes need CRM 3.61.0 or later.' }), link('Open activities', t.links.activities)])
        : null,
      t.timelineAvailable === false ? null : section('activities', t.notesScope === 'client' ? 'Client activities (all trips)' : 'Activities', t.activities, (a) => row(
        a.title, a.status ? ui.statusPill(a.status) : null, [a.type, when(a.date), a.owner, a.text].filter(Boolean).join(' · '), t.links.activities
      ), { open: t.links.activities, openLabel: 'Activities tab', note: clientNote }),
      t.timelineAvailable === false ? null : section('notes', t.notesScope === 'client' ? 'Client notes (all trips)' : 'Notes', t.notes, (n) => row(
        n.title || n.text.slice(0, 80) || 'Note', n.private ? h('span', { class: 'tvx-bx-pill is-warn', text: 'Private' }) : null,
        [n.title ? n.text : n.text.length > 80 ? n.text : '', n.author, when(n.date)].filter(Boolean).join(' · '),
        t.links.notes
      ), { open: t.links.notes, openLabel: 'Notes tab', note: clientNote })
    );
  }

  async function load(query) {
    const q = query || {};
    const lead = String(q.lead || '');
    const trip = String(q.client_trip || '');
    const key = lead ? `lead:${lead}` : trip ? `client:${trip}` : '';
    current = key;
    if (!key) {
      root.replaceChildren(
        h('p', { class: 'tvx-muted', text: 'Open a trip from Reports → Trips.' }),
        link('Go to Trips report', REPORT)
      );
      return;
    }
    root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading trip…' }));
    let data;
    try {
      data = await ctx.api.get(lead ? `/trips/lead/${encodeURIComponent(lead)}` : `/trips/client/${encodeURIComponent(trip)}`);
    } catch (err) {
      if (current !== key) return;
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }),
        h('div', { class: 'tvx-row-gap' }, [
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load(q) }),
          link('← Trips report', REPORT)
        ])
      );
      return;
    }
    if (current !== key) return;
    // A merged lead, or a client trip that became a lead: show that lead's trip.
    if (data && data.redirect && data.redirect.lead) {
      go(`${PAGE}?lead=${encodeURIComponent(data.redirect.lead)}`);
      return;
    }
    draw(data);
  }

  subscribe(root, ctx, 'onQueryChange', (q) => load(q));
  load(ctx.query || {});
}

class TripPage extends TravelElement {
  start(ctx) {
    renderTripPage(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-trip-page-v1', TripPage);
