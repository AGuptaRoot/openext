'use strict';

/**
 * Travel locations offered in the From and To fields of a travel lead (Settings → Travel).
 *
 * The lead fields read their options from the settings lists `from_places` / `to_places` (plain names).
 * Every location also has a TravelLocation row with a stable `location_id` (generated once, never
 * changed), its `available_for` (from | to | both) and `enabled`.
 *
 * CSV import (the browser parses the file and sends rows; nothing is stored as a file):
 *  - every row is checked here (the browser check is only a preview);
 *  - names are compared without case and extra spaces: the first row of a name wins, later ones are skipped;
 *  - a known name is updated (available for / enabled), or skipped when nothing changes;
 *  - names already in the lists that have no row yet get one (backfill), so every location has an id;
 *  - the lists only grow: enabled locations are appended where they are available; nothing is ever
 *    removed or reordered, because leads that already use a name must stay valid. A disabled or
 *    narrowed location that is still in a list stays there, with a warning on its row.
 */

const MAX_NAME = 120;
const MAX_ROWS = 2000;
const MAX_LIST = 500; // the CRM's limit for a list setting
const CHUNK = 500; // $in limit
const AVAILABLE = ['from', 'to', 'both'];
const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);
const STILL_OFFERED = 'remove it from the list by hand if no lead uses it';

