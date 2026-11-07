'use strict';

const { deriveTenantRole } = require('../utils/tenant-role.util');

const TENANTS = 'plugin_openext_crm_suite_tenants';
const MEMBERSHIPS = 'plugin_openext_crm_suite_tenant_memberships';

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (!existing.length) await db.createCollection(name);
  return db.collection(name);
}

module.exports = {
  name: '008_tenant_security',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const db = connection.db;

    const tenants = await ensureCollection(db, TENANTS);
    await tenants.createIndex(
      { tenantId: 1 },
      { unique: true, name: 'tenants_tenant_id_unique' }
    );

    const memberships = await ensureCollection(db, MEMBERSHIPS);
    await memberships.createIndex(
      { tenantId: 1, userId: 1 },
      { unique: true, name: 'tenant_memberships_tenant_user_unique' }
    );
    await memberships.createIndex(
      { userId: 1, status: 1 },
      { name: 'tenant_memberships_user_status' }
    );
    await memberships.createIndex(
      { tenantId: 1, role: 1, status: 1 },
      { name: 'tenant_memberships_tenant_role_status' }
    );

    const now = new Date();
    await tenants.updateOne(
      { tenantId: 'default' },
      {
        $setOnInsert: {
          tenantId: 'default',
          name: 'Default CRM Tenant',
          status: 'active',
          createdBy: 'migration',
          updatedBy: 'migration',
          createdAt: now,
          updatedAt: now
        }
      },
      { upsert: true }
    );

    const userCollectionExists = await db.listCollections({ name: 'users' }).toArray();
    if (userCollectionExists.length) {
      const users = await db.collection('users')
        .find({ active: { $ne: false } })
        .project({ _id: 1, role: 1 })
        .toArray();
      if (users.length) {
        await memberships.bulkWrite(
          users.map((user) => ({
            updateOne: {
              filter: { tenantId: 'default', userId: String(user._id) },
              update: {
                $setOnInsert: {
                  tenantId: 'default',
                  userId: String(user._id),
                  role: deriveTenantRole(user.role),
                  status: 'active',
                  createdBy: 'migration',
                  updatedBy: 'migration',
                  createdAt: now,
                  updatedAt: now
                }
              },
              upsert: true
            }
          })),
          { ordered: false }
        );
      }
    }

    cms.logger.info('Migration 008: tenant security ready and existing active users preserved');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;

    for (const name of [MEMBERSHIPS, TENANTS]) {
      const existing = await connection.db.listCollections({ name }).toArray();
      if (existing.length) await connection.db.dropCollection(name);
    }
  }
};
