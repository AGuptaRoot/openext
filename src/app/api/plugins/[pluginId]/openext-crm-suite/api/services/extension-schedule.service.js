'use strict';

/**
 * Scheduled jobs of the active extension (CRM 3.33.0, manifest `schedules`: [{ route, every: "daily" }]).
 * Once a day the CRM calls each declared POST route for every tenant whose active extension declares
 * it, as the system (sdk.user.id 'system', the hook permissions), e.g. Travel's passport expiry alerts.
 * A failing tenant or route never stops the others; nothing is logged about the records involved.
 */

const { resolveTenantId } = require('../utils/tenant.util');

async function tenantIds(cms) {
  const ids = new Set(['default']);
  const Setting = cms && cms.models && typeof cms.models.get === 'function' ? cms.models.get('Setting') : null;
  try {
    if (Setting && typeof Setting.distinct === 'function') {
      for (const id of (await Setting.distinct('tenantId', { isDeleted: false })) || []) if (id) ids.add(String(id));
    }
  } catch {
    /* the default tenant only */
  }
  return [...ids];
}

/** Runs the declared schedules of one tenant: { ran, failed }. */
async function runForTenant(cms, tenantId, every = 'daily') {
  const req = { cms, tenantId, headers: {}, method: 'POST' };
  const CrmExtensionService = require('./crm-extension.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  const schedules = def && def.isInternal === false && Array.isArray(def.schedules) ? def.schedules.filter((s) => s.every === every) : [];
  let ran = 0;
  let failed = 0;
  const { callActiveRoute } = require('../extension-runtime/runtime');
  for (const s of schedules) {
    try {
      await callActiveRoute(req, 'POST', s.route, { schedule: every, tenantId: resolveTenantId(req) }, { system: true });
      ran += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[plugin:openext-crm-suite] extension schedule ${s.route} failed (status ${Number(error && error.status) || 500})`);
    }
  }
  return { ran, failed };
}

async function runAll(cms, every = 'daily') {
  let ran = 0;
  let failed = 0;
  for (const tenantId of await tenantIds(cms)) {
    try {
      const r = await runForTenant(cms, tenantId, every);
      ran += r.ran;
      failed += r.failed;
    } catch {
      failed += 1;
    }
  }
  return { ran, failed };
}

module.exports = { runAll, runForTenant, tenantIds };
