'use strict';

const { seedDefaults } = require('../services/setting.service');

/**
 * Collection names for Phase 1 sales core (Section 5.5 migration 001).
 */
const COLLECTIONS = {
  leads: 'plugin_openext_crm_suite_leads',
  companies: 'plugin_openext_crm_suite_companies',
  contacts: 'plugin_openext_crm_suite_contacts',
  settings: 'plugin_openext_crm_suite_settings',
  auditLogs: 'plugin_openext_crm_suite_audit_logs'
};

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name);
  }
  return db.collection(name);
}

module.exports = {
  name: '001_crm_sales_core',

  /**
   * Creates sales-core collections and indexes.
   * Entity models (Lead, Company, etc.) are added in later build steps.
   */
  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) {
      throw new Error('userDB connection is unavailable');
    }

    const db = connection.db;

    // --- Leads ---
    const leads = await ensureCollection(db, COLLECTIONS.leads);
    await leads.createIndex({ tenantId: 1, stage: 1 }, { name: 'leads_tenant_stage' });
    await leads.createIndex({ tenantId: 1, assignedTo: 1 }, { name: 'leads_tenant_assigned' });
    await leads.createIndex({ tenantId: 1, createdAt: -1 }, { name: 'leads_tenant_created' });

    // --- Companies (clients) ---
    const companies = await ensureCollection(db, COLLECTIONS.companies);
    await companies.createIndex({ tenantId: 1, name: 1 }, { name: 'companies_tenant_name' });
    await companies.createIndex({ tenantId: 1, email: 1 }, { name: 'companies_tenant_email' });

    // --- Contacts ---
    const contacts = await ensureCollection(db, COLLECTIONS.contacts);
    await contacts.createIndex({ tenantId: 1, companyId: 1 }, { name: 'contacts_tenant_company' });

    // --- Settings ---
    const settings = await ensureCollection(db, COLLECTIONS.settings);
    await settings.createIndex(
      { tenantId: 1, key: 1 },
      { unique: true, name: 'settings_tenant_key_unique' }
    );

    // --- Audit logs ---
    const auditLogs = await ensureCollection(db, COLLECTIONS.auditLogs);
    await auditLogs.createIndex(
      { tenantId: 1, module: 1, createdAt: -1 },
      { name: 'audit_tenant_module_created' }
    );
    await auditLogs.createIndex(
      { tenantId: 1, recordId: 1 },
      { name: 'audit_tenant_record' }
    );

    cms.logger.info('Migration 001: sales core collections and indexes ready');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;

    for (const name of Object.values(COLLECTIONS)) {
      const existing = await connection.db.listCollections({ name }).toArray();
      if (existing.length > 0) {
        await connection.db.dropCollection(name);
      }
    }
  }
};
