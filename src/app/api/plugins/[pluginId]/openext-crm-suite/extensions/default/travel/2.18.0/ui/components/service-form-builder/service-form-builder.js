/**
 * <x-travel-service-builder-v1>: Services & Forms page. Lists the services
 * and edits each one's requirement form, with a live preview. Saved through
 * this extension's backend: PUT /services.
 *
 * Inputs save on "change" (not on every key), so typing never loses focus. An enabled
 * service needs at least one field (otherwise its requirement could never be filled in).
 * A date field can be set to "not before" another date of the form (e.g. check-out after
 * check-in; the server applies the same rule and defaults).
 */

import { h, slug, uniqueKey, clone, sortByOrder, errorText } from '../../shared/dom.js';
import { FIELD_TYPES, CHOICE_TYPES, optionList, serviceForm } from '../../shared/fields.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import { parseCsv, downloadText } from '../../shared/csv.js';

useStyles(new URL('./service-form-builder.css', import.meta.url));

// Same defaults as the server (api/services/catalog.js) for date fields with no rule saved yet.
const DEFAULT_AFTER = {
  check_out_date: ['check_in_date'],
  return_date: ['departure_date', 'journey_date', 'pickup_date'],
  end_date: ['start_date']
};
// 2.12.0 trip rules, same defaults as the server: a trip date stays inside the lead's travel dates,
// a check-out is strictly after its check-in, nights / days fields are limited by the stay or the trip.
const NOT_TRIP_DATE_RE = /(birth|dob|expir|issue|appointment|booking|deadline|submission|application|valid)/;
const STRICT_AFTER_RE = /check_?out/;
const defaultConstraint = (key) => (NOT_TRIP_DATE_RE.test(String(key || '')) ? 'none' : 'lead_travel_range');
const defaultTripLimit = (key) => (/night/.test(String(key || '')) ? 'nights' : /(^|_)days?$/.test(String(key || '')) ? 'days' : 'none');

// Panel icons: fixed markup drawn in currentColor (the theme colours come from the CSS).
const ICONS = {
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h3M8 17h6"/></svg>',
  form: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
};
function icon(name) {
  const el = h('span', { class: 'tvx-sb-icon', 'aria-hidden': 'true' });
  el.innerHTML = ICONS[name];
  return el;
}
/** A card with an icon, a title, a one-line explanation, optional actions on the right, then its body. */
function panel(iconName, title, subtitle, actions, body) {
  return h('section', { class: 'tvx-sb-panel' }, [
    h('div', { class: 'tvx-sb-panel-head' }, [
      icon(iconName),
      h('div', { class: 'tvx-sb-panel-title' }, [h('h4', { class: 'tvx-h4', text: title }), h('p', { class: 'tvx-sub', text: subtitle })]),
      actions || null
    ]),
    h('div', { class: 'tvx-sb-panel-body' }, body)
  ]);
}
/* ------------------------------------------------- options CSV import */

// Same limits as the server (api/services/catalog.js cleanOptions): 100 options, label / value up to 200 characters.
export const OPTIONS_MAX = 100;
const OPTION_TEXT_MAX = 200;
const OPTIONS_FILE_MAX = 512 * 1024;
// Dropdown, Searchable dropdown and Multiple choice fields with their own options (not linked to Travel Settings).
const IMPORT_TYPES = new Set(['select', 'searchable_select', 'multiselect']);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const OPTIONS_TEMPLATE = 'label,value\nEconomy,economy\nBusiness,business\nFirst Class,first_class\n';

/**
 * Checks a parsed CSV (string[][]) against a field's options. Nothing is changed here.
 * Header "label,value" (any case, value optional); a one-column file without that header is labels only.
 * A missing value is the label itself, as when an option is typed in by hand.
 * Returns { error } or { rows: [{ line, label, value, status: 'new'|'exists'|'duplicate'|'invalid', reason }], add: [{label, value}] }.
 */
