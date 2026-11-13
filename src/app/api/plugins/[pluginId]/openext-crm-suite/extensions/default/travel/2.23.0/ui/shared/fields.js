/**
 * Inputs for builder-defined fields. Used by the lead requirement form and by
 * the builder's live preview, so both always look the same.
 *
 * A saved choice whose option was removed later in Services & Forms stays visible,
 * marked "(no longer offered)", and can be cleared; the server drops it on save.
 *
 * 2.12.0 trip rules (opts.trip = the lead's { start, end, nights, days }): date pickers only offer days
 * inside the travel dates and after their paired date, a nights field with two dates is calculated
 * (read only), other nights / days fields cannot go above the trip. The server checks the same rules.
 */

import { h, sortByOrder } from './dom.js';
import { allowedRange } from './trip-range.js';

const STALE = 'no longer offered';

export const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
  { value: 'searchable_select', label: 'Searchable dropdown' },
  { value: 'radio', label: 'Single choice' },
  { value: 'multiselect', label: 'Multiple choice' },
  { value: 'checkbox', label: 'Checkbox' }
];
export const CHOICE_TYPES = new Set(['select', 'radio', 'multiselect', 'searchable_select']);

export function optionList(field, settings) {
  let list = Array.isArray(field && field.options) ? [...field.options] : [];
  const s = settings || (typeof window !== 'undefined' && window.CrmApp && window.CrmApp.settings);
  if (field && field.optionsFrom && s) {
    const key = typeof field.optionsFrom === 'string' ? field.optionsFrom.replace(/^settings\./, '') : (field.optionsFrom.setting || '');
    const fromSettings = key && Array.isArray(s[key]) ? s[key] : [];
    if (fromSettings.length) {
      const existingVals = new Set(list.map((o) => (typeof o === 'string' ? o : o.value)));
      for (const item of fromSettings) {
        const strVal = typeof item === 'string' ? item : (item && (item.value || item.label));
        if (strVal && !existingVals.has(strVal)) {
          list.push({ label: strVal, value: strVal });
          existingVals.add(strVal);
        }
      }
    }
  }
  return list
    .map((o) => (typeof o === 'string' ? { label: o, value: o } : { label: String(o.label || o.value || ''), value: String(o.value || o.label || '') }))
    .filter((o) => o.value);
}

/* ------------------------------------------------------------ type-ahead */

// Same rule as api/services/field-suggestions.js: personal details never get shared suggestions.
const SUGGEST_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
const PERSONAL_RE = /(phone|mobile|whats_?app|e_?mail|passport|aadhaar|aadhar|\bpan\b|pan_no|pan_number|address|dob|birth|(guest|traveller|traveler|passenger|contact|customer|person|lead|client)_?name|^name$)/i;

/** A requirement text field that offers the values entered before for it. */
export function suggestibleField(field) {
  if (!field || field.type !== 'text' || field.internal) return false;
  const key = String(field.key || '');
  if (!SUGGEST_KEY_RE.test(key)) return false;
  return !PERSONAL_RE.test(key) && !PERSONAL_RE.test(String(field.label || '').replace(/\s+/g, '_'));
}

let suggestUid = 0;

/**
 * A text input that shows the field's earlier values while typing (GET /field-suggestions) and offers
 * to add what was typed (POST /field-suggestions). Anything typed is still the value: the list only helps.
 */
