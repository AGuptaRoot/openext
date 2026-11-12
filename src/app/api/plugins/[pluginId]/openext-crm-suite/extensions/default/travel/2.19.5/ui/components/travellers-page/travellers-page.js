/**
 * <x-travel-travellers-page-v1>: the Travellers page in the CRM sidebar.
 *
 * - Metrics: travellers, adults / children / infants, document photos, passport status.
 * - List: everyone travelling on the workspace's travel leads, newest first, one row per person
 *   (the same person on several leads shows "N trips"), with search (full name, phone, or last
 *   4 digits of a passport / Aadhaar number) and an age filter. Numbers are masked. "Load more"
 *   pages by cursor.
 * - View: one traveller with lead, contact person, trips and — with edit permission — the
 *   passport / Aadhaar photos (a photo shows the full number; others see "Photo on file").
 * - Add traveller / Import: choose a lead first. Only leads whose Travel Requirement has a
 *   Complete service are offered. Add opens the lead Travellers form right here (same
 *   component as Lead → Travellers); Import reads a CSV (no document numbers).
 * - Export: CSV of the current search (document numbers masked).
 *
 * Backend: GET /travellers, /travellers/summary, /travellers/export, /travellers/:id/detail (with trips),
 *          GET /travellers/:id/documents/:kind, GET /lead-options, POST /leads/:id/travellers/import
 */

import { h, errorText } from '../../shared/dom.js';
import { TravelElement, defineOnce, subscribe } from '../../shared/element.js';
import { useStyles } from '../../shared/styles.js';
import { expiryWarningLabel, formatDisplayDate, formatAgeDisplay } from '../../shared/traveller-age.js';
import { parseCsv, toIsoDate, downloadText } from '../../shared/csv.js';
import { TAG as LEAD_TRAVELLERS } from '../lead-travellers/lead-travellers.js';

useStyles(new URL('../lead-travellers/lead-travellers.css', import.meta.url));
useStyles(new URL('./travellers-page.css', import.meta.url));

const CATEGORIES = ['Adult', 'Child', 'Infant'];
const IMPORT_MAX = 500;

/** CSV header (lower case, no "*") → import field. */
const IMPORT_COLUMNS = {
  'first name': 'firstName',
  'last name': 'lastName',
  phone: 'phone',
  'phone number': 'phone',
  email: 'email',
  relation: 'relation',
  gender: 'gender',
  'date of birth': 'dob',
  dob: 'dob',
  'year of birth': 'yearOfBirth',
  nationality: 'nationality',
  'passport issue date': 'passportIssueDate',
  'passport expiry date': 'passportExpiryDate',
  'passport country': 'passportCountry',
  'issuing country': 'passportCountry'
};
const TEMPLATE_HEADER = 'First name*,Last name,Phone*,Email,Relation*,Gender,Date of birth,Nationality,Passport issue date,Passport expiry date,Passport country';
const TEMPLATE_EXAMPLE = 'Priya,Sharma,+919876543210,priya@example.com,Family member,Female,12/05/1990,Indian,15/03/2019,14/03/2029,IND';

