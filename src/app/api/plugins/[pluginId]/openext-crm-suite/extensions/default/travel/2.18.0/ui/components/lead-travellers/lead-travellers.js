/**
 * <x-travel-lead-travellers-v1>: Lead → Travellers tab.
 *
 * Implements:
 * - Travellers list with counts, mismatch warning, desktop table & mobile cards
 * - Add / Edit traveller form (inline, replaces list)
 * - Live age and category calculation on DOB change
 * - Live passport expiry warning
 * - Passport and Aadhaar image upload with browser resizing
 * - OCR extraction via Groq vision with merge rules and review banner
 * - Document thumbnail preview and in-tab document viewer overlay
 * - Year of birth when the date of birth is not known
 * - Add existing traveller: search the directory, link the person's profile to this lead
 * - Add form: leaving phone / email / Aadhaar / passport shows an "Existing Traveller Found" card
 *   (masked values, "Add Existing Traveller"), or a warning when the values belong to different people
 * - Trips: the person's travel history (every lead / booking of the same profile)
 * - Complete permission, dark mode, and accessibility support
 *
 * Embeddable (Travellers page, booking traveller picker): ctx.startWith = 'add' | { edit: id } opens
 * the form at once; ctx.onSaved(travellerId) is called after a traveller is saved or added;
 * ctx.onDone() hands control back after Save / Cancel of the form.
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import {
  isValidDate,
  todayIso,
  calculateAgeInfo,
  calculateExpiryWarning,
  expiryWarningLabel,
  formatDisplayDate,
  formatAgeDisplay,
  toTitleCase,
  cleanPassportNumber,
  isValidAadhaar,
  yearsBetween,
  compareDocumentIdentity
} from '../../shared/traveller-age.js';
import { openDialog } from '../../shared/booking-ui.js';

const PHONE_RE = /^\+?\d{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Same rules as the backend (traveller-rules.js): names are letters of any language with spaces,
// dots, apostrophes and hyphens; a country may also have "&", commas and brackets.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const COUNTRY_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,&()'’-]*$/u;
const nameProblem = (value, label) =>
  value && !NAME_RE.test(value) ? `${label} can only have letters, spaces, dots, apostrophes and hyphens` : '';
const cleanPhone = (v) => {
  const raw = String(v || '').trim();
  return (raw.startsWith('+') ? '+' : '') + raw.replace(/\D/g, '');
};

/** Same rule as the backend: an expired passport, or one expiring before the trip, cannot be saved. */
function passportExpiryBlock(expiry, referenceDate) {
  if (!isValidDate(expiry)) return '';
  if (expiry < todayIso()) return 'Passport has expired — it cannot be saved. Renew it first.';
  if (isValidDate(referenceDate) && expiry < referenceDate) {
    return `Passport expires before the trip (${formatDisplayDate(referenceDate)}) — it cannot be saved.`;
  }
  return '';
}
import { shrinkImageFile } from '../../shared/image-shrink.js';

useStyles(new URL('./lead-travellers.css', import.meta.url));

// 2.14.0 duplicate checks: the fields the server compares across the workspace, and the sentence of each.
const DUPLICATE_FIELDS = ['email', 'phone', 'aadhaarNumber', 'passportNumber'];
const DUPLICATE_SENTENCES = [
  ['email', /A traveller with this email already exists\./],
  ['phone', /A traveller with this phone number already exists\./],
  ['aadhaarNumber', /A traveller with this Aadhaar number already exists\./],
  ['passportNumber', /A traveller with this passport number already exists[^.]*\./]
];

// Add form: leaving one of these fields asks the server who already has the values (one combined
// request after a short pause; the newest answer wins).
const EXISTING_CHECK_DELAY = 150;
const EXISTING_FIELD_LABEL = { phone: 'Mobile', email: 'Email', aadhaarNumber: 'Aadhaar', passportNumber: 'Passport' };
const ALREADY_ADDED_TEXT = 'This Traveller is already added.';
const CONFLICT_TEXT = 'The entered details match different existing Travellers. Please review the information before continuing.';

/** [[field, sentence]] of a duplicate error (read from the message: the host may drop the code). */
function duplicateFields(err) {
  const text = String((err && err.message) || '');
  return DUPLICATE_SENTENCES.map(([field, re]) => {
    const m = text.match(re);
    return m ? [field, m[0]] : null;
  }).filter(Boolean);
}

