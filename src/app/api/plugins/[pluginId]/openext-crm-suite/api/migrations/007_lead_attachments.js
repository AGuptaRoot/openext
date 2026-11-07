'use strict';

const COLLECTION = 'plugin_openext_crm_suite_lead_attachments';

module.exports = {
  name: '007_lead_attachments',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const db = connection.db;

    const existing = await db.listCollections({ name: COLLECTION }).toArray();
    if (!existing.length) await db.createCollection(COLLECTION);

    await db.collection(COLLECTION).createIndex(
      { tenantId: 1, leadId: 1, createdAt: -1 },
      { name: 'lead_attachments_tenant_lead_created' }
    );

    cms.logger.info('Migration 007: lead attachments collection ready');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;
    const existing = await connection.db.listCollections({ name: COLLECTION }).toArray();
    if (existing.length) await connection.db.dropCollection(COLLECTION);
  }
};
