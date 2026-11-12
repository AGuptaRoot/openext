/**
 * <x-travel-lead-requirements-v1>: Lead → Travel Requirement tab (T2, requirements v2). Each service
 * selected in Required Services shows its requirements as cards — a lead can need two hotels
 * ("Hotel – Goa", "Hotel – Mumbai"). This extension's backend checks each save and sets Draft / Complete:
 *   GET    /leads/:lead_id/requirements        services, requirements (with their latest availability check)
 *   POST   /leads/:lead_id/requirements        first / another requirement of a service
 *   PUT    /requirements/:id                   save one requirement (values, label)
 *   DELETE /requirements/:id                   remove one (kept on the server, marked removed)
 *
 * Per card: status pill, availability badge ("Held · valid till 14 Jun", "Expired — recheck",
 * "Unavailable — propose an alternative") and "Check availability" (T3 dialog; off until the
 * requirement is Complete). "+ Add another <Service>" adds an unsaved card (Cancel drops it); with more
 * than one card a service's cards get a label. Read-only users see everything and the availability history.
 *
 * What is typed stays on screen while a save runs and after a failed save (E2). A service without
 * questions gets "Mark complete" (E4). A selected service that was switched off, or removed, in
 * Services & Forms shows its saved details read only, saying which (E12). Choices whose option was
 * removed show "(no longer offered)" and can be cleared (E3, shared/fields.js).
 */

import { h, sortByOrder, errorText } from '../../shared/dom.js';
import { serviceForm } from '../../shared/fields.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import { openAvailabilityDialog, availabilityBadge } from '../availability-dialog/availability-dialog.js';

useStyles(new URL('./lead-requirements.css', import.meta.url));

const MAX_INSTANCES = 20;

/** The lead's trip from its field values (same as the server's tripOf). */
function tripFromValues(values) {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : '');
  const start = day(values && values.travel_start_date);
  const end = day(values && values.travel_end_date);
  const nights = start && end && end >= start ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) : null;
  return { start, end, nights, days: nights === null ? null : nights + 1 };
}

