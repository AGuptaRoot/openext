/**
 * <x-travel-guided-sale-v1>: the travel steps of the CRM's "Create Invoice from Scratch" page (2.36.0,
 * CRM 3.64.0 salesFlow.guidedInvoice). One element, three slots:
 *
 *   guided.travel_info   Travel Information — the CRM's own Lead Create fields (ctx.fieldsForm)
 *   guided.travellers    Travellers — at least one; the lead's own Travellers form on the draft (2.36.2)
 *   guided.requirements  Travel Requirements — one form per service chosen in Travel Information
 *
 * Nothing is saved here. Each step keeps its values in the CRM page's draft (ctx.wizard.setStepData) and checks
 * them before Next (ctx.wizard.onBeforeNext): the local required fields, then the server (POST /quotation-prefill
 * { draft, check }) with the same rules as the Travel Requirement and Travellers tabs. The CRM saves the trip
 * only when Create is clicked on the last step. Document numbers stay in the page's memory only.
 */

import { h, errorText, sortByOrder } from '../../shared/dom.js';
import { serviceForm } from '../../shared/fields.js';
import { tripOf } from '../../shared/trip-range.js';
import { TravelElement, defineOnce } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import { TAG as LEAD_TRAVELLERS } from '../lead-travellers/lead-travellers.js';

useStyles(new URL('./guided-sale.css', import.meta.url));

const REQUEST_TYPE = 'travel_enquiry';
const GROUPS = ['travel_information', 'required_services'];
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || v === false;
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

function noWizard(root) {
  root.replaceChildren(h('p', { class: 'tvx-msg tvx-msg-warn', text: 'This step opens from Invoices → Create Direct Invoice or Quotations → Create Direct Quotation (CRM 3.64.0 or later).' }));
}

/** Server check of one step → error text or null. Matches (existing travellers) go to `onMatches`. */
async function serverCheck(ctx, step, onMatches) {
  const res = await ctx.api.post('/quotation-prefill', { draft: ctx.wizard.getDraft(), check: step });
  if (onMatches) onMatches(Array.isArray(res && res.matches) ? res.matches : []);
  const errors = Array.isArray(res && res.errors) ? res.errors : [];
  return errors.length ? errors.slice(0, 8).join(' · ') : null;
}

/* ------------------------------------------------------------ Travel Information */

/**
 * 2.36.3 (CRM 3.64.4 ctx.wizard.getContext / setDraft): an existing client picked in step 1 → its saved Travel
 * Information, requirement forms and open-trip travellers fill the steps, only while that trip has no quotation.
 * A trip with a quotation: the forms stay empty and Next is blocked (one open trip per client). Picking another
 * client later replaces what was filled from the previous one. → the prefill state { clientId, blocked, message }.
 */
async function prefillFromClient(ctx) {
  const context = typeof ctx.wizard.getContext === 'function' ? ctx.wizard.getContext() : null;
  const clientId = String((context && context.client && context.client.id) || '');
  const draft = ctx.wizard.getDraft();
  const before = draft.prefill && typeof draft.prefill === 'object' ? draft.prefill : null;
  if (typeof ctx.wizard.setDraft !== 'function') return null;
  if (before && before.clientId === clientId) return before;
  const cleared = before && before.filled ? { travel_info: {}, requirements: {}, travellers: [] } : {};
  if (!clientId) {
    const state = { clientId: '', filled: false, blocked: false, message: '' };
    ctx.wizard.setDraft({ ...cleared, prefill: state });
    return state;
  }
  const res = await ctx.api.post('/quotation-prefill', { draft: draft, check: 'client_prefill', clientId });
  const state = { clientId, filled: Boolean(res && res.available), blocked: Boolean(res && res.blocked), message: String((res && res.message) || ''), source: String((res && res.source) || '') };
  if (state.filled) {
    ctx.wizard.setDraft({
      travel_info: (res && res.travel_info) || {},
      requirements: (res && res.requirements) || {},
      travellers: Array.isArray(res && res.travellers) ? res.travellers : [],
      prefill: state
    });
  } else {
    // Nothing to fill (or a trip with a quotation: never shown) — what came from another client is removed.
    ctx.wizard.setDraft({ ...(state.blocked ? { travel_info: {}, requirements: {}, travellers: [] } : cleared), prefill: state });
  }
  return state;
}

