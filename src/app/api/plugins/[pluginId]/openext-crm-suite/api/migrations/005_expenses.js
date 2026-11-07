'use strict';

const COLLECTION = 'plugin_openext_crm_suite_expenses';

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) await db.createCollection(name);
  return db.collection(name);
}

module.exports = {
  name: '005_expenses',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const db = connection.db;

    const expenses = await ensureCollection(db, COLLECTION);
    await expenses.createIndex(
      { tenantId: 1, expenseNo: 1 },
      { unique: true, name: 'expenses_tenant_expense_no' }
    );
    await expenses.createIndex({ tenantId: 1, status: 1 }, { name: 'expenses_tenant_status' });
    await expenses.createIndex({ tenantId: 1, expenseDate: -1 }, { name: 'expenses_tenant_date' });
    await expenses.createIndex({ tenantId: 1, projectId: 1 }, { name: 'expenses_tenant_project' });
    await expenses.createIndex({ tenantId: 1, clientId: 1 }, { name: 'expenses_tenant_client' });
    await expenses.createIndex({ tenantId: 1, createdBy: 1 }, { name: 'expenses_tenant_created_by' });

    cms.logger.info('Migration 005: expenses collection and indexes ready');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;
    const existing = await connection.db.listCollections({ name: COLLECTION }).toArray();
    if (existing.length > 0) await connection.db.dropCollection(COLLECTION);
  }
};