function suggestInput(field, value, fire, disabled, api, inputId) {
  const listId = `tvx-sg-${++suggestUid}`;
  const input = h('input', {
    id: inputId,
    type: 'text',
    class: 'tvx-input tvx-combobox-input tvx-suggest-input',
    placeholder: field.placeholder || `Type or pick ${String(field.label || '').toLowerCase()}`,
    disabled: Boolean(disabled),
    autocomplete: 'off',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    maxlength: '120'
  });
  input.value = value === undefined || value === null ? '' : String(value);
  const menu = h('div', { class: 'tvx-combobox-menu', role: 'listbox', id: listId, 'aria-label': `${field.label} suggestions` });
  menu.style.display = 'none';
  const cache = new Map();
  let items = [];
  let active = -1;
  let timer = 0;
  let seq = 0;

  const close = () => {
    menu.style.display = 'none';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const choose = (text) => {
    input.value = text;
    close();
    fire();
  };
  async function addTyped(text) {
    choose(text);
    try {
      const res = await api.post('/field-suggestions', { field: field.key, value: text });
      cache.clear();
      if (res && res.value && res.value !== text) input.value = res.value;
    } catch {
      // The value stays on the requirement even if the list could not be updated.
    }
  }
  function highlight(index) {
    active = index;
    items.forEach((el, i) => el.classList.toggle('is-active', i === index));
    if (index >= 0 && items[index]) {
      input.setAttribute('aria-activedescendant', items[index].id);
      items[index].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function render(values) {
    const typed = input.value.replace(/\s+/g, ' ').trim();
    const lower = typed.toLowerCase();
    menu.replaceChildren();
    items = [];
    values.forEach((v, i) => {
      const el = h('button', { type: 'button', class: 'tvx-combobox-item', role: 'option', id: `${listId}-${i}`, tabindex: '-1', 'aria-selected': 'false' }, [h('span', { text: v })]);
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(v);
      });
      items.push(el);
      menu.append(el);
    });
    if (typed && !values.some((v) => v.toLowerCase() === lower)) {
      const add = h('button', { type: 'button', class: 'tvx-combobox-add', role: 'option', id: `${listId}-add`, tabindex: '-1', 'aria-selected': 'false' }, [
        h('span', { class: 'tvx-combobox-add-plus', text: '+' }),
        h('span', { text: `Add "${typed}"` })
      ]);
      add.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addTyped(typed);
      });
      items.push(add);
      menu.append(add);
    }
    if (!items.length) {
      close();
      return;
    }
    menu.style.display = 'flex';
    input.setAttribute('aria-expanded', 'true');
    highlight(-1);
  }
  async function lookup() {
    const q = input.value.replace(/\s+/g, ' ').trim();
    const key = q.toLowerCase();
    const mine = ++seq;
    let values = cache.get(key);
    if (!values) {
      try {
        const res = await api.get(`/field-suggestions?field=${encodeURIComponent(field.key)}&q=${encodeURIComponent(q)}`);
        values = Array.isArray(res && res.values) ? res.values.map(String) : [];
      } catch {
        values = [];
      }
      cache.set(key, values);
    }
    if (mine !== seq || document.activeElement !== input) return;
    render(values);
  }
  const soon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(lookup, 180);
  };

  input.addEventListener('input', () => {
    fire();
    soon();
  });
  input.addEventListener('focus', () => {
    if (!disabled) soon();
  });
  input.addEventListener('blur', () => window.setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    const open = menu.style.display !== 'none';
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) lookup();
      else highlight(Math.min(items.length - 1, active + 1));
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      highlight(Math.max(-1, active - 1));
    } else if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault();
      items[active].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  });

  const wrap = h('div', { class: 'tvx-combobox' }, [h('div', { class: 'tvx-combobox-input-wrap' }, [input]), menu]);
  wrap.readValue = () => input.value.replace(/\s+/g, ' ').trim();
  Object.defineProperty(wrap, 'value', {
    get: () => input.value,
    set: (v) => {
      input.value = v === undefined || v === null ? '' : String(v);
    }
  });
  return wrap;
}

/**
 * One input for a builder-defined field.
 * @returns {{ el: HTMLElement, read: () => any }}
 */
