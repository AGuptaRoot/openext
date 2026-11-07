'use strict';

const { normalizeCompanyName, buildCompanyTokens } = require('../utils/lead-duplicate.util');
const {
  trimLowerEmail,
  normalizeMobile,
  normalizePan,
  isValidEmail,
  isValidMobile,
  isValidPan
} = require('../validation/common.util');

const LEADS = 'plugin_openext_crm_suite_leads';
const BATCH_SIZE = 500;

module.exports = {
  name: '011_lead_duplicate_detection',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const existing = await connection.db.listCollections({ name: LEADS }).toArray();
    if (!existing.length) return;

    const collection = connection.db.collection(LEADS);
    const cursor = collection.find({}, { projection: { _id: 1, company: 1, email: 1, phone: 1, pan: 1 } });
    let operations = [];
    for await (const lead of cursor) {
      const email = trimLowerEmail(lead.email) || '';
      const phone = normalizeMobile(lead.phone) || '';
      const pan = normalizePan(lead.pan) || '';
      const normalizedIdentity = {};
      if (!email || isValidEmail(email)) normalizedIdentity.email = email;
      if (!phone || isValidMobile(phone)) normalizedIdentity.phone = phone;
      if (!pan || isValidPan(pan)) normalizedIdentity.pan = pan;
      operations.push({
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              companyKey: normalizeCompanyName(lead.company),
              companyTokens: buildCompanyTokens(lead.company),
              ...normalizedIdentity
            }
          }
        }
      });
      if (operations.length >= BATCH_SIZE) {
        await collection.bulkWrite(operations, { ordered: false });
        operations = [];
      }
    }
    if (operations.length) await collection.bulkWrite(operations, { ordered: false });
    await collection.createIndex(
      { tenantId: 1, companyTokens: 1 },
      { name: 'leads_tenant_company_tokens' }
    );
    cms.logger.info('Migration 011: lead company duplicate-search keys initialized');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;
    const existing = await connection.db.listCollections({ name: LEADS }).toArray();
    if (!existing.length) return;

    const collection = connection.db.collection(LEADS);
    if (await collection.indexExists('leads_tenant_company_tokens')) {
      await collection.dropIndex('leads_tenant_company_tokens');
    }
    await collection.updateMany({}, { $unset: { companyKey: '', companyTokens: '' } });
  }
};