function renderTravelInfo(root, ctx) {
  if (typeof ctx.fieldsForm !== 'function') {
    root.replaceChildren(h('p', { class: 'tvx-msg tvx-msg-warn', text: 'Update the CRM to use this step.' }));
    return;
  }
  let prefill = null;
  let handle = null;
  let ready = false;
  root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading the client’s saved travel details…' }));
  if (typeof root.onCleanup === 'function') root.onCleanup(() => handle && handle.destroy && handle.destroy());
  ctx.wizard.onBeforeNext(async () => {
    if (!ready) return 'The form is still loading.';
    if (prefill && prefill.blocked) return prefill.message;
    ctx.wizard.setStepData(handle.getValues());
    const problem = handle.validate();
    if (problem) return problem;
    if (!list(handle.getValues().required_services).length) return 'Select at least one Required Service.';
    return serverCheck(ctx, 'travel_info');
  });
  prefillFromClient(ctx)
    .catch((err) => ({ clientId: '', filled: false, blocked: false, message: '', error: errorText(err) }))
    .then((state) => {
      prefill = state;
      if (!root.isConnected) return;
      const notice = state && state.blocked
        ? h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: state.message })
        : state && state.filled
          ? h('div', { class: 'tvx-msg tvx-msg-success', text: state.message })
          : state && state.error
            ? h('div', { class: 'tvx-msg tvx-msg-warn', text: `Could not load the client’s saved travel details: ${state.error}` })
            : null;
      renderForm(notice);
    });

  function renderForm(notice) {
  const host = h('div', { class: 'tvx-gs-fields' });
  root.replaceChildren(h('div', { class: 'tvx-gs' }, [notice, h('section', { class: 'tvx-card' }, [host])]));
  handle = ctx.fieldsForm(host, {
    record: 'lead',
    requestTypeKey: REQUEST_TYPE,
    groupIds: GROUPS,
    values: { ...(ctx.wizard.getDraft().travel_info || {}) },
    onChange: (values) => ctx.wizard.setStepData(values)
  });
  ready = true;
  }
}

/* -------------------------------------------------------------------- Travellers */

/*
 * 2.36.2: the Travellers step shows the lead's own Travellers form — the same component as Lead → Travellers and
 * Travellers → Add traveller (same fields, rules, OCR, "Existing Traveller Found" card, Add existing traveller).
 * Nothing is saved: the form talks to a draft adapter instead of the lead. The adapter keeps the travellers in the
 * CRM page's draft (ctx.wizard.setStepData); each save is checked by the server first (POST /quotation-prefill
 * { draft, check: 'travellers' }) and the list comes from { check: 'travellers_setup' } (numbers masked).
 * Workspace look-ups (duplicates check, search, OCR, an existing traveller's trips / photos) go to the real API.
 */

