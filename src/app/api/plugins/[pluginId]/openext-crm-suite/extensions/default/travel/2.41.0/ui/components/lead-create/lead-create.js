/**
 * <x-travel-lead-create-v1>: 2.39.0 / 2.40.0 (CRM 3.67.0 salesFlow.leadCreateExtras, slot lead.create.travel) — the
 * Travel sections at the end of CRM Leads → Create.
 *
 * 2.40.0: nothing is shown until Traveller Details (Adults + Children + Infants at least 1) and Travel Information
 * (From, To, Travel Start Date, Travel End Date) are filled in on the lead form. Then:
 *
 *   Travellers            one traveller form per person, all open at once ("Traveller 1 of 3", "Traveller 2 of 3"…):
 *                         the lead's own Travellers form (same fields, rules, OCR, existing-traveller card). A saved
 *                         traveller shows as a short card with Edit / Remove. Changing the counts adds or removes
 *                         empty forms at once. Optional: empty forms are simply not saved.
 *   Travel Requirements   one form per service ticked in Required Services; ticking / unticking adds or hides the
 *                         form at once. An unticked form keeps what was typed until Create (only ticked ones are
 *                         saved). Optional: missing required fields are finished on the lead's Travel Requirement tab.
 *
 * Nothing is saved here. The list and the forms live in the CRM page's draft (ctx.createForm.setDraft). On Create the
 * CRM asks the server (POST /quotation-prefill { leadCreate: true }): wrong values stop Create; ages that do not match
 * the counts give a warning the user may accept. After the lead is made, POST /leads/:id/requirements
 * { leadCreate: true } saves it all. Document numbers stay in the page's memory only.
 *
 * 2.41.0 (CRM 3.68.0): document photos chosen in a traveller form are kept in this page's memory too (not in the
 * draft, never browser storage). After the lead is created, ctx.createForm.onAfterSave uploads each one, one at a
 * time, with PUT /travellers/:id/documents/:kind (encrypted, S3 only, audited) onto the traveller that form made;
 * the ones that could not be uploaded are listed in a warning ("add on the lead's Travellers tab").
 */

import { h, sortByOrder, errorText } from '../../shared/dom.js';
import { serviceForm } from '../../shared/fields.js';
import { tripOf } from '../../shared/trip-range.js';
import { calculateAgeInfo, formatAgeDisplay } from '../../shared/traveller-age.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { renderDraftTravellers } from '../guided-sale/guided-sale.js';

// The Travellers form's checks go to POST /quotation-prefill { leadCreate: true, draft, check } (no new route).
const CHECK = '/quotation-prefill';
const MAX_TRAVELLERS = 30;
// A document photo as the server takes it (5 MB) — as a base64 data URL.
const MAX_PHOTO_CHARS = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 200;
const DOC_LABEL = { passport: 'Passport', aadhaar: 'Aadhaar', pan: 'PAN card' };
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const text = (v) => String(v === undefined || v === null ? '' : v).trim();
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
const countsOf = (values) => ({ adults: count(values.adults), children: count(values.children), infants: count(values.infants) });
const totalOf = (c) => c.adults + c.children + c.infants;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function countsText(c) {
  const parts = [];
  if (c.adults) parts.push(plural(c.adults, 'adult', 'adults'));
  if (c.children) parts.push(plural(c.children, 'child', 'children'));
  if (c.infants) parts.push(plural(c.infants, 'infant', 'infants'));
  return parts.join(', ');
}

/** What is still empty on the lead form before the Travel sections open ([] = ready). */
export function missingBeforeForms(values) {
  const v = values || {};
  const missing = [];
  if (!totalOf(countsOf(v))) missing.push('Traveller Details (Adults, Children or Infants)');
  if (!text(v.from)) missing.push('From');
  if (!text(v.to)) missing.push('To');
  if (!text(v.travel_start_date)) missing.push('Travel Start Date');
  if (!text(v.travel_end_date)) missing.push('Travel End Date');
  return missing;
}

