'use strict';

/**
 * Travel locations of the From / To fields (Settings → Travel, admins only).
 *
 *   GET  /locations                                   stored locations (stable ids) and the From / To lists
 *   POST /locations/import { rows: [{ name, available_for, enabled, line? }], dryRun? }
 *        check every row and report what would happen (dryRun), or import: create / update locations
 *        and append enabled ones to from_places / to_places (never removes a list entry). Audited.
 */

const locations = require('../services/travel-locations.js');

const list = (value) => (Array.isArray(value) ? value : []);

exports.list = async (req, sdk) => {
  const [rows, fromPlaces, toPlaces] = await Promise.all([
    locations.listAll(sdk),
    sdk.settings.get('from_places'),
    sdk.settings.get('to_places')
  ]);
  return { locations: rows.map(locations.view), total: rows.length, from_places: list(fromPlaces), to_places: list(toPlaces) };
};

exports.importRows = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const dryRun = body.dryRun === true;
  const result = await locations.importLocations(sdk, body.rows, { dryRun });
  if (!dryRun) {
    const t = result.totals;
    // Counts only: no location names in the audit trail.
    await sdk.audit(
      t.imported || result.backfilled ? 'created' : 'updated',
      `Travel locations imported from CSV: ${t.imported} added, ${t.updated} updated, ${t.skipped} skipped, ${t.failed} failed${result.backfilled ? `, ${result.backfilled} existing list names given a location id` : ''}`,
      { imported: t.imported, updated: t.updated, skipped: t.skipped, failed: t.failed, backfilled: result.backfilled, listsChanged: result.listsChanged }
    );
  }
  return result;
};