export function fieldInput(field, value, onChange, disabled, opts = {}) {
  const id = `tvx_${field.key}_${Math.random().toString(36).slice(2, 7)}`;
  const label = h('label', { class: 'tvx-label', for: id }, [field.label, field.required ? h('span', { class: 'tvx-req', text: '*' }) : null]);
  let control;
  const fire = () => onChange && onChange();

  switch (field.type) {
    case 'textarea':
      control = h('textarea', { id, class: 'tvx-input tvx-textarea', rows: 3, placeholder: field.placeholder || '', disabled, oninput: fire });
      control.value = value === undefined || value === null ? '' : String(value);
      break;
    case 'number':
      control = h('input', { id, type: 'number', class: 'tvx-input', placeholder: field.placeholder || '', disabled, oninput: fire });
      control.value = value === undefined || value === null ? '' : String(value);
      break;
    case 'date':
      control = h('input', { id, type: 'date', class: 'tvx-input', disabled, oninput: fire });
      control.value = typeof value === 'string' ? value.slice(0, 10) : '';
      break;
    case 'searchable_select':
    case 'select': {
      if (field.type === 'select' && !field.searchable) {
        const current = value === undefined || value === null ? '' : String(value);
        const offered = optionList(field, opts.settings || (opts.ctx && opts.ctx.settings));
        const stale = current && !offered.some((o) => o.value === current);
        control = h('select', { id, class: 'tvx-input', disabled, onchange: fire }, [
          h('option', { value: '', text: field.placeholder || `Select ${String(field.label || '').toLowerCase()}` }),
          ...offered.map((o) => h('option', { value: o.value, text: o.label })),
          stale ? h('option', { value: current, text: `${current} (${STALE})` }) : null
        ]);
        control.value = current;
        break;
      }

      // Searchable dropdown / combobox
      let current = value === undefined || value === null ? '' : String(value);
      const settingsObj = opts.settings || (opts.ctx && opts.ctx.settings);
      let offered = optionList(field, settingsObj);
      if (current && !offered.some((o) => o.value === current)) {
        offered.push({ label: current, value: current });
      }

      let settingKey = '';
      if (field.optionsFrom) {
        settingKey = typeof field.optionsFrom === 'string'
          ? field.optionsFrom.replace(/^settings\./, '')
          : (field.optionsFrom.setting || '');
      }
      if (!settingKey) {
        const k = String(field.key || '').toLowerCase();
        if (/destination/.test(k)) settingKey = 'destinations';
        else if (/^from(_|$)|_from(_|$)/.test(k)) settingKey = 'from_places';
        else if (/^to(_|$)|_to(_|$)/.test(k)) settingKey = 'to_places';
      }

      const getSelectedLabel = () => {
        const found = offered.find((o) => o.value === current);
        return found ? found.label : current;
      };

      const searchInput = h('input', {
        id,
        type: 'text',
        class: 'tvx-input tvx-combobox-input',
        placeholder: field.placeholder || `Select or search ${String(field.label || '').toLowerCase()}...`,
        disabled: Boolean(disabled),
        autocomplete: 'off'
      });
      searchInput.value = getSelectedLabel();

      const clearBtn = h('button', {
        type: 'button',
        class: 'tvx-combobox-clear',
        'aria-label': 'Clear selection',
        title: 'Clear selection',
        disabled: Boolean(disabled),
        text: '×'
      });
      clearBtn.style.display = current && !disabled ? 'inline-flex' : 'none';

      const arrow = h('span', { class: 'tvx-combobox-arrow', 'aria-hidden': 'true', text: '▾' });
      const menu = h('div', { class: 'tvx-combobox-menu', role: 'listbox' });
      menu.style.display = 'none';

      function selectValue(val, triggerFire = true) {
        current = val;
        searchInput.value = getSelectedLabel();
        clearBtn.style.display = current && !disabled ? 'inline-flex' : 'none';
        closeMenu();
        if (triggerFire) fire();
      }

      function openMenu() {
        if (disabled) return;
        renderMenu(searchInput.value.trim());
        menu.style.display = 'flex';
      }

      function closeMenu() {
        menu.style.display = 'none';
        if (searchInput.value !== getSelectedLabel()) {
          searchInput.value = getSelectedLabel();
        }
      }

      async function handleAddOption(typed) {
        const textVal = String(typed || '').trim();
        if (!textVal) return;
        const exists = offered.find((o) => o.value.toLowerCase() === textVal.toLowerCase() || o.label.toLowerCase() === textVal.toLowerCase());
        if (exists) {
          selectValue(exists.value);
          return;
        }

        const newItem = { label: textVal, value: textVal };
        offered.push(newItem);
        if (Array.isArray(field.options) && !field.options.some((o) => (typeof o === 'string' ? o : o.value).toLowerCase() === textVal.toLowerCase())) {
          field.options.push(newItem);
        }

        selectValue(textVal);

        if (typeof opts.onAddOption === 'function') {
          try {
            await opts.onAddOption(textVal, field, settingKey);
          } catch (e) {
            console.warn('onAddOption error:', e);
          }
        } else if (settingKey) {
          try {
            const st = opts.settings || (opts.ctx && opts.ctx.settings) || (typeof window !== 'undefined' && window.CrmApp && window.CrmApp.settings) || {};
            const list = Array.isArray(st[settingKey]) ? [...st[settingKey]] : [];
            if (!list.some((x) => String(x).toLowerCase() === textVal.toLowerCase())) {
              list.push(textVal);
              st[settingKey] = list;
              if (typeof opts.saveSettings === 'function') {
                await opts.saveSettings({ [settingKey]: list });
              } else if (opts.ctx && typeof opts.ctx.saveSettings === 'function') {
                await opts.ctx.saveSettings({ [settingKey]: list });
              } else if (typeof window !== 'undefined' && window.CrmApi && typeof window.CrmApi.setExtensionSettings === 'function') {
                await window.CrmApi.setExtensionSettings({ [settingKey]: list });
              } else if (typeof fetch === 'function') {
                await fetch('/api/plugins/openext-crm-suite/crm-extension-data/settings', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ values: { [settingKey]: list } })
                }).catch(() => {});
              }
            }
          } catch (err) {
            console.warn('Failed to update travel setting', settingKey, err);
          }
        }
      }

      function renderMenu(query = '') {
        menu.replaceChildren();
        const q = query.toLowerCase();
        const filtered = offered.filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));

        if (filtered.length) {
          filtered.forEach((opt) => {
            const isSelected = opt.value === current;
            const itemBtn = h('button', {
              type: 'button',
              class: `tvx-combobox-item${isSelected ? ' is-active' : ''}`,
              role: 'option',
              'aria-selected': isSelected ? 'true' : 'false'
            }, [
              h('span', { text: opt.label }),
              isSelected ? h('span', { class: 'tvx-combobox-check', text: '✓' }) : null
            ]);
            itemBtn.addEventListener('mousedown', (e) => {
              e.preventDefault();
              selectValue(opt.value);
            });
            menu.append(itemBtn);
          });
        }

        const exactMatch = offered.some((o) => o.value.toLowerCase() === q || o.label.toLowerCase() === q);
        if (q && !exactMatch && !disabled) {
          const addBtn = h('button', {
            type: 'button',
            class: 'tvx-combobox-add',
            role: 'button'
          }, [
            h('span', { class: 'tvx-combobox-add-plus', text: '+' }),
            h('span', { text: `Add "${query}"` })
          ]);
          addBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            handleAddOption(query);
          });
          menu.append(addBtn);
        } else if (!filtered.length && !q) {
          menu.append(h('div', { class: 'tvx-combobox-empty', text: 'No options available' }));
        } else if (!filtered.length && q) {
          menu.append(h('div', { class: 'tvx-combobox-empty', text: 'No matching options' }));
        }
      }

      searchInput.addEventListener('focus', () => {
        openMenu();
      });

      searchInput.addEventListener('input', () => {
        clearBtn.style.display = searchInput.value && !disabled ? 'inline-flex' : 'none';
        openMenu();
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const q = searchInput.value.trim();
          if (!q) return;
          const match = offered.find((o) => o.label.toLowerCase() === q.toLowerCase() || o.value.toLowerCase() === q.toLowerCase());
          if (match) {
            selectValue(match.value);
          } else {
            handleAddOption(q);
          }
        } else if (e.key === 'Escape') {
          closeMenu();
        } else if (e.key === 'ArrowDown') {
          if (menu.style.display === 'none') {
            openMenu();
          }
        }
      });

      searchInput.addEventListener('blur', () => {
        setTimeout(() => {
          closeMenu();
        }, 200);
      });

      clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        selectValue('');
        searchInput.focus();
      });

      const wrap = h('div', { class: 'tvx-combobox' }, [
        h('div', { class: 'tvx-combobox-input-wrap' }, [searchInput, clearBtn, arrow]),
        menu
      ]);

      control = wrap;
      control.readValue = () => current;
      Object.defineProperty(control, 'value', {
        get: () => current,
        set: (v) => {
          selectValue(v === undefined || v === null ? '' : String(v), false);
        }
      });
      break;
    }
    case 'radio': {
      const name = `${id}_r`;
      const current = value === undefined || value === null ? '' : String(value);
      const offered = optionList(field);
      const stale = current && !offered.some((o) => o.value === current);
      const choices = offered.map((o) =>
        h('label', { class: 'tvx-choice' }, [
          h('input', { type: 'radio', name, value: o.value, checked: current === o.value, disabled, onchange: fire }),
          h('span', { text: o.label })
        ])
      );
      if (stale) {
        // Shown so the agent sees what was saved; "Clear" unticks it (a radio cannot be unticked).
        const staleBox = h('label', { class: 'tvx-choice' }, [
          h('input', { type: 'radio', name, value: current, checked: true, disabled, onchange: fire }),
          h('span', { text: `${current} (${STALE})` })
        ]);
        const clear = h('button', { type: 'button', class: 'tvx-link-btn', disabled, text: 'Clear' });
        clear.addEventListener('click', () => {
          staleBox.remove();
          clear.remove();
          fire();
        });
        choices.push(staleBox, clear);
      }
      control = h('div', { class: 'tvx-choices', role: 'radiogroup' }, choices);
      control.readValue = () => {
        const picked = control.querySelector('input:checked');
        return picked ? picked.value : '';
      };
      break;
    }
    case 'multiselect': {
      const selected = new Set(Array.isArray(value) ? value.map(String) : []);
      const offered = optionList(field);
      const chips = offered.map((o) => {
        const chip = h('button', { type: 'button', class: `tvx-chip${selected.has(o.value) ? ' is-on' : ''}`, disabled, text: o.label });
        chip.addEventListener('click', () => {
          if (selected.has(o.value)) selected.delete(o.value);
          else selected.add(o.value);
          chip.classList.toggle('is-on');
          fire();
        });
        return chip;
      });
      // Saved values whose option was removed: shown until the agent takes them off (×).
      for (const v of [...selected].filter((v) => !offered.some((o) => o.value === v))) {
        const chip = h('span', { class: 'tvx-chip is-static is-stale' }, [`${v} (${STALE})`]);
        if (!disabled) {
          chip.append(h('button', {
            type: 'button',
            class: 'tvx-chip-x',
            'aria-label': `Remove ${v}`,
            text: '×',
            onclick: () => {
              selected.delete(v);
              chip.remove();
              fire();
            }
          }));
        }
        chips.push(chip);
      }
      control = h('div', { class: 'tvx-chips' }, chips);
      control.readValue = () => [...selected];
      break;
    }
    case 'checkbox': {
      const box = h('input', { id, type: 'checkbox', checked: value === true, disabled, onchange: fire });
      control = h('label', { class: 'tvx-check', for: id }, [box, h('span', { text: field.placeholder || 'Yes' })]);
      control.readValue = () => box.checked;
      break;
    }
    default: {
      // Text fields of a requirement form: type-ahead from the values entered before for that field.
      const api = opts.ctx && opts.ctx.api;
      if (opts.suggest !== false && api && typeof api.get === 'function' && suggestibleField(field)) {
        control = suggestInput(field, value, fire, disabled, api, id);
        break;
      }
      control = h('input', { id, type: 'text', class: 'tvx-input', placeholder: field.placeholder || '', disabled, oninput: fire });
      control.value = value === undefined || value === null ? '' : String(value);
    }
  }

  const read = () => {
    if (typeof control.readValue === 'function') return control.readValue();
    if (field.type === 'number') return control.value === '' ? null : Number(control.value);
    return control.value;
  };

  const width = field.type === 'textarea' || field.type === 'multiselect' ? ' tvx-col-full' : '';
  const el = h('div', { class: `tvx-field${width}` }, [
    label,
    control,
    field.helpText ? h('p', { class: 'tvx-help', text: field.helpText }) : null
  ]);
  return { el, read, control };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Day + n ("YYYY-MM-DD", date-only: no time-zone shift). */
