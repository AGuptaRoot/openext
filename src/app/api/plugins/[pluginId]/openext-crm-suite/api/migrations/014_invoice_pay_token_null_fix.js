'use strict';

const COLLECTION = 'plugin_openext_crm_suite_invoices';

module.exports = {
  name: '014_invoice_pay_token_null_fix',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const invoices = connection.db.collection(COLLECTION);

    // Explicit null payToken values collide on the sparse-unique index; omit the field until send().
    const cleanup = await invoices.updateMany(
      { $or: [{ payToken: null }, { payToken: '' }] },
      { $unset: { payToken: '' } }
    );

    try {
      await invoices.dropIndex('invoices_pay_token');
    } catch {
      /* index may not exist yet */
    }

    await invoices.createIndex(
      { payToken: 1 },
      {
        unique: true,
        sparse: true,
        name: 'invoices_pay_token'
      }
    );

    cms.logger.info(
      `Migration 014: cleared ${cleanup.modifiedCount || 0} null payToken(s) and rebuilt invoices_pay_token index`
    );
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;
    const invoices = connection.db.collection(COLLECTION);
    try {
      await invoices.dropIndex('invoices_pay_token');
    } catch {
      /* ignore if missing */
    }
    await invoices.createIndex(
      { payToken: 1 },
      {
        unique: true,
        sparse: true,
        name: 'invoices_pay_token'
      }
    );
  }
};
