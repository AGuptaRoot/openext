'use strict';

const COLLECTIONS = {
  estimates: 'plugin_openext_crm_suite_estimates',
  invoices: 'plugin_openext_crm_suite_invoices',
  payments: 'plugin_openext_crm_suite_payments'
};

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) await db.createCollection(name);
  return db.collection(name);
}

module.exports = {
  name: '002_finance_core',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const db = connection.db;

    const estimates = await ensureCollection(db, COLLECTIONS.estimates);
    await estimates.createIndex(
      { tenantId: 1, quotationNo: 1 },
      { unique: true, name: 'estimates_tenant_quotation_no' }
    );
    await estimates.createIndex({ tenantId: 1, clientId: 1 }, { name: 'estimates_tenant_client' });
    await estimates.createIndex({ tenantId: 1, status: 1 }, { name: 'estimates_tenant_status' });

    const invoices = await ensureCollection(db, COLLECTIONS.invoices);
    await invoices.createIndex(
      { tenantId: 1, invoiceNo: 1 },
      { unique: true, name: 'invoices_tenant_invoice_no' }
    );
    await invoices.createIndex({ tenantId: 1, clientId: 1 }, { name: 'invoices_tenant_client' });
    await invoices.createIndex(
      { tenantId: 1, status: 1, dueDate: 1 },
      { name: 'invoices_tenant_status_due' }
    );

    const payments = await ensureCollection(db, COLLECTIONS.payments);
    await payments.createIndex({ tenantId: 1, invoiceId: 1 }, { name: 'payments_tenant_invoice' });
    await payments.createIndex({ tenantId: 1, clientId: 1 }, { name: 'payments_tenant_client' });
    await payments.createIndex({ tenantId: 1, paymentDate: -1 }, { name: 'payments_tenant_date' });

    cms.logger.info('Migration 002: finance collections and indexes ready');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;
    for (const name of Object.values(COLLECTIONS)) {
      const existing = await connection.db.listCollections({ name }).toArray();
      if (existing.length > 0) await connection.db.dropCollection(name);
    }
  }
};
