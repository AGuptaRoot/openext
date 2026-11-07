'use strict';

/**
 * Migration 016 — Lead activity assignee index
 * Adds tenant + assignedTo + eventDate index for dashboard "My assigned activities".
 */

module.exports = {
  id: '016_lead_event_assignee',
  name: 'Lead event assignee index',
  async up(cms) {
    const db = cms?.db || cms?.mongoose?.connection?.db;
    if (!db) return { skipped: true, reason: 'No database handle' };

    const collection = db.collection('plugin_openext_crm_suite_lead_events');
    try {
      await collection.createIndex(
        { tenantId: 1, assignedTo: 1, eventDate: 1 },
        { name: 'lead_events_tenant_assigned_date', background: true }
      );
    } catch (err) {
      if (!String(err.message || '').includes('already exists')) throw err;
    }
    return { ok: true };
  }
};
