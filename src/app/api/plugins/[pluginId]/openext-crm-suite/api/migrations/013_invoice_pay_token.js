'use strict';

const COLLECTION = 'plugin_openext_crm_suite_invoices';

module.exports = {
  name: '013_invoice_pay_token',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');
    const invoices = connection.db.collection(COLLECTION);

    await invoices.createIndex(
      { payToken: 1 },
      {
        unique: true,
        sparse: true,
        name: 'invoices_pay_token'
      }
    );

    cms.logger.info('Migration 013: invoice payToken index ready');
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
  }
};