function shiftDay(day, n) {
  if (!DAY_RE.test(String(day || ''))) return '';
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nightsBetween(a, b) {
  if (!DAY_RE.test(String(a || '')) || !DAY_RE.test(String(b || ''))) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function setBound(control, name, value) {
  if (value === '' || value === null || value === undefined) control.removeAttribute(name);
  else control.setAttribute(name, String(value));
}

/** Applies the trip rules of the form's fields to its inputs (run again after every change). */
function tripRules(inputs, trip) {
  const byKey = new Map(inputs.map((i) => [i.field.key, i]));
  const valueOf = (key) => {
    const i = byKey.get(key);
    const v = i ? i.read() : '';
    return typeof v === 'string' ? v.slice(0, 10) : '';
  };
  const t = trip || {};
  // 2.23.0: the same allowed range as the server (Date Flexibility: Fixed / ± 7-day buffer / Flexible).
  const range = allowedRange(t);
  return () => {
    for (const i of inputs) {
      const f = i.field;
      const c = i.control;
      if (!c || typeof c.setAttribute !== 'function') continue;
      if (f.type === 'date') {
        let min = f.dateConstraint === 'lead_travel_range' ? range.min : '';
        const max = f.dateConstraint === 'lead_travel_range' ? range.max : '';
        const other = f.after ? valueOf(f.after) : '';
        const after = other ? (f.afterStrict ? shiftDay(other, 1) : other) : '';
        if (after && (!min || after > min)) min = after;
        setBound(c, 'min', min);
        setBound(c, 'max', max);
        continue;
      }
      if (f.type !== 'number') continue;
      const stay = f.nightsFrom && f.nightsTo ? nightsBetween(valueOf(f.nightsFrom), valueOf(f.nightsTo)) : null;
      if (stay !== null && stay > 0) {
        c.value = String(stay);
        c.readOnly = true;
        c.title = 'Calculated from the dates';
        setBound(c, 'max', stay);
      } else {
        c.readOnly = false;
        c.removeAttribute('title');
        const limit = range.kind === 'flexible' ? null : f.tripLimit === 'nights' ? t.nights : f.tripLimit === 'days' ? t.days : null;
        setBound(c, 'max', limit === null || limit === undefined ? '' : limit);
      }
      setBound(c, 'min', 0);
    }
  };
}

/** A grid of inputs for a service's enabled fields. */
export function serviceForm(service, values, { disabled, onChange, ...opts } = {}) {
  const fields = sortByOrder(service.fields).filter((f) => f.enabled !== false && f.key && f.label);
  let apply = () => {};
  const changed = () => {
    apply();
    if (onChange) onChange();
  };
  const inputs = fields.map((field) => ({ field, ...fieldInput(field, values ? values[field.key] : undefined, changed, disabled, opts) }));
  apply = tripRules(inputs, opts.trip);
  apply();
  const grid = h('div', { class: 'tvx-grid' }, inputs.map((i) => i.el));
  return {
    el: fields.length ? grid : h('p', { class: 'tvx-muted', text: 'This service has no questions. Mark it complete when it is agreed with the customer.' }),
    fieldCount: fields.length,
    read: () => Object.fromEntries(inputs.map((i) => [i.field.key, i.read()]))
  };
}