function renderLeadCreate(root, ctx) {
  const cf = ctx.createForm;
  let values = cf.getValues();
  const start = cf.getDraft();
  let people = Array.isArray(start.travellers) ? start.travellers : [];
  const requirements = { ...(start.requirements && typeof start.requirements === 'object' ? start.requirements : {}) };

  /** What the server checks: the lead form's values, the lead kind, the list and the forms. */
  const draft = () => ({ values: cf.getValues(), context: cf.getContext(), travellers: people, requirements });
  /**
   * 2.41.0 (CRM 3.68.0 createForm.onAfterSave): the document photos chosen in the traveller forms, kept in this
   * page's memory only (never browser storage, never the draft the server sees) and uploaded — encrypted, S3 only,
   * audited — by the lead's own photo route once the traveller exists. draftId → Map(kind → { image, name }).
   */
  const photoStore = new Map();
  const canUpload = typeof cf.onAfterSave === 'function';
  const photos = canUpload
    ? {
        get: (id, kind) => {
          const files = photoStore.get(text(id));
          return (files && files.get(kind)) || null;
        },
        set: (id, kind, file) => {
          if (String(file.image).length > MAX_PHOTO_CHARS) return false;
          if (!photoStore.has(text(id))) photoStore.set(text(id), new Map());
          photoStore.get(text(id)).set(kind, { image: String(file.image), name: text(file.name).slice(0, 120) });
          return true;
        },
        remove: (id, kind) => {
          const files = photoStore.get(text(id));
          if (!files) return;
          if (kind) files.delete(kind);
          if (!kind || !files.size) photoStore.delete(text(id));
        }
      }
    : null;
  const setPeople = (next) => {
    people = Array.isArray(next) ? next.map((p) => ({ ...p })) : [];
    // A removed traveller's photos go with them.
    const ids = new Set(people.map((p) => text(p.draftId)));
    for (const id of [...photoStore.keys()]) if (!ids.has(id)) photoStore.delete(id);
    cf.setDraft({ travellers: people });
  };

  const waitingEl = h('div', { class: 'tvx-msg tvx-msg-warn', 'data-testid': 'lead-create-waiting' });
  const statusEl = h('p', { class: 'tvx-muted', 'data-testid': 'lead-create-travellers-status' });
  const slotsHost = h('div', { class: 'tvx-gs' });
  const reqHost = h('div');
  const travellersCard = h('section', { class: 'tvx-card', 'data-testid': 'lead-create-travellers' }, [
    h('h3', { class: 'tvx-h3', text: 'Travellers' }),
    statusEl,
    slotsHost
  ]);
  const requirementsCard = h('section', { class: 'tvx-card', 'data-testid': 'lead-create-requirements' }, [
    h('h3', { class: 'tvx-h3', text: 'Travel Requirements' }),
    reqHost
  ]);
  root.replaceChildren(h('div', { class: 'tvx-gs' }, [waitingEl, travellersCard, requirementsCard]));

  /* ------------------------------------------------------------------ Travellers */

  /**
   * One slot per person: slot i shows traveller i of the list (a short card) or an empty Add form.
   * slot = { host, key, form (the Travellers element while a form is open), mode: 'add' | 'edit' | 'card' }
   */
  const slots = [];
  let shownPeople = new Map(); // draftId → the server's presented row (name, age; numbers masked)

  const isDirty = (slot) => Boolean(slot.form && typeof slot.form.isDirty === 'function' && slot.form.isDirty());
  const anyDirty = () => slots.some(isDirty);

  function slotCount() {
    return Math.min(Math.max(Math.min(totalOf(countsOf(values)), MAX_TRAVELLERS), people.length), MAX_TRAVELLERS);
  }

  function personLine(t) {
    const shown = shownPeople.get(text(t.draftId));
    const name = (shown && shown.fullName) || [text(t.firstName), text(t.lastName)].filter(Boolean).join(' ') || (t.existingTravellerId ? 'Existing traveller' : 'Traveller');
    let age = shown && shown.age !== undefined && shown.age !== null ? formatAgeDisplay(shown.age, shown.ageApproximate) : '';
    let category = (shown && shown.ageCategory) || '';
    if (!shown && (t.dob || t.yearOfBirth)) {
      const info = calculateAgeInfo({ dob: t.dob, yearOfBirth: t.yearOfBirth }, text(values.travel_start_date));
      age = formatAgeDisplay(info.age, info.ageApproximate);
      category = info.ageCategory;
    }
    return [name, category, age].filter(Boolean).join(' · ');
  }

  function mountForm(slot, index, startWith) {
    let saved = false;
    slot.mode = startWith === 'add' ? 'add' : 'edit';
    const box = h('div');
    slot.host.replaceChildren(h('h4', { class: 'tvx-gs-person-title', text: `Traveller ${index + 1} of ${slotCount()}` }), box);
    const res = renderDraftTravellers(box, ctx, {
      getDraft: draft,
      getList: () => people,
      save: (next) => {
        setPeople(next);
        paintStatus();
      },
      checkPath: CHECK,
      extra: { leadCreate: true },
      contactsNote: 'No contact person yet (the travellers are saved when the lead is created)',
      photoNote: canUpload
        ? 'The photo is uploaded (encrypted) as soon as the lead is created.'
        : 'Here the photo is only used to read the details (OCR); it is not saved. Add the photo on the lead’s Travellers tab after the lead is created.',
      photos: photos || undefined,
      intro: '',
      embed: {
        startWith,
        onSaved: (id) => {
          saved = true;
          // This form's traveller (its card stays in this place).
          if (id) slot.id = text(id);
        },
        // After Save / Cancel: every slot is shown again (a saved traveller becomes its card).
        onDone: () => {
          slot.form = null;
          slot.key = '';
          if (saved) refreshShown();
          paintSlots(true);
        }
      }
    });
    slot.form = res && res.form;
  }

  function mountCard(slot, index, t) {
    slot.mode = 'card';
    slot.form = null;
    const edit = h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Edit' });
    const remove = h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Remove' });
    edit.addEventListener('click', () => {
      if (t.existingTravellerId) {
        ctx.toast('An existing traveller is added as saved. To change their details, edit them on the Travellers page.', 'info');
        return;
      }
      slot.key = `edit:${t.draftId}`;
      mountForm(slot, index, { edit: t.draftId });
    });
    remove.addEventListener('click', () => {
      setPeople(people.filter((p) => text(p.draftId) !== text(t.draftId)));
      slot.id = '';
      paintSlots(true);
      paintStatus();
    });
    slot.host.replaceChildren(
      h('div', { class: 'tvx-msg tvx-msg-success', 'data-testid': 'lead-create-traveller-card' }, [
        h('strong', { text: `Traveller ${index + 1} of ${slotCount()}: ` }),
        h('span', { text: personLine(t) }),
        h('span', { text: ' ' }),
        edit,
        h('span', { text: ' ' }),
        remove
      ])
    );
  }

  /**
   * Show one slot per person; slots with a form being typed are never touched. Each slot keeps the traveller
   * saved in it (slot.id = draftId); a traveller no slot holds yet (e.g. after the counts changed) takes the
   * first free slot.
   */
  function paintSlots(force = false) {
    const n = slotCount();
    while (slots.length < n) {
      const host = h('div', { class: 'tvx-card', 'data-slot': String(slots.length) });
      slots.push({ host, key: '', form: null, mode: '', id: '' });
      slotsHost.appendChild(host);
    }
    const ids = new Set(people.map((p) => text(p.draftId)));
    for (const s of slots) if (s.id && !ids.has(s.id)) s.id = '';
    const held = new Set(slots.map((s) => s.id).filter(Boolean));
    const free = people.filter((p) => !held.has(text(p.draftId)));
    for (const s of slots) {
      if (!free.length) break;
      if (!s.id && !isDirty(s) && !(s.mode === 'edit' && s.form)) s.id = text(free.shift().draftId);
    }
    // Fewer people now: the empty forms at the end go (a saved traveller or a form being typed stays).
    for (let i = slots.length - 1; i >= n; i -= 1) {
      if (isDirty(slots[i]) || slots[i].id) break;
      slots[i].host.remove();
      slots.pop();
    }
    slots.forEach((slot, i) => {
      if (isDirty(slot) || (slot.mode === 'edit' && slot.form)) return;
      const t = slot.id ? people.find((p) => text(p.draftId) === slot.id) : null;
      const key = t ? `card:${t.draftId}:${personLine(t)}:${n}` : `add:${n}`;
      if (!force && key === slot.key) return;
      if (!t && slot.mode === 'add' && slot.form && key.startsWith('add:') && slot.key.startsWith('add:')) {
        // An open empty Add form: only its title changes.
        const title = slot.host.querySelector('.tvx-gs-person-title');
        if (title) title.textContent = `Traveller ${i + 1} of ${n}`;
        slot.key = key;
        return;
      }
      slot.key = key;
      if (t) mountCard(slot, i, t);
      else mountForm(slot, i, 'add');
    });
  }

  /** Names and ages as the server shows them (an existing traveller's name; numbers masked). */
  let setupSeq = 0;
  function refreshShown() {
    const seq = ++setupSeq;
    if (!people.length) {
      shownPeople = new Map();
      return;
    }
    ctx.api
      .post(CHECK, { leadCreate: true, draft: draft(), check: 'travellers_setup' })
      .then((res) => {
        if (seq !== setupSeq) return;
        shownPeople = new Map(((res && res.travellers) || []).map((t) => [text(t.id), t]));
        paintSlots();
      })
      .catch(() => {});
  }

  function paintStatus() {
    const c = countsOf(values);
    const total = Math.min(totalOf(c), MAX_TRAVELLERS);
    const added = people.length;
    if (added < total) {
      statusEl.textContent = `Traveller Details: ${countsText(c)} — one form for each person (${added} of ${total} saved). Optional: empty forms are not saved; travellers can also be added later on the lead.`;
    } else if (added === total) {
      statusEl.textContent = `Traveller Details: ${countsText(c)} — all ${total} saved. Their ages are checked against these counts when you click Create.`;
    } else {
      statusEl.textContent = `Traveller Details says ${total}, but ${added} travellers are saved. Change the counts or remove a traveller.`;
    }
  }

  /* --------------------------------------------------------- Travel Requirements */

  let services = null;
  const forms = new Map();
  let shown = null;

  function readForms() {
    for (const [key, form] of forms) requirements[key] = form.read();
    cf.setDraft({ requirements });
  }

  function paintRequirements(force = false) {
    if (!services) return;
    const chosen = list(values.required_services);
    const trip = tripOf(values);
    const key = JSON.stringify([chosen, trip.start, trip.end, values.date_flexibility || '']);
    if (!force && key === shown) return;
    shown = key;
    readForms(); // what was typed is kept (also for a service unticked now)
    forms.clear();
    const active = sortByOrder(services).filter((sv) => sv.enabled !== false && chosen.includes(sv.key));
    if (!active.length) {
      reqHost.replaceChildren(h('p', { class: 'tvx-muted', text: 'Tick the Required Services above — each one opens its own form here.' }));
      return;
    }
    const cards = active.map((service) => {
      const form = serviceForm(service, requirements[service.key] || {}, { trip, ctx, settings: ctx.settings, onChange: () => readForms() });
      forms.set(service.key, form);
      return h('section', { class: 'tvx-card', 'data-service': service.key }, [h('h4', { class: 'tvx-gs-person-title', text: `${service.name} Requirement` }), form.el]);
    });
    reqHost.replaceChildren(
      h('div', { class: 'tvx-gs' }, [
        h('p', { class: 'tvx-muted', text: 'Optional. One form for each service ticked above — fill what you know now; the rest can be finished on the lead’s Travel Requirement tab. Dates stay inside the travel dates.' }),
        ...cards
      ])
    );
  }

  reqHost.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading the requirement forms…' }));
  ctx.api
    .get('/services')
    .then((res) => {
      services = (res && res.services) || [];
      if (root.isConnected && ready) paintRequirements(true);
    })
    .catch((err) => reqHost.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) })));

  /* ------------------------------------------- open only when the two sections are filled */

  let ready = false;
  let travellerKey = '';
  const travellerKeyOf = (v) => JSON.stringify([v.travel_start_date || '', list(v.required_services)]);

  function applyValues() {
    const missing = missingBeforeForms(values);
    const nowReady = !missing.length;
    waitingEl.textContent = `Travellers and Travel Requirements open here once Traveller Details and Travel Information are filled in. Still needed: ${missing.join(', ')}.`;
    // style.display, not `hidden`: the card styles may set display themselves.
    waitingEl.style.display = nowReady ? 'none' : '';
    travellersCard.style.display = nowReady ? '' : 'none';
    requirementsCard.style.display = nowReady ? '' : 'none';
    if (!nowReady) {
      // Hidden, not lost: what was typed comes back when the fields are filled again.
      if (ready) readForms();
      ready = false;
      return;
    }
    const first = !ready;
    ready = true;
    paintStatus();
    // A new start date (ages) or services (passport rule): the travellers' forms are opened again (never one
    // being typed). A new count: forms are added or removed.
    const k = travellerKeyOf(values);
    const changed = k !== travellerKey;
    travellerKey = k;
    paintSlots(first || changed);
    if (changed && people.length) refreshShown();
    paintRequirements(first);
  }

  let timer = null;
  const unsubscribe = cf.onValuesChange((next) => {
    values = next || {};
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (root.isConnected) applyValues();
    }, 300);
  });
  if (typeof root.onCleanup === 'function') {
    root.onCleanup(() => {
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
    });
  }

  cf.onBeforeSave(() => {
    if (anyDirty()) return 'Save the traveller you are typing (or Cancel that form) before creating the lead.';
    if (ready) readForms();
    cf.setDraft({ travellers: people });
    return null;
  });

  // 2.41.0: after the lead is created — each kept photo onto the traveller its form made, one at a time.
  if (canUpload) {
    cf.onAfterSave(async (saved) => {
      if (!photoStore.size) return null;
      const made = new Map(
        (Array.isArray(saved && saved.result && saved.result.travellers) ? saved.result.travellers : [])
          .filter((x) => x && text(x.draftId) && /^[a-f0-9]{24}$/i.test(text(x.travellerId)))
          .map((x) => [text(x.draftId), text(x.travellerId)])
      );
      const failed = [];
      let uploaded = 0;
      for (const [draftId, files] of photoStore) {
        const index = people.findIndex((p) => text(p.draftId) === draftId);
        const who = index >= 0 ? `Traveller ${index + 1}` : 'a traveller';
        const travellerId = made.get(draftId);
        for (const [kind, file] of files) {
          const what = `${DOC_LABEL[kind] || 'Document'} photo of ${who}`;
          if (!travellerId) {
            failed.push(`${what} (the traveller was not saved, or was already on the lead)`);
            continue;
          }
          try {
            await ctx.api.put(`/travellers/${encodeURIComponent(travellerId)}/documents/${kind}`, { image: file.image, name: file.name });
            uploaded += 1;
          } catch (err) {
            failed.push(`${what} (${errorText(err)})`);
          }
        }
      }
      photoStore.clear();
      if (!failed.length) return null;
      return (
        `${plural(uploaded, 'document photo', 'document photos')} uploaded. Not uploaded — add on the lead’s Travellers tab: ` +
        `${failed.slice(0, 4).join(' · ')}${failed.length > 4 ? ' …' : ''}`
      );
    });
  }

  applyValues();
  if (people.length) refreshShown();
}

class LeadCreateExtras extends TravelElement {
  start(ctx) {
    this.classList.add('tvx-bx');
    if (!ctx.createForm || typeof ctx.createForm.getValues !== 'function') {
      this.replaceChildren(h('p', { class: 'tvx-msg tvx-msg-warn', text: 'Update the CRM (3.67.0 or later) to add travellers and requirement forms here.' }));
      return;
    }
    renderLeadCreate(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-lead-create-v1', LeadCreateExtras);
