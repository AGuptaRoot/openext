/**
 * <x-travel-client-travel-requirement-v1>: Client → Travel Requirement (2.15.0).
 *
 *   Step 1  Travel Information — the CRM's own Lead Create fields (ctx.fieldsForm: From / To
 *           searchable lists, dates with their rules, Number of Days and Travel Month calculated, Date
 *           Flexibility, Required Services from Services & Forms). At least one service → Continue.
 *   Step 2  one requirement form per selected service (Services & Forms), dates kept inside the trip.
 *   Save    every form complete → saved for the client (server checks it all again). 2.22.0: saving
 *           never creates a lead; the trip (enquiry lead) opens only from Create Quotation or
 *           "Open Trip & Add Travellers".
 *   Then    Create Quotation → the quotation page for this client (it asks who travels first).
 *
 * Backend: GET / PUT /clients/:client_id/travel-requirement, POST …/travel-requirement/trip
 */

import { h, errorText, sortByOrder } from '../../shared/dom.js';
import { serviceForm } from '../../shared/fields.js';
import { tripOf } from '../../shared/trip-range.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';

useStyles(new URL('./client-travel-requirement.css', import.meta.url));

const REQUEST_TYPE = 'travel_enquiry';
const GROUPS = ['travel_information', 'required_services'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : '');
const fmtDay = (iso) => (day(iso) ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || v === false;

function renderClientTravelRequirement(root, ctx) {
  const clientId = String((ctx.record && ctx.record.id) || '');
  const canEdit = ctx.can('crm.leads.write');
  const canQuote = ctx.can('crm.quotes.write') || ctx.can('crm.finance.write');
  const state = { data: null, step: 'loading', values: {}, drafts: {}, error: '', saving: false };
  let fieldsHandle = null;
  let forms = new Map();

  const selected = () => {
    const list = Array.isArray(state.values.required_services) ? state.values.required_services.map(String) : [];
    const services = (state.data && state.data.services) || [];
    return sortByOrder(services.filter((s) => list.includes(s.key)));
  };

  function dropFields() {
    if (fieldsHandle && typeof fieldsHandle.destroy === 'function') fieldsHandle.destroy();
    fieldsHandle = null;
  }
  if (typeof root.onCleanup === 'function') root.onCleanup(dropFields);

  async function load() {
    state.step = 'loading';
    render();
    try {
      state.data = await ctx.api.get(`/clients/${encodeURIComponent(clientId)}/travel-requirement`);
      state.values = { ...(state.data.values || {}) };
      state.drafts = Object.fromEntries(Object.entries(state.data.requirements || {}).map(([k, r]) => [k, r.values || {}]));
      state.error = '';
      state.step = state.data.complete ? 'done' : canEdit ? 1 : 'done';
    } catch (err) {
      state.step = 'error';
      state.error = errorText(err);
    }
    render();
  }

  function steps(current) {
    const item = (n, label) =>
      h('li', { class: `tvx-ctr-step${current === n ? ' is-on' : ''}${current === 'done' || (typeof current === 'number' && current > n) ? ' is-done' : ''}` }, [
        h('span', { class: 'tvx-ctr-step-n', text: String(n) }),
        h('span', { text: label })
      ]);
    return h('ol', { class: 'tvx-ctr-steps', 'aria-label': 'Steps' }, [item(1, 'Travel Information'), item(2, 'Travel Requirement Forms'), item(3, 'Save & Create Quotation')]);
  }

  /* ----------------------------------------------------------- step 1 */

  function stepOne() {
    const host = h('div', { class: 'tvx-ctr-fields' });
    const message = h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', hidden: !state.error, text: state.error });
    if (typeof ctx.fieldsForm !== 'function') {
      return h('section', { class: 'tvx-card' }, [h('p', { class: 'tvx-msg tvx-msg-warn', text: 'Update the CRM to 3.34.0 or later to use the client Travel Requirement.' })]);
    }
    queueMicrotask(() => {
      if (!host.isConnected) return;
      dropFields();
      fieldsHandle = ctx.fieldsForm(host, {
        record: 'lead',
        requestTypeKey: REQUEST_TYPE,
        groupIds: GROUPS,
        values: state.values,
        onChange: (values) => {
          state.values = values;
        }
      });
    });
    const next = () => {
      if (!fieldsHandle) return;
      state.values = fieldsHandle.getValues();
      const problem = fieldsHandle.validate() || (!selected().length ? 'Select at least one Required Service.' : '');
      if (problem) {
        message.textContent = problem;
        message.hidden = false;
        return;
      }
      state.error = '';
      dropFields();
      state.step = 2;
      render();
    };
    return h('section', { class: 'tvx-card tvx-ctr-card' }, [
      h('div', { class: 'tvx-card-head' }, [h('h3', { class: 'tvx-h3', text: 'Step 1 · Travel Information' })]),
      host,
      message,
      h('div', { class: 'tvx-row-gap tvx-ctr-actions' }, [
        state.data && state.data.complete ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Cancel', onclick: () => { dropFields(); state.step = 'done'; render(); } }) : null,
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: 'Continue', onclick: next })
      ])
    ]);
  }

  /* ----------------------------------------------------------- step 2 */

  function stepTwo() {
    const trip = tripOf(state.values);
    forms = new Map();
    const cards = selected().map((service) => {
      const form = serviceForm(service, state.drafts[service.key] || {}, { disabled: state.saving, trip, ctx, settings: ctx.settings });
      forms.set(service.key, { service, form });
      return h('section', { class: 'tvx-card tvx-ctr-form' }, [
        h('h4', { class: 'tvx-ctr-form-title', text: `${service.name} Requirement` }),
        form.el
      ]);
    });
    const message = h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', hidden: !state.error, text: state.error });
    const save = async () => {
      const requirements = {};
      const missing = [];
      for (const [key, { service, form }] of forms) {
        const values = form.read();
        requirements[key] = values;
        state.drafts[key] = values;
        for (const f of service.fields || []) {
          if (f.enabled === false || !f.required) continue;
          if (isEmpty(values[f.key])) missing.push(`${service.name}: ${f.label}`);
        }
      }
      if (missing.length) {
        message.textContent = `Complete the required fields: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`;
        message.hidden = false;
        return;
      }
      state.saving = true;
      render();
      try {
        state.data = await ctx.api.put(`/clients/${encodeURIComponent(clientId)}/travel-requirement`, { values: state.values, requirements });
        state.values = { ...(state.data.values || {}) };
        state.error = '';
        state.step = 'done';
        ctx.toast('Travel Requirement saved', 'success');
        if (typeof ctx.recordChanged === 'function') ctx.recordChanged();
      } catch (err) {
        state.error = errorText(err);
      }
      state.saving = false;
      render();
    };
    return h('div', { class: 'tvx-ctr-forms' }, [
      h('section', { class: 'tvx-card tvx-ctr-trip' }, [
        h('div', { class: 'tvx-card-head' }, [
          h('h3', { class: 'tvx-h3', text: 'Step 2 · Travel Requirement Forms' }),
          h('span', { class: 'tvx-muted', text: [state.values.to || state.values.destination, trip.start ? `${fmtDay(trip.start)}${trip.end ? ` – ${fmtDay(trip.end)}` : ''}` : ''].filter(Boolean).join(' · ') })
        ]),
        h('p', { class: 'tvx-muted', text: 'Every date stays inside the travel dates of Step 1.' })
      ]),
      ...cards,
      message,
      h('div', { class: 'tvx-row-gap tvx-ctr-actions' }, [
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: '← Back', disabled: state.saving, onclick: () => { for (const [k, { form }] of forms) state.drafts[k] = form.read(); state.step = 1; render(); } }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: state.saving ? 'Saving…' : 'Save Travel Requirement', disabled: state.saving, onclick: save })
      ])
    ]);
  }

  /* ------------------------------------------------------------- done */

  function summary() {
    const data = state.data || {};
    const v = data.values || {};
    if (!data.saved && !data.enquiry) {
      return h('section', { class: 'tvx-card tvx-empty' }, [
        h('p', { class: 'tvx-empty-title', text: 'No Travel Requirement yet' }),
        h('p', { class: 'tvx-muted', text: canEdit ? 'Start with the travel information.' : 'Someone with edit rights can add it.' }),
        canEdit ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: 'Add Travel Requirement', onclick: () => { state.step = 1; render(); } }) : null
      ]);
    }
    const trip = tripOf(v);
    const services = (data.services || []).filter((s) => (v.required_services || []).includes(s.key));
    const row = (label, value) => (value ? h('div', { class: 'tvx-ctr-kv' }, [h('span', { class: 'tvx-muted', text: label }), h('strong', { text: value })]) : null);
    return h('section', { class: 'tvx-card tvx-ctr-done' }, [
      h('div', { class: 'tvx-card-head' }, [
        h('h3', { class: 'tvx-h3', text: 'Travel Requirement' }),
        h('span', { class: `tvx-pill ${data.complete ? 'is-done' : 'is-draft'}`, text: data.complete ? 'Complete' : 'Incomplete' })
      ]),
      h('div', { class: 'tvx-ctr-grid' }, [
        row('From', v.from),
        row('To', v.to),
        row('Travel Dates', trip.start ? `${fmtDay(trip.start)}${trip.end ? ` – ${fmtDay(trip.end)}` : ''}` : ''),
        row('Number of Days', trip.days ? String(trip.days) : ''),
        row('Date Flexibility', v.date_flexibility)
      ]),
      h('ul', { class: 'tvx-ctr-services' }, services.map((s) => {
        const r = (data.requirements || {})[s.key];
        const done = r && r.status === 'Complete';
        return h('li', {}, [h('span', { text: s.name }), h('span', { class: `tvx-pill ${done ? 'is-done' : 'is-draft'}`, text: done ? 'Complete' : 'To complete' })]);
      })),
      h('div', { class: 'tvx-row-gap tvx-ctr-actions' }, [
        canEdit ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Edit', onclick: () => { state.step = 1; render(); } }) : null,
        travellersButton(data),
        data.complete && canQuote
          ? h('button', {
              type: 'button',
              class: 'tvx-btn tvx-btn-primary',
              text: 'Create Quotation',
              onclick: () => {
                const back = `/clients/${clientId}?tab=decl_travel_requirement`;
                ctx.navigate(`/quotations/create?clientId=${encodeURIComponent(clientId)}&returnTo=${encodeURIComponent(back)}`);
              }
            })
          : null
      ])
    ]);
  }

  /** Travellers live on the trip: open it (made from this requirement) only when the user asks. */
  function travellersButton(data) {
    if (data.enquiry && data.enquiry.leadId) {
      return h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Travellers', onclick: () => ctx.navigate(`/leads/${encodeURIComponent(data.enquiry.leadId)}?tab=decl_travellers`) });
    }
    if (!data.complete || !canEdit) return null;
    return h('button', {
      type: 'button',
      class: 'tvx-btn tvx-btn-ghost',
      text: state.opening ? 'Opening trip…' : 'Open Trip & Add Travellers',
      title: 'Opens this trip (an enquiry on the Leads page) from the saved requirement, so travellers can be added.',
      disabled: Boolean(state.opening),
      onclick: async () => {
        state.opening = true;
        render();
        try {
          const res = await ctx.api.post(`/clients/${encodeURIComponent(clientId)}/travel-requirement/trip`, {});
          ctx.navigate(`/leads/${encodeURIComponent(res.leadId)}?tab=decl_travellers`);
        } catch (err) {
          ctx.toast(errorText(err), 'error');
        }
        state.opening = false;
        render();
      }
    });
  }

  function render() {
    if (state.step !== 1) dropFields();
    if (state.step === 'loading') {
      root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading travel requirement…' }));
      return;
    }
    if (state.step === 'error') {
      root.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: state.error }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load() })
      );
      return;
    }
    const body = state.step === 1 ? stepOne() : state.step === 2 ? stepTwo() : summary();
    root.replaceChildren(h('div', { class: 'tvx-ctr' }, [canEdit && state.step !== 'done' ? steps(state.step) : null, body]));
  }

  load();
}

class ClientTravelRequirement extends TravelElement {
  start(ctx) {
    renderClientTravelRequirement(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-client-travel-requirement-v1', ClientTravelRequirement);