function renderLeadTravellers(root, ctx) {

  const lead = ctx.record || {};
  const leadId = String(lead.id || '');
  const canEdit = Boolean(typeof ctx.can === 'function' ? ctx.can('crm.leads.write') : true);

  // Component state
  let currentView = 'list'; // 'list' | 'form'
  let loading = true;
  let error = '';

  let travellers = [];
  let counts = { Adult: 0, Child: 0, Infant: 0, total: 0 };
  // Groups as the quotation counts them (no known age = Adult), for the mismatch warning.
  let groups = null;
  // Travellers being deleted (a second click does nothing).
  const deleting = new Set();
  // Trips view: { traveller, loading, error, trips }.
  let tripsState = null;
  let expected = null;
  let referenceDate = todayIso();
  let referenceSource = 'today';
  let leadContact = null;
  let aadhaarStorage = 'last4';
  // Choices from Settings → Travel (Nationalities, Traveller Relations).
  let nationalityOptions = [];
  let relationOptions = [];
  // Passport details are required when the lead's Travel Requirement has a "Passport required" service.
  let passportRequired = false;
  let passportRequiredBy = [];
  // Contact people of the lead (to pick the traveller's contact person).
  let leadContacts = [];
  let leadContactsNote = '';

  // Overlay state
  let overlay = { open: false, dataUrl: '', title: '' };

  // Form state
  let formState = null;

  // Unique ids so every label can point at its input (label for=…).
  let fieldSeq = 0;

  // Active elements references for live updates without losing input focus
  let ageInputRef = null;
  let catInputRef = null;
  let expiryWarningRef = null;
  let yearFieldRef = null;
  // Add form: the phone / email / Aadhaar / passport inputs, and the slot of the "Existing Traveller Found" card.
  let dupInputRefs = {};
  let existingSlot = null;

  // Listen for changes from outside (unsubscribed when the tab closes).
  subscribe(root, ctx, 'onValuesChanged', () => {
    if (currentView === 'list') {
      loadList();
    }
  });

  // Global keydown for overlay Esc
  function onWindowKeyDown(e) {
    if (e.key === 'Escape' && overlay.open) {
      closeOverlay();
    }
  }
  window.addEventListener('keydown', onWindowKeyDown);

  // Unsaved changes in the form: the browser asks before the page is left (reload, close, typed URL);
  // Cancel asks first; an embedding page can ask too (root.isDirty()).
  const formSnapshot = (fs) => JSON.stringify({
    values: fs.values,
    passport: [Boolean(fs.passportDoc.newFile), fs.passportDoc.markedForRemoval],
    aadhaar: [Boolean(fs.aadhaarDoc.newFile), fs.aadhaarDoc.markedForRemoval]
  });
  const formDirty = () => Boolean(currentView === 'form' && formState && formState.initial !== undefined && formSnapshot(formState) !== formState.initial);
  root.isDirty = formDirty;
  const beforeUnload = (event) => {
    if (!formDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);

  // Cleanup when the element leaves the page.
  root.onCleanup(() => {
    window.removeEventListener('keydown', onWindowKeyDown);
    window.removeEventListener('beforeunload', beforeUnload);
    if (formState) {
      clearTimeout(formState.existingTimer);
      formState.passportDoc.newFile = null;
      formState.aadhaarDoc.newFile = null;
    }
  });

  // Newest request per kind: a slower, older answer never overwrites a newer one.
  let listSeq = 0;
  let contactsSeq = 0;
  let formSeq = 0;

  async function loadList() {
    const seq = ++listSeq;
    loading = true;
    error = '';
    render();
    try {
      const data = await ctx.api.get(`/leads/${encodeURIComponent(leadId)}/travellers`);
      if (seq !== listSeq) return;
      travellers = Array.isArray(data && data.travellers) ? data.travellers : [];
      counts = data && data.counts ? data.counts : { Adult: 0, Child: 0, Infant: 0, total: 0 };
      groups = data && data.groups ? data.groups : null;
      expected = data && data.expected ? data.expected : null;
      referenceDate = (data && data.referenceDate) || todayIso();
      referenceSource = (data && data.referenceSource) || 'today';
      leadContact = (data && data.leadContact) || null;
      aadhaarStorage = (data && data.aadhaarStorage) || 'last4';
      nationalityOptions = Array.isArray(data && data.nationalityOptions) ? data.nationalityOptions : [];
      relationOptions = Array.isArray(data && data.relationOptions) ? data.relationOptions : [];
      passportRequired = Boolean(data && data.passportRequired);
      passportRequiredBy = Array.isArray(data && data.passportRequiredBy) ? data.passportRequiredBy : [];
    } catch (err) {
      if (seq !== listSeq) return;
      error = errorText(err);
    } finally {
      if (seq === listSeq) {
        loading = false;
        render();
      }
    }
  }

  async function loadLeadContacts() {
    const seq = ++contactsSeq;
    let contacts = [];
    let note = '';
    try {
      const data = await ctx.api.get(`/leads/${encodeURIComponent(leadId)}/contacts`);
      contacts = Array.isArray(data && data.contacts) ? data.contacts : [];
      note = (data && data.note) || '';
    } catch (err) {
      note = errorText(err);
    }
    if (seq !== contactsSeq) return;
    leadContacts = contacts;
    leadContactsNote = note;
    if (currentView === 'form') render();
  }

  function openAddForm() {
    formSeq += 1;
    loadLeadContacts();
    formState = {
      mode: 'add',
      travellerId: '',
      saving: false,
      formError: '',
      photoUploadError: '',
      fieldErrors: {},
      values: {
        firstName: '',
        lastName: '',
        phone: '',
        email: '',
        gender: '',
        dob: '',
        yearOfBirth: null,
        nationality: '',
        relation: '',
        contactId: '',
        passportNumber: '',
        passportIssueDate: '',
        passportExpiryDate: '',
        passportCountry: '',
        aadhaarNumber: ''
      },
      meta: {},
      isLeadContact: false,
      passportDoc: {
        hasStoredFile: false,
        newFile: null,
        markedForRemoval: false,
        ocrLoading: false,
        ocrError: ''
      },
      aadhaarDoc: {
        hasStoredFile: false,
        newFile: null,
        markedForRemoval: false,
        ocrLoading: false,
        ocrError: ''
      },
      ocrUsed: false,
      ocrConfirmed: false,
      ocrBanner: { visible: false, filledCount: 0, reviewCount: 0, notes: [] }
    };
    formState.initial = formSnapshot(formState);
    currentView = 'form';
    render();
  }

  async function openEditForm(travellerId) {
    const seq = ++formSeq;
    loadLeadContacts();
    loading = true;
    render();
    try {
      const data = await ctx.api.get(`/travellers/${encodeURIComponent(travellerId)}`);
      if (seq !== formSeq) return; // another form / view was opened meanwhile
      const tr = (data && data.traveller) || {};
      const passport = tr.passport || {};
      const aadhaar = tr.aadhaar || {};

      const isLead = Boolean(leadContact && leadContact.contactId && tr.contactId === leadContact.contactId);

      const meta = {};
      if (aadhaarStorage === 'last4' && aadhaar.last4 && !aadhaar.number) {
        meta.aadhaarNumber = {
          source: 'init',
          hint: `The card shows only the last 4 digits (${aadhaar.last4}). Type the full number if you have it.`
        };
      }

      formState = {
        mode: 'edit',
        travellerId: tr.id || travellerId,
        saving: false,
        formError: '',
        photoUploadError: '',
        fieldErrors: {},
        values: {
          firstName: tr.firstName || '',
          lastName: tr.lastName || '',
          phone: tr.phone || '',
          email: tr.email || '',
          gender: tr.gender || '',
          dob: tr.dob || '',
          yearOfBirth: tr.yearOfBirth || null,
          nationality: tr.nationality || '',
          relation: tr.relation || '',
          contactId: tr.contactId || '',
          passportNumber: passport.number || '',
          passportIssueDate: passport.issueDate || '',
          passportExpiryDate: passport.expiryDate || '',
          passportCountry: passport.country || '',
          aadhaarNumber: aadhaar.number || ''
        },
        meta,
        isLeadContact: isLead,
        passportDoc: {
          hasStoredFile: Boolean(passport.hasFile),
          newFile: null,
          markedForRemoval: false,
          ocrLoading: false,
          ocrError: ''
        },
        aadhaarDoc: {
          hasStoredFile: Boolean(aadhaar.hasFile),
          newFile: null,
          markedForRemoval: false,
          ocrLoading: false,
          ocrError: ''
        },
        ocrUsed: false,
        ocrConfirmed: false,
        ocrBanner: { visible: false, filledCount: 0, reviewCount: 0, notes: [] }
      };
      formState.initial = formSnapshot(formState);
      currentView = 'form';
    } catch (err) {
      if (seq !== formSeq) return;
      ctx.toast(`Could not load traveller: ${errorText(err)}`, 'error');
    } finally {
      if (seq === formSeq) {
        loading = false;
        render();
      }
    }
  }

  /** Tell an embedding page (e.g. a booking's "Add new traveller") which traveller was saved. */
  function notifySaved(travellerId) {
    if (typeof ctx.onSaved !== 'function' || !travellerId) return;
    try {
      ctx.onSaved(String(travellerId));
    } catch {
      /* the embedding page's problem; the save itself worked */
    }
  }

  /** Cancel of the form: never while saving; asks before dropping unsaved changes. */
  function cancelForm() {
    if (formState && formState.saving) return;
    if (formDirty() && !window.confirm('Discard the changes to this traveller? They are not saved.')) return;
    closeForm();
  }

  function closeForm() {
    formSeq += 1;
    if (formState) {
      clearTimeout(formState.existingTimer);
      formState.existingSeq = (formState.existingSeq || 0) + 1;
      formState.passportDoc.newFile = null;
      formState.aadhaarDoc.newFile = null;
      formState = null;
    }
    currentView = 'list';
    // Embedded in the Travellers page: hand control back after Save / Cancel.
    if (typeof ctx.onDone === 'function') {
      ctx.onDone();
      return;
    }
    render();
  }

  async function deleteTraveller(tr, button) {
    if (deleting.has(tr.id)) return;
    const name = tr.fullName || tr.firstName || 'this traveller';
    if (!window.confirm(`Delete ${name}? Their passport and Aadhaar photos are deleted too.`)) {
      return;
    }
    // One request per traveller: the button is off until the list reloads.
    deleting.add(tr.id);
    if (button) {
      button.disabled = true;
      button.textContent = 'Deleting…';
    }
    try {
      await ctx.api.del(`/travellers/${encodeURIComponent(tr.id)}`);
    } catch (err) {
      // Already gone (e.g. deleted in another tab): that is what was asked for.
      if (!err || err.status !== 404) {
        deleting.delete(tr.id);
        if (button) {
          button.disabled = false;
          button.textContent = 'Delete';
        }
        ctx.toast(`Failed to delete: ${errorText(err)}`, 'error');
        return;
      }
    }
    ctx.toast('Traveller deleted', 'info');
    if (typeof ctx.recordChanged === 'function') ctx.recordChanged();
    deleting.delete(tr.id);
    await loadList();
  }

  /* ------------------------------------------- add an existing traveller */

  // Built once per opening, so typing in the search box never loses focus.
  let pickView = null;

  function openPicker() {
    currentView = 'pick';
    let timer = null;
    let token = 0;
    const results = h('div', { class: 'tvx-tr-pick-list', 'aria-live': 'polite' });
    const message = h('div');
    const showMessage = (kind, text) => message.replaceChildren(...(text ? [h('div', { class: `tvx-msg tvx-msg-${kind}`, role: kind === 'error' ? 'alert' : 'status', text })] : []));

    async function find(q) {
      const mine = (token += 1);
      if (q.length < 2) {
        results.replaceChildren(h('p', { class: 'tvx-muted', text: 'Type at least 2 letters of the name, or the phone number.' }));
        return;
      }
      results.replaceChildren(h('p', { class: 'tvx-loading', text: 'Searching travellers…' }));
      try {
        const data = await ctx.api.get(`/travellers/search?q=${encodeURIComponent(q)}&leadId=${encodeURIComponent(leadId)}`);
        if (mine !== token) return;
        const list = Array.isArray(data && data.travellers) ? data.travellers : [];
        if (!list.length) {
          results.replaceChildren(h('p', { class: 'tvx-muted', text: 'Nobody matches. Use + Add traveller for someone new.' }));
          return;
        }
        results.replaceChildren(...list.map((t) => {
          const name = t.fullName || t.firstName || 'Traveller';
          const trips = Number(t.trips) || 1;
          const add = h('button', {
            type: 'button',
            class: 'tvx-btn tvx-btn-primary',
            disabled: Boolean(t.onLead),
            'aria-label': t.onLead ? `${name} is already on this lead` : `Add ${name} to this lead`,
            text: t.onLead ? 'Already on this lead' : 'Add to this lead'
          });
          add.addEventListener('click', () => addExisting(t, add));
          return h('div', { class: 'tvx-tr-pick-item' }, [
            h('div', { class: 'tvx-tr-name-cell' }, [
              h('span', { class: 'tvx-tr-name-title', text: name }),
              h('span', { class: 'tvx-tr-sub-val', text: [t.phone, t.ageCategory, `${trips} trip${trips === 1 ? '' : 's'}`, t.leadName ? `last: ${t.leadName}` : ''].filter(Boolean).join(' · ') })
            ]),
            add
          ]);
        }));
      } catch (err) {
        if (mine === token) results.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }));
      }
    }

    async function addExisting(t, button) {
      button.disabled = true;
      button.textContent = 'Adding…';
      showMessage('', '');
      try {
        const res = await ctx.api.post(`/leads/${encodeURIComponent(leadId)}/travellers/copy`, { travellerId: t.id });
        const missedPhotos = Array.isArray(res && res.photoErrors) && res.photoErrors.length;
        const moved = res && res.workflow && res.workflow.stageChanged ? res.workflow.stage : '';
        ctx.toast(
          missedPhotos
            ? 'Traveller added, but a document photo could not be copied — upload it in Edit.'
            : moved ? `Traveller added — the lead is ready and moved to ${moved}` : 'Traveller added to this lead',
          missedPhotos ? 'info' : 'success'
        );
        if (typeof ctx.recordChanged === 'function') ctx.recordChanged();
        notifySaved(res && res.traveller && res.traveller.id);
        pickView = null;
        currentView = 'list';
        await loadList();
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Add to this lead';
        showMessage('error', errorText(err));
      }
    }

    const input = h('input', {
      type: 'search',
      id: `tvx-tr-pick-${(fieldSeq += 1)}`,
      class: 'tvx-input',
      autocomplete: 'off',
      placeholder: 'Name (first and last) or phone',
      oninput: (e) => {
        clearTimeout(timer);
        const value = e.target.value.trim();
        timer = setTimeout(() => find(value), 300);
      }
    });
    root.onCleanup(() => clearTimeout(timer));
    pickView = h('div', { class: 'tvx-card' }, [
      h('div', { class: 'tvx-tr-form-header' }, [
        h('div', {}, [
          h('h3', { class: 'tvx-h3', text: 'Add existing traveller' }),
          h('p', { class: 'tvx-sub', text: 'Someone who travelled before: the same traveller, with their passport and photos, is added to this lead.' })
        ]),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Cancel', onclick: () => { pickView = null; currentView = 'list'; render(); } })
      ]),
      h('div', { class: 'tvx-field' }, [h('label', { class: 'tvx-label', for: input.id, text: 'Find the traveller' }), input]),
      message,
      results
    ]);
    find('');
    render();
    input.focus();
  }

  /* ----------------------------------------------------------------- trips */

  async function openTrips(tr) {
    currentView = 'trips';
    tripsState = { traveller: tr, loading: true, error: '', trips: [] };
    render();
    try {
      const data = await ctx.api.get(`/travellers/${encodeURIComponent(tr.id)}/trips`);
      if (!tripsState || tripsState.traveller !== tr) return;
      tripsState.trips = Array.isArray(data && data.trips) ? data.trips : [];
    } catch (err) {
      if (tripsState) tripsState.error = errorText(err);
    } finally {
      if (tripsState && tripsState.traveller === tr) {
        tripsState.loading = false;
        render();
      }
    }
  }

  function renderTripsView() {
    const t = tripsState.traveller;
    const back = h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: '← Travellers', onclick: () => { tripsState = null; currentView = 'list'; render(); } });
    let body;
    if (tripsState.loading) body = h('p', { class: 'tvx-loading', text: 'Loading trips…' });
    else if (tripsState.error) body = h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: tripsState.error });
    else body = renderTripList(tripsState.trips);
    return h('div', { class: 'tvx-card' }, [
      h('div', { class: 'tvx-tr-form-header' }, [
        h('div', {}, [
          h('h3', { class: 'tvx-h3', text: `Trips — ${t.fullName || t.firstName || 'Traveller'}` }),
          h('p', { class: 'tvx-sub', text: 'Every lead and booking this person travels on, newest first.' })
        ]),
        back
      ]),
      body
    ]);
  }

  function renderTripList(trips) {
    if (!trips.length) return h('p', { class: 'tvx-muted', text: 'No trips found.' });
    return h('ul', { class: 'tvx-tr-trips' }, trips.map((trip) => {
      const dates = [trip.startDate, trip.endDate].filter(Boolean).map(formatDisplayDate).join(' – ');
      return h('li', { class: 'tvx-tr-trip' }, [
        h('div', { class: 'tvx-tr-name-cell' }, [
          h('span', { class: 'tvx-tr-name-title', text: `${trip.kind === 'booking' ? 'Booking ' : ''}${trip.title || 'Trip'}` }),
          h('span', { class: 'tvx-tr-sub-val', text: [trip.destination, dates].filter(Boolean).join(' · ') || 'No travel dates yet' })
        ]),
        h('div', { class: 'tvx-row-gap' }, [
          trip.status ? h('span', { class: 'tvx-pill is-none', text: trip.status }) : null,
          trip.current
            ? h('span', { class: 'tvx-muted', text: 'This lead' })
            : trip.leadId && typeof ctx.navigate === 'function'
              ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Open lead', 'aria-label': `Open lead ${trip.title || ''}`.trim(), onclick: () => ctx.navigate(`/leads/${encodeURIComponent(trip.leadId)}`) })
              : null
        ])
      ]);
    }));
  }

  async function openOverlay(dataUrl, title, travellerId, kind) {
    if (dataUrl) {
      overlay = { open: true, dataUrl, title: title || 'Document photo' };
      render();
      return;
    }
    if (travellerId && kind) {
      try {
        const res = await ctx.api.get(`/travellers/${encodeURIComponent(travellerId)}/documents/${kind}`);
        if (res && res.dataUrl) {
          overlay = { open: true, dataUrl: res.dataUrl, title: title || `${toTitleCase(kind)} photo` };
          render();
        }
      } catch (err) {
        ctx.toast(`Could not load document: ${errorText(err)}`, 'error');
      }
    }
  }

  function closeOverlay() {
    overlay = { open: false, dataUrl: '', title: '' };
    render();
  }

  // --- Form Handlers ---

  function updateDerivedFields() {
    if (!formState) return;
    const v = formState.values;
    const ageInfo = calculateAgeInfo({ dob: v.dob, yearOfBirth: v.yearOfBirth }, referenceDate);
    if (ageInputRef) {
      ageInputRef.value = formatAgeDisplay(ageInfo.age, ageInfo.ageApproximate);
    }
    if (catInputRef) {
      catInputRef.value = ageInfo.ageCategory;
    }

    if (expiryWarningRef) {
      const block = passportExpiryBlock(v.passportExpiryDate, referenceDate);
      if (block) {
        expiryWarningRef.textContent = `⛔ ${block}`;
        expiryWarningRef.className = 'tvx-tr-danger-icon tvx-help';
        if (expiryWarningRef.style) expiryWarningRef.style.display = 'block';
        return;
      }
      const warning = calculateExpiryWarning(v.passportExpiryDate, referenceDate);
      const text = expiryWarningLabel(warning);
      if (text) {
        const isDanger = warning === 'expired';
        expiryWarningRef.textContent = `⚠ ${text}`;
        expiryWarningRef.className = isDanger ? 'tvx-tr-danger-icon tvx-help' : 'tvx-tr-warn-icon tvx-help';
        if (expiryWarningRef.style) expiryWarningRef.style.display = 'block';
      } else {
        expiryWarningRef.textContent = '';
        if (expiryWarningRef.style) expiryWarningRef.style.display = 'none';
      }
    }
  }

  function onFieldInput(key, val) {
    if (!formState) return;
    formState.values[key] = val;
    formState.meta[key] = { source: 'user', status: null, ocrValue: '', conflictHint: '', hint: '' };
    delete formState.fieldErrors[key];
    updateDerivedFields();
  }

  function useOcrValue(key) {
    if (!formState) return;
    const meta = formState.meta[key];
    if (!meta || !meta.ocrValue) return;
    formState.values[key] = meta.ocrValue;
    formState.meta[key] = { source: 'ocr', status: meta.status || 'ocr', ocrValue: meta.ocrValue, conflictHint: '' };
    delete formState.fieldErrors[key];
    render();
  }

  async function handleFileChoose(kind, file) {
    if (!formState || !file) return;
    const doc = kind === 'passport' ? formState.passportDoc : formState.aadhaarDoc;
    doc.ocrError = '';
    render();
    try {
      const shrunken = await shrinkImageFile(file);
      doc.newFile = shrunken;
      doc.markedForRemoval = false;
      doc.read = null;
      formState.docMismatchConfirmed = false;
    } catch (err) {
      doc.ocrError = errorText(err);
    } finally {
      render();
    }
  }

  function handleRemoveFile(kind) {
    if (!formState) return;
    const doc = kind === 'passport' ? formState.passportDoc : formState.aadhaarDoc;
    doc.newFile = null;
    doc.markedForRemoval = true;
    doc.ocrError = '';
    doc.read = null;
    formState.docMismatchConfirmed = false;
    render();
  }

  async function runOcr(kind) {
    if (!formState) return;
    const doc = kind === 'passport' ? formState.passportDoc : formState.aadhaarDoc;
    if (!doc.newFile || !doc.newFile.dataUrl) return;

    doc.ocrLoading = true;
    doc.ocrError = '';
    render();

    try {
      const result = await ctx.api.post(`/ocr/${kind}`, { image: doc.newFile.dataUrl });
      const fields = (result && result.fields) || {};
      const status = (result && result.status) || {};
      const readOk = (key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== '' && status[key] !== 'missing';
      doc.read = {
        firstName: readOk('firstName') ? toTitleCase(String(fields.firstName)) : '',
        lastName: readOk('lastName') ? toTitleCase(String(fields.lastName)) : '',
        dob: readOk('dob') ? String(fields.dob) : '',
        yearOfBirth: readOk('yearOfBirth') ? Number(fields.yearOfBirth) : null,
        gender: readOk('gender') ? String(fields.gender) : ''
      };
      formState.docMismatchConfirmed = false;

      let anyChange = false;

      // Merge fields
      for (const [key, rawVal] of Object.entries(fields)) {
        if (rawVal === undefined || rawVal === null) continue;
        let ocrVal = String(rawVal);
        if (key === 'firstName' || key === 'lastName') {
          ocrVal = toTitleCase(ocrVal);
        } else if (key === 'passportNumber') {
          ocrVal = cleanPassportNumber(ocrVal);
        } else if (key === 'aadhaarNumber') {
          ocrVal = ocrVal.replace(/\s+/g, '');
        }

        const fieldStatus = status[key] || 'ocr';

        if (fieldStatus === 'missing') {
          if (!formState.values[key]) {
            formState.meta[key] = { ...(formState.meta[key] || {}), status: 'review' };
            anyChange = true;
          }
          continue;
        }

        const currentVal = formState.values[key];
        const currentMeta = formState.meta[key] || { source: 'init' };

        // Fill an empty field; replace an earlier OCR value only with a sure one ("ocr").
        // An unsure value ("review", e.g. Indian suggested from Aadhaar) never replaces what is
        // there — it is offered as "OCR read: … Use this" instead.
        if (!currentVal || (currentMeta.source === 'ocr' && fieldStatus === 'ocr')) {
          formState.values[key] = ocrVal;
          formState.meta[key] = { source: 'ocr', status: fieldStatus, ocrValue: ocrVal, conflictHint: '' };
          anyChange = true;
        } else if (currentVal !== ocrVal) {
          formState.meta[key] = {
            source: currentMeta.source === 'ocr' ? 'ocr' : 'user',
            status: 'review',
            ocrValue: ocrVal,
            conflictHint: ocrVal
          };
          anyChange = true;
        }
      }

      // Fields OCR could not read are only in `status` ("missing"): mark them when still empty.
      for (const [key, fieldStatus] of Object.entries(status)) {
        if (fieldStatus !== 'missing' || key in fields || !(key in formState.values)) continue;
        if (!formState.values[key]) {
          formState.meta[key] = { ...(formState.meta[key] || {}), status: 'review' };
          anyChange = true;
        }
      }

      if (kind === 'aadhaar' && fields.aadhaarLast4 && !fields.aadhaarNumber) {
        formState.meta.aadhaarNumber = {
          ...(formState.meta.aadhaarNumber || {}),
          hint: `The card shows only the last 4 digits (${fields.aadhaarLast4}). Type the full number if you have it.`
        };
        anyChange = true;
      }

      if (anyChange || (result && result.notes && result.notes.length)) {
        formState.ocrUsed = true;
      }

      // Count filled & review
      let filledCount = 0;
      let reviewCount = 0;
      for (const m of Object.values(formState.meta)) {
        if (!m) continue;
        if (m.source === 'ocr' && m.status === 'ocr') filledCount += 1;
        if (m.status === 'review' || m.conflictHint) reviewCount += 1;
      }

      formState.ocrBanner = {
        visible: true,
        filledCount,
        reviewCount,
        notes: Array.isArray(result && result.notes) ? result.notes : []
      };
    } catch (err) {
      if (err.status === 413) {
        doc.ocrError = 'This photo is too large. Try a smaller or cropped photo.';
      } else if (err.status === 504) {
        doc.ocrError = 'OCR took too long. Try again or enter the details yourself.';
      } else if (err.status === 502 || err.status === 503) {
        // Show the real reason (e.g. "Open Settings → Integrations and Save the key again").
        doc.ocrError = `OCR could not run: ${errorText(err)} You can still enter the details yourself.`;
      } else {
        doc.ocrError = errorText(err);
      }
    } finally {
      doc.ocrLoading = false;
      render();
    }
  }

  function validateClientForm() {
    const errors = {};
    const v = formState.values;
    const firstName = String(v.firstName || '').trim();
    if (!v.dob && v.yearOfBirth !== null && v.yearOfBirth !== undefined && v.yearOfBirth !== '') {
      const y = Number(v.yearOfBirth);
      const max = Number(todayIso().slice(0, 4));
      const min = Math.max(1900, max - 120);
      if (!Number.isInteger(y) || y < min || y > max) errors.yearOfBirth = `Year of birth must be between ${min} and ${max}`;
    }
    if (!firstName) {
      errors.firstName = 'First name is required';
    } else if (firstName.length > 60) {
      errors.firstName = 'First name must be at most 60 characters';
    } else if (nameProblem(firstName, 'First name')) {
      errors.firstName = nameProblem(firstName, 'First name');
    }
    const lastName = String(v.lastName || '').trim();
    if (nameProblem(lastName, 'Last name')) errors.lastName = nameProblem(lastName, 'Last name');

    if (!String(v.relation || '').trim()) errors.relation = 'Relation is required';
    const phone = cleanPhone(v.phone);
    if (!phone) errors.phone = 'Phone number is required';
    else if (!PHONE_RE.test(phone)) errors.phone = 'Phone number must be 7–15 digits (a leading + is allowed)';
    if (v.email && !EMAIL_RE.test(String(v.email).trim())) errors.email = 'Email address is not valid';
    if (passportRequired) {
      if (!String(v.passportNumber || '').trim()) errors.passportNumber = `Required for this lead (${passportRequiredBy.join(', ')})`;
      if (!v.passportExpiryDate) errors.passportExpiryDate = 'Required for this lead';
      if (!String(v.passportCountry || '').trim()) errors.passportCountry = 'Required for this lead';
    }
    const expiryBlock = passportExpiryBlock(v.passportExpiryDate, referenceDate);
    if (expiryBlock) errors.passportExpiryDate = expiryBlock;

    if (v.lastName && String(v.lastName).trim().length > 60) {
      errors.lastName = 'Last name must be at most 60 characters';
    }
    if (v.nationality && String(v.nationality).trim().length > 60) {
      errors.nationality = 'Nationality must be at most 60 characters';
    }
    if (v.passportCountry && String(v.passportCountry).trim().length > 60) {
      errors.passportCountry = 'Issuing country must be at most 60 characters';
    } else if (v.passportCountry && !COUNTRY_RE.test(String(v.passportCountry).trim())) {
      errors.passportCountry = "Issuing country can only have letters, spaces and . , & ( ) ' -";
    }
    // A passport number is only usable with its expiry date and issuing country.
    if (String(v.passportNumber || '').trim()) {
      if (!v.passportExpiryDate && !errors.passportExpiryDate) errors.passportExpiryDate = 'Required with a passport number';
      if (!String(v.passportCountry || '').trim() && !errors.passportCountry) errors.passportCountry = 'Required with a passport number';
    }

    const today = todayIso();
    if (v.dob) {
      if (!isValidDate(v.dob)) errors.dob = 'Date of birth must be a valid date';
      else if (v.dob > today) errors.dob = 'Date of birth cannot be in the future';
      else if (yearsBetween(v.dob, today) > 120) errors.dob = 'Check the date of birth';
    }

    if (v.passportIssueDate) {
      if (!isValidDate(v.passportIssueDate)) errors.passportIssueDate = 'Passport issue date must be a valid date';
      else if (v.passportIssueDate > today) errors.passportIssueDate = 'Passport issue date cannot be in the future';
    }
    if (v.passportExpiryDate && !isValidDate(v.passportExpiryDate)) {
      errors.passportExpiryDate = 'Passport expiry date must be a valid date';
    }
    if (v.passportIssueDate && v.passportExpiryDate && isValidDate(v.passportIssueDate) && isValidDate(v.passportExpiryDate)) {
      if (v.passportIssueDate >= v.passportExpiryDate) {
        errors.passportIssueDate = 'Passport issue date must be before the expiry date';
      }
    }

    if (v.passportNumber) {
      const cleanNum = cleanPassportNumber(v.passportNumber);
      if (!cleanNum || cleanNum.length < 6 || cleanNum.length > 15) {
        errors.passportNumber = 'Passport number must be 6–15 letters or digits';
      }
    }

    if (v.aadhaarNumber) {
      const cleanAadhaar = String(v.aadhaarNumber).replace(/\s+/g, '');
      if (cleanAadhaar && !/^[2-9]\d{11}$/.test(cleanAadhaar)) {
        errors.aadhaarNumber = 'Aadhaar number must be exactly 12 digits not starting with 0 or 1';
      } else if (cleanAadhaar && !isValidAadhaar(cleanAadhaar)) {
        errors.aadhaarNumber = 'Aadhaar number check digit is invalid';
      }
    }

    // The same person twice on this lead: same full name and the same date of birth or phone.
    if (firstName && !errors.firstName) {
      const fullName = `${firstName} ${lastName}`.replace(/\s+/g, ' ').trim().toLowerCase();
      const twin = travellers.find(
        (t) =>
          t.id !== formState.travellerId &&
          `${t.firstName || ''} ${t.lastName || ''}`.replace(/\s+/g, ' ').trim().toLowerCase() === fullName &&
          ((v.dob && t.dob === v.dob) || (phone && cleanPhone(t.phone) === phone))
      );
      if (twin) errors.firstName = `${twin.fullName || firstName} is already a traveller on this lead`;
    }

    if (formState.ocrUsed && !formState.ocrConfirmed) {
      errors.ocrConfirmed = 'Please confirm that you have checked the details read by OCR';
    }

    return errors;
  }

  async function handleSaveTraveller() {
    if (!formState || formState.saving) return;
    formState.formError = '';
    formState.photoUploadError = '';

    const errors = validateClientForm();
    if (Object.keys(errors).length > 0) {
      formState.fieldErrors = errors;
      const count = Object.keys(errors).filter((k) => k !== 'ocrConfirmed').length;
      formState.formError =
        errors.ocrConfirmed ||
        `Please fix ${count === 1 ? 'the highlighted field' : `the ${count} highlighted fields`} before saving.`;
      render();
      focusFirstError();
      return;
    }

    if (!formState.docMismatchConfirmed) {
      const diffs = compareDocumentIdentity(formState.passportDoc.read, formState.aadhaarDoc.read, referenceDate);
      if (diffs.length) {
        showDocumentMismatch(diffs);
        return;
      }
    }

    // The save works on this form (fs) to the end, even if the view changes meanwhile; the screen is
    // only touched while this form is still the one shown.
    const fs = formState;
    const current = () => formState === fs;
    fs.saving = true;
    render();

    try {
      const input = {
        firstName: fs.values.firstName.trim(),
        lastName: fs.values.lastName.trim(),
        dob: fs.values.dob || '',
        // A full date of birth wins over a year of birth.
        yearOfBirth: fs.values.dob ? null : fs.values.yearOfBirth || null,
        gender: fs.values.gender || '',
        nationality: fs.values.nationality.trim(),
        relation: String(fs.values.relation || '').trim(),
        phone: cleanPhone(fs.values.phone),
        email: String(fs.values.email || '').trim(),
        contactId: fs.values.contactId || '',
        passportNumber: fs.values.passportNumber ? cleanPassportNumber(fs.values.passportNumber) : '',
        passportIssueDate: fs.values.passportIssueDate || '',
        passportExpiryDate: fs.values.passportExpiryDate || '',
        passportCountry: fs.values.passportCountry.trim(),
        ocrUsed: Boolean(fs.ocrUsed),
        ocrConfirmed: Boolean(fs.ocrConfirmed),
        // Kept in the audit trail only: the user saved although passport and Aadhaar differ.
        docMismatchConfirmed: Boolean(fs.docMismatchConfirmed)
      };

      if (fs.mode === 'add') {
        input.aadhaarNumber = fs.values.aadhaarNumber ? fs.values.aadhaarNumber.replace(/\s+/g, '') : '';
      } else {
        const aadhaarMeta = fs.meta.aadhaarNumber;
        if (aadhaarMeta && (aadhaarMeta.source === 'user' || aadhaarMeta.source === 'ocr')) {
          input.aadhaarNumber = fs.values.aadhaarNumber ? fs.values.aadhaarNumber.replace(/\s+/g, '') : '';
        }
      }

      let saved;
      let workflowResult = null;
      if (fs.mode === 'add') {
        const res = await ctx.api.post(`/leads/${encodeURIComponent(leadId)}/travellers`, input);
        saved = res && res.traveller;
        workflowResult = res && res.workflow;
      } else {
        const res = await ctx.api.put(`/travellers/${encodeURIComponent(fs.travellerId)}`, input);
        saved = res && res.traveller;
      }

      const targetId = saved && saved.id ? saved.id : fs.travellerId;

      // Handle photos sequentially
      try {
        if (fs.passportDoc.markedForRemoval) {
          await ctx.api.del(`/travellers/${encodeURIComponent(targetId)}/documents/passport`);
          fs.passportDoc.hasStoredFile = false;
          fs.passportDoc.markedForRemoval = false;
        } else if (fs.passportDoc.newFile) {
          await ctx.api.put(`/travellers/${encodeURIComponent(targetId)}/documents/passport`, {
            image: fs.passportDoc.newFile.dataUrl,
            name: fs.passportDoc.newFile.name || 'passport.jpg'
          });
          fs.passportDoc.hasStoredFile = true;
          fs.passportDoc.newFile = null;
        }

        if (fs.aadhaarDoc.markedForRemoval) {
          await ctx.api.del(`/travellers/${encodeURIComponent(targetId)}/documents/aadhaar`);
          fs.aadhaarDoc.hasStoredFile = false;
          fs.aadhaarDoc.markedForRemoval = false;
        } else if (fs.aadhaarDoc.newFile) {
          await ctx.api.put(`/travellers/${encodeURIComponent(targetId)}/documents/aadhaar`, {
            image: fs.aadhaarDoc.newFile.dataUrl,
            name: fs.aadhaarDoc.newFile.name || 'aadhaar.jpg'
          });
          fs.aadhaarDoc.hasStoredFile = true;
          fs.aadhaarDoc.newFile = null;
        }
      } catch (docErr) {
        fs.mode = 'edit';
        fs.travellerId = targetId;
        fs.photoUploadError = `Details saved, but the photo upload failed: ${errorText(docErr)}`;
        fs.saving = false;
        if (current()) render();
        else ctx.toast(fs.photoUploadError, 'error');
        return;
      }

      ctx.toast(
        workflowResult && workflowResult.stageChanged
          ? `Traveller saved — the lead is ready and moved to ${workflowResult.stage}`
          : 'Traveller saved',
        'success'
      );
      // The lead page refreshes its stage and the Create Opportunity button.
      if (typeof ctx.recordChanged === 'function') ctx.recordChanged();
      notifySaved(targetId);
      fs.saving = false;
      if (current()) closeForm();
      await loadList();
    } catch (err) {
      fs.saving = false;
      if (!current()) {
        ctx.toast(`Traveller not saved: ${errorText(err)}`, 'error');
        return;
      }
      // The host may not pass the error code on, so the message is checked too.
      if (err && err.status === 409 && (err.code === 'DUPLICATE_TRAVELLER' || /already a traveller on this lead/.test(err.message || ''))) {
        fs.fieldErrors.firstName = err.message || 'This person is already a traveller on this lead.';
        fs.formError = fs.fieldErrors.firstName;
      } else if (err && err.status === 409 && duplicateFields(err).length) {
        // Email / phone / Aadhaar / passport another person already has: each under its own field.
        for (const [field, message] of duplicateFields(err)) fs.fieldErrors[field] = message;
        fs.formError = err.message;
      } else if (err && err.status === 409) {
        fs.fieldErrors.passportNumber = err.message || 'A traveller with this passport number already exists on this lead.';
        fs.formError = fs.fieldErrors.passportNumber;
      } else {
        fs.formError = errorText(err);
      }
      render();
      if (err && err.status === 409) focusFirstError();
    }
  }

  /**
   * Passport and Aadhaar read different details: say what differs and let the user decide.
   * "Cancel entry" saves nothing (the form stays open to fix the details); "OK, continue" saves.
   */
  function showDocumentMismatch(diffs) {
    const fs = formState;
    const rows = diffs.map((d) =>
      h('tr', {}, [
        h('th', { scope: 'row', text: d.label }),
        h('td', { text: d.passport || '—' }),
        h('td', { text: d.aadhaar || '—' })
      ])
    );
    openDialog(root, {
      title: 'Passport and Aadhaar details do not match',
      intro: 'These details read from the two documents are different. Check that both belong to this traveller.',
      cancelLabel: 'Cancel entry',
      content: [
        h('table', { class: 'tvx-tr-mismatch', 'data-testid': 'doc-mismatch' }, [
          h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', text: '' }), h('th', { scope: 'col', text: 'Passport' }), h('th', { scope: 'col', text: 'Aadhaar' })])]),
          h('tbody', {}, rows)
        ])
      ],
      actions: [
        {
          label: 'OK, continue',
          onClick: () => {
            if (formState !== fs) return;
            fs.docMismatchConfirmed = true;
            // After the dialog has closed, so the save renders the form normally.
            setTimeout(() => handleSaveTraveller(), 0);
          }
        }
      ]
    });
  }

  // --- Rendering Functions ---

  function renderCountsSummary() {
    const total = counts.total || (counts.Adult || 0) + (counts.Child || 0) + (counts.Infant || 0);
    const travWord = total === 1 ? 'traveller' : 'travellers';
    const adultWord = counts.Adult === 1 ? 'Adult' : 'Adults';
    const childWord = counts.Child === 1 ? 'Child' : 'Children';
    const infantWord = counts.Infant === 1 ? 'Infant' : 'Infants';

    const countsText = `${total} ${travWord} · ${counts.Adult || 0} ${adultWord} · ${counts.Child || 0} ${childWord} · ${counts.Infant || 0} ${infantWord}`;

    const dateFormatted = formatDisplayDate(referenceDate);
    const refText =
      referenceSource === 'travel_start_date'
        ? `Age is worked out on the travel start date (${dateFormatted}).`
        : `Age is worked out on today's date (${dateFormatted}).`;

    return h('div', { class: 'tvx-tr-titles' }, [
      h('h3', { class: 'tvx-h3', text: 'Travellers' }),
      h('p', { class: 'tvx-sub', text: countsText }),
      h('p', { class: 'tvx-muted', text: refText })
    ]);
  }

  function renderMismatchWarning() {
    if (!expected) return null;
    const a = Number(expected.adults) || 0;
    const c = Number(expected.children) || 0;
    const i = Number(expected.infants) || 0;
    // Compared the way the quotation counts: a traveller without a known age is an Adult.
    const got = groups || { Adult: counts.Adult, Child: counts.Child, Infant: counts.Infant, unknownAge: 0 };
    if (a === got.Adult && c === got.Child && i === got.Infant) {
      return null;
    }
    const aWord = a === 1 ? 'adult' : 'adults';
    const cWord = c === 1 ? 'child' : 'children';
    const iWord = i === 1 ? 'infant' : 'infants';
    const unknown = Number(got.unknownAge) || 0;
    const unknownText = unknown ? ` ${unknown} traveller${unknown === 1 ? ' has' : 's have'} no date of birth and ${unknown === 1 ? 'counts' : 'count'} as ${unknown === 1 ? 'an adult' : 'adults'}.` : '';
    return h('div', { class: 'tvx-msg tvx-msg-warn' }, [
      h('span', { text: `⚠ The lead says ${a} ${aWord}, ${c} ${cWord}, ${i} ${iWord}.${unknownText}` })
    ]);
  }

  /** "Family member · Lead contact" under the name. */
  function relationLine(tr) {
    const parts = [];
    if (tr.relation) parts.push(tr.relation);
    if (tr.contactId && leadContact && tr.contactId === leadContact.contactId) parts.push('Lead contact');
    return parts.length ? h('span', { class: 'tvx-tr-sub-val', text: parts.join(' · ') }) : null;
  }

  function renderCategoryPill(category) {
    if (category === 'Infant') return h('span', { class: 'tvx-pill is-done', text: 'Infant' });
    if (category === 'Child') return h('span', { class: 'tvx-pill is-draft', text: 'Child' });
    if (category === 'Adult') return h('span', { class: 'tvx-pill is-none', text: 'Adult' });
    return h('span', { class: 'tvx-muted', text: '—' });
  }

  function renderPassportCell(passport) {
    if (passport && passport.missing) {
      return h('span', { class: 'tvx-pill is-draft', title: 'This lead needs passport details for every traveller', text: 'Passport needed' });
    }
    if (!passport || (!passport.numberMasked && !passport.hasFile)) {
      return h('span', { class: 'tvx-muted', text: '—' });
    }
    const numChildren = [h('span', { class: 'tvx-mono', text: passport.numberMasked || '—' })];
    if (passport.expiryWarning) {
      const isDanger = passport.expiryWarning === 'expired';
      numChildren.push(
        h('span', {
          class: isDanger ? 'tvx-tr-danger-icon' : 'tvx-tr-warn-icon',
          title: expiryWarningLabel(passport.expiryWarning),
          role: 'img',
          'aria-label': expiryWarningLabel(passport.expiryWarning),
          text: ' ⚠'
        })
      );
    }

    const subChildren = [];
    if (passport.expiryDate) {
      subChildren.push(h('span', { class: 'tvx-tr-sub-val', text: `exp ${formatDisplayDate(passport.expiryDate)}` }));
    }
    if (passport.hasFile) {
      subChildren.push(h('span', { class: 'tvx-tr-file-icon', title: 'Document stored', text: ' 📎' }));
    }

    return h('div', { class: 'tvx-tr-doc-cell' }, [
      h('div', { class: 'tvx-tr-doc-num' }, numChildren),
      subChildren.length ? h('div', { class: 'tvx-row-gap' }, subChildren) : null
    ]);
  }

  function renderAadhaarCell(aadhaar) {
    if (!aadhaar || (!aadhaar.numberMasked && !aadhaar.hasFile)) {
      return h('span', { class: 'tvx-muted', text: '—' });
    }
    const numChildren = [h('span', { class: 'tvx-mono', text: aadhaar.numberMasked || '—' })];
    if (aadhaar.hasFile) {
      numChildren.push(h('span', { class: 'tvx-tr-file-icon', title: 'Document stored', text: ' 📎' }));
    }
    return h('div', { class: 'tvx-tr-doc-num' }, numChildren);
  }

  /** Trips for everyone; Edit and Delete with the edit permission. */
  function rowActions(tr) {
    const name = tr.fullName || tr.firstName || 'traveller';
    return h('div', { class: 'tvx-tr-actions' }, [
      h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Trips', 'aria-label': `Trips of ${name}`, onclick: () => openTrips(tr) }),
      canEdit ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Edit', onclick: () => openEditForm(tr.id) }) : null,
      canEdit
        ? h('button', {
            type: 'button',
            class: 'tvx-btn tvx-btn-danger',
            text: deleting.has(tr.id) ? 'Deleting…' : 'Delete',
            disabled: deleting.has(tr.id),
            onclick: (e) => deleteTraveller(tr, e.currentTarget)
          })
        : null
    ]);
  }

  function renderTableView() {
    return h('div', { class: 'tvx-tr-table-wrap' }, [
      h('table', { class: 'tvx-tr-table' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { text: 'Name' }),
            h('th', { text: 'Category' }),
            h('th', { text: 'DOB / Age' }),
            h('th', { text: 'Gender' }),
            h('th', { text: 'Passport' }),
            h('th', { text: 'Aadhaar' }),
            h('th', { style: 'text-align: right;', text: 'Actions' })
          ])
        ]),
        h(
          'tbody',
          {},
          travellers.map((tr) => {
            const ageStr = formatAgeDisplay(tr.age, tr.ageApproximate);
            const dobStr = tr.dob ? formatDisplayDate(tr.dob) : tr.yearOfBirth ? String(tr.yearOfBirth) : '—';
            return h('tr', {}, [
              h('td', {}, [
                h('div', { class: 'tvx-tr-name-cell' }, [
                  h('span', { class: 'tvx-tr-name-title', text: tr.fullName || tr.firstName || '—' }),
                  relationLine(tr)
                ])
              ]),
              h('td', {}, [renderCategoryPill(tr.ageCategory)]),
              h('td', {}, [
                h('div', { class: 'tvx-tr-name-cell' }, [
                  h('span', { text: dobStr }),
                  ageStr ? h('span', { class: 'tvx-tr-sub-val', text: ageStr }) : null
                ])
              ]),
              h('td', {}, [h('span', { text: tr.gender || '—' })]),
              h('td', {}, [renderPassportCell(tr.passport)]),
              h('td', {}, [renderAadhaarCell(tr.aadhaar)]),
              h('td', { style: 'text-align: right;' }, [rowActions(tr)])
            ]);
          })
        )
      ])
    ]);
  }

  function renderMobileCards() {
    return h(
      'div',
      { class: 'tvx-tr-cards-list' },
      travellers.map((tr) => {
        const ageStr = formatAgeDisplay(tr.age, tr.ageApproximate);
        const dobStr = tr.dob ? formatDisplayDate(tr.dob) : tr.yearOfBirth ? String(tr.yearOfBirth) : '—';
        return h('div', { class: 'tvx-tr-card-item' }, [
          h('div', { class: 'tvx-tr-card-row' }, [
            h('div', { class: 'tvx-tr-name-cell' }, [
              h('span', { class: 'tvx-tr-name-title', text: tr.fullName || tr.firstName || '—' }),
              relationLine(tr)
            ]),
            renderCategoryPill(tr.ageCategory)
          ]),
          h('div', { class: 'tvx-tr-card-grid' }, [
            h('div', { class: 'tvx-tr-card-cell' }, [
              h('span', { class: 'tvx-tr-card-label', text: 'DOB / Age' }),
              h('span', { text: dobStr }),
              ageStr ? h('span', { class: 'tvx-tr-sub-val', text: ageStr }) : null
            ]),
            h('div', { class: 'tvx-tr-card-cell' }, [
              h('span', { class: 'tvx-tr-card-label', text: 'Gender' }),
              h('span', { text: tr.gender || '—' })
            ]),
            h('div', { class: 'tvx-tr-card-cell' }, [
              h('span', { class: 'tvx-tr-card-label', text: 'Passport' }),
              renderPassportCell(tr.passport)
            ]),
            h('div', { class: 'tvx-tr-card-cell' }, [
              h('span', { class: 'tvx-tr-card-label', text: 'Aadhaar' }),
              renderAadhaarCell(tr.aadhaar)
            ])
          ]),
          h('div', { style: 'margin-top: 6px;' }, [rowActions(tr)])
        ]);
      })
    );
  }

  function renderListView() {
    if (travellers.length === 0) {
      return h('div', { class: 'tvx-card tvx-empty' }, [
        h('p', { class: 'tvx-empty-title', text: 'No travellers yet' }),
        h('p', {
          class: 'tvx-sub',
          text: 'Add the people travelling on this lead. Upload a passport or Aadhaar photo to fill the details faster.'
        }),
        canEdit
          ? h('div', { class: 'tvx-row-gap', style: 'margin-top: 12px; justify-content: center;' }, [
              h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Add existing traveller', onclick: () => openPicker() }),
              h('button', {
                type: 'button',
                class: 'tvx-btn tvx-btn-primary',
                text: '+ Add traveller',
                onclick: () => openAddForm()
              })
            ])
          : null
      ]);
    }

    return h('div', { class: 'tvx-card' }, [
      h('div', { class: 'tvx-tr-head' }, [
        renderCountsSummary(),
        canEdit
          ? h('div', { class: 'tvx-row-gap' }, [
              h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Add existing traveller', onclick: () => openPicker() }),
              h('button', {
                type: 'button',
                class: 'tvx-btn tvx-btn-primary',
                text: '+ Add traveller',
                onclick: () => openAddForm()
              })
            ])
          : null
      ]),
      renderMismatchWarning(),
      renderTableView(),
      renderMobileCards()
    ]);
  }

  // --- Document Block for Form ---

  function renderDocBlock(kind, title, fieldsContent) {
    const doc = kind === 'passport' ? formState.passportDoc : formState.aadhaarDoc;
    const hasImage = Boolean(doc.newFile && doc.newFile.dataUrl) || (doc.hasStoredFile && !doc.markedForRemoval);

    // Hidden file input
    const fileInput = h('input', {
      type: 'file',
      accept: 'image/jpeg,image/png,image/webp',
      class: 'tvx-tr-sr-only',
      onchange: (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) handleFileChoose(kind, file);
      }
    });

    let thumbContent = [h('span', { text: 'No image' })];
    if (doc.newFile && doc.newFile.dataUrl) {
      thumbContent = [
        h('img', {
          class: 'tvx-tr-thumb-img',
          src: doc.newFile.dataUrl,
          alt: `${title} preview`
        })
      ];
    } else if (doc.hasStoredFile && !doc.markedForRemoval) {
      thumbContent = [
        h('span', { class: 'tvx-mono', text: 'Stored photo' }),
        h('span', { class: 'tvx-muted tvx-help', text: 'Click to view' })
      ];
    }

    const thumbBox = h(
      'div',
      {
        class: `tvx-tr-thumb-box ${hasImage ? 'has-image' : ''}`,
        tabindex: 0,
        role: 'button',
        'aria-label': `View ${title}`,
        onclick: () => {
          if (doc.newFile && doc.newFile.dataUrl) {
            openOverlay(doc.newFile.dataUrl, `${title} preview`);
          } else if (doc.hasStoredFile && !doc.markedForRemoval && formState.travellerId) {
            openOverlay('', `${title} — ${formState.values.firstName || 'Traveller'}`, formState.travellerId, kind);
          } else {
            fileInput.click();
          }
        },
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            thumbBox.click();
          }
        }
      },
      thumbContent
    );

    const previewButtons = [];

    previewButtons.push(
      h(
        'button',
        {
          type: 'button',
          class: 'tvx-btn tvx-btn-ghost',
          onclick: () => fileInput.click()
        },
        ['Upload']
      )
    );

    if (hasImage) {
      if (doc.hasStoredFile && !doc.newFile && formState.travellerId) {
        previewButtons.push(
          h(
            'button',
            {
              type: 'button',
              class: 'tvx-btn tvx-btn-ghost',
              onclick: () =>
                openOverlay('', `${title} — ${formState.values.firstName || 'Traveller'}`, formState.travellerId, kind)
            },
            ['View']
          )
        );
      }
      previewButtons.push(
        h(
          'button',
          {
            type: 'button',
            class: 'tvx-btn tvx-btn-danger',
            onclick: () => handleRemoveFile(kind)
          },
          ['Remove']
        )
      );
    }

    if (doc.newFile && doc.newFile.dataUrl) {
      previewButtons.push(
        h(
          'button',
          {
            type: 'button',
            class: 'tvx-btn tvx-btn-primary',
            disabled: doc.ocrLoading,
            onclick: () => runOcr(kind)
          },
          [doc.ocrLoading ? 'Extracting…' : 'Extract Details with OCR']
        )
      );
    }

    const previewBox = h('div', { class: 'tvx-tr-doc-preview' }, [
      fileInput,
      thumbBox,
      h('div', { class: 'tvx-tr-preview-actions' }, previewButtons),
      doc.ocrError ? h('div', { class: 'tvx-msg tvx-msg-error', text: doc.ocrError }) : null
    ]);

    return h('div', { class: 'tvx-tr-doc-block' }, [previewBox, fieldsContent]);
  }

  /**
   * A dropdown of the workspace's choices (Settings → Travel). A current value that is not in
   * the list (older record, or read by OCR) stays selectable, marked "not in your list".
   */
  function choiceSelect(key, choices, placeholder, emptyHint) {
    const current = String((formState && formState.values[key]) || '');
    const list = choices.slice();
    const options = [h('option', { value: '', text: list.length ? placeholder : emptyHint })];
    for (const choice of list) options.push(h('option', { value: choice, text: choice, selected: choice === current }));
    if (current && !list.includes(current)) {
      options.push(h('option', { value: current, text: `${current} (not in your list)`, selected: true }));
    }
    return h('select', { onchange: (e) => onFieldInput(key, e.target.value) }, options);
  }

  function renderFormField(key, labelText, inputEl, options = {}) {
    const meta = (formState && formState.meta[key]) || {};
    const errorMsg = (formState && formState.fieldErrors[key]) || '';

    // Text and the required mark stay together on the left; OCR tags go to the right.
    const labelChildren = [
      h('span', {}, [labelText, options.required ? h('span', { class: 'tvx-req', text: '*' }) : null])
    ];

    if (meta.status === 'ocr' && meta.source === 'ocr') {
      labelChildren.push(h('span', { class: 'tvx-tr-tag-ocr', text: 'OCR' }));
    } else if (meta.status === 'review') {
      labelChildren.push(h('span', { class: 'tvx-tr-tag-review', text: 'Needs review' }));
    }

    let inputCls = 'tvx-input';
    if (meta.source === 'ocr' && meta.status === 'ocr') inputCls += ' tvx-ocr';
    else if (meta.status === 'review') inputCls += ' tvx-review';

    inputEl.className = inputCls;
    if (!inputEl.id) inputEl.id = `tvx-tr-${key}-${(fieldSeq += 1)}`;
    const labelEl = h('label', { class: 'tvx-label tvx-tr-label-row', for: inputEl.id }, labelChildren);

    // Editing a value makes it the user's own: drop its OCR / review mark at once.
    inputEl.addEventListener(inputEl.tagName === 'SELECT' ? 'change' : 'input', () => {
      inputEl.classList.remove('tvx-ocr', 'tvx-review');
      labelEl.querySelectorAll('.tvx-tr-tag-ocr, .tvx-tr-tag-review').forEach((tag) => tag.remove());
      // The value changed, so its old error no longer applies (checked again on Save).
      const box = inputEl.closest('.tvx-field');
      if (box) box.querySelectorAll('.tvx-tr-field-error').forEach((el) => el.remove());
      setInvalid(inputEl, '');
      // A changed phone / email / Aadhaar / passport: the existing-traveller card of the old value goes.
      if (DUPLICATE_FIELDS.includes(key)) dropExistingFor(key);
    });
    if (DUPLICATE_FIELDS.includes(key)) dupInputRefs[key] = inputEl;

    // Leaving a field checks it at once (the whole form is checked again on Save).
    if (!inputEl.disabled) {
      inputEl.addEventListener('blur', () => {
        if (!formState || formState.saving) return;
        const msg = validateClientForm()[key] || '';
        if (msg) formState.fieldErrors[key] = msg;
        else delete formState.fieldErrors[key];
        const box = inputEl.closest('.tvx-field');
        if (!box) return;
        box.querySelectorAll('.tvx-tr-field-error, .tvx-tr-field-warn').forEach((el) => el.remove());
        setInvalid(inputEl, msg);
        if (msg) box.append(fieldErrorEl(inputEl, msg));
        // Add form: who has these values (card); editing: the field message as before.
        if (DUPLICATE_FIELDS.includes(key) && formState.mode === 'add') scheduleExistingCheck();
        else if (!msg && DUPLICATE_FIELDS.includes(key)) checkDuplicate(key, inputEl);
      });
    }

    const children = [labelEl, inputEl];

    if (meta.conflictHint) {
      children.push(
        h('div', { class: 'tvx-tr-conflict-hint' }, [
          h('span', { text: `OCR read: ${meta.conflictHint}` }),
          h('button', {
            type: 'button',
            class: 'tvx-tr-use-btn',
            text: 'Use this',
            onclick: () => useOcrValue(key)
          })
        ])
      );
    }

    if (meta.hint) {
      children.push(h('p', { class: 'tvx-help', text: meta.hint }));
    }

    setInvalid(inputEl, errorMsg);
    if (errorMsg) children.push(fieldErrorEl(inputEl, errorMsg));

    return h('div', { class: 'tvx-field' }, children);
  }

  /**
   * 2.14.1: another person in the workspace already has this email / phone / Aadhaar / passport number?
   * Asked when the field is left, so the problem shows before Save (Save checks again on the server).
   */
  async function checkDuplicate(key, inputEl) {
    const fs = formState;
    const value = String((fs && fs.values[key]) || '').trim();
    if (!fs || !value) return;
    const asked = value;
    let res;
    try {
      res = await ctx.api.post('/travellers/duplicates-check', {
        leadId,
        ...(fs.mode === 'edit' && fs.travellerId ? { travellerId: fs.travellerId } : {}),
        [key]: key === 'aadhaarNumber' ? value.replace(/\s+/g, '') : value
      });
    } catch {
      return; // never block typing; Save checks again
    }
    // The user changed the field (or closed the form) meanwhile: this answer is old.
    if (formState !== fs || String(fs.values[key] || '').trim() !== asked || !inputEl.isConnected) return;
    const box = inputEl.closest('.tvx-field');
    if (!box) return;
    box.querySelectorAll('.tvx-tr-field-error, .tvx-tr-field-warn').forEach((el) => el.remove());
    const dup = ((res && res.duplicates) || []).find((d) => d.field === key);
    const maybe = ((res && res.possible) || []).find((d) => d.field === key);
    if (dup) {
      fs.fieldErrors[key] = dup.message;
      setInvalid(inputEl, dup.message);
      box.append(fieldErrorEl(inputEl, dup.message));
    } else if (maybe) {
      box.append(h('p', { class: 'tvx-tr-field-warn', role: 'status', text: maybe.message }));
    }
  }

  /* -------------------------------- add form: an existing traveller found */

  /** A field's value as it is sent to duplicates-check (the server normalises it like a save). */
  const existingValue = (fs, key) => {
    const raw = String((fs && fs.values[key]) || '').trim();
    return key === 'aadhaarNumber' ? raw.replace(/\s+/g, '') : raw;
  };

  /** Leaving phone / email / Aadhaar / passport on the add form: one check after a short pause. */
  function scheduleExistingCheck() {
    const fs = formState;
    if (!fs || fs.mode !== 'add') return;
    clearTimeout(fs.existingTimer);
    fs.existingTimer = setTimeout(() => runExistingCheck(fs), EXISTING_CHECK_DELAY);
  }

  /**
   * Asks who already has the valid values of the four fields. The newest request wins; an answer for
   * values that changed meanwhile is dropped. A plain duplicate (no match details) shows under its
   * field as before; one person → the card with "Add Existing Traveller"; different people → a warning.
   */
  async function runExistingCheck(fs) {
    if (formState !== fs || fs.saving) return;
    const errors = validateClientForm();
    const input = {};
    for (const key of DUPLICATE_FIELDS) {
      const value = existingValue(fs, key);
      if (value && !errors[key]) input[key] = value;
    }
    const seq = (fs.existingSeq = (fs.existingSeq || 0) + 1);
    if (!Object.keys(input).length) {
      fs.existing = null;
      paintExisting();
      return;
    }
    let res;
    try {
      res = await ctx.api.post('/travellers/duplicates-check', { leadId, ...input });
    } catch {
      return; // never block typing; Save checks again
    }
    if (formState !== fs || seq !== fs.existingSeq) return;
    if (Object.keys(input).some((key) => existingValue(fs, key) !== input[key])) return;
    const duplicates = (res && res.duplicates) || [];
    const possible = (res && res.possible) || [];
    const match = res && res.match && res.match.travellerId ? res.match : null;
    const conflict = Boolean(res && res.conflict);
    fs.existing = match || conflict ? { match, conflict, message: (res && res.message) || CONFLICT_TEXT, asked: input, error: '', adding: false } : null;
    // The field messages of the fields asked: a plain duplicate under its field (no card to explain it).
    for (const key of Object.keys(input)) {
      const inputEl = dupInputRefs[key];
      const box = inputEl && inputEl.isConnected ? inputEl.closest('.tvx-field') : null;
      if (!box) continue;
      box.querySelectorAll('.tvx-tr-field-error, .tvx-tr-field-warn').forEach((el) => el.remove());
      const dup = duplicates.find((d) => d.field === key);
      const maybe = possible.find((d) => d.field === key);
      if (dup && !fs.existing) {
        fs.fieldErrors[key] = dup.message;
        setInvalid(inputEl, dup.message);
        box.append(fieldErrorEl(inputEl, dup.message));
      } else {
        delete fs.fieldErrors[key];
        setInvalid(inputEl, '');
        if (maybe) box.append(h('p', { class: 'tvx-tr-field-warn', role: 'status', text: maybe.message }));
      }
    }
    paintExisting();
  }

  /** A phone / email / Aadhaar / passport changed: a card found with its old value no longer applies. */
  function dropExistingFor(key) {
    const fs = formState;
    if (!fs || fs.mode !== 'add') return;
    clearTimeout(fs.existingTimer);
    fs.existingSeq = (fs.existingSeq || 0) + 1; // an answer on its way is for the old values
    if (fs.existing && key in fs.existing.asked && !fs.existing.adding) {
      fs.existing = null;
      paintExisting();
    }
  }

  /** The card is still about the values in the form (OCR or the contact picker may have changed them). */
  function existingCurrent(fs) {
    const e = fs && fs.existing;
    return Boolean(e && Object.keys(e.asked).every((key) => existingValue(fs, key) === e.asked[key]));
  }

  function paintExisting() {
    if (!existingSlot || !existingSlot.isConnected) return;
    existingSlot.replaceChildren(...renderExistingCard());
  }

  function renderExistingCard() {
    const fs = formState;
    if (!fs || fs.mode !== 'add' || !existingCurrent(fs)) return [];
    const e = fs.existing;
    if (e.conflict) {
      return [h('div', { class: 'tvx-tr-existing tvx-tr-existing-conflict', role: 'alert', 'data-testid': 'existing-traveller' }, [
        h('p', { class: 'tvx-tr-existing-title', text: 'Check the details' }),
        h('p', { class: 'tvx-tr-existing-note', text: e.message || CONFLICT_TEXT })
      ])];
    }
    const m = e.match;
    const lines = [['Mobile', m.phone], ['Email', m.email], ['Aadhaar', m.aadhaar], ['Passport', m.passport]].filter(([, value]) => value);
    const fields = Array.isArray(m.fields) ? m.fields : [];
    const matched = Object.keys(EXISTING_FIELD_LABEL).filter((f) => fields.includes(f)).map((f) => EXISTING_FIELD_LABEL[f]);
    const children = [
      h('p', { class: 'tvx-tr-existing-title', text: 'Existing Traveller Found' }),
      h('p', { class: 'tvx-tr-existing-name', text: m.name || 'Traveller' }),
      lines.length ? h('dl', { class: 'tvx-tr-existing-lines' }, lines.flatMap(([label, value]) => [h('dt', { text: label }), h('dd', { text: value })])) : null,
      matched.length ? h('p', { class: 'tvx-tr-existing-matched', text: `Matched on: ${matched.join(', ')}` }) : null
    ];
    if (m.alreadyOnLead) {
      children.push(h('p', { class: 'tvx-tr-existing-note', role: 'status', text: ALREADY_ADDED_TEXT }));
    } else {
      const button = h('button', {
        type: 'button',
        class: 'tvx-btn tvx-btn-primary',
        disabled: Boolean(e.adding || fs.saving),
        text: e.adding ? 'Adding…' : 'Add Existing Traveller',
        onclick: () => addExistingFromCard(fs)
      });
      children.push(button);
    }
    if (e.error) children.push(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: e.error }));
    return [h('div', { class: 'tvx-tr-existing', role: 'status', 'aria-live': 'polite', 'data-testid': 'existing-traveller' }, children)];
  }

  /**
   * "Add Existing Traveller": links the person to this lead (the copy route: same profile, the stored
   * record and its documents stay as they are; no new traveller is created from the form).
   */
  async function addExistingFromCard(fs) {
    const e = fs && fs.existing;
    if (!e || !e.match || e.adding || formState !== fs) return;
    const m = e.match;
    e.adding = true;
    e.error = '';
    paintExisting();
    try {
      const res = await ctx.api.post(`/leads/${encodeURIComponent(leadId)}/travellers/copy`, { travellerId: m.travellerId });
      const name = m.name || 'Traveller';
      const moved = res && res.workflow && res.workflow.stageChanged ? res.workflow.stage : '';
      ctx.toast(moved ? `${name} added to this lead — the lead is ready and moved to ${moved}` : `${name} added to this lead`, 'success');
      if (typeof ctx.recordChanged === 'function') ctx.recordChanged();
      notifySaved(res && res.traveller && res.traveller.id);
      if (formState === fs) closeForm();
      await loadList();
    } catch (err) {
      e.adding = false;
      if (err && err.status === 409 && (err.code === 'TRAVELLER_ON_LEAD' || /already added|already on this lead/i.test(err.message || ''))) {
        m.alreadyOnLead = true;
      } else {
        e.error = errorText(err);
      }
      if (formState === fs) paintExisting();
    }
  }

  function fieldErrorEl(inputEl, msg) {
    return h('p', { class: 'tvx-tr-field-error', id: `${inputEl.id}-error`, role: 'alert', text: msg });
  }

  function setInvalid(inputEl, msg) {
    if (msg) {
      inputEl.setAttribute('aria-invalid', 'true');
      inputEl.setAttribute('aria-describedby', `${inputEl.id}-error`);
    } else {
      inputEl.removeAttribute('aria-invalid');
      inputEl.removeAttribute('aria-describedby');
    }
  }

  /** Scrolls to and focuses the first field with an error (or the OCR confirmation). */
  function focusFirstError() {
    const target = root.querySelector('[aria-invalid="true"]') || root.querySelector('.tvx-tr-ocr-confirm input');
    if (!target) return;
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  }

  function renderFormView() {
    const isEdit = formState.mode === 'edit';
    const v = formState.values;
    dupInputRefs = {};
    // Add form only: the "Existing Traveller Found" card, below the fields (kept across re-renders).
    existingSlot = isEdit ? null : h('div', { class: 'tvx-tr-existing-slot' }, renderExistingCard());

    const ageInfo = calculateAgeInfo({ dob: v.dob, yearOfBirth: v.yearOfBirth }, referenceDate);

    // Personal details fields
    const firstNameInput = h('input', {
      type: 'text',
      maxlength: 60,
      value: v.firstName,
      oninput: (e) => onFieldInput('firstName', e.target.value)
    });

    const lastNameInput = h('input', {
      type: 'text',
      maxlength: 60,
      value: v.lastName,
      oninput: (e) => onFieldInput('lastName', e.target.value)
    });

    const genderSelect = h(
      'select',
      {
        onchange: (e) => onFieldInput('gender', e.target.value)
      },
      [
        h('option', { value: '', text: 'Select gender…' }),
        h('option', { value: 'Male', text: 'Male', selected: v.gender === 'Male' }),
        h('option', { value: 'Female', text: 'Female', selected: v.gender === 'Female' }),
        h('option', { value: 'Other', text: 'Other', selected: v.gender === 'Other' })
      ]
    );

    const dobInput = h('input', {
      type: 'date',
      max: todayIso(),
      value: v.dob,
      oninput: (e) => {
        onFieldInput('dob', e.target.value);
        // Year of birth is only asked when the full date is not known.
        if (yearFieldRef) yearFieldRef.style.display = e.target.value ? 'none' : '';
      }
    });

    const thisYear = Number(todayIso().slice(0, 4));
    const yearInput = h('input', {
      type: 'number',
      min: Math.max(1900, thisYear - 120),
      max: thisYear,
      step: 1,
      inputmode: 'numeric',
      placeholder: 'e.g. 1990',
      value: v.yearOfBirth === null || v.yearOfBirth === undefined ? '' : String(v.yearOfBirth),
      oninput: (e) => onFieldInput('yearOfBirth', e.target.value === '' ? null : Number(e.target.value))
    });
    yearFieldRef = renderFormField('yearOfBirth', 'Year of birth', yearInput);
    yearFieldRef.append(h('p', { class: 'tvx-help', text: 'When the date of birth is not known. Age is then approximate.' }));
    if (v.dob) yearFieldRef.style.display = 'none';

    ageInputRef = h('input', {
      type: 'text',
      disabled: true,
      value: formatAgeDisplay(ageInfo.age, ageInfo.ageApproximate)
    });

    catInputRef = h('input', {
      type: 'text',
      disabled: true,
      value: ageInfo.ageCategory
    });

    const natInput = choiceSelect('nationality', nationalityOptions, 'Select nationality…', 'Add nationalities in Settings → Travel');
    const relationInput = choiceSelect('relation', relationOptions, 'Select relation…', 'Add relations in Settings → Travel');

    // Contact person: one of the lead's contacts; choosing one fills empty name / phone / email.
    const currentContact = String(formState.values.contactId || '');
    const contactOptions = [h('option', { value: '', text: leadContacts.length ? 'No contact person' : leadContactsNote || 'No contacts on this lead' })];
    for (const c of leadContacts) {
      const label = [c.name, c.phone].filter(Boolean).join(' · ') + (c.isLeadContact ? ' (lead contact)' : '');
      contactOptions.push(h('option', { value: c.id, text: label, selected: c.id === currentContact }));
    }
    if (currentContact && !leadContacts.some((c) => c.id === currentContact)) {
      contactOptions.push(h('option', { value: currentContact, text: 'Current contact (not linked to this lead)', selected: true }));
    }
    const contactInput = h('select', {
      onchange: (e) => {
        const chosen = leadContacts.find((c) => c.id === e.target.value);
        onFieldInput('contactId', e.target.value);
        if (chosen) {
          const v = formState.values;
          if (!v.firstName && !v.lastName) {
            const parts = String(chosen.name || '').trim().split(/\s+/);
            v.firstName = parts[0] || '';
            v.lastName = parts.slice(1).join(' ');
          }
          if (!v.phone && chosen.phone) v.phone = chosen.phone;
          if (!v.email && chosen.email) v.email = chosen.email;
          render();
        }
      }
    }, contactOptions);
    const phoneInput = h('input', {
      type: 'tel',
      maxlength: 20,
      value: formState.values.phone || '',
      placeholder: '+91 98765 43210',
      oninput: (e) => onFieldInput('phone', e.target.value)
    });
    const emailInput = h('input', {
      type: 'email',
      maxlength: 120,
      value: formState.values.email || '',
      placeholder: 'name@example.com',
      oninput: (e) => onFieldInput('email', e.target.value)
    });

    // Passport fields
    const passportNumInput = h('input', {
      type: 'text',
      maxlength: 15,
      value: v.passportNumber,
      oninput: (e) => onFieldInput('passportNumber', e.target.value)
    });

    const passportIssueInput = h('input', {
      type: 'date',
      max: todayIso(),
      value: v.passportIssueDate,
      oninput: (e) => onFieldInput('passportIssueDate', e.target.value)
    });

    const passportExpiryInput = h('input', {
      type: 'date',
      value: v.passportExpiryDate,
      oninput: (e) => onFieldInput('passportExpiryDate', e.target.value)
    });

    const passportCountryInput = h('input', {
      type: 'text',
      maxlength: 60,
      value: v.passportCountry,
      oninput: (e) => onFieldInput('passportCountry', e.target.value)
    });

    // Passport expiry warning element
    const expiryBlock = passportExpiryBlock(v.passportExpiryDate, referenceDate);
    const warning = calculateExpiryWarning(v.passportExpiryDate, referenceDate);
    const warningText = expiryBlock ? `⛔ ${expiryBlock}` : expiryWarningLabel(warning) ? `⚠ ${expiryWarningLabel(warning)}` : '';
    const isDanger = Boolean(expiryBlock) || warning === 'expired';
    expiryWarningRef = h('p', {
      class: isDanger ? 'tvx-tr-danger-icon tvx-help' : 'tvx-tr-warn-icon tvx-help',
      style: warningText ? 'display: block;' : 'display: none;',
      text: warningText
    });

    const passportFieldsGrid = h('div', { class: 'tvx-tr-doc-fields' }, [
      renderFormField('passportNumber', 'Passport number', passportNumInput, { required: passportRequired }),
      renderFormField('passportCountry', 'Issuing country', passportCountryInput, { required: passportRequired }),
      renderFormField('passportIssueDate', 'Issue date', passportIssueInput),
      h('div', { class: 'tvx-field' }, [
        renderFormField('passportExpiryDate', 'Expiry date', passportExpiryInput, { required: passportRequired }),
        expiryWarningRef
      ])
    ]);

    // Aadhaar fields
    const aadhaarNumInput = h('input', {
      type: 'text',
      maxlength: 14,
      value: v.aadhaarNumber,
      placeholder: aadhaarStorage === 'last4' ? '12-digit number' : '12-digit number',
      oninput: (e) => onFieldInput('aadhaarNumber', e.target.value)
    });

    const aadhaarStorageNote =
      aadhaarStorage === 'last4' ? 'Only the last 4 digits are stored.' : 'Stored encrypted.';

    const aadhaarFieldsGrid = h('div', { class: 'tvx-tr-doc-fields' }, [
      h('div', { class: 'tvx-field' }, [
        renderFormField('aadhaarNumber', 'Aadhaar number', aadhaarNumInput),
        h('p', { class: 'tvx-help', text: aadhaarStorageNote })
      ])
    ]);

    // OCR review banner
    let ocrBannerEl = null;
    if (formState.ocrBanner && formState.ocrBanner.visible) {
      const { filledCount, reviewCount, notes } = formState.ocrBanner;
      const bTitle = `Review OCR Details — ${filledCount} field${filledCount === 1 ? '' : 's'} filled, ${reviewCount} need${reviewCount === 1 ? 's' : ''} review. Check highlighted values before saving.`;
      ocrBannerEl = h('div', { class: 'tvx-tr-ocr-banner', role: 'status' }, [
        h('div', { class: 'tvx-tr-ocr-banner-title' }, [h('span', { text: 'ⓘ' }), h('span', { text: bTitle })]),
        notes && notes.length
          ? h(
              'ul',
              { class: 'tvx-tr-ocr-banner-notes' },
              notes.map((n) => h('li', { text: n }))
            )
          : null
      ]);
    }

    // Confirmation checkbox
    let confirmCheckbox = null;
    if (formState.ocrUsed) {
      confirmCheckbox = h('label', { class: 'tvx-check tvx-tr-ocr-confirm' }, [
        h('input', {
          type: 'checkbox',
          checked: formState.ocrConfirmed,
          onchange: (e) => {
            formState.ocrConfirmed = Boolean(e.target && e.target.checked);
            delete formState.fieldErrors.ocrConfirmed;
            render();
          }
        }),
        h('span', { text: 'I have checked the details read by OCR' })
      ]);
    }

    // Footer actions
    const saveDisabled = Boolean(formState.saving || (formState.ocrUsed && !formState.ocrConfirmed));

    return h('div', { class: 'tvx-card tvx-tr-form-card' }, [
      h('div', { class: 'tvx-tr-form-header' }, [
        h('h3', { class: 'tvx-h3', text: isEdit ? 'Edit traveller' : 'Add traveller' }),
        h('button', {
          type: 'button',
          class: 'tvx-btn tvx-btn-ghost',
          disabled: Boolean(formState.saving),
          onclick: () => cancelForm()
        }, ['Cancel'])
      ]),

      formState.formError ? h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: formState.formError }) : null,
      formState.photoUploadError
        ? h('div', { class: 'tvx-msg tvx-msg-warn', role: 'alert' }, [
            h('p', { text: formState.photoUploadError }),
            h('button', {
              type: 'button',
              class: 'tvx-btn tvx-btn-primary',
              style: 'margin-top: 8px;',
              text: 'Retry photo upload',
              onclick: () => handleSaveTraveller()
            })
          ])
        : null,

      ocrBannerEl,

      // Section: Personal details
      h('div', { class: 'tvx-tr-section' }, [
        h('span', { class: 'tvx-eyebrow', text: 'PERSONAL DETAILS' }),
        h('div', { class: 'tvx-grid' }, [
          renderFormField('firstName', 'First name', firstNameInput, { required: true }),
          renderFormField('lastName', 'Last name', lastNameInput),
          renderFormField('gender', 'Gender', genderSelect),
          renderFormField('dob', 'Date of birth', dobInput),
          yearFieldRef,
          renderFormField('age', 'Age (auto)', ageInputRef),
          renderFormField('category', 'Category (auto)', catInputRef),
          renderFormField('nationality', 'Nationality', natInput),
          renderFormField('relation', 'Relation', relationInput, { required: true }),
          renderFormField('phone', 'Phone number', phoneInput, { required: true }),
          renderFormField('email', 'Email', emailInput),
          renderFormField('contactId', 'Contact person', contactInput)
        ]),
        null
      ]),

      // Section: Passport
      h('div', { class: 'tvx-tr-section' }, [
        h('span', { class: 'tvx-eyebrow', text: 'PASSPORT' }),
        passportRequired
          ? h('p', { class: 'tvx-msg tvx-msg-warn', text: `Passport details are required for this lead (${passportRequiredBy.join(', ')}).` })
          : h('p', { class: 'tvx-muted', text: 'Optional for this lead.' }),
        renderDocBlock('passport', 'Passport', passportFieldsGrid)
      ]),

      // Section: Aadhaar
      h('div', { class: 'tvx-tr-section' }, [
        h('span', { class: 'tvx-eyebrow', text: 'AADHAAR' }),
        renderDocBlock('aadhaar', 'Aadhaar Card', aadhaarFieldsGrid)
      ]),

      existingSlot,

      // Footer
      h('div', { class: 'tvx-row tvx-divider-top' }, [
        confirmCheckbox ? h('div', {}, [confirmCheckbox]) : h('div', {}),
        h('div', { class: 'tvx-row-gap' }, [
          h('button', {
            type: 'button',
            class: 'tvx-btn tvx-btn-ghost',
            disabled: Boolean(formState.saving),
            onclick: () => cancelForm()
          }, ['Cancel']),
          h('button', {
            type: 'button',
            class: 'tvx-btn tvx-btn-primary',
            disabled: saveDisabled,
            onclick: () => handleSaveTraveller()
          }, [formState.saving ? 'Saving…' : 'Save traveller'])
        ])
      ])
    ]);
  }

  function renderDocumentOverlay() {
    if (!overlay.open) return null;
    const closeBtn = h('button', {
      type: 'button',
      class: 'tvx-btn tvx-btn-ghost',
      style: 'background: #27272a; color: #fff; border-color: #3f3f46;',
      onclick: () => closeOverlay()
    }, ['✕ Close']);

    setTimeout(() => {
      try {
        closeBtn.focus();
      } catch (err) {}
    }, 0);

    return h(
      'div',
      {
        class: 'tvx-tr-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': overlay.title || 'Document viewer',
        onclick: (e) => {
          if (e.target === e.currentTarget) closeOverlay();
        },
        // Modal: Tab / Shift+Tab stay on the viewer's only control.
        onkeydown: (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            closeBtn.focus();
          }
        }
      },
      [
        h('div', { class: 'tvx-tr-overlay-content' }, [
          h('div', { class: 'tvx-tr-overlay-bar' }, [
            h('span', { text: overlay.title || 'Document Photo' }),
            closeBtn
          ]),
          h('img', {
            class: 'tvx-tr-overlay-img',
            src: overlay.dataUrl,
            alt: overlay.title || 'Document photo'
          })
        ])
      ]
    );
  }

  function render() {
    if (loading) {
      root.replaceChildren(
        h('div', { class: 'tvx-card tvx-empty' }, [
          h('p', { class: 'tvx-loading', text: 'Loading travellers…' })
        ])
      );
      return;
    }

    if (error) {
      root.replaceChildren(
        h('div', { class: 'tvx-card' }, [
          h('div', { class: 'tvx-msg tvx-msg-error', text: error }),
          h('button', {
            type: 'button',
            class: 'tvx-btn tvx-btn-ghost',
            style: 'align-self: flex-start; margin-top: 10px;',
            text: 'Retry',
            onclick: () => loadList()
          })
        ])
      );
      return;
    }

    const mainContent =
      currentView === 'form' ? renderFormView()
        : currentView === 'pick' && pickView ? pickView
          : currentView === 'trips' && tripsState ? renderTripsView()
            : renderListView();
    const overlayContent = renderDocumentOverlay();

    if (overlayContent) {
      root.replaceChildren(mainContent, overlayContent);
    } else {
      root.replaceChildren(mainContent);
    }
  }

  // Initial load. Embedded in the Travellers page, the form can open straight away
  // (ctx.startWith = 'add' | { edit: travellerId }).
  loadList().then(() => {
    if (error || !canEdit) return;
    if (ctx.startWith === 'add') openAddForm();
    else if (ctx.startWith && ctx.startWith.edit) openEditForm(ctx.startWith.edit);
  });
}

export class LeadTravellers extends TravelElement {
  start(ctx) {
    renderLeadTravellers(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-lead-travellers-v1', LeadTravellers);
