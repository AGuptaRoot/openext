'use strict';

/**
 * Requirement status rechecked on read (E11).
 *
 * A requirement's Draft / Complete is worked out when it is saved, but the service's form can change
 * afterwards in Services & Forms (a field made required, a field added). Whenever requirements are
 * read for the tab, readiness or the quotation prefill, their status is worked out again against the
 * current form; a different status is changed in place (so the caller uses it at once) and stored,
 * audited as a system change. A switched-off or removed service keeps its saved status.
 * A failed write never fails the read.
 */

const { activeService } = require('./catalog.js');
const { statusOf } = require('./requirement-form.js');

const str = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * @param {object} sdk
 * @param {object[]} rows      TravelRequirement rows (changed in place)
 * @param {object[]} services  readServices(sdk)
 * @returns {Promise<object[]>} the rows whose status changed
 */
async function refreshStatuses(sdk, rows, services) {
  const changed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.removed === true) continue;
    const service = activeService(services || [], str(row.service_key));
    if (!service) continue;
    const before = str(row.status) || 'Draft';
    const after = statusOf(service, row.values && typeof row.values === 'object' ? row.values : {});
    if (after === before) continue;
    row.status = after;
    changed.push(row);
    const model = sdk.models && sdk.models.TravelRequirement;
    if (!model || typeof model.updateById !== 'function' || !row._id) continue;
    try {
      await model.updateById(row._id, { status: after });
      await sdk.audit('updated', `Travel requirement "${service.name}" of lead ${str(row.lead_id)} is now ${after} (its form changed in Services & Forms)`, {
        leadId: str(row.lead_id),
        requirementId: str(row._id),
        serviceKey: str(row.service_key),
        from: before,
        to: after,
        system: true
      });
    } catch (error) {
      if (sdk.logger) sdk.logger.warn('requirement status recheck: save failed:', error && error.message);
    }
  }
  return changed;
}

module.exports = { refreshStatuses };