const DRAFT_LEAD = 'guided-draft';
const MAX_TRAVELLERS = 30;
const clean = (v) => String(v === undefined || v === null ? '' : v).trim();
const digits = (v) => clean(v).replace(/[\s()-]/g, '');
const newDraftId = () => `d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const INPUT_KEYS = [
  'firstName', 'lastName', 'dob', 'yearOfBirth', 'gender', 'nationality', 'relation', 'phone', 'email',
  'passportNumber', 'passportIssueDate', 'passportExpiryDate', 'passportCountry', 'aadhaarNumber', 'panNumber',
  'ocrUsed', 'ocrConfirmed', 'docMismatchConfirmed'
];
/** Values two travellers of the list may not share — the sentences the form puts under the field. */
const UNIQUE = {
  phone: 'A traveller with this phone number already exists.',
  email: 'A traveller with this email already exists.',
  passportNumber: 'A traveller with this passport number already exists.',
  aadhaarNumber: 'A traveller with this Aadhaar number already exists.',
  panNumber: 'A traveller with this PAN number already exists.'
};
const uniqueKey = (key, v) =>
  key === 'phone' ? digits(v).replace(/^\+/, '').slice(-10) : key === 'email' ? clean(v).toLowerCase() : clean(v).toUpperCase().replace(/\s+/g, '');

function apiError(status, message, code = '') {
  return Object.assign(new Error(message), { status, code });
}

/** The Create Invoice / Quotation wizard as the place the draft travellers live. */
function wizardSource(ctx) {
  return {
    getDraft: () => ctx.wizard.getDraft(),
    save: (list) => ctx.wizard.setStepData(list),
    checkPath: '/quotation-prefill',
    contactsNote: 'No contact person (the trip is saved when the invoice is created)',
    photoNote: 'In this step the photo is only used to read the details (OCR); it is not saved. Add the photo on the trip’s Travellers tab after the invoice is created.',
    intro: 'Add everyone who travels (at least one) — the same form as Travellers → Add traveller. Nothing is saved until you click Create.',
    onBeforeNext: (check) => ctx.wizard.onBeforeNext(check),
    embed: {}
  };
}

/**
 * The lead's Travellers form on an unsaved list. `src` says where the list lives (2.39.0: also Lead Create):
 * { getDraft, getList? (one list shared by several forms), save(list), checkPath, extra (more body fields), contactsNote, photoNote, intro, onBeforeNext?, embed: { startWith, onSaved, onDone } }.
 * → { form } (the Travellers element: form.isDirty()).
 */
export function renderDraftTravellers(root, ctx, src) {
  return renderTravellers(root, ctx, src);
}

function renderTravellers(root, ctx, src = wizardSource(ctx)) {
  const real = ctx.api;
  const saved = src.getDraft().travellers;
  const norm = (rows) => (Array.isArray(rows) ? rows : [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({ ...t, draftId: clean(t.draftId) || newDraftId() }));
  let people = norm(saved);
  // 2.40.0: several forms may share one list (Lead Create shows one form per traveller): src.getList() is the
  // shared list, read again before every change so one form never overwrites another form's traveller.
  const sync = () => {
    if (typeof src.getList === 'function') people = norm(src.getList());
    return people;
  };
  const save = () => src.save(people.map((p) => ({ ...p })));
  const byId = (id) => people.find((p) => p.draftId === id);
  const inputOf = (body) => {
    const out = {};
    for (const key of INPUT_KEYS) if (body && body[key] !== undefined) out[key] = body[key];
    return out;
  };

  /** The same mobile / email / document number as another traveller of this list → 409 under the field. */
  const assertUniqueInList = (t, selfId) => {
    const found = [];
    for (const [key, sentence] of Object.entries(UNIQUE)) {
      const v = uniqueKey(key, t[key]);
      if (!v) continue;
      const other = people.findIndex((q) => q.draftId !== selfId && !q.existingTravellerId && uniqueKey(key, q[key]) === v);
      if (other >= 0) found.push(`${sentence} (Traveller ${other + 1} in this list — each traveller needs their own.)`);
    }
    if (found.length) throw apiError(409, found.join(' '), 'DUPLICATE_VALUES');
  };

  /** The server's check of this one traveller inside the whole list (the rules of the lead's Travellers tab). */
  const serverCheckOne = async (list, id) => {
    const res = await real.post(src.checkPath, { ...(src.extra || {}), draft: { ...src.getDraft(), travellers: list }, check: 'travellers' });
    const n = list.findIndex((p) => p.draftId === id) + 1;
    const prefix = new RegExp(`^Traveller ${n}(?![0-9])\\s*(\\([^)]*\\))?\\s*:?\\s*`);
    const all = (res && res.errors) || [];
    if (all.some((e) => /^Fix the Travel Information step first/.test(e))) throw apiError(400, all.join(' '));
    const mine = all.filter((e) => prefix.test(e)).map((e) => e.replace(prefix, ''));
    if (!mine.length) return;
    const text = mine.join(' ');
    if (/in the list twice|already in the list/.test(text)) {
      throw apiError(409, 'This person is already a traveller on this lead (same name and date of birth or phone in this list).', 'DUPLICATE_TRAVELLER');
    }
    if (Object.values(UNIQUE).some((s) => text.includes(s.slice(0, -1)))) throw apiError(409, text, 'DUPLICATE_VALUES');
    throw apiError(400, text, /required for/.test(text) ? 'ID_DOCUMENTS_REQUIRED' : 'INVALID_TRAVELLER');
  };

  /** A draft traveller as GET /travellers/:id returns one (for the Edit form; the user's own typing, in memory). */
  const asTraveller = (t) => ({
    id: t.draftId,
    firstName: clean(t.firstName),
    lastName: clean(t.lastName),
    phone: clean(t.phone),
    email: clean(t.email),
    gender: clean(t.gender),
    dob: clean(t.dob),
    yearOfBirth: t.yearOfBirth || null,
    nationality: clean(t.nationality),
    relation: clean(t.relation),
    contactId: '',
    passport: {
      number: clean(t.passportNumber),
      issueDate: clean(t.passportIssueDate),
      expiryDate: clean(t.passportExpiryDate),
      country: clean(t.passportCountry),
      hasFile: false
    },
    aadhaar: { number: clean(t.aadhaarNumber), last4: clean(t.aadhaarNumber).slice(-4), hasFile: false },
    pan: { number: clean(t.panNumber), hasFile: false }
  });

  const DRAFT_PATH = /^\/travellers\/(d-[a-z0-9]+)(\/[a-z]+(?:\/[a-z]+)?)?$/;
  const api = {
    ...real,
    async get(path) {
      sync();
      const [p] = String(path).split('?');
      if (p === `/leads/${DRAFT_LEAD}/travellers`) {
        return real.post(src.checkPath, { ...(src.extra || {}), draft: src.getDraft(), check: 'travellers_setup' });
      }
      if (p === `/leads/${DRAFT_LEAD}/contacts`) {
        return { contacts: [], note: src.contactsNote };
      }
      const m = p.match(DRAFT_PATH);
      if (m) {
        const t = byId(m[1]);
        if (!t) throw apiError(404, 'This traveller is no longer in the list.');
        const rest = m[2] || '';
        if (t.existingTravellerId) {
          if (!rest) throw apiError(400, 'An existing traveller is added as saved. To change their details, edit them on the Travellers page.');
          return real.get(`/travellers/${encodeURIComponent(t.existingTravellerId)}${rest}`);
        }
        if (!rest) return { traveller: asTraveller(t) };
        if (rest === '/trips') return { trips: [] };
        throw apiError(404, 'The photo is not kept in this step.');
      }
      return real.get(path);
    },
    async post(path, body = {}) {
      sync();
      if (path === `/leads/${DRAFT_LEAD}/travellers`) {
        if (people.length >= MAX_TRAVELLERS) throw apiError(400, `At most ${MAX_TRAVELLERS} travellers.`);
        const t = { ...inputOf(body), draftId: newDraftId() };
        assertUniqueInList(t, t.draftId);
        await serverCheckOne([...people, t], t.draftId);
        people = [...sync(), t];
        save();
        return { traveller: { id: t.draftId } };
      }
      if (path === `/leads/${DRAFT_LEAD}/travellers/copy`) {
        const id = clean(body && body.travellerId);
        if (!id) throw apiError(400, 'Choose a traveller.');
        if (people.some((p) => p.existingTravellerId === id)) throw apiError(409, 'This Traveller is already added.', 'TRAVELLER_ON_LEAD');
        if (people.length >= MAX_TRAVELLERS) throw apiError(400, `At most ${MAX_TRAVELLERS} travellers.`);
        const t = { draftId: newDraftId(), existingTravellerId: id };
        await serverCheckOne([...people, t], t.draftId);
        people = [...sync(), t];
        save();
        return { traveller: { id: t.draftId } };
      }
      if (path === '/travellers/duplicates-check') {
        const { leadId, ...rest } = body || {};
        return real.post(path, rest);
      }
      return real.post(path, body);
    },
    async put(path, body = {}) {
      sync();
      const m = String(path).match(DRAFT_PATH);
      if (m && m[2]) return { kept: false }; // a document photo: read by OCR only, not stored (ctx.photoNote)
      if (m) {
        const t = byId(m[1]);
        if (!t || t.existingTravellerId) throw apiError(404, 'This traveller is no longer in the list.');
        const next = { ...inputOf(body), draftId: t.draftId };
        // The Edit form sends the Aadhaar number only when it was changed.
        if (!('aadhaarNumber' in (body || {}))) next.aadhaarNumber = t.aadhaarNumber;
        assertUniqueInList(next, t.draftId);
        const list = people.map((p) => (p.draftId === t.draftId ? next : p));
        await serverCheckOne(list, t.draftId);
        people = sync().map((p) => (p.draftId === t.draftId ? next : p));
        save();
        return { traveller: { id: t.draftId } };
      }
      return real.put(path, body);
    },
    async del(path) {
      sync();
      const m = String(path).match(DRAFT_PATH);
      if (m && m[2]) return {};
      if (m && byId(m[1]) && byId(m[1]).onTrip) {
        throw apiError(400, 'This traveller is already on the client’s open trip. Remove them from the trip’s Travellers tab.');
      }
      if (m) {
        people = people.filter((p) => p.draftId !== m[1]);
        save();
        return { deleted: true };
      }
      return real.del(path);
    }
  };

  save();
  const form = document.createElement(LEAD_TRAVELLERS);
  form.className = 'tvx-root';
  form.ctx = {
    ...ctx,
    api,
    slot: 'lead.tab.travellers',
    record: { id: DRAFT_LEAD, name: '' },
    photoNote: src.photoNote,
    toast: (message, tone) => ctx.toast(String(message || '').replace(/to this lead/g, 'to the list'), tone),
    recordChanged: undefined,
    // 2.39.0: Lead Create opens the Add form at once and is told after each Save / Cancel.
    startWith: src.embed && src.embed.startWith,
    onDone: src.embed && src.embed.onDone,
    onSaved: src.embed && src.embed.onSaved,
    onValuesChanged: () => () => {},
    onSettingsChanged: () => () => {}
  };
  root.replaceChildren(
    h('div', { class: 'tvx-gs' }, [
      src.intro ? h('p', { class: 'tvx-muted', text: src.intro }) : null,
      form
    ])
  );

  if (typeof src.onBeforeNext === 'function') {
    src.onBeforeNext(async () => {
      if (typeof form.isDirty === 'function' && form.isDirty()) return 'Save the traveller (or Cancel the form) before Next.';
      save();
      if (!people.length) return 'Add at least one traveller.';
      return serverCheck(ctx, 'travellers');
    });
  }
  return { form };
}

/* ---------------------------------------------------------- Travel Requirements */

function renderRequirements(root, ctx) {
  const draft = ctx.wizard.getDraft();
  const values = draft.travel_info || {};
  const chosen = list(values.required_services);
  const stored = { ...(draft.requirements || {}) };
  const trip = tripOf(values);
  const forms = new Map();
  root.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading the requirement forms…' }));

  const read = () => {
    const out = {};
    for (const [key, { form }] of forms) out[key] = form.read();
    ctx.wizard.setStepData(out);
    return out;
  };

  ctx.api.get('/services')
    .then((res) => {
      const services = sortByOrder((res && res.services) || []).filter((sv) => sv.enabled !== false && chosen.includes(sv.key));
      if (!services.length) {
        root.replaceChildren(h('p', { class: 'tvx-msg tvx-msg-warn', text: 'Choose the Required Services in Travel Information first.' }));
        return;
      }
      const cards = services.map((service) => {
        const form = serviceForm(service, stored[service.key] || {}, { trip, ctx, settings: ctx.settings, onChange: () => read() });
        forms.set(service.key, { service, form });
        return h('section', { class: 'tvx-card' }, [h('h4', { class: 'tvx-gs-person-title', text: `${service.name} Requirement` }), form.el]);
      });
      root.replaceChildren(h('div', { class: 'tvx-gs' }, [
        h('p', { class: 'tvx-muted', text: 'One form for each service you chose. Every date stays inside the travel dates.' }),
        ...cards
      ]));
      read();
    })
    .catch((err) => root.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) })));

  ctx.wizard.onBeforeNext(async () => {
    if (!forms.size) return 'The requirement forms are not loaded yet.';
    const out = read();
    const missing = [];
    for (const [key, { service }] of forms) {
      for (const f of service.fields || []) {
        if (f.enabled === false || !f.required) continue;
        if (isEmpty(out[key] && out[key][f.key])) missing.push(`${service.name}: ${f.label}`);
      }
    }
    if (missing.length) return `Complete the required fields: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`;
    return serverCheck(ctx, 'requirements');
  });
}

/* ------------------------------------------------------------------------ element */

const VIEWS = { 'guided.travel_info': renderTravelInfo, 'guided.travellers': renderTravellers, 'guided.requirements': renderRequirements };

class GuidedSale extends TravelElement {
  start(ctx) {
    this.classList.add('tvx-bx');
    if (!ctx.wizard || typeof ctx.wizard.getDraft !== 'function') return noWizard(this);
    const view = VIEWS[ctx.slot];
    if (!view) return noWizard(this);
    view(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-guided-sale-v1', GuidedSale);
