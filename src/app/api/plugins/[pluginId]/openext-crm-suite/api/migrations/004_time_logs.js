'use strict';

const COLLECTION = 'plugin_openext_crm_suite_time_logs';

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name);
  }
  return db.collection(name);
}

module.exports = {
  name: '004_time_logs',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) {
      throw new Error('userDB connection is unavailable');
    }

    const db = connection.db;
    const timeLogs = await ensureCollection(db, COLLECTION);
    await timeLogs.createIndex({ tenantId: 1, taskId: 1, workDate: -1 }, { name: 'time_logs_task_date' });
    await timeLogs.createIndex({ tenantId: 1, projectId: 1, workDate: -1 }, { name: 'time_logs_project_date' });
    await timeLogs.createIndex({ tenantId: 1, createdBy: 1, workDate: -1 }, { name: 'time_logs_user_date' });
    await timeLogs.createIndex({ tenantId: 1, isBillable: 1, workDate: -1 }, { name: 'time_logs_billable_date' });

    cms.logger.info('Migration 004: time logs collection ready');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;

    const existing = await connection.db.listCollections({ name: COLLECTION }).toArray();
    if (existing.length > 0) {
      await connection.db.dropCollection(COLLECTION);
    }
  }
};