function renderTravellersPage(root, ctx) {

  const state = {
    q: '', category: '', items: [], total: 0, totalApproximate: false, hasMore: false, nextCursor: '', loading: true, loadingMore: false, error: '',
    canEdit: typeof ctx.can === 'function' ? ctx.can('crm.leads.write') : false
  };
  let searchTimer = null;
  let request = 0;
  // Which view is on screen (list / form / detail / import): a slow answer for an older view is dropped.
  let view = 0;

  /* ------------------------------------------------------------ data */

  async function load({ append = false } = {}) {
    const mine = (request += 1);
    if (append) state.loadingMore = true;
    else state.loading = true;
    state.error = '';
    renderResults();
    const params = queryParams();
    if (append && state.nextCursor) params.set('after', state.nextCursor);
    const qs = params.toString();
    try {
      const data = await ctx.api.get(`/travellers${qs ? `?${qs}` : ''}`);
      if (mine !== request) return; // a newer search is on its way
      const rows = Array.isArray(data && data.travellers) ? data.travellers : [];
      state.items = append ? [...state.items, ...rows] : rows;
      state.total = Number(data && data.total) || 0;
      state.totalApproximate = Boolean(data && data.totalApproximate);
      state.hasMore = Boolean(data && data.hasMore);
      state.nextCursor = String((data && data.nextCursor) || '');
      if (data && typeof data.canEdit === 'boolean') state.canEdit = data.canEdit;
    } catch (err) {
      if (mine !== request) return;
      state.error = errorText(err);
    } finally {
      if (mine === request) {
        state.loading = false;
        state.loadingMore = false;
        renderResults();
        renderActions();
      }
    }
  }

  function queryParams() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);
    return params;
  }

  const metricsHost = h('div', { class: 'tvx-tp-metrics', 'aria-live': 'polite' });
  async function loadSummary() {
    try {
      const s = await ctx.api.get('/travellers/summary');
      const tile = (label, value, tone = '') =>
        h('div', { class: `tvx-tp-metric ${tone}` }, [h('span', { class: 'tvx-tp-metric-value', text: String(value ?? 0) }), h('span', { class: 'tvx-tp-metric-label', text: label })]);
      metricsHost.replaceChildren(
        tile('Travellers', s.total),
        tile('Adults', s.adults),
        tile('Children', s.children),
        tile('Infants', s.infants),
        tile('Passport photos', s.withPassportPhoto),
        tile('Aadhaar photos', s.withAadhaarPhoto),
        tile('Passports expired', s.passportsExpired, s.passportsExpired ? 'is-danger' : ''),
        tile('Expiring in 6 months', s.passportsExpiringSoon, s.passportsExpiringSoon ? 'is-warn' : ''),
        ...(s.unknownAge ? [tile('No date of birth', s.unknownAge)] : [])
      );
    } catch {
      metricsHost.replaceChildren();
    }
  }

  const openLead = (leadId) => ctx.navigate(`/leads/${encodeURIComponent(leadId)}`);

  /* ------------------------------------------------------------- cells */

  function categoryPill(category) {
    if (category === 'Infant') return h('span', { class: 'tvx-pill is-done', text: 'Infant' });
    if (category === 'Child') return h('span', { class: 'tvx-pill is-draft', text: 'Child' });
    if (category === 'Adult') return h('span', { class: 'tvx-pill is-none', text: 'Adult' });
    return h('span', { class: 'tvx-muted', text: '—' });
  }

  function passportCell(passport) {
    if (passport && passport.missing) {
      return h('span', { class: 'tvx-pill is-draft', title: 'This lead needs passport details for every traveller', text: 'Passport needed' });
    }
    if (!passport || (!passport.numberMasked && !passport.hasFile)) return h('span', { class: 'tvx-muted', text: '—' });
    const num = [h('span', { class: 'tvx-mono', text: passport.numberMasked || '—' })];
    if (passport.expiryWarning) {
      const label = expiryWarningLabel(passport.expiryWarning);
      num.push(h('span', { class: passport.expiryWarning === 'expired' ? 'tvx-tr-danger-icon' : 'tvx-tr-warn-icon', title: label, role: 'img', 'aria-label': label, text: ' ⚠' }));
    }
    const sub = [];
    if (passport.expiryDate) sub.push(h('span', { class: 'tvx-tr-sub-val', text: `exp ${formatDisplayDate(passport.expiryDate)}` }));
    if (passport.hasFile) sub.push(h('span', { class: 'tvx-tr-file-icon', title: 'Document stored', text: ' 📎' }));
    return h('div', { class: 'tvx-tr-doc-cell' }, [h('div', { class: 'tvx-tr-doc-num' }, num), sub.length ? h('div', { class: 'tvx-row-gap' }, sub) : null]);
  }

  function aadhaarCell(aadhaar) {
    if (!aadhaar || (!aadhaar.numberMasked && !aadhaar.hasFile)) return h('span', { class: 'tvx-muted', text: '—' });
    const num = [h('span', { class: 'tvx-mono', text: aadhaar.numberMasked || '—' })];
    if (aadhaar.hasFile) num.push(h('span', { class: 'tvx-tr-file-icon', title: 'Document stored', text: ' 📎' }));
    return h('div', { class: 'tvx-tr-doc-num' }, num);
  }

  function dobAge(tr) {
    const age = formatAgeDisplay(tr.age, tr.ageApproximate);
    const dob = tr.dob ? formatDisplayDate(tr.dob) : tr.yearOfBirth ? String(tr.yearOfBirth) : '—';
    return h('div', { class: 'tvx-tr-name-cell' }, [h('span', { text: dob }), age ? h('span', { class: 'tvx-tr-sub-val', text: age }) : null]);
  }

  const nameOf = (tr) => tr.fullName || tr.firstName || 'traveller';
  const tripsText = (tr) => (Number(tr.trips) > 1 ? `${tr.trips} trips` : '');

  function rowActions(tr) {
    return h('div', { class: 'tvx-tr-actions' }, [
      h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'View', 'aria-label': `View ${nameOf(tr)}`, onclick: () => showDetail(tr) }),
      state.canEdit
        ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Edit', 'aria-label': `Edit ${nameOf(tr)}`, onclick: () => showForm({ id: tr.leadId, name: tr.leadName }, { edit: tr.id }) })
        : null,
      h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Open lead', 'aria-label': `Open lead ${tr.leadName || ''} for ${nameOf(tr)}`.trim(), onclick: () => openLead(tr.leadId) })
    ]);
  }

  /* -------------------------------------------------------------- list */

  function table() {
    return h('div', { class: 'tvx-tr-table-wrap' }, [
      h('table', { class: 'tvx-tr-table' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { text: 'Name' }),
            h('th', { text: 'Phone' }),
            h('th', { text: 'Lead' }),
            h('th', { text: 'Category' }),
            h('th', { text: 'DOB / Age' }),
            h('th', { text: 'Passport' }),
            h('th', { text: 'Aadhaar' }),
            h('th', { style: 'text-align: right;', text: '' })
          ])
        ]),
        h('tbody', {}, state.items.map((tr) =>
          h('tr', {}, [
            h('td', {}, [h('div', { class: 'tvx-tr-name-cell' }, [
              h('span', { class: 'tvx-tr-name-title', text: tr.fullName || tr.firstName || '—' }),
              tr.relation || tripsText(tr) ? h('span', { class: 'tvx-tr-sub-val', text: [tr.relation, tripsText(tr)].filter(Boolean).join(' · ') }) : null
            ])]),
            h('td', {}, [h('span', { class: 'tvx-mono', text: tr.phone || '—' })]),
            h('td', {}, [h('span', { class: 'tvx-tp-lead', text: tr.leadName || '—' })]),
            h('td', {}, [categoryPill(tr.ageCategory)]),
            h('td', {}, [dobAge(tr)]),
            h('td', {}, [passportCell(tr.passport)]),
            h('td', {}, [aadhaarCell(tr.aadhaar)]),
            h('td', { style: 'text-align: right;' }, [rowActions(tr)])
          ])
        ))
      ])
    ]);
  }

  function cards() {
    return h('div', { class: 'tvx-tr-cards-list' }, state.items.map((tr) =>
      h('div', { class: 'tvx-tr-card-item' }, [
        h('div', { class: 'tvx-tr-card-row' }, [
          h('div', { class: 'tvx-tr-name-cell' }, [
            h('span', { class: 'tvx-tr-name-title', text: tr.fullName || tr.firstName || '—' }),
            h('span', { class: 'tvx-tr-sub-val', text: [tr.relation, tr.leadName, tripsText(tr)].filter(Boolean).join(' · ') })
          ]),
          categoryPill(tr.ageCategory)
        ]),
        h('div', { class: 'tvx-tr-card-grid' }, [
          h('div', { class: 'tvx-tr-card-cell' }, [h('span', { class: 'tvx-tr-card-label', text: 'Phone' }), h('span', { class: 'tvx-mono', text: tr.phone || '—' })]),
          h('div', { class: 'tvx-tr-card-cell' }, [h('span', { class: 'tvx-tr-card-label', text: 'DOB / Age' }), dobAge(tr)]),
          h('div', { class: 'tvx-tr-card-cell' }, [h('span', { class: 'tvx-tr-card-label', text: 'Passport' }), passportCell(tr.passport)]),
          h('div', { class: 'tvx-tr-card-cell' }, [h('span', { class: 'tvx-tr-card-label', text: 'Aadhaar' }), aadhaarCell(tr.aadhaar)])
        ]),
        h('div', { style: 'margin-top: 6px;' }, [rowActions(tr)])
      ])
    ));
  }

  const resultsHost = h('div', { class: 'tvx-tp-results', 'aria-live': 'polite' });

  function renderResults() {
    if (state.loading) {
      resultsHost.replaceChildren(h('p', { class: 'tvx-loading', text: 'Loading travellers…' }));
      return;
    }
    if (state.error) {
      resultsHost.replaceChildren(
        h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: state.error }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Retry', onclick: () => load() })
      );
      return;
    }
    if (!state.items.length) {
      const filtered = Boolean(state.q || state.category);
      resultsHost.replaceChildren(
        h('div', { class: 'tvx-empty' }, [
          h('p', { class: 'tvx-empty-title', text: filtered ? 'No travellers match' : 'No travellers yet' }),
          h('p', {
            class: 'tvx-sub',
            text: filtered ? 'Try another name or phone, or the last 4 digits of a passport or Aadhaar number.' : 'Use Add traveller or Import to add the people travelling on your leads.'
          })
        ])
      );
      return;
    }
    const shown = state.items.length;
    const parts = [
      h('p', {
        class: 'tvx-muted',
        text: shown < state.total
          ? `Showing ${shown} of ${state.totalApproximate ? 'about ' : ''}${state.total}`
          : `${state.total} traveller${state.total === 1 ? '' : 's'}`
      }),
      table(),
      cards()
    ];
    if (state.hasMore) {
      parts.push(h('div', { class: 'tvx-tp-more' }, [
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', disabled: state.loadingMore, text: state.loadingMore ? 'Loading…' : 'Load more', onclick: () => load({ append: true }) })
      ]));
    }
    // replaceChildren would print a null as the text "null", so only real nodes go in.
    resultsHost.replaceChildren(...parts);
  }

  /* ------------------------------------------------------------ export */

  let exporting = false;
  async function exportCsv() {
    if (exporting) return;
    exporting = true;
    renderActions();
    try {
      const qs = queryParams().toString();
      const data = await ctx.api.get(`/travellers/export${qs ? `?${qs}` : ''}`);
      downloadText(data.filename || 'travellers.csv', data.csv || '');
      ctx.toast(`Exported ${data.count} traveller${data.count === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      ctx.toast(`Export failed: ${errorText(err)}`, 'error');
    } finally {
      exporting = false;
      renderActions();
    }
  }

  /* ------------------------------------------------------------ header */

  const actionsHost = h('div', { class: 'tvx-row-gap' });
  function renderActions() {
    const buttons = [
      h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: exporting ? 'Exporting…' : 'Export', disabled: exporting, onclick: () => exportCsv() })
    ];
    if (state.canEdit) {
      buttons.push(
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Import', onclick: () => showPicker('import') }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: '+ Add traveller', onclick: () => showPicker('add') })
      );
    }
    actionsHost.replaceChildren(...buttons);
  }

  const search = h('input', {
    type: 'search',
    id: 'tvx-tp-search',
    class: 'tvx-input',
    placeholder: 'Name, phone, or last 4 digits of a passport / Aadhaar',
    autocomplete: 'off',
    oninput: (e) => {
      clearTimeout(searchTimer);
      const value = e.target.value.trim();
      searchTimer = setTimeout(() => {
        if (value === state.q) return;
        state.q = value;
        load();
      }, 300);
    }
  });

  const categorySelect = h('select', {
    id: 'tvx-tp-category',
    class: 'tvx-input',
    onchange: (e) => {
      state.category = e.target.value;
      load();
    }
  }, [h('option', { value: '', text: 'All ages' }), ...CATEGORIES.map((c) => h('option', { value: c, text: c }))]);

  const listView = h('section', { class: 'tvx-card' }, [
    h('div', { class: 'tvx-card-head' }, [
      h('div', {}, [
        h('h3', { class: 'tvx-h3', text: 'Travellers' }),
        h('p', { class: 'tvx-sub', text: 'Everyone travelling on your travel leads.' })
      ]),
      actionsHost
    ]),
    metricsHost,
    h('div', { class: 'tvx-tp-filters', role: 'search' }, [
      h('div', { class: 'tvx-field tvx-tp-search' }, [h('label', { class: 'tvx-label', for: 'tvx-tp-search', text: 'Search' }), search]),
      h('div', { class: 'tvx-field tvx-tp-category' }, [h('label', { class: 'tvx-label', for: 'tvx-tp-category', text: 'Age category' }), categorySelect])
    ]),
    resultsHost
  ]);

  /* --------------------------------------------- views: list / pick / form */

  function showList({ reload = false } = {}) {
    view += 1;
    root.replaceChildren(listView);
    renderActions();
    if (reload) {
      load();
      loadSummary();
    }
  }

  /** Choose the lead (Add traveller / Import). Only leads with a Complete travel requirement are offered. */
  function showPicker(mode) {
    let timer = null;
    let token = 0;
    const results = h('div', { class: 'tvx-tp-leads', 'aria-live': 'polite' });
    const find = async (q) => {
      const mine = (token += 1);
      results.replaceChildren(h('p', { class: 'tvx-loading', text: 'Searching leads…' }));
      try {
        const data = await ctx.api.get(`/lead-options${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        if (mine !== token) return;
        const leads = Array.isArray(data && data.leads) ? data.leads : [];
        const hidden = Number(data && data.hiddenWithoutRequirement) || 0;
        const note = hidden
          ? h('p', { class: 'tvx-muted', text: `${hidden} lead${hidden === 1 ? ' is' : 's are'} not shown: their Travel Requirement has no Complete service yet.` })
          : null;
        if (!leads.length) {
          results.replaceChildren(...[
            h('p', { class: 'tvx-muted', text: q ? 'No ready lead matches. Try the contact name or company.' : 'No lead is ready yet. Complete a Travel Requirement on the lead first.' }),
            note
          ].filter(Boolean));
          return;
        }
        results.replaceChildren(...[
          ...leads.map((lead) =>
            h('button', { type: 'button', class: 'tvx-tp-lead-option', onclick: () => (mode === 'import' ? showImport(lead) : showForm(lead, 'add')) }, [
              h('span', { class: 'tvx-tp-lead-name', text: lead.name || 'Unnamed lead' }),
              h('span', { class: 'tvx-tp-lead-meta', text: [lead.company, lead.title, lead.stage].filter(Boolean).join(' · ') })
            ])
          ),
          note
        ].filter(Boolean));
      } catch (err) {
        if (mine === token) results.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }));
      }
    };
    const input = h('input', {
      type: 'search',
      id: 'tvx-tp-lead-search',
      class: 'tvx-input',
      placeholder: 'Contact name, company or lead title',
      autocomplete: 'off',
      oninput: (e) => {
        clearTimeout(timer);
        const value = e.target.value.trim();
        timer = setTimeout(() => find(value), 300);
      }
    });
    root.replaceChildren(
      h('section', { class: 'tvx-card' }, [
        h('div', { class: 'tvx-card-head' }, [
          h('div', {}, [
            h('h3', { class: 'tvx-h3', text: mode === 'import' ? 'Import travellers' : 'Add traveller' }),
            h('p', { class: 'tvx-sub', text: `Step 1 of 2 — choose the lead ${mode === 'import' ? 'the travellers belong to' : 'this traveller belongs to'}.` })
          ]),
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Cancel', onclick: () => showList() })
        ]),
        h('div', { class: 'tvx-field' }, [h('label', { class: 'tvx-label', for: 'tvx-tp-lead-search', text: 'Find the lead' }), input]),
        results
      ])
    );
    input.focus();
    find('');
  }

  /** Add (step 2) or Edit: the lead Travellers form, embedded. */
  function showForm(lead, startWith) {
    view += 1;
    const form = document.createElement(LEAD_TRAVELLERS);
    form.className = 'tvx-root';
    form.ctx = {
      ...ctx,
      slot: 'lead.tab.travellers',
      record: { id: lead.id, name: lead.name || '' },
      startWith,
      onDone: () => showList({ reload: true }),
      onValuesChanged: () => () => {},
      onSettingsChanged: () => () => {}
    };
    root.replaceChildren(
      h('div', { class: 'tvx-tp-form-bar' }, [
        h('button', {
          type: 'button',
          class: 'tvx-btn tvx-btn-ghost',
          text: '← All travellers',
          onclick: () => {
            // The embedded form knows whether it has unsaved changes (root.isDirty of lead-travellers).
            if (typeof form.isDirty === 'function' && form.isDirty() && !window.confirm('Discard the changes to this traveller? They are not saved.')) return;
            showList({ reload: true });
          }
        }),
        h('span', { class: 'tvx-muted', text: `Lead: ${lead.name || 'Unnamed lead'}` })
      ]),
      form
    );
  }

  /* -------------------------------------------------------------- detail */

  async function showDetail(tr) {
    const mine = ++view;
    const back = h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: '← All travellers', onclick: () => showList() });
    root.replaceChildren(h('div', { class: 'tvx-tp-form-bar' }, [back]), h('section', { class: 'tvx-card' }, [h('p', { class: 'tvx-loading', text: 'Loading traveller…' })]));
    let data;
    try {
      data = await ctx.api.get(`/travellers/${encodeURIComponent(tr.id)}/detail`);
    } catch (err) {
      if (mine !== view) return; // the user went elsewhere meanwhile
      root.replaceChildren(h('div', { class: 'tvx-tp-form-bar' }, [back]), h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }));
      return;
    }
    if (mine !== view) return; // the user went elsewhere (another traveller, the list) meanwhile
    const t = data.traveller;
    const item = (label, value, mono) =>
      h('div', { class: 'tvx-tp-item' }, [h('span', { class: 'tvx-tr-card-label', text: label }), h('span', { class: mono ? 'tvx-mono' : '', text: value || '—' })]);
    const age = formatAgeDisplay(t.age, t.ageApproximate);
    const expiry = t.passport.expiryWarning ? ` — ${expiryWarningLabel(t.passport.expiryWarning)}` : '';

    // A document photo shows the full number: only users who may edit travellers open it.
    const photo = (kind, title, hasFile) => {
      const frame = h('div', { class: 'tvx-tp-photo-frame' }, [
        h('span', { class: 'tvx-muted', text: !hasFile ? 'No photo stored' : state.canEdit ? 'Loading photo…' : 'Photo on file' })
      ]);
      if (hasFile && state.canEdit) {
        ctx.api.get(`/travellers/${encodeURIComponent(t.id)}/documents/${kind}`)
          .then((doc) => frame.isConnected && frame.replaceChildren(h('img', { src: doc.dataUrl, alt: `${title} of ${t.fullName || t.firstName}`, class: 'tvx-tp-photo-img' })))
          .catch((err) => frame.replaceChildren(h('span', { class: 'tvx-tr-danger-icon', text: errorText(err) })));
      }
      return h('div', { class: 'tvx-tp-photo' }, [h('span', { class: 'tvx-tr-card-label', text: title }), frame]);
    };

    const contact = data.contact;
    root.replaceChildren(
      h('div', { class: 'tvx-tp-form-bar' }, [
        back,
        state.canEdit ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Edit', onclick: () => showForm(data.lead, { edit: t.id }) }) : null,
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Open lead', onclick: () => openLead(data.lead.id) })
      ]),
      h('section', { class: 'tvx-card' }, [
        h('div', { class: 'tvx-card-head' }, [
          h('div', {}, [
            h('h3', { class: 'tvx-h3', text: t.fullName || t.firstName }),
            h('p', { class: 'tvx-sub', text: [t.relation, age].filter(Boolean).join(' · ') })
          ]),
          categoryPill(t.ageCategory)
        ]),
        h('div', { class: 'tvx-tp-detail-grid' }, [
          h('div', { class: 'tvx-tp-block' }, [
            h('span', { class: 'tvx-eyebrow', text: 'PERSONAL DETAILS' }),
            item('Phone', t.phone, true),
            item('Email', t.email),
            item('Gender', t.gender),
            item('Date of birth', t.dob ? formatDisplayDate(t.dob) : t.yearOfBirth ? String(t.yearOfBirth) : ''),
            item('Nationality', t.nationality),
            item('Relation', t.relation)
          ]),
          h('div', { class: 'tvx-tp-block' }, [
            h('span', { class: 'tvx-eyebrow', text: 'LEAD & CONTACT PERSON' }),
            item('Lead', [data.lead.name, data.lead.company].filter(Boolean).join(' — ')),
            item('Lead title', data.lead.title),
            item('Contact person', contact ? contact.name : ''),
            item('Contact phone', contact ? contact.phone : '', true),
            item('Contact email', contact ? contact.email : ''),
            item('Ages worked out on', `${formatDisplayDate(data.referenceDate)} (${data.referenceSource === 'travel_start_date' ? 'travel start date' : 'today'})`)
          ]),
          h('div', { class: 'tvx-tp-block' }, [
            h('span', { class: 'tvx-eyebrow', text: 'PASSPORT & AADHAAR' }),
            data.passportRequired ? h('p', { class: 'tvx-muted', text: `Passport required for this lead (${data.passportRequiredBy.join(', ')})` }) : null,
            t.passport.missing ? h('span', { class: 'tvx-pill is-draft', text: 'Passport needed' }) : null,
            item('Passport number', t.passport.numberMasked, true),
            item('Issuing country', t.passport.country),
            item('Issue date', t.passport.issueDate ? formatDisplayDate(t.passport.issueDate) : ''),
            item('Expiry date', t.passport.expiryDate ? `${formatDisplayDate(t.passport.expiryDate)}${expiry}` : ''),
            item('Aadhaar number', t.aadhaar.numberMasked, true)
          ])
        ]),
        h('div', { class: 'tvx-tp-photos' }, [
          photo('passport', 'Passport photo', t.passport.hasFile),
          photo('aadhaar', 'Aadhaar card photo', t.aadhaar.hasFile)
        ]),
        tripsBlock(Array.isArray(data.trips) ? data.trips : [])
      ])
    );
  }

  /** The person's travel history: every lead / booking of the same profile, newest first. */
  function tripsBlock(trips) {
    const items = trips.map((trip) => {
      const dates = [trip.startDate, trip.endDate].filter(Boolean).map(formatDisplayDate).join(' – ');
      return h('li', { class: 'tvx-tp-trip' }, [
        h('div', { class: 'tvx-tr-name-cell' }, [
          h('span', { class: 'tvx-tr-name-title', text: `${trip.kind === 'booking' ? 'Booking ' : ''}${trip.title || 'Trip'}` }),
          h('span', { class: 'tvx-tr-sub-val', text: [trip.destination, dates].filter(Boolean).join(' · ') || 'No travel dates yet' })
        ]),
        h('div', { class: 'tvx-row-gap' }, [
          trip.status ? h('span', { class: 'tvx-pill is-none', text: trip.status }) : null,
          trip.leadId ? h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Open lead', 'aria-label': `Open lead ${trip.title || ''}`.trim(), onclick: () => openLead(trip.leadId) }) : null
        ])
      ]);
    });
    return h('div', { class: 'tvx-tp-block' }, [
      h('span', { class: 'tvx-eyebrow', text: `TRIPS (${trips.length})` }),
      items.length ? h('ul', { class: 'tvx-tp-trips' }, items) : h('p', { class: 'tvx-muted', text: 'No trips found.' })
    ]);
  }

  /* -------------------------------------------------------------- import */

  function showImport(lead) {
    view += 1;
    let rows = [];
    let importing = false;
    const status = h('div', { class: 'tvx-tp-import-status', 'aria-live': 'polite' });
    const runBtn = h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: 'Import', disabled: true });

    const file = h('input', {
      type: 'file',
      id: 'tvx-tp-import-file',
      accept: '.csv,text/csv',
      class: 'tvx-input',
      onchange: async (e) => {
        // While an import runs the file cannot change (that would re-enable Import for a second run).
        if (importing) return;
        const chosen = e.target.files && e.target.files[0];
        rows = [];
        runBtn.disabled = true;
        if (!chosen) {
          status.replaceChildren();
          return;
        }
        const table = parseCsv(await chosen.text());
        if (table.length < 2) {
          status.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: 'The file has no rows below the header.' }));
          return;
        }
        const header = table[0].map((c) => String(c).replace(/\*/g, '').trim().toLowerCase());
        const map = header.map((c) => IMPORT_COLUMNS[c] || null);
        const has = (field) => map.includes(field);
        const missing = [['firstName', 'First name'], ['phone', 'Phone'], ['relation', 'Relation']].filter(([f]) => !has(f)).map(([, l]) => l);
        if (missing.length) {
          status.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use the template.` }));
          return;
        }
        for (const line of table.slice(1, IMPORT_MAX + 1)) {
          const row = {};
          map.forEach((key, i) => {
            if (!key) return;
            let value = String(line[i] ?? '').trim();
            if (['dob', 'passportIssueDate', 'passportExpiryDate'].includes(key)) value = toIsoDate(value) || value;
            if (key === 'gender') value = { male: 'Male', female: 'Female', other: 'Other', m: 'Male', f: 'Female' }[value.toLowerCase()] || value;
            row[key] = value;
          });
          rows.push(row);
        }
        const notes = [];
        if (table.length - 1 > IMPORT_MAX) notes.push(`Only the first ${IMPORT_MAX} rows are imported at once.`);
        const ignored = header.filter((c, i) => c && !map[i]);
        if (ignored.length) notes.push(`Ignored columns: ${ignored.join(', ')}. Passport and Aadhaar numbers are never imported — add them in the form.`);
        status.replaceChildren(...[
          h('p', { class: 'tvx-msg tvx-msg-success', text: `${rows.length} traveller${rows.length === 1 ? '' : 's'} ready to import into ${lead.name || 'this lead'}.` }),
          ...notes.map((n) => h('p', { class: 'tvx-muted', text: n })),
          h('ul', { class: 'tvx-tp-preview' }, rows.slice(0, 5).map((r) => h('li', { text: [`${r.firstName || '?'} ${r.lastName || ''}`.trim(), r.phone, r.relation].filter(Boolean).join(' · ') }))),
          rows.length > 5 ? h('p', { class: 'tvx-muted', text: `…and ${rows.length - 5} more` }) : null
        ].filter(Boolean));
        if (!importing) runBtn.disabled = false;
      }
    });

    runBtn.addEventListener('click', async () => {
      if (importing || !rows.length) return;
      importing = true;
      file.disabled = true;
      runBtn.disabled = true;
      runBtn.textContent = 'Importing…';
      try {
        const res = await ctx.api.post(`/leads/${encodeURIComponent(lead.id)}/travellers/import`, { rows });
        const parts = [
          h('p', { class: res.errors.length ? 'tvx-msg tvx-msg-warn' : 'tvx-msg tvx-msg-success', text: `${res.created} added · ${res.skipped} already on the lead · ${res.errors.length} with problems.` })
        ];
        if (res.passportMissing) {
          parts.push(h('p', { class: 'tvx-muted', text: `${res.passportMissing} need passport details for this lead (${(res.passportRequiredBy || []).join(', ')}) — open each traveller and add them.` }));
        }
        if (res.errors.length) {
          parts.push(h('ul', { class: 'tvx-tp-preview' }, res.errors.slice(0, 50).map((e) => h('li', { text: `Row ${e.row}: ${e.message}` }))));
        }
        parts.push(h('button', { type: 'button', class: 'tvx-btn tvx-btn-primary', text: 'Done', onclick: () => showList({ reload: true }) }));
        status.replaceChildren(...parts);
        runBtn.remove();
        if (res.created) ctx.toast(`Imported ${res.created} traveller${res.created === 1 ? '' : 's'}`, 'success');
      } catch (err) {
        status.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', role: 'alert', text: errorText(err) }));
        importing = false;
        file.disabled = false;
        runBtn.disabled = false;
        runBtn.textContent = 'Import';
      }
    });

    root.replaceChildren(
      h('section', { class: 'tvx-card' }, [
        h('div', { class: 'tvx-card-head' }, [
          h('div', {}, [
            h('h3', { class: 'tvx-h3', text: 'Import travellers' }),
            h('p', { class: 'tvx-sub', text: `Step 2 of 2 — CSV for ${lead.name || 'the lead'}. Required columns: First name, Phone, Relation. Dates as DD/MM/YYYY or YYYY-MM-DD. Passport and Aadhaar numbers are not imported.` })
          ]),
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Cancel', onclick: () => showList() })
        ]),
        h('div', { class: 'tvx-row-gap' }, [
          h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Download template', onclick: () => downloadText('travellers-template.csv', `${TEMPLATE_HEADER}\r\n${TEMPLATE_EXAMPLE}\r\n`) })
        ]),
        h('div', { class: 'tvx-field' }, [h('label', { class: 'tvx-label', for: 'tvx-tp-import-file', text: 'CSV file' }), file]),
        status,
        h('div', { class: 'tvx-row-gap' }, [runBtn])
      ])
    );
  }

  showList();
  load();
  loadSummary();

  // ?traveller=<id> (e.g. "View Traveller" from a passport alert or a client's Travellers tab) opens that
  // traveller; the server still checks the user may see it.
  const openFromQuery = (query) => {
    const id = String((query && query.traveller) || '');
    if (/^[a-f0-9]{24}$/i.test(id)) showDetail({ id });
  };
  openFromQuery(ctx.query);
  subscribe(root, ctx, 'onQueryChange', openFromQuery);
}

class TravellersPage extends TravelElement {
  start(ctx) {
    renderTravellersPage(this, ctx);
  }
}

export const TAG = defineOnce('x-travel-travellers-page-v1', TravellersPage);
