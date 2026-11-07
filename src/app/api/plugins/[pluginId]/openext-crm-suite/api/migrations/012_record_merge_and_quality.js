'use strict';

const {
  normalizeCompanyName,
  buildCompanyTokens
} = require('../utils/lead-duplicate.util');

const LEADS = 'plugin_openext_crm_suite_leads';
const COMPANIES = 'plugin_openext_crm_suite_companies';
const BATCH_SIZE = 500;

async function collectionExists(db, name) {
  return (await db.listCollections({ name }).toArray()).length > 0;
}

module.exports = {
  name: '012_record_merge_and_quality',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const db = connection.db;
    const hasLeads = await collectionExists(db, LEADS);
    const hasCompanies = await collectionExists(db, COMPANIES);

    if (hasCompanies) {
      const companies = db.collection(COMPANIES);
      const cursor = companies.find({}, { projection: { _id: 1, name: 1 } });
      let operations = [];
      for await (const company of cursor) {
        operations.push({
          updateOne: {
            filter: { _id: company._id },
            update: {
              $set: {
                companyKey: normalizeCompanyName(company.name),
                companyTokens: buildCompanyTokens(company.name)
              }
            }
          }
        });
        if (operations.length >= BATCH_SIZE) {
          await companies.bulkWrite(operations, { ordered: false });
          operations = [];
        }
      }
      if (operations.length) await companies.bulkWrite(operations, { ordered: false });

      await companies.createIndex(
        { tenantId: 1, companyTokens: 1 },
        { name: 'companies_tenant_company_tokens' }
      );
      await companies.createIndex({ tenantId: 1, phone: 1 }, { name: 'companies_tenant_phone' });
      await companies.createIndex(
        { tenantId: 1, mergedIntoId: 1 },
        { name: 'companies_tenant_merged_into' }
      );
    }

    if (hasLeads) {
      await db.collection(LEADS).createIndex(
        { tenantId: 1, mergedIntoId: 1 },
        { name: 'leads_tenant_merged_into' }
      );
    }

    cms.logger.info('Migration 012: merge metadata indexes and client duplicate-search keys initialized');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;
    const db = connection.db;
    const specs = [
      [LEADS, 'leads_tenant_merged_into'],
      [COMPANIES, 'companies_tenant_company_tokens'],
      [COMPANIES, 'companies_tenant_phone'],
      [COMPANIES, 'companies_tenant_merged_into']
    ];
    for (const [collectionName, indexName] of specs) {
      if (!(await collectionExists(db, collectionName))) continue;
      const collection = db.collection(collectionName);
      if (await collection.indexExists(indexName)) await collection.dropIndex(indexName);
    }
    // Merge metadata is deliberately preserved. Removing it after a real merge
    // would reactivate secondary records without restoring their relationships.
  }
};
