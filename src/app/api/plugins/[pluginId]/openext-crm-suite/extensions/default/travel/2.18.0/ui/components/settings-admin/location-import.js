/**
 * Settings → Travel: "Import From / To locations (CSV)" card (inside <x-travel-settings-admin-v1>).
 *
 * The CSV is read and parsed in the browser and sent as JSON rows; no file is uploaded or stored.
 * Columns (header names without case): Name, Available For (from | to | both), Enabled (yes / no).
 * Choosing a file shows a preview with each row's check, then asks the server for a dry run (the
 * server checks everything again), then "Import N locations" imports. The From / To lists only grow:
 * after the import the lists the server returned are saved with ctx.saveSettings so the settings form
 * above shows them (the same values; nothing is removed).
 *
 * Backend: POST /locations/import { rows, dryRun }, GET /locations (download current locations)
 */

import { h, errorText } from '../../shared/dom.js';
import { parseCsv, downloadText } from '../../shared/csv.js';

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_NAME = 120;
const PREVIEW_ROWS = 20;
const LIST_PROBLEMS = 50;
const TEMPLATE = 'Name,Available For,Enabled\r\nMumbai,both,yes\r\nSurat,from,yes\r\nGoa,to,no\r\n';
const COLUMNS = { name: 'name', 'available for': 'available_for', availability: 'available_for', enabled: 'enabled', active: 'enabled' };
const TRUE_WORDS = ['true', 'yes', 'y', '1'];
const FALSE_WORDS = ['false', 'no', 'n', '0'];
const STATUS_TEXT = { created: 'New', updated: 'Update', skipped: 'Skip', failed: 'Error' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const headerKey = (c) => String(c || '').replace(/\*/g, '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim();

/** The browser's check of one row (the server checks again). */
function checkRow(row) {
  const errors = [];
  if (!row.name) errors.push('Name is required');
  else if (row.name.length > MAX_NAME) errors.push(`Name is longer than ${MAX_NAME} characters`);
  const a = row.available_for.toLowerCase();
  if (!a) errors.push('Available For is required');
  else if (!['from', 'to', 'both'].includes(a)) errors.push('Available For must be from, to or both');
  const e = row.enabled.toLowerCase();
  if (e && !TRUE_WORDS.includes(e) && !FALSE_WORDS.includes(e)) errors.push('Enabled must be yes or no');
  return errors;
}

/** CSV text → { rows, error }. */
export function readLocationsCsv(text) {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], error: 'The file has no rows below the header.' };
  const map = table[0].map((c) => COLUMNS[headerKey(c)] || null);
  const missing = [['name', 'Name'], ['available_for', 'Available For'], ['enabled', 'Enabled']].filter(([k]) => !map.includes(k)).map(([, l]) => l);
  if (missing.length) return { rows: [], error: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use the template.` };
  if (table.length - 1 > MAX_ROWS) return { rows: [], error: `At most ${MAX_ROWS} locations can be imported at once; split the file.` };
  const rows = table.slice(1).map((cells, i) => {
    const row = { line: i + 2, name: '', available_for: '', enabled: '' };
    const taken = new Set(); // the first column of a kind wins
    map.forEach((key, c) => {
      if (!key || taken.has(key)) return;
      taken.add(key);
      row[key] = key === 'name' ? cleanName(cells[c]) : String(cells[c] ?? '').trim();
    });
    return { ...row, errors: checkRow(row) };
  });
  return { rows, error: '' };
}

const toCsvCell = (v) => {
  let text = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // never a formula in a spreadsheet
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function locationImportCard(ctx) {
  const card = h('section', { class: 'tvx-card tvx-sa tvx-li' });
  const toast = (msg, kind) => {
    if (typeof ctx.toast === 'function') ctx.toast(msg, kind);
  };
  const state = { fileName: '', rows: [], preview: null, checking: false, importing: false, result: null };
  let fileInput = null;

  function reset() {
    state.fileName = '';
    state.rows = [];
    state.preview = null;
    if (fileInput) fileInput.value = '';
  }

  async function dryRun() {
    const valid = state.rows.filter((r) => !r.errors.length);
    state.preview = null;
    if (!valid.length) return render();
    state.checking = true;
    render();
    try {
      state.preview = await ctx.api.post('/locations/import', { rows: state.rows.map(({ line, name, available_for, enabled }) => ({ line, name, available_for, enabled })), dryRun: true });
    } catch (err) {
      toast(`Could not check the file: ${errorText(err)}`, 'error');
    } finally {
      state.checking = false;
      render();
    }
  }

  async function onFile(e) {
    if (state.importing) return;
    const chosen = e.target.files && e.target.files[0];
    state.result = null;
    if (!chosen) {
      reset();
      return render();
    }
    if (!/\.csv$/i.test(chosen.name || '') && !/csv/.test(chosen.type || '')) {
      reset();
      toast('Choose a .csv file', 'error');
      return render();
    }
    if (chosen.size > MAX_BYTES) {
      reset();
      toast('The file is larger than 1 MB; split it into smaller files', 'error');
      return render();
    }
    const { rows, error } = readLocationsCsv(await chosen.text());
    if (error) {
      reset();
      toast(error, 'error');
      return render();
    }
    state.fileName = chosen.name || 'locations.csv';
    state.rows = rows;
    await dryRun();
  }

  async function runImport() {
    const p = state.preview;
    if (!p || state.importing) return;
    state.importing = true;
    render();
    try {
      const rows = state.rows.map(({ line, name, available_for, enabled }) => ({ line, name, available_for, enabled }));
      const res = await ctx.api.post('/locations/import', { rows, dryRun: false });
      state.result = res;
      reset();
      if (res.listsChanged && typeof ctx.saveSettings === 'function') {
        // The same lists the server saved (only appended): refreshes the settings form above.
        try {
          await ctx.saveSettings({ from_places: res.from_places, to_places: res.to_places });
        } catch (err) {
          toast(`Imported, but the settings form did not refresh: ${errorText(err)}. Reload the page.`, 'warning');
        }
      }
      const t = res.totals || {};
      const text = `Locations: ${t.imported || 0} imported, ${t.updated || 0} updated, ${t.skipped || 0} skipped, ${t.failed || 0} failed`;
      toast(text, t.failed ? 'warning' : 'success');
    } catch (err) {
      toast(`Import failed: ${errorText(err)}`, 'error');
    } finally {
      state.importing = false;
      render();
    }
  }

  async function downloadCurrent() {
    try {
      const res = await ctx.api.get('/locations');
      const lines = ['Name,Available For,Enabled,Location ID'];
      for (const l of res.locations || []) lines.push([l.name, l.available_for, l.enabled ? 'yes' : 'no', l.location_id].map(toCsvCell).join(','));
      downloadText('travel-locations.csv', `${lines.join('\r\n')}\r\n`);
    } catch (err) {
      toast(`Could not download the locations: ${errorText(err)}`, 'error');
    }
  }

  function counts(t) {
    const box = (label, n, tone) => h('div', { class: `tvx-li-count${tone ? ` tvx-li-${tone}` : ''}` }, [h('strong', { text: String(n || 0) }), h('span', { text: label })]);
    return h('div', { class: 'tvx-li-counts', role: 'status' }, [
      box('imported', t.imported, 'ok'),
      box('updated', t.updated, 'info'),
      box('skipped', t.skipped, ''),
      box('failed', t.failed, t.failed ? 'bad' : '')
    ]);
  }

  function previewTable() {
    const server = new Map(((state.preview && state.preview.rows) || []).map((r) => [r.line, r]));
    const shown = state.rows.slice(0, PREVIEW_ROWS);
    const check = (row) => {
      if (row.errors.length) return h('span', { class: 'tvx-li-bad', text: row.errors.join('. ') });
      const s = server.get(row.line);
      if (!s) return h('span', { class: 'tvx-muted', text: state.checking ? 'Checking…' : 'OK' });
      const tone = s.status === 'failed' ? 'bad' : s.status === 'skipped' ? 'muted' : 'ok';
      return h('span', { class: `tvx-li-${tone}` }, [`${STATUS_TEXT[s.status] || s.status}: ${s.reason}`, s.warning ? h('span', { class: 'tvx-li-warn', text: ` (${s.warning})` }) : null]);
    };
    return h('div', { class: 'tvx-li-scroll' }, [
      h('table', { class: 'tvx-li-table' }, [
        h('thead', {}, h('tr', {}, ['Line', 'Name', 'Available For', 'Enabled', 'Check'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, shown.map((r) => h('tr', { class: r.errors.length ? 'tvx-li-row-bad' : '' }, [
          h('td', { text: String(r.line) }),
          h('td', { text: r.name }),
          h('td', { text: r.available_for }),
          h('td', { text: r.enabled || '(yes)' }),
          h('td', {}, check(r))
        ])))
      ])
    ]);
  }

  function problems(rows) {
    const list = (rows || []).filter((r) => r.status === 'failed' || r.status === 'skipped' || r.warning);
    if (!list.length) return null;
    return h('div', {}, [
      h('p', { class: 'tvx-label', text: 'Skipped, failed and warnings' }),
      h('ul', { class: 'tvx-li-problems' }, list.slice(0, LIST_PROBLEMS).map((r) => h('li', {
        text: `Line ${r.line}${r.name ? ` (${r.name})` : ''}: ${r.status === 'failed' || r.status === 'skipped' ? `${r.status}: ${r.reason}` : r.reason}${r.warning ? ` · ${r.warning}` : ''}`
      }))),
      list.length > LIST_PROBLEMS ? h('p', { class: 'tvx-muted', text: `…and ${list.length - LIST_PROBLEMS} more` }) : null
    ]);
  }

  function render() {
    const p = state.preview;
    const t = (p && p.totals) || {};
    const changes = (t.imported || 0) + (t.updated || 0);
    const localBad = state.rows.filter((r) => r.errors.length).length;
    fileInput = h('input', { type: 'file', id: 'tvx-li-file', class: 'tvx-input', accept: '.csv,text/csv', disabled: state.importing, onchange: onFile });
    const parts = [
      h('div', {}, [
        h('h3', { class: 'tvx-h3', text: 'Import From / To locations (CSV)' }),
        h('p', {
          class: 'tvx-sub',
          text: 'Add or update many locations at once. Columns: Name, Available For (from, to or both), Enabled (yes / no; empty means yes). Existing names are updated, never duplicated; names already in the From / To lists are never removed, so older leads stay valid.'
        })
      ]),
      h('div', { class: 'tvx-row-gap' }, [
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Download template', onclick: () => downloadText('travel-locations-template.csv', TEMPLATE) }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Download current locations', onclick: downloadCurrent })
      ]),
      h('div', { class: 'tvx-field' }, [h('label', { class: 'tvx-label', for: 'tvx-li-file', text: 'CSV file (up to 1 MB)' }), fileInput])
    ];
    if (state.rows.length) {
      parts.push(h('p', {
        class: 'tvx-muted',
        text: `${state.fileName}: ${plural(state.rows.length, 'row', 'rows')}${localBad ? `, ${localBad} with errors` : ''}.${state.rows.length > PREVIEW_ROWS ? ` Showing the first ${PREVIEW_ROWS}.` : ''}`
      }));
      parts.push(previewTable());
      if (p) {
        parts.push(h('p', { class: 'tvx-label', text: 'If you import this file' }));
        parts.push(counts(t));
        if (p.backfilled) parts.push(h('p', { class: 'tvx-muted', text: `${plural(p.backfilled, 'name', 'names')} already in the lists will also get a location id.` }));
      }
      parts.push(h('div', { class: 'tvx-row-gap' }, [
        h('button', {
          type: 'button',
          class: 'tvx-btn tvx-btn-primary',
          disabled: !p || state.checking || state.importing || !changes,
          text: state.importing ? 'Importing…' : changes ? `Import ${plural(changes, 'location', 'locations')}` : 'Nothing to import',
          onclick: runImport
        }),
        h('button', { type: 'button', class: 'tvx-btn tvx-btn-ghost', text: 'Clear', disabled: state.importing, onclick: () => { reset(); render(); } })
      ]));
    }
    const r = state.result;
    if (r) {
      parts.push(h('p', { class: 'tvx-label', text: 'Last import' }));
      parts.push(counts(r.totals || {}));
      const problemList = problems(r.rows);
      if (problemList) parts.push(problemList);
    }
    card.replaceChildren(...parts);
  }

  render();
  return card;
}
