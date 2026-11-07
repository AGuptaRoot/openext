'use strict';

const TICKETS = 'plugin_openext_crm_suite_tickets';
const FEEDBACKS = 'plugin_openext_crm_suite_customer_feedbacks';

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (!existing.length) await db.createCollection(name);
  return db.collection(name);
}

module.exports = {
  name: '009_customer_success',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const db = connection.db;

    const tickets = await ensureCollection(db, TICKETS);
    await tickets.createIndex(
      { tenantId: 1, ticketNumber: 1 },
      { name: 'tck_tenant_number' }
    );
    await tickets.createIndex(
      { tenantId: 1, clientId: 1 },
      { name: 'tck_tenant_client' }
    );
    await tickets.createIndex(
      { tenantId: 1, status: 1, priority: 1 },
      { name: 'tck_status_priority' }
    );

    const feedbacks = await ensureCollection(db, FEEDBACKS);
    await feedbacks.createIndex(
      { tenantId: 1, clientId: 1 },
      { name: 'fb_tenant_client' }
    );
    await feedbacks.createIndex(
      { tenantId: 1, rating: 1 },
      { name: 'fb_tenant_rating' }
    );

    cms.logger.info('Migration 009: Customer Success (Tickets & Feedback) collections and indexes created');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;

    for (const name of [FEEDBACKS, TICKETS]) {
      const existing = await connection.db.listCollections({ name }).toArray();
      if (existing.length) await connection.db.dropCollection(name);
    }
  }
};