const str = (v) => (v === null || v === undefined ? '' : String(v));
const cleanName = (v) => str(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const keyOf = (v) => cleanName(v).toLowerCase();
const offersFrom = (a) => a === 'from' || a === 'both';
const offersTo = (a) => a === 'to' || a === 'both';

/** A new stable id: loc_<time><random>, e.g. loc_mh3k2x9a7f4q1z0c. */
function newLocationId() {
  let rand = '';
  while (rand.length < 10) rand += Math.random().toString(36).slice(2);
  return `loc_${Date.now().toString(36)}${rand.slice(0, 10)}`;
}

/** 'yes' / 'No' / 1 / true / '' → boolean (empty means enabled); null when not understood. */
function parseEnabled(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const text = str(value).trim().toLowerCase();
  if (!text) return true;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

/** One input row → { values: { name, name_key, available_for, enabled } } or { errors: [...] }. */
function checkRow(raw) {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const name = cleanName(row.name);
  if (!name) errors.push('Name is required');
  else if (name.length > MAX_NAME) errors.push(`Name is longer than ${MAX_NAME} characters`);
  const availRaw = row.available_for !== undefined ? row.available_for : row.availableFor;
  const available = str(availRaw).trim().toLowerCase();
  if (!available) errors.push('Available For is required (from, to or both)');
  else if (!AVAILABLE.includes(available)) errors.push('Available For must be from, to or both');
  const enabled = parseEnabled(row.enabled);
  if (enabled === null) errors.push('Enabled must be yes or no (true / false, 1 / 0)');
  if (errors.length) return { errors };
  return { values: { name, name_key: name.toLowerCase(), available_for: available, enabled } };
}

/** The CSV line to show for a row: the browser's `line`, else its position after the header. */
function lineOf(raw, index) {
  const n = raw && typeof raw === 'object' ? Number(raw.line) : NaN;
  return Number.isInteger(n) && n > 0 && n < 1e7 ? n : index + 2;
}

const listOf = (value) => (Array.isArray(value) ? value.map((v) => str(v).trim()).filter(Boolean) : []);

/** Existing TravelLocation rows by name_key, for these keys. */
async function findByKeys(sdk, keys) {
  const out = new Map();
  const list = [...new Set(keys)];
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = await sdk.models.TravelLocation.find({ name_key: { $in: part } }, { limit: CHUNK });
    for (const row of rows) out.set(str(row.name_key), row);
  }
  return out;
}

/** Every stored location (up to `max`), oldest first. */
async function listAll(sdk, max = 5000) {
  const out = [];
  for (let skip = 0; skip < max; skip += CHUNK) {
    const rows = await sdk.models.TravelLocation.find({}, { limit: CHUNK, skip, sort: { createdAt: 1 } });
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

const view = (row) => ({
  location_id: str(row.location_id),
  name: str(row.name),
  available_for: str(row.available_for),
  enabled: row.enabled !== false,
  source: str(row.source)
});

/**
 * Plans (and unless dryRun, applies) an import.
 * @returns {{ dryRun, totals, rows, from_places, to_places, backfilled, listsChanged }}
 */
async function importLocations(sdk, input, { dryRun = false } = {}) {
  if (!Array.isArray(input) || !input.length) throw sdk.error(400, 'rows must be a non-empty list', 'INVALID_IMPORT');
  if (input.length > MAX_ROWS) throw sdk.error(400, `At most ${MAX_ROWS} locations can be imported at once`, 'INVALID_IMPORT');

  const [fromSetting, toSetting] = await Promise.all([sdk.settings.get('from_places'), sdk.settings.get('to_places')]);
  const fromList = listOf(fromSetting);
  const toList = listOf(toSetting);
  const fromKeys = new Set(fromList.map(keyOf));
  const toKeys = new Set(toList.map(keyOf));

  // 1. Check every row; the first row of a name wins.
  const results = [];
  const accepted = [];
  const seen = new Map(); // name_key → line of the first row
  input.forEach((raw, i) => {
    const line = lineOf(raw, i);
    const { values, errors } = checkRow(raw);
    if (errors) {
      results.push({ line, name: cleanName(raw && raw.name).slice(0, MAX_NAME), status: 'failed', reason: errors.join('. ') });
      return;
    }
    if (seen.has(values.name_key)) {
      results.push({ line, name: values.name, status: 'skipped', reason: `Duplicate in file (same name as line ${seen.get(values.name_key)})` });
      return;
    }
    seen.set(values.name_key, line);
    const result = { line, name: values.name, status: '', reason: '' };
    results.push(result);
    accepted.push({ values, result });
  });

  // 2. Stored locations of these names and of the names already in the lists.
  const listNames = new Map();
  for (const name of [...fromList, ...toList]) if (!listNames.has(keyOf(name))) listNames.set(keyOf(name), cleanName(name));
  const existing = await findByKeys(sdk, [...seen.keys(), ...listNames.keys()]);

  // 3. Backfill: list names without a row get one (as the lists offer them today).
  const now = new Date().toISOString();
  const backfill = new Map(); // name_key → row to create
  for (const [key, name] of listNames) {
    if (existing.has(key) || !name || name.length > MAX_NAME) continue;
    const available = fromKeys.has(key) && toKeys.has(key) ? 'both' : fromKeys.has(key) ? 'from' : 'to';
    const row = { location_id: newLocationId(), name, name_key: key, available_for: available, enabled: true, source: 'settings' };
    backfill.set(key, row);
    existing.set(key, row);
  }

  // 4. Each accepted row: create, update or no change.
  const writes = [];
  for (const { values, result } of accepted) {
    const before = existing.get(values.name_key);
    if (!before) {
      const row = { location_id: newLocationId(), name: values.name, name_key: values.name_key, available_for: values.available_for, enabled: values.enabled, source: 'csv', last_import_at: now };
      existing.set(values.name_key, row);
      writes.push({ kind: 'create', row, result });
      result.status = 'created';
      result.reason = values.enabled ? 'New location' : 'New location (disabled: stored, not offered)';
      result.location_id = dryRun ? '' : row.location_id;
      continue;
    }
    const pending = backfill.has(values.name_key); // in a list, its row is created by this import
    result.location_id = dryRun && pending ? '' : str(before.location_id);
    result.name = str(before.name); // the stored spelling stays (lists and leads use it)
    if (str(before.available_for) === values.available_for && (before.enabled !== false) === values.enabled) {
      result.status = 'skipped';
      result.reason = 'No change';
      continue;
    }
    result.status = 'updated';
    result.reason = pending ? 'Already offered; availability or enabled changed' : 'Availability or enabled changed';
    before.available_for = values.available_for;
    before.enabled = values.enabled;
    before.last_import_at = now;
    if (!pending) writes.push({ kind: 'update', row: before, result, patch: { available_for: values.available_for, enabled: values.enabled, last_import_at: now } });
  }

  // 5. The lists only grow: enabled locations are appended where they are available.
  const nextFrom = [...fromList];
  const nextTo = [...toList];
  for (const { values, result } of accepted) {
    const loc = existing.get(values.name_key);
    const name = str(loc.name);
    const warnings = [];
    const place = (list, keys, offered, label) => {
      const listed = keys.has(values.name_key);
      if (listed && (!offered || !values.enabled)) warnings.push(`Still offered in ${label}: ${STILL_OFFERED}`);
      if (listed || !offered || !values.enabled) return;
      if (list.length >= MAX_LIST) {
        warnings.push(`Not added to ${label}: the list already has ${MAX_LIST} names`);
        return;
      }
      list.push(name);
      keys.add(values.name_key);
      result.added = [...(result.added || []), label === 'From Locations' ? 'from' : 'to'];
    };
    place(nextFrom, fromKeys, offersFrom(values.available_for), 'From Locations');
    place(nextTo, toKeys, offersTo(values.available_for), 'To Locations');
    if (warnings.length) result.warning = warnings.join(' · ');
  }
  const fromChanged = nextFrom.length !== fromList.length;
  const toChanged = nextTo.length !== toList.length;

  // 6. Apply.
  let backfilled = 0;
  if (!dryRun) {
    const failedKeys = new Set();
    const createRow = async (row) => {
      try {
        await sdk.models.TravelLocation.create(row);
        return { created: true };
      } catch (error) {
        // Added at the same time by another import: keep that row (and its id).
        const again = await sdk.models.TravelLocation.findOne({ name_key: row.name_key }).catch(() => null);
        if (!again) throw error;
        return { created: false, again };
      }
    };
    for (const row of backfill.values()) {
      try {
        const out = await createRow(row);
        if (out.created) backfilled += 1;
        else {
          row.location_id = str(out.again.location_id);
          await sdk.models.TravelLocation.updateById(out.again._id, { available_for: row.available_for, enabled: row.enabled });
        }
      } catch (error) {
        failedKeys.add(row.name_key);
        if (sdk.logger) sdk.logger.warn(`travel location not saved: ${str(error && error.message)}`);
      }
    }
    for (const write of writes) {
      try {
        if (write.kind === 'create') {
          const out = await createRow(write.row);
          if (!out.created) {
            await sdk.models.TravelLocation.updateById(out.again._id, { available_for: write.row.available_for, enabled: write.row.enabled, last_import_at: now });
            write.result.status = 'updated';
            write.result.reason = 'Added at the same time by someone else; updated';
            write.result.location_id = str(out.again.location_id);
          }
        } else {
          await sdk.models.TravelLocation.updateById(write.row._id, write.patch);
        }
      } catch (error) {
        failedKeys.add(write.row.name_key);
        if (sdk.logger) sdk.logger.warn(`travel location not saved: ${str(error && error.message)}`);
      }
    }
    for (const { values, result } of accepted) {
      if (!failedKeys.has(values.name_key)) continue;
      result.status = 'failed';
      result.reason = 'Could not be saved; try again';
      result.location_id = '';
    }
    // Names that could not be saved are not offered; names already in the lists always stay.
    const keep = (list, base) => list.filter((n, i) => i < base.length || !failedKeys.has(keyOf(n)));
    const fromOut = keep(nextFrom, fromList);
    const toOut = keep(nextTo, toList);
    nextFrom.splice(0, nextFrom.length, ...fromOut);
    nextTo.splice(0, nextTo.length, ...toOut);
    // Separate writes keep each patch well under the CRM's settings size limit.
    if (nextFrom.length !== fromList.length) await sdk.settings.set({ from_places: nextFrom });
    if (nextTo.length !== toList.length) await sdk.settings.set({ to_places: nextTo });
  }

  for (const r of results) if (r.status === 'failed') delete r.added;
  const totals = { total: results.length, imported: 0, updated: 0, skipped: 0, failed: 0, warnings: 0 };
  for (const r of results) {
    if (r.status === 'created') totals.imported += 1;
    else if (r.status === 'updated') totals.updated += 1;
    else if (r.status === 'skipped') totals.skipped += 1;
    else totals.failed += 1;
    if (r.warning) totals.warnings += 1;
  }
  return {
    dryRun: Boolean(dryRun),
    totals,
    rows: results,
    from_places: nextFrom,
    to_places: nextTo,
    backfilled: dryRun ? backfill.size : backfilled,
    listsChanged: dryRun ? fromChanged || toChanged : nextFrom.length !== fromList.length || nextTo.length !== toList.length
  };
}

module.exports = { importLocations, checkRow, parseEnabled, listAll, view, newLocationId, keyOf, MAX_ROWS, MAX_NAME };