function renderLeadRequirements(root, ctx) {
  const lead = ctx.record || {};
  const leadId = String(lead.id || '');
  const canEdit = ctx.can('crm.leads.write');
  // drafts / labels: what the agent typed per card (kept while saving, after a failed save and when
  // another card re-renders the list). pending: unsaved "add another" cards per service.
  // trip: the lead's travel dates; every requirement date stays inside them (2.12.0).
  const state = { loading: true, error: '', selected: [], rows: [], services: [], settings: {}, trip: null, saving: {}, messages: {}, drafts: {}, labels: {}, pending: {} };
  const forms = new Map(); // card key → { form, label input }
  let pendingSeq = 0;

  const catalog = () => sortByOrder((state.services || []).filter((s) => s && s.enabled !== false));
  const rowsOf = (key) => state.rows.filter((r) => r && r.service_key === key && r.removed !== true).sort((a, b) => Number(a.instance || 1) - Number(b.instance || 1));
  const tz = () => (state.settings && state.settings.timezone) || 'Asia/Kolkata';
  const changed = () => {
    if (typeof ctx.recordChanged === 'function') ctx.recordChanged();
  };

  // What each card showed when it was drawn from its saved row (form.read() / label): a card whose
  // inputs differ has unsaved changes — the browser then asks before the page is left.
  const baselines = {};
  const labelBases = {};
  const isDirty = () => {
    for (const [key, entry] of forms) {
      if (entry.form && baselines[key] !== undefined && JSON.stringify(entry.form.read()) !== baselines[key]) return true;
      if (entry.label && entry.label.value.trim() !== (labelBases[key] || '').trim()) return true;
    }
    return false;
  };
  root.isDirty = isDirty;
  const beforeUnload = (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  if (typeof root.onCleanup === 'function') root.onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    state.loading = true;
    render();
    try {
      const data = await ctx.api.get(`/leads/${encodeURIComponent(leadId)}/requirements`);
      if (seq !== loadSeq) return; // a newer load is running; its answer is the one shown
      state.selected = Array.isArray(data && data.selected) ? data.selected : [];
      state.services = Array.isArray(data && data.services) ? data.services : [];
      state.rows = Array.isArray(data && data.requirements) ? data.requirements : [];
      state.settings = (data && data.settings) || {};
      state.trip = (data && data.trip) || null;
      state.error = '';
    } catch (err) {
      if (seq !== loadSeq) return;
      state.error = errorText(err);
    } finally {
      if (seq === loadSeq) {
        state.loading = false;
        render();
      }
    }
  }

  /** Keep what is typed in every open card before the list is drawn again. */
  function snapshot(skip) {
    for (const [key, entry] of forms) {
      if (key === skip) continue;
      if (entry.form) state.drafts[key] = entry.form.read();
      if (entry.label) state.labels[key] = entry.label.value;
    }
  }

  function selectedServices() {
    const byKey = new Map(catalog().map((s) => [s.key, s]));
    const all = new Map((state.services || []).filter(Boolean).map((s) => [s.key, s]));
    const ordered = catalog().filter((s) => state.selected.includes(s.key));
    // Selected keys whose service was switched off, or removed, in Services & Forms still show their saved data.
    for (const key of state.selected) {
      if (byKey.has(key)) continue;
      const row = rowsOf(key)[0];
      const off = all.get(key);
      if (off) ordered.push({ ...off, switchedOff: true });
      else ordered.push({ key, name: (row && row.service_name) || key, fields: [], missing: true });
    }
    return ordered;
  }

  /** Cards of a service: its saved requirements, then unsaved ones (the first card when none is saved). */
  function cardsOf(service) {
    const saved = rowsOf(service.key).map((row) => ({ key: row._id, row, service }));
    const readOnly = Boolean(service.missing || service.switchedOff);
    if (readOnly) return saved.length ? saved : [{ key: `empty:${service.key}`, row: null, service, readOnly: true }];
    const pending = (state.pending[service.key] || []).map((key) => ({ key, row: null, service, pending: true }));
    if (!saved.length && !pending.length) return [{ key: `first:${service.key}`, row: null, service, first: true }];
    return [...saved, ...pending];
  }

  function serviceStatus(service) {
    const rows = rowsOf(service.key);
    if (rows.some((r) => r.status === 'Complete')) return { label: 'Complete', cls: 'is-done' };
    return rows.length ? { label: 'Draft', cls: 'is-draft' } : { label: 'Not started', cls: 'is-none' };
  }

  function cardStatus(row) {
    if (!row) return { label: 'Not started', cls: 'is-none' };
    return row.status === 'Complete' ? { label: 'Complete', cls: 'is-done' } : { label: 'Draft', cls: 'is-draft' };
  }

  async function saveCard(card) {
    const entry = forms.get(card.key) || {};
    const values = entry.form ? entry.form.read() : {};
    const label = entry.label ? entry.label.value.trim() : undefined;
    snapshot(card.key);
    state.drafts[card.key] = values;
    if (label !== undefined) state.labels[card.key] = label;
    state.saving[card.key] = true;
    state.messages[card.key] = null;
    render();
    let doneKey = card.key;
    let ok = false;
    try {
      // The backend checks the values and decides Draft / Complete.
      const result = card.row
        ? await ctx.api.put(`/requirements/${encodeURIComponent(card.row._id)}`, label !== undefined ? { values, label } : { values })
        : await ctx.api.post(`/leads/${encodeURIComponent(leadId)}/requirements`, { service_key: card.service.key, values, ...(label ? { label } : {}) });
      const saved = result && result.requirement;
      const missing = (result && Array.isArray(result.missing)) ? result.missing : [];
      const warnings = (result && Array.isArray(result.warnings)) ? result.warnings : [];
      if (saved) {
        const before = card.row ? state.rows.find((r) => r._id === card.row._id) : null;
        const merged = { ...saved, availability: saved.availability !== undefined ? saved.availability : before ? before.availability : null };
        state.rows = card.row ? state.rows.map((r) => (r._id === card.row._id ? merged : r)) : [...state.rows, merged];
        if (card.pending) state.pending[card.service.key] = (state.pending[card.service.key] || []).filter((k) => k !== card.key);
        doneKey = saved._id || card.key;
      }
      delete state.drafts[card.key];
      delete state.labels[card.key];
      const moved = result && result.workflow && result.workflow.stageChanged ? result.workflow.stage : '';
      state.messages[doneKey] = missing.length
        ? { kind: 'warn', text: `Saved as draft. Still needed: ${missing.join(', ')}` }
        : warnings.length
          ? { kind: 'warn', text: `Saved. ${warnings.join(' · ')}` }
          : { kind: 'success', text: moved ? `Saved. The lead is ready and moved to ${moved}.` : 'Saved. All required details are filled in.' };
      ok = true;
      // The lead page refreshes its stage and the Create Opportunity button.
      changed();
    } catch (err) {
      state.messages[card.key] = { kind: 'error', text: errorText(err) };
    } finally {
      state.saving[card.key] = false;
      if (doneKey !== card.key) delete state.saving[card.key];
      // After a failed save the typed values stay (E2); after a good one the saved row is shown.
      render(ok ? card.key : null);
    }
  }

  async function removeCard(card) {
    const name = card.row.label || card.service.name;
    if (!window.confirm(`Remove the requirement "${name}" from this lead? Its details and availability checks are kept in the history.`)) return;
    snapshot();
    state.saving[card.key] = true;
    render();
    try {
      await ctx.api.del(`/requirements/${encodeURIComponent(card.row._id)}`);
      state.rows = state.rows.filter((r) => r._id !== card.row._id);
      changed();
    } catch (err) {
      state.messages[card.key] = { kind: 'error', text: errorText(err) };
    } finally {
      state.saving[card.key] = false;
      render(null, false);
    }
  }

  function addAnother(service) {
    snapshot();
    pendingSeq += 1;
    state.pending[service.key] = [...(state.pending[service.key] || []), `new:${service.key}:${pendingSeq}`];
    render(null, false);
  }

  function cancelPending(card) {
    snapshot(card.key);
    state.pending[card.service.key] = (state.pending[card.service.key] || []).filter((k) => k !== card.key);
    delete state.drafts[card.key];
    delete state.labels[card.key];
    render(null, false);
  }

  function openAvailability(card) {
    snapshot();
    openAvailabilityDialog(root, ctx, {
      requirementId: card.row._id,
      title: card.row.label || card.service.name,
      canEdit,
      onChange: (latest) => {
        state.rows = state.rows.map((r) => (r._id === card.row._id ? { ...r, availability: latest } : r));
        render(null, false);
      }
    });
  }

  /** Saved values of a switched-off / removed service, read only. */
  function savedDetails(service, row) {
    const values = (row && row.values) || {};
    const labels = new Map((service.fields || []).map((f) => [f.key, f.label || f.key]));
    const shown = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
    const items = Object.entries(values)
      .filter(([, v]) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)))
      .map(([k, v]) => h('li', {}, [h('span', { class: 'tvx-label', text: `${labels.get(k) || k}: ` }), shown(v)]));
    return items.length ? h('ul', { class: 'tvx-req-saved' }, items) : h('p', { class: 'tvx-muted', text: 'Nothing was saved for this service.' });
  }

  function cardView(card, count) {
    const { service, row } = card;
    const readOnly = Boolean(service.missing || service.switchedOff);
    const st = cardStatus(row);
    const msg = state.messages[card.key];
    const saving = Boolean(state.saving[card.key]);
    const note = service.switchedOff
      ? 'This service is switched off in Services & Forms. Saved details are kept (read only); switch it on to edit them.'
      : service.missing
        ? 'This service was removed on the Services & Forms page. Saved details are kept (read only).'
        : '';
    const title = card.pending ? `New ${service.name}` : (row && row.label) || service.name;
    // Typed values win over the saved row while saving and after a failed save.
    const values = state.drafts[card.key] || (row && row.values) || {};
    const form = readOnly ? null : serviceForm(service, values, {
      disabled: !canEdit || saving,
      trip: state.trip,
      ctx,
      settings: ctx && ctx.settings,
      saveSettings: ctx && typeof ctx.saveSettings === 'function' ? ctx.saveSettings.bind(ctx) : undefined
    });
    let labelInput = null;
    if (!readOnly && canEdit && count > 1) {
      const labelId = `tvx-req-label-${String(card.key).replace(/[^A-Za-z0-9_-]/g, '-')}`;
      const n = row ? Number(row.instance || 1) : null;
      labelInput = h('input', {
        id: labelId,
        class: 'tvx-input',
        maxlength: '80',
        disabled: saving,
        placeholder: n ? (n > 1 ? `${service.name} ${n}` : service.name) : `e.g. ${service.name} – city`,
        value: state.labels[card.key] !== undefined ? state.labels[card.key] : (row && row.label) || ''
      });
      labelInput.addEventListener('input', () => {
        state.labels[card.key] = labelInput.value;
      });
      labelInput = { el: h('div', { class: 'tvx-field tvx-req-label' }, [h('label', { class: 'tvx-label', for: labelId, text: 'Label' }), labelInput]), input: labelInput };
    }
    forms.set(card.key, { form, label: labelInput ? labelInput.input : null });
    // Drawn from the saved row (no typed draft): this is what "unchanged" looks like for the card.
    if (form && !state.drafts[card.key]) baselines[card.key] = JSON.stringify(form.read());
    if (state.labels[card.key] === undefined) labelBases[card.key] = (row && row.label) || '';

    const badge = row ? availabilityBadge(row.availability, tz()) : null;
    const fieldless = Boolean(form) && !form.fieldCount;
    const complete = Boolean(row && row.status === 'Complete');
    const buttons = [];
    if (canEdit && form && !(fieldless && complete && !card.pending)) {
      buttons.push(h('button', {
        type: 'button',
        class: 'tvx-btn tvx-btn-primary',
        disabled: saving,
        onclick: () => saveCard(card),
        text: saving ? 'Saving…' : fieldless ? 'Mark complete' : `Save ${service.name}`
      }));
    }
    if (canEdit && card.pending) buttons.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', disabled: saving, onclick: () => cancelPending(card), text: 'Cancel' }));
    if (!readOnly && !card.pending) {
      const enabled = Boolean(row && complete);
      buttons.push(h('button', {
        type: 'button',
        class: 'tvx-btn tvx-btn-ghost',
        disabled: !enabled || saving,
        title: enabled ? 'Record what the provider said' : 'Complete the requirement first',
        onclick: () => openAvailability(card),
        text: canEdit ? 'Check availability' : 'Availability'
      }));
    }
    if (canEdit && row && !readOnly) buttons.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-danger', disabled: saving, onclick: () => removeCard(card), text: 'Remove' }));

    const footer = buttons.length
      ? h('div', { class: 'tvx-req-foot' }, [
          row && row.updatedAt ? h('span', { class: 'tvx-muted', text: `Last saved ${new Date(row.updatedAt).toLocaleString()}` }) : h('span'),
          h('div', { class: 'tvx-req-actions' }, buttons)
        ])
      : null;

    const el = h('section', { class: `tvx-card tvx-req-card${card.pending ? ' is-new' : ''}` });
    // replaceChildren prints a null as the text "null": only real nodes go in.
    el.replaceChildren(...[
      h('div', { class: 'tvx-req-head' }, [
        h('div', { class: 'tvx-req-title' }, [
          h('h4', { class: 'tvx-h4', text: title }),
          service.description ? h('p', { class: 'tvx-sub', text: service.description }) : null,
          note ? h('p', { class: 'tvx-warn', text: note }) : null
        ]),
        h('div', { class: 'tvx-req-pills' }, [
          h('span', { class: `tvx-pill ${st.cls}`, text: st.label }),
          badge ? h('span', { class: `tvx-pill ${badge.cls}`, text: badge.text }) : null
        ])
      ]),
      labelInput ? labelInput.el : null,
      form ? form.el : savedDetails(service, row),
      msg ? h('div', { class: `tvx-msg tvx-msg-${msg.kind}`, role: msg.kind === 'error' ? 'alert' : 'status', text: msg.text }) : null,
      footer
    ].filter(Boolean));
    return el;
  }

  const summaryHost = h('div');
  const cardsHost = h('div', { class: 'tvx-req-list' });

  function renderSummary(services) {
    const done = services.filter((s) => serviceStatus(s).cls === 'is-done').length;
    summaryHost.replaceChildren(
      h('div', { class: 'tvx-card tvx-req-summary' }, [
        h('div', {}, [
          h('h3', { class: 'tvx-h3', text: 'Travel Requirement' }),
          h('p', { class: 'tvx-sub', text: services.length ? `${done} of ${services.length} services complete` : 'No services selected yet' })
        ]),
        h(
          'div',
          { class: 'tvx-chips' },
          services.map((s) => {
            const st = serviceStatus(s);
            const n = rowsOf(s.key).length;
            return h('span', { class: `tvx-pill ${st.cls}` }, [n > 1 ? `${s.name} ×${n}` : s.name, h('em', { text: st.label })]);
          })
        )
      ])
    );
  }

  /** Draws the list. `skip`: the card just saved (its typed values are not kept); keep=false: no snapshot. */
  function render(skip = null, keep = true) {
    if (keep && !state.loading) snapshot(skip);
    if (state.loading) {
      root.replaceChildren(h('div', { class: 'tvx-card tvx-loading', text: 'Loading travel requirement…' }));
      return;
    }
    if (state.error) {
      root.replaceChildren(
        h('div', { class: 'tvx-card' }, [
          h('div', { class: 'tvx-msg tvx-msg-error', text: state.error }),
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', onclick: load, text: 'Retry' })
        ])
      );
      return;
    }
    // Typed values of the card just saved were replaced by the saved row.
    if (skip) {
      delete state.drafts[skip];
      delete state.labels[skip];
    }
    forms.clear();
    const services = selectedServices();
    renderSummary(services);
    if (!services.length) {
      cardsHost.replaceChildren(
        h('div', { class: 'tvx-card tvx-empty' }, [
          h('p', { class: 'tvx-empty-title', text: 'Pick the services this traveller needs' }),
          h('p', {
            class: 'tvx-sub',
            text: 'Choose them under Required Services on this lead (Edit → Required Services). A form appears here for each one.'
          })
        ])
      );
    } else {
      cardsHost.replaceChildren(
        ...services.map((service) => {
          const cards = cardsOf(service);
          const readOnly = Boolean(service.missing || service.switchedOff);
          const savedCount = rowsOf(service.key).length;
          const canAdd = canEdit && !readOnly && savedCount > 0 && cards.length < MAX_INSTANCES;
          return h('div', { class: 'tvx-req-group' }, [
            ...cards.map((card) => cardView(card, cards.length)),
            canAdd ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost tvx-req-add', onclick: () => addAnother(service), text: `+ Add another ${service.name}` }) : null
          ].filter(Boolean));
        })
      );
    }
    if (!summaryHost.isConnected || !cardsHost.isConnected) {
      const keep = [...root.children].filter((el) => el.classList && el.classList.contains('tvx-av-overlay'));
      root.replaceChildren(summaryHost, cardsHost, ...keep);
    }
  }

  // Unsubscribed when the tab closes.
  subscribe(root, ctx, 'onValuesChanged', (values) => {
    state.selected = Array.isArray(values && values.required_services) ? values.required_services : [];
    state.trip = tripFromValues(values);
    render();
  });
  subscribe(root, ctx, 'onSettingsChanged', (values) => {
    ctx.settings = { ...(ctx.settings || {}), ...values };
    load();
  });
  load();
}

class LeadRequirements extends TravelElement {
  start(ctx) {
    renderLeadRequirements(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-lead-requirements-v1', LeadRequirements);