export function planOptionsImport(existing, table, max = OPTIONS_MAX) {
  const rowsIn = Array.isArray(table) ? table : [];
  if (!rowsIn.length) return { error: 'The file is empty.' };
  const head = rowsIn[0].map((c) => String(c || '').trim().toLowerCase());
  let labelAt = head.indexOf('label');
  let valueAt = head.indexOf('value');
  let start = 1;
  if (labelAt < 0) {
    if (rowsIn.every((r) => r.length <= 1)) {
      labelAt = 0;
      valueAt = -1;
      start = 0;
    } else {
      return { error: 'The first row must be the header: label,value (download the template).' };
    }
  }
  const body = rowsIn.slice(start);
  if (!body.length) return { error: 'The file has no rows below the header.' };

  const known = (Array.isArray(existing) ? existing : [])
    .map((o) => (typeof o === 'string' ? { label: o, value: o } : { label: String((o && (o.label || o.value)) || ''), value: String((o && (o.value || o.label)) || '') }))
    .filter((o) => o.value);
  const takenValues = new Set(known.map((o) => o.value.toLowerCase()));
  const takenLabels = new Set(known.map((o) => o.label.toLowerCase()));
  const fileValues = new Set();
  const fileLabels = new Set();
  let room = Math.max(0, max - known.length);
  const rows = [];
  const add = [];
  body.forEach((r, i) => {
    const line = i + start + 1;
    const label = String(r[labelAt] ?? '').trim();
    const rawValue = valueAt >= 0 ? String(r[valueAt] ?? '').trim() : '';
    const value = rawValue || label;
    const row = { line, label, value, status: 'new', reason: '' };
    if (!label) Object.assign(row, { status: 'invalid', reason: 'Label is empty' });
    else if (label.length > OPTION_TEXT_MAX) Object.assign(row, { status: 'invalid', reason: `Label is longer than ${OPTION_TEXT_MAX} characters` });
    else if (value.length > OPTION_TEXT_MAX) Object.assign(row, { status: 'invalid', reason: `Value is longer than ${OPTION_TEXT_MAX} characters` });
    else if (CONTROL_RE.test(label) || CONTROL_RE.test(value)) Object.assign(row, { status: 'invalid', reason: 'Contains invalid characters' });
    else if (takenValues.has(value.toLowerCase()) || takenLabels.has(label.toLowerCase())) Object.assign(row, { status: 'exists', reason: 'Already an option' });
    else if (fileValues.has(value.toLowerCase()) || fileLabels.has(label.toLowerCase())) Object.assign(row, { status: 'duplicate', reason: 'Duplicate in the file' });
    else if (room <= 0) Object.assign(row, { status: 'invalid', reason: `Over the limit of ${max} options per field` });
    if (row.status === 'new') {
      fileValues.add(value.toLowerCase());
      fileLabels.add(label.toLowerCase());
      room -= 1;
      add.push({ label, value });
    }
    rows.push(row);
  });
  return { rows, add };
}

const IMPORT_STATUS = {
  new: ['New', 'is-new'],
  exists: ['Already exists (skipped)', 'is-skip'],
  duplicate: ['Duplicate in file (skipped)', 'is-skip'],
  invalid: ['Failed', 'is-fail']
};

const info = (text) => h('span', { class: 'tvx-sb-info', title: text, 'aria-label': text, role: 'img', text: 'i' });
/** A checkbox drawn as a switch (still a real checkbox: keyboard, screen readers and "change" work as before). */
const toggle = (input, text, title) =>
  h('label', { class: 'tvx-toggle', title }, [input, h('span', { class: 'tvx-toggle-track', 'aria-hidden': 'true' }), h('span', { class: 'tvx-toggle-text', text })]);
const requiredLabel = (text, forId) => h('label', { class: 'tvx-label', for: forId }, [text, h('span', { class: 'tvx-sb-req', 'aria-hidden': 'true', text: ' *' })]);

