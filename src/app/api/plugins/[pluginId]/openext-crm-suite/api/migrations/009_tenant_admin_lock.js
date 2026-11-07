'use strict';

const TENANTS = 'plugin_openext_crm_suite_tenants';

module.exports = {
  name: '009_tenant_admin_lock',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');

    const existing = await connection.db.listCollections({ name: TENANTS }).toArray();
    if (!existing.length) return;

    await connection.db.collection(TENANTS).updateMany(
      {},
      { $unset: { adminMutationLockToken: '', adminMutationLockUntil: '' } }
    );
    cms.logger.info('Migration 009: tenant administrator mutation lock fields initialized');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;

    const existing = await connection.db.listCollections({ name: TENANTS }).toArray();
    if (!existing.length) return;

    await connection.db.collection(TENANTS).updateMany(
      {},
      { $unset: { adminMutationLockToken: '', adminMutationLockUntil: '' } }
    );
  }
};
