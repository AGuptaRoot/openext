'use strict';

const INVOICE_COLLECTION = 'plugin_openext_crm_suite_invoices';
const SETTINGS_COLLECTION = 'plugin_openext_crm_suite_settings';

function parseInvoiceSequence(prefix, invoiceNo) {
  const safePrefix = String(prefix || 'INV-');
  const docNo = String(invoiceNo || '').trim();
  if (!docNo.startsWith(safePrefix)) return null;
  const parsed = parseInt(docNo.slice(safePrefix.length), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

module.exports = {
  name: '015_sync_invoice_sequence_counter',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) throw new Error('userDB connection is unavailable');

    const invoices = connection.db.collection(INVOICE_COLLECTION);
    const settings = connection.db.collection(SETTINGS_COLLECTION);

    const prefixRows = await settings
      .find({ key: 'invoice_prefix', isDeleted: { $ne: true } })
      .project({ tenantId: 1, value: 1 })
      .toArray();
    const prefixByTenant = new Map(
      prefixRows.map((row) => [String(row.tenantId), String(row.value || 'INV-')])
    );

    const invoiceRows = await invoices
      .find({ isDeleted: { $ne: true } })
      .project({ tenantId: 1, invoiceNo: 1 })
      .toArray();

    const maxByTenant = new Map();
    for (const row of invoiceRows) {
      const tenantId = String(row.tenantId || 'default');
      const prefix = prefixByTenant.get(tenantId) || 'INV-';
      const parsed = parseInvoiceSequence(prefix, row.invoiceNo);
      if (parsed == null) continue;
      const current = maxByTenant.get(tenantId) || 0;
      maxByTenant.set(tenantId, Math.max(current, parsed));
    }

    let updated = 0;
    for (const [tenantId, maxSeq] of maxByTenant.entries()) {
      const result = await settings.updateOne(
        { tenantId, key: 'invoice_sequence', isDeleted: { $ne: true } },
        {
          $max: { value: maxSeq },
          $setOnInsert: {
            tenantId,
            key: 'invoice_sequence',
            category: 'finance',
            status: 'active',
            isDeleted: false,
            createdBy: 'system'
          }
        },
        { upsert: true }
      );
      if (result.modifiedCount || result.upsertedCount) updated++;
    }

    cms.logger.info(
      `Migration 015: synced invoice_sequence for ${updated} tenant(s) from existing invoice numbers`
    );
  },

  async down() {
    /* non-destructive data repair — no rollback */
  }
};