function renderServiceBuilder(root, ctx) {
  const canEdit = ctx.can('crm.settings.manage');
  const state = {
    services: sortByOrder(clone((ctx.settings && ctx.settings.services) || [])),
    selected: 0,
    dirty: false,
    saving: false,
    message: null,
    // Fields whose details (label, placeholder, help, options, date rule) are open: "<service>:<field>".
    openFields: new Set(),
    dragFrom: -1,
    // Options CSV import panel: { key: "<service>:<field>", fileName, plan, error, result }.
    optionImport: null
  };
  normaliseOrders(true);

  /**
   * Orders follow the current list positions. Only stored lists (on load / discard) are sorted first:
   * sorting after a move would put the moved item back by its old order.
   */
  function normaliseOrders(sortStored = false) {
    state.services.forEach((s, i) => {
      s.order = (i + 1) * 10;
      s.fields = sortStored ? sortByOrder(s.fields || []) : s.fields || [];
      s.fields.forEach((f, j) => (f.order = (j + 1) * 10));
    });
  }

  function touch() {
    state.dirty = true;
    state.edits = (state.edits || 0) + 1;
    state.message = null;
    render();
  }

  // Unsaved changes: the browser asks before the page is left (reload, close, typed URL).
  const beforeUnload = (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  if (typeof root.onCleanup === 'function') root.onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));
  root.isDirty = () => Boolean(state.dirty);

  function problems() {
    const out = [];
    const serviceKeys = new Set();
    state.services.forEach((s) => {
      if (!String(s.name || '').trim()) out.push('Every service needs a name');
      if (serviceKeys.has(s.key)) out.push(`Duplicate service key "${s.key}"`);
      serviceKeys.add(s.key);
      const fieldKeys = new Set();
      (s.fields || []).forEach((f) => {
        if (!String(f.label || '').trim()) out.push(`${s.name}: every field needs a label`);
        if (fieldKeys.has(f.key)) out.push(`${s.name}: duplicate field key "${f.key}"`);
        fieldKeys.add(f.key);
        if (CHOICE_TYPES.has(f.type) && !optionList(f, ctx.settings).length && !f.optionsFrom) out.push(`${s.name} → ${f.label || 'field'}: add at least one option`);
      });
      const shown = (s.fields || []).filter((f) => f.enabled !== false && String(f.label || '').trim());
      if (s.enabled !== false && !shown.length) out.push(`${s.name || 'A service'}: add at least one field, or switch the service off`);
    });
    return [...new Set(out)];
  }

  async function save() {
    const issues = problems();
    if (issues.length) {
      state.message = { kind: 'error', text: issues.slice(0, 4).join(' · ') };
      render();
      return;
    }
    state.saving = true;
    const editsAtStart = state.edits || 0;
    render();
    try {
      normaliseOrders();
      const saved = await ctx.api.put('/services', { services: clone(state.services) });
      ctx.settings = { ...(ctx.settings || {}), services: clone((saved && saved.services) || state.services) };
      // Edits made while the save ran stay on screen (and unsaved); otherwise the saved forms are shown.
      if ((state.edits || 0) !== editsAtStart) {
        state.message = { kind: 'success', text: 'Saved. Newer changes are not saved yet.' };
        return;
      }
      state.services = sortByOrder(clone((saved && saved.services) || state.services));
      state.dirty = false;
      state.message = { kind: 'success', text: 'Services and forms saved. New leads use them right away.' };
    } catch (err) {
      state.message = { kind: 'error', text: errorText(err) };
    } finally {
      state.saving = false;
      render();
    }
  }

  function addService() {
    const taken = new Set(state.services.map((s) => s.key));
    state.services.push({ key: uniqueKey('new_service', taken), name: 'New service', description: '', enabled: true, order: 0, fields: [], isNew: true });
    state.selected = state.services.length - 1;
    normaliseOrders();
    touch();
  }

  function moveService(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.services.length) return;
    const [item] = state.services.splice(index, 1);
    state.services.splice(target, 0, item);
    state.selected = target;
    normaliseOrders();
    touch();
  }

  function removeService(index) {
    const s = state.services[index];
    if (!window.confirm(`Delete the service "${s.name}" and its form? Leads that already saved this service keep their data.`)) return;
    state.services.splice(index, 1);
    state.selected = Math.max(0, Math.min(state.selected, state.services.length - 1));
    touch();
  }

  function addField(service) {
    const taken = new Set((service.fields || []).map((f) => f.key));
    service.fields.push({ key: uniqueKey('new_field', taken), label: 'New field', type: 'text', required: false, placeholder: '', helpText: '', options: [], order: 0, enabled: true, isNew: true });
    normaliseOrders();
    touch();
  }

  function moveField(service, index, delta) {
    moveFieldTo(service, index, index + delta);
  }

  function moveFieldTo(service, from, to) {
    if (from === to || from < 0 || to < 0 || from >= service.fields.length || to >= service.fields.length) return;
    const [item] = service.fields.splice(from, 1);
    service.fields.splice(to, 0, item);
    normaliseOrders();
    touch();
  }

  /* ---------------------------------------------------------------- views */

  function serviceList() {
    return h('div', { class: 'tvx-svc-list' }, [
      ...state.services.map((s, i) =>
        h(
          'button',
          {
            type: 'button',
            class: `tvx-svc${i === state.selected ? ' is-active' : ''}${s.enabled === false ? ' is-off' : ''}`,
            onclick: () => {
              state.selected = i;
              render();
            }
          },
          [
            h('span', { class: 'tvx-svc-name', text: s.name || 'Untitled' }),
            h('span', { class: 'tvx-svc-meta', text: `${(s.fields || []).filter((f) => f.enabled !== false).length} fields${s.enabled === false ? ' · off' : ''}` })
          ]
        )
      ),
      canEdit ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost tvx-add', onclick: addService, text: '+ Add service' }) : null
    ]);
  }

  function serviceEditor(service, index) {
    const takenServiceKeys = new Set(state.services.filter((_, i) => i !== index).map((s) => s.key));
    const nameId = `tvx-svc-name-${service.key}`;
    const nameInput = h('input', { id: nameId, class: 'tvx-input', value: service.name || '', disabled: !canEdit });
    nameInput.addEventListener('change', () => {
      service.name = nameInput.value.trim();
      if (service.isNew) service.key = uniqueKey(slug(service.name, 'service'), takenServiceKeys);
      touch();
    });
    // 2.16.0: the Service Configuration card is gone. Description, Quotation Pricing / Tax % / Line Group
    // and "Passport required" are no longer edited here; what a service already has is saved unchanged.
    const enabled = h('input', { type: 'checkbox', checked: service.enabled !== false, disabled: !canEdit });
    enabled.addEventListener('change', () => {
      service.enabled = enabled.checked;
      touch();
    });
    const serviceActions = canEdit
      ? h('div', { class: 'tvx-row-gap' }, [
          h('button', { type: 'button', class: 'tvx-icon-btn', title: 'Move service up', 'aria-label': 'Move service up', disabled: index === 0, onclick: () => moveService(index, -1), text: '↑' }),
          h('button', { type: 'button', class: 'tvx-icon-btn', title: 'Move service down', 'aria-label': 'Move service down', disabled: index === state.services.length - 1, onclick: () => moveService(index, 1), text: '↓' }),
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-danger', onclick: () => removeService(index), text: 'Delete service' })
        ])
      : null;

    const config = h('section', { class: 'tvx-sb-panel tvx-sb-svc-head', 'aria-label': 'Service' }, [
      h('div', { class: 'tvx-field tvx-sb-svc-name' }, [requiredLabel('Service Name', nameId), nameInput]),
      h('label', { class: 'tvx-switch' }, [enabled, h('span', { text: 'Offered on leads' }), info('Shown in Required Services on a travel lead')]),
      serviceActions
    ]);

    const rows = (service.fields || []).map((field, fi) => fieldRow(service, field, fi));
    const fieldsCard = panel(
      'form',
      `Form Fields (${service.fields.length})`,
      'Build the requirement form by adding, arranging, and configuring form fields.',
      canEdit ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost tvx-sb-add', onclick: () => addField(service), text: '+ Add Field' }) : null,
      [rows.length ? h('div', { class: 'tvx-sb-rows', role: 'list' }, rows) : h('p', { class: 'tvx-muted', text: 'No fields yet. Add the questions staff should ask for this service.' })]
    );

    const preview = panel('eye', 'Live Preview', 'How the form looks on a lead.', null, [h('div', { class: 'tvx-preview' }, [serviceForm(service, {}, { disabled: true, ctx, settings: ctx.settings }).el])]);

    return h('div', { class: 'tvx-editor' }, [config, fieldsCard, preview]);
  }

  /** "Import Options from CSV": choose a file, preview every row, then append only the new options. */
  function optionsImportPanel(field, openKey) {
    const imp = state.optionImport;
    const fieldName = field.label || field.key;
    const close = () => {
      state.optionImport = null;
      render();
    };
    const file = h('input', {
      type: 'file',
      accept: '.csv,text/csv',
      class: 'tvx-input tvx-sb-import-file',
      'aria-label': `CSV file with options for ${fieldName}`,
      onchange: async (e) => {
        const chosen = e.target.files && e.target.files[0];
        if (!chosen) return;
        // Read here in the browser only: the file is never uploaded or kept.
        const next = { key: openKey, fileName: chosen.name, plan: null, error: '', result: null };
        if (chosen.size > OPTIONS_FILE_MAX) next.error = 'The file is larger than 512 KB.';
        else {
          try {
            const plan = planOptionsImport(field.options, parseCsv(await chosen.text()));
            if (plan.error) next.error = plan.error;
            else next.plan = plan;
          } catch (err) {
            next.error = `The file could not be read: ${errorText(err)}`;
          }
        }
        state.optionImport = next;
        render();
      }
    });
    const runImport = () => {
      const plan = imp && imp.plan;
      if (!plan) return;
      // Re-checked against the options as they are now; existing options are kept exactly as they are.
      const fresh = planOptionsImport(field.options, [['label', 'value'], ...plan.rows.map((r) => [r.label, r.value])]);
      const added = fresh.add || [];
      const count = (s) => (fresh.rows || []).filter((r) => r.status === s).length;
      const result = { added: added.length, skipped: count('exists') + count('duplicate'), failed: count('invalid') };
      if (added.length) {
        field.options = [...(Array.isArray(field.options) ? field.options : []), ...added];
        state.dirty = true;
        state.edits = (state.edits || 0) + 1;
      }
      state.optionImport = { key: openKey, fileName: imp.fileName, plan: null, error: '', result };
      const summary = `${result.added} added · ${result.skipped} skipped · ${result.failed} failed`;
      state.message = { kind: result.added ? 'success' : 'warn', text: `${fieldName}: options import — ${summary}.${result.added ? ' Click "Save forms" to keep them.' : ''}` };
      if (typeof ctx.toast === 'function') ctx.toast(`Options import: ${summary}`, result.added ? 'success' : 'info');
      render();
    };

    const plan = imp && imp.plan;
    const counts = plan ? Object.fromEntries(Object.keys(IMPORT_STATUS).map((s) => [s, plan.rows.filter((r) => r.status === s).length])) : null;
    return h('div', { class: 'tvx-sb-import', role: 'group', 'aria-label': `Import options for ${fieldName}` }, [
      h('div', { class: 'tvx-sb-import-head' }, [
        h('strong', { text: 'Import Options from CSV' }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', onclick: close, text: imp && imp.result ? 'Done' : 'Cancel' })
      ]),
      h('p', {
        class: 'tvx-help',
        text: 'Columns: label,value (value is optional — the label is used). New options are added after the existing ones; existing options are never changed or removed. Max 512 KB. The file is read in your browser and not stored.'
      }),
      h('div', { class: 'tvx-row-gap' }, [
        file,
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', onclick: () => downloadText('dropdown-options-template.csv', OPTIONS_TEMPLATE), text: 'Download template' })
      ]),
      imp && imp.error ? h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: imp.error }) : null,
      imp && imp.result
        ? h('div', {
            class: `tvx-msg tvx-msg-${imp.result.added ? 'success' : 'warn'} tvx-sb-import-result`,
            role: 'status',
            text: `Import result: ${imp.result.added} added · ${imp.result.skipped} skipped · ${imp.result.failed} failed.${imp.result.added ? ' Click "Save forms" to keep them.' : ''}`
          })
        : null,
      plan
        ? h('div', { class: 'tvx-sb-import-preview' }, [
            h('p', { class: 'tvx-muted', text: `${imp.fileName || 'File'}: ${counts.new} new · ${counts.exists} already exist · ${counts.duplicate} duplicate in file · ${counts.invalid} failed` }),
            h('div', { class: 'tvx-sb-import-table-wrap' }, [
              h('table', { class: 'tvx-sb-import-table' }, [
                h('thead', {}, [h('tr', {}, ['Row', 'Label', 'Value', 'Status'].map((t) => h('th', { text: t })))]),
                h('tbody', {}, plan.rows.map((r) => {
                  const [text, cls] = IMPORT_STATUS[r.status];
                  return h('tr', { class: `tvx-sb-import-row ${cls}` }, [
                    h('td', { text: String(r.line) }),
                    h('td', { text: r.label }),
                    h('td', { class: 'tvx-mono', text: r.value }),
                    h('td', { text: r.status === 'invalid' ? `${text}: ${r.reason}` : text })
                  ]);
                }))
              ])
            ]),
            h('div', { class: 'tvx-row-gap' }, [
              h('button', {
                type: 'button',
                class: 'tvx-btn tvx-btn-primary',
                disabled: !plan.add.length,
                onclick: runImport,
                text: `Import ${plan.add.length} option${plan.add.length === 1 ? '' : 's'}`
              })
            ])
          ])
        : null
    ]);
  }

  function fieldRow(service, field, index) {
    const takenFieldKeys = new Set(service.fields.filter((_, i) => i !== index).map((f) => f.key));
    const disabled = !canEdit;
    const label = h('input', { class: 'tvx-input', value: field.label || '', placeholder: 'Label', disabled });
    label.addEventListener('change', () => {
      field.label = label.value.trim();
      if (field.isNew) field.key = uniqueKey(slug(field.label, 'field'), takenFieldKeys);
      touch();
    });
    const type = h('select', { class: 'tvx-input', disabled, 'aria-label': `Type of ${field.label || field.key}` }, FIELD_TYPES.map((t) => h('option', { value: t.value, text: t.label })));
    type.value = field.type || 'text';

    const searchableToggle = h('input', {
      type: 'checkbox',
      checked: field.type === 'searchable_select' || field.searchable === true,
      disabled
    });
    searchableToggle.addEventListener('change', () => {
      field.searchable = searchableToggle.checked;
      if (searchableToggle.checked && field.type === 'select') {
        field.type = 'searchable_select';
        type.value = 'searchable_select';
      } else if (!searchableToggle.checked && field.type === 'searchable_select') {
        field.type = 'select';
        type.value = 'select';
      }
      touch();
    });

    type.addEventListener('change', () => {
      field.type = type.value;
      if (field.type === 'searchable_select') {
        field.searchable = true;
        searchableToggle.checked = true;
      } else if (field.type === 'select') {
        searchableToggle.checked = Boolean(field.searchable);
      } else {
        delete field.searchable;
        delete field.optionsFrom;
      }
      if (!CHOICE_TYPES.has(field.type)) field.options = [];
      touch();
    });
    const required = h('input', { type: 'checkbox', checked: field.required === true, disabled });
    required.addEventListener('change', () => {
      field.required = required.checked;
      touch();
    });
    const enabled = h('input', { type: 'checkbox', checked: field.enabled !== false, disabled });
    enabled.addEventListener('change', () => {
      field.enabled = enabled.checked;
      touch();
    });
    const placeholder = h('input', { class: 'tvx-input', value: field.placeholder || '', placeholder: 'Placeholder (optional)', disabled });
    placeholder.addEventListener('change', () => {
      field.placeholder = placeholder.value.trim();
      touch();
    });
    const help = h('input', { class: 'tvx-input', value: field.helpText || '', placeholder: 'Help text (optional)', disabled });
    help.addEventListener('change', () => {
      field.helpText = help.value.trim();
      touch();
    });

    let options = null;
    if (CHOICE_TYPES.has(field.type)) {
      // Fields filled from Travel Settings (optionsFrom) get their options there, so no CSV import.
      const importable = IMPORT_TYPES.has(field.type) && !field.optionsFrom;
      const importKey = `${service.key}:${field.key}`;
      const draft = h('input', { class: 'tvx-input', placeholder: 'Add option and press Enter', disabled });
      const addOption = () => {
        const text = draft.value.trim();
        if (!text) return;
        const list = optionList(field);
        if (!list.some((o) => o.value.toLowerCase() === text.toLowerCase())) list.push({ label: text, value: text });
        field.options = list;
        draft.value = '';
        touch();
      };
      draft.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addOption();
        }
      });
      options = h('div', { class: 'tvx-options' }, [
        h('div', { class: 'tvx-chips' }, [
          ...optionList(field).map((o, oi) =>
            h('span', { class: 'tvx-chip is-static' }, [
              o.label,
              canEdit
                ? h('button', {
                    type: 'button',
                    class: 'tvx-chip-x',
                    'aria-label': `Remove ${o.label}`,
                    onclick: () => {
                      field.options = optionList(field).filter((_, i) => i !== oi);
                      touch();
                    },
                    text: '×'
                  })
                : null
            ])
          ),
          optionList(field).length ? null : h('span', { class: 'tvx-warn', text: 'Needs at least one option' })
        ]),
        canEdit ? h('div', { class: 'tvx-row-gap' }, [draft, h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', onclick: addOption, text: 'Add' })]) : null,
        canEdit && importable
          ? state.optionImport && state.optionImport.key === importKey
            ? optionsImportPanel(field, importKey)
            : h('div', { class: 'tvx-row-gap' }, [
                h('button', {
                  type: 'button',
                  class: 'tvx-btn tvx-btn-ghost tvx-sb-import-open',
                  onclick: () => {
                    state.optionImport = { key: importKey, fileName: '', plan: null, error: '', result: null };
                    render();
                  },
                  text: 'Import Options from CSV'
                })
              ])
          : null
      ]);
    }

    // Date order: this date cannot be before another date of the form.
    let afterRow = null;
    if (field.type === 'date') {
      const others = service.fields.filter((f, i) => i !== index && f.type === 'date' && f.key);
      if (others.length) {
        const keys = new Set(others.map((f) => f.key));
        const current = field.after === undefined ? (DEFAULT_AFTER[field.key] || []).find((k) => keys.has(k)) || '' : field.after;
        const strict = field.afterStrict === undefined ? STRICT_AFTER_RE.test(field.key) : field.afterStrict === true;
        const afterId = `tvx-after-${service.key}-${field.key}`;
        // "ge:<key>" on or after, "gt:<key>" strictly after (e.g. check-out after check-in).
        const after = h('select', { id: afterId, class: 'tvx-input tvx-after-select', disabled }, [
          h('option', { value: '', text: 'Any date' }),
          ...others.flatMap((f) => [
            h('option', { value: `ge:${f.key}`, text: `On or after ${f.label || f.key}` }),
            h('option', { value: `gt:${f.key}`, text: `After ${f.label || f.key}` })
          ])
        ]);
        after.value = keys.has(current) ? `${strict ? 'gt' : 'ge'}:${current}` : '';
        after.addEventListener('change', () => {
          const [mode, key] = after.value ? after.value.split(':') : ['', ''];
          field.after = key || '';
          field.afterStrict = mode === 'gt';
          touch();
        });
        afterRow = h('div', { class: 'tvx-row-gap tvx-after-row' }, [h('label', { class: 'tvx-label', for: afterId, text: 'Date rule' }), after]);
      }
      // Inside the lead's Travel Start / End Date (the form disables other days; the server refuses them).
      const rangeId = `tvx-range-${service.key}-${field.key}`;
      const range = h('select', { id: rangeId, class: 'tvx-input tvx-after-select', disabled }, [
        h('option', { value: 'lead_travel_range', text: 'Within the lead’s travel dates' }),
        h('option', { value: 'none', text: 'Any date (not a trip date)' })
      ]);
      range.value = field.dateConstraint === 'none' || field.dateConstraint === 'lead_travel_range' ? field.dateConstraint : defaultConstraint(field.key);
      range.addEventListener('change', () => {
        field.dateConstraint = range.value;
        touch();
      });
      const rangeRow = h('div', { class: 'tvx-row-gap tvx-after-row' }, [h('label', { class: 'tvx-label', for: rangeId, text: 'Trip dates' }), range]);
      afterRow = afterRow ? h('div', {}, [rangeRow, afterRow]) : rangeRow;
    }

    // Number limits: the nights between two dates of the form (calculated), or at most the trip's nights / days.
    if (field.type === 'number') {
      const pairs = service.fields.filter((f) => f.type === 'date' && f.key && f.after && service.fields.some((o) => o.key === f.after && o.type === 'date'));
      const limitId = `tvx-limit-${service.key}-${field.key}`;
      const limit = h('select', { id: limitId, class: 'tvx-input tvx-after-select', disabled }, [
        h('option', { value: 'none', text: 'No limit' }),
        h('option', { value: 'nights', text: 'At most the trip’s nights' }),
        h('option', { value: 'days', text: 'At most the trip’s days' }),
        ...pairs.map((f) => {
          const from = service.fields.find((o) => o.key === f.after);
          return h('option', { value: `stay:${f.after}:${f.key}`, text: `Nights from ${(from && from.label) || f.after} to ${f.label || f.key} (calculated)` });
        })
      ]);
      const stayPair = field.nightsFrom && field.nightsTo ? `stay:${field.nightsFrom}:${field.nightsTo}` : '';
      const autoPair = field.nightsFrom === undefined && /night/.test(field.key) ? pairs.find((f) => STRICT_AFTER_RE.test(f.key)) : null;
      const shown = stayPair || (autoPair ? `stay:${autoPair.after}:${autoPair.key}` : '') || (field.tripLimit && field.tripLimit !== undefined ? field.tripLimit : defaultTripLimit(field.key));
      limit.value = [...limit.options].some((o) => o.value === shown) ? shown : 'none';
      limit.addEventListener('change', () => {
        const [kind, from, to] = limit.value.split(':');
        field.nightsFrom = kind === 'stay' ? from : '';
        field.nightsTo = kind === 'stay' ? to : '';
        field.tripLimit = kind === 'stay' ? 'nights' : kind;
        touch();
      });
      afterRow = h('div', { class: 'tvx-row-gap tvx-after-row' }, [h('label', { class: 'tvx-label', for: limitId, text: 'Limit' }), limit]);
    }

    let settingsRow = null;
    if (CHOICE_TYPES.has(field.type)) {
      const travelSettingsOptions = [
        ['', 'None / Custom options'],
        ['settings.destinations', 'Destinations (Settings → Travel)'],
        ['settings.from_places', 'From Locations (Settings → Travel)'],
        ['settings.to_places', 'To Locations (Settings → Travel)']
      ];
      const curOptionsFrom = typeof field.optionsFrom === 'string'
        ? field.optionsFrom
        : (field.optionsFrom && field.optionsFrom.setting ? `settings.${field.optionsFrom.setting}` : '');
      const settingsSelect = h(
        'select',
        { class: 'tvx-input', disabled },
        travelSettingsOptions.map(([val, lbl]) => h('option', { value: val, text: lbl }))
      );
      settingsSelect.value = travelSettingsOptions.some(([val]) => val === curOptionsFrom) ? curOptionsFrom : '';
      settingsSelect.addEventListener('change', () => {
        const val = settingsSelect.value;
        if (val) {
          field.optionsFrom = val;
          const key = val.replace(/^settings\./, '');
          const fromSettings = Array.isArray(ctx.settings && ctx.settings[key]) ? ctx.settings[key] : [];
          if (fromSettings.length) {
            const existingVals = new Set(optionList(field).map((o) => o.value.toLowerCase()));
            for (const item of fromSettings) {
              const strVal = String(item || '').trim();
              if (strVal && !existingVals.has(strVal.toLowerCase())) {
                field.options.push({ label: strVal, value: strVal });
                existingVals.add(strVal.toLowerCase());
              }
            }
          }
        } else {
          delete field.optionsFrom;
        }
        touch();
      });

      settingsRow = h('div', { class: 'tvx-field tvx-col-full' }, [
        h('label', { class: 'tvx-label', text: 'Options from Travel Settings' }),
        settingsSelect,
        h('p', { class: 'tvx-help', text: 'When linked to Travel Settings (Destinations, From / To Locations), options populate from Settings → Travel, and new entries added on forms automatically update the Travel Settings.' })
      ]);
    }

    const openKey = `${service.key}:${field.key}`;
    const isOpen = state.openFields.has(openKey);
    const labelId = `tvx-field-label-${service.key}-${field.key}`;
    label.id = labelId;
    const toggleOpen = () => {
      if (state.openFields.has(openKey)) state.openFields.delete(openKey);
      else state.openFields.add(openKey);
      render();
    };

    // Drag by the handle (the row is only draggable while the handle is held, so inputs keep text selection);
    // the handle also moves the field with the ↑ / ↓ keys.
    const handle = h('button', {
      type: 'button',
      class: 'tvx-sb-handle',
      title: canEdit ? 'Drag to reorder (or focus and press ↑ / ↓)' : 'Order',
      'aria-label': `Reorder ${field.label || field.key}`,
      disabled: !canEdit,
      text: '⠿'
    });
    const row = h('div', { class: `tvx-sb-row${field.enabled === false ? ' is-off' : ''}${isOpen ? ' is-open' : ''}`, role: 'listitem' });
    if (canEdit) {
      handle.addEventListener('pointerdown', () => row.setAttribute('draggable', 'true'));
      handle.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        moveField(service, index, e.key === 'ArrowUp' ? -1 : 1);
        const moved = root.querySelectorAll('.tvx-sb-handle')[index + (e.key === 'ArrowUp' ? -1 : 1)];
        if (moved) moved.focus();
      });
      row.addEventListener('dragstart', (e) => {
        state.dragFrom = index;
        row.classList.add('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
        }
      });
      row.addEventListener('dragover', (e) => {
        if (state.dragFrom < 0) return;
        e.preventDefault();
        row.classList.add('is-drop');
      });
      row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = state.dragFrom;
        state.dragFrom = -1;
        moveFieldTo(service, from, index);
      });
      row.addEventListener('dragend', () => {
        state.dragFrom = -1;
        row.removeAttribute('draggable');
        row.classList.remove('is-dragging');
        root.querySelectorAll('.tvx-sb-row.is-drop').forEach((r) => r.classList.remove('is-drop'));
      });
    }

    const details = h('div', { class: 'tvx-sb-details', hidden: !isOpen }, [
      h('div', { class: 'tvx-grid tvx-grid-2' }, [
        h('div', { class: 'tvx-field' }, [h('label', { class: 'tvx-label', for: labelId, text: 'Label' }), label]),
        h('div', { class: 'tvx-field' }, [h('span', { class: 'tvx-label', text: 'Key' }), h('span', { class: 'tvx-mono tvx-muted tvx-sb-key-full', text: field.key })]),
        h('div', { class: 'tvx-field' }, [h('span', { class: 'tvx-label', text: 'Placeholder' }), placeholder]),
        h('div', { class: 'tvx-field' }, [h('span', { class: 'tvx-label', text: 'Help text' }), help])
      ]),
      afterRow,
      settingsRow,
      options,
      canEdit
        ? h('div', { class: 'tvx-row-gap tvx-sb-detail-actions' }, [
            h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', disabled: index === 0, onclick: () => moveField(service, index, -1), text: '↑ Move up' }),
            h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', disabled: index === service.fields.length - 1, onclick: () => moveField(service, index, 1), text: '↓ Move down' }),
            h('button', {
              type: 'button',
              class: 'tvx-btn tvx-btn-danger',
              onclick: () => {
                service.fields.splice(index, 1);
                state.openFields.delete(openKey);
                normaliseOrders();
                touch();
              },
              text: 'Delete field'
            })
          ])
        : null
    ]);

    row.append(
      h('div', { class: 'tvx-sb-row-main' }, [
        handle,
        h('span', { class: 'tvx-sb-num', text: `${index + 1}.` }),
        h('button', { type: 'button', class: 'tvx-sb-name', 'aria-expanded': isOpen ? 'true' : 'false', title: 'Show the field details', onclick: toggleOpen }, [
          h('span', { class: 'tvx-sb-name-label', text: field.label || 'Untitled field' }),
          h('span', { class: 'tvx-sb-name-key tvx-mono', text: field.key })
        ]),
        h('div', { class: 'tvx-sb-type' }, [type]),
        h('div', { class: 'tvx-sb-toggles' }, [
          toggle(required, 'Required'),
          toggle(enabled, 'Shown'),
          (field.type === 'select' || field.type === 'searchable_select') ? toggle(searchableToggle, 'Searchable', 'Searchable dropdown with dynamic option addition') : null
        ]),
        h('button', {
          type: 'button',
          class: `tvx-icon-btn tvx-sb-expand${isOpen ? ' is-open' : ''}`,
          title: isOpen ? 'Hide details' : 'Edit label, placeholder, help, options',
          'aria-label': isOpen ? `Hide details of ${field.label || field.key}` : `Edit ${field.label || field.key}`,
          'aria-expanded': isOpen ? 'true' : 'false',
          onclick: toggleOpen,
          text: '⌄'
        })
      ]),
      details
    );
    return row;
  }

  /** O2: services without a stored tax rate quote with the default 18% — say so until one is saved. */
  function noTaxBanner() {
    const missing = state.services.filter((s) => s.taxRate === undefined || s.taxRate === null || s.taxRate === '');
    if (!missing.length) return null;
    return h('div', { class: 'tvx-msg tvx-msg-warn', role: 'status', text: `No quotation tax % saved for ${missing.map((s) => s.name || s.key).join(', ')} — quotations use 18% until you set one and save.` });
  }

  function render() {
    const service = state.services[state.selected];
    const body = state.services.length
      ? h('div', { class: 'tvx-builder' }, [serviceList(), serviceEditor(service, state.selected)])
      : h('div', { class: 'tvx-empty' }, [
          h('p', { text: 'No services yet.' }),
          canEdit ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', onclick: addService, text: 'Add the first service' }) : null
        ]);

    root.replaceChildren(
      h('section', { class: 'tvx-card' }, [
        h('div', { class: 'tvx-card-head' }, [
          h('div', {}, [
            h('h3', { class: 'tvx-h3', text: 'Services & Requirement Forms' }),
            h('p', {
              class: 'tvx-sub',
              text: 'Each service appears in Required Services on a travel lead. Its fields become the form in the lead’s Travel Requirement tab.'
            })
          ]),
          canEdit
            ? h('div', { class: 'tvx-row-gap' }, [
                state.dirty ? h('span', { class: 'tvx-dirty', text: 'Unsaved changes' }) : null,
                h('button', {
                  type: 'button',
                  class: 'tvx-btn tvx-btn-ghost',
                  disabled: !state.dirty || state.saving,
                  onclick: () => {
                    state.services = sortByOrder(clone((ctx.settings && ctx.settings.services) || []));
                    state.selected = 0;
                    state.dirty = false;
                    state.message = null;
                    normaliseOrders(true);
                    render();
                  },
                  text: 'Discard'
                }),
                h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', disabled: !state.dirty || state.saving, onclick: save, text: state.saving ? 'Saving…' : 'Save forms' })
              ])
            : h('span', { class: 'tvx-muted', text: 'Read only' })
        ]),
        state.message ? h('div', { class: `tvx-msg tvx-msg-${state.message.kind}`, text: state.message.text }) : null,
        noTaxBanner(),
        body
      ])
    );
  }

  render();
  // Keep ctx.settings current for "Discard" after a save.
  subscribe(root, ctx, 'onSettingsChanged', (values) => {
    ctx.settings = { ...(ctx.settings || {}), ...values };
  });
}

class ServiceFormBuilder extends TravelElement {
  start(ctx) {
    renderServiceBuilder(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-service-builder-v1', ServiceFormBuilder);
