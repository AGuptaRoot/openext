'use strict';

const LEADS = 'plugin_openext_crm_suite_leads';

module.exports = {
  name: '010_lead_contact_validation',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');

    const existing = await connection.db.listCollections({ name: LEADS }).toArray();
    if (!existing.length) return;

    const collection = connection.db.collection(LEADS);
    await collection.updateMany({ pan: { $exists: false } }, { $set: { pan: '' } });
    await collection.createIndex({ tenantId: 1, email: 1 }, { name: 'leads_tenant_email' });
    await collection.createIndex({ tenantId: 1, phone: 1 }, { name: 'leads_tenant_phone' });
    await collection.createIndex({ tenantId: 1, pan: 1 }, { name: 'leads_tenant_pan' });
    cms.logger.info('Migration 010: lead PAN field and contact validation indexes initialized');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;

    const existing = await connection.db.listCollections({ name: LEADS }).toArray();
    if (!existing.length) return;

    const collection = connection.db.collection(LEADS);
    for (const indexName of ['leads_tenant_email', 'leads_tenant_phone', 'leads_tenant_pan']) {
      if ((await collection.indexExists(indexName))) await collection.dropIndex(indexName);
    }
    await collection.updateMany({ pan: '' }, { $unset: { pan: '' } });
  }
};
