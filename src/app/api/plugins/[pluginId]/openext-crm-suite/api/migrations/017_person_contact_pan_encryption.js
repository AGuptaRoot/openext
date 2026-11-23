'use strict';

/**
 * Migration 017 — Contact PAN encrypted at rest (CRM 3.64.0)
 * Encrypts plain PAN values of person contacts (bound to each row's tenant), sets panHash (duplicate checks)
 * and panLast4 (masking), drops the old plain-PAN index and creates the panHash index.
 * Idempotent: values already encrypted are skipped. PAN values are never logged.
 */

const DataProtection = require('../extension-runtime/data-protection');

const SCOPE = 'crm-core:person-contact';
const COLLECTION = 'plugin_openext_crm_suite_person_contacts';

async function encryptPlainPans(collection) {
  let encrypted = 0;
  let cleared = 0;
  const cursor = collection.find(
    { pan: { $exists: true, $nin: ['', null], $not: new RegExp(`^${DataProtection.TEXT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) } },
    { projection: { _id: 1, tenantId: 1, pan: 1 } }
  );
  for await (const row of cursor) {
    if (String(row.pan || '').startsWith(DataProtection.TEXT_PREFIX)) continue;
    const plain = String(row.pan || '').trim().toUpperCase();
    const tenantId = String(row.tenantId || '');
    if (!plain || !tenantId) continue;
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(plain)) {
      // Not a PAN (typo kept from before format checks): kept only as its last 4, never in plain text.
      await collection.updateOne({ _id: row._id }, { $set: { pan: DataProtection.encryptText(tenantId, SCOPE, plain), panHash: '', panLast4: plain.slice(-4) } });
      cleared += 1;
      continue;
    }
    await collection.updateOne(
      { _id: row._id },
      {
        $set: {
          pan: DataProtection.encryptText(tenantId, SCOPE, plain),
          panHash: DataProtection.hashText(tenantId, SCOPE, plain),
          panLast4: plain.slice(-4)
        }
      }
    );
    encrypted += 1;
  }
  return { encrypted, invalid: cleared };
}

module.exports = {
  id: '017_person_contact_pan_encryption',
  name: 'Contact PAN encrypted at rest',
  encryptPlainPans,
  async up(cms) {
    const db = cms?.db || cms?.mongoose?.connection?.db;
    if (!db) return { skipped: true, reason: 'No database handle' };
    const collection = db.collection(COLLECTION);
    const result = await encryptPlainPans(collection);
    try {
      await collection.dropIndex('person_contacts_tenant_pan');
    } catch {
      /* not there */
    }
    try {
      await collection.createIndex({ tenantId: 1, panHash: 1 }, { name: 'person_contacts_tenant_pan_hash', background: true });
    } catch (err) {
      if (!String(err.message || '').includes('already exists')) throw err;
    }
    return { ok: true, ...result };
  }
};
