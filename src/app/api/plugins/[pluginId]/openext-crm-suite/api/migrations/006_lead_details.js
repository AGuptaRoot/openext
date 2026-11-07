'use strict';

const LEAD_EVENTS = 'plugin_openext_crm_suite_lead_events';
const FOLLOW_UPS = 'plugin_openext_crm_suite_follow_ups';

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) await db.createCollection(name);
  return db.collection(name);
}

module.exports = {
  name: '006_lead_details',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const db = connection.db;

    const leadEvents = await ensureCollection(db, LEAD_EVENTS);
    await leadEvents.createIndex(
      { tenantId: 1, leadId: 1, eventDate: -1 },
      { name: 'lead_events_tenant_lead_date' }
    );

    const followUps = await ensureCollection(db, FOLLOW_UPS);
    await followUps.createIndex(
      { tenantId: 1, leadId: 1, dueDate: 1 },
      { name: 'follow_ups_tenant_lead_due' }
    );

    const estimates = db.collection('plugin_openext_crm_suite_estimates');
    try {
      await estimates.createIndex({ tenantId: 1, leadId: 1 }, { name: 'estimates_tenant_lead' });
    } catch {
      /* collection may not exist yet on fresh install */
    }

    cms.logger.info('Migration 006: lead events, follow-ups, estimate leadId index ready');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;
    for (const name of [LEAD_EVENTS, FOLLOW_UPS]) {
      const existing = await connection.db.listCollections({ name }).toArray();
      if (existing.length > 0) await connection.db.dropCollection(name);
    }
  }
};
