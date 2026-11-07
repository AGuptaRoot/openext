'use strict';

/**
 * Declared extension data routes:
 *   - Values on core records: GET/PUT /crm-extension-data/values/:record/:recordId
 *   - Extension settings:     GET/PUT /crm-extension-data/settings
 *
 * OWNER: Step 2 (see documentation/crm-upload-plan/AGY-STEP-2-declarations.md).
 * Shared Contract: documentation/crm-upload-plan/00-CONTRACTS.md §3.
 */

const controller = require('../controllers/crm-extension-data.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

const RECORD_PERMISSION_MAP = {
  lead: 'leads',
  client: 'clients',
  opportunity: 'opportunities',
  ticket: 'tickets'
};

/** Records whose values follow the record's own permissions rather than crm.<plural>.<action>. */
const RECORD_PERMISSION_ANY = {
  // A quotation's declared values: same permissions as the quotation itself.
  quotation: { read: ['crm.finance.read', 'crm.quotes.write'], write: ['crm.quotes.write', 'crm.finance.write'] }
};

function requireRecordPermission(action) {
  return async (req, res, next) => {
    const record = String(req.params?.record || '').toLowerCase();
    if (RECORD_PERMISSION_ANY[record]) {
      return requireAnyPermission(RECORD_PERMISSION_ANY[record][action])(req, res, next);
    }
    const plural = RECORD_PERMISSION_MAP[record];
    if (!plural) {
      res.status(400).json({
        success: false,
        error: `Invalid record type: "${req.params?.record}". Supported types: lead, client, opportunity, ticket, quotation.`
      });
      return;
    }
    const permission = `crm.${plural}.${action}`;
    const check = requirePermission(permission);
    return check(req, res, next);
  };
}

module.exports = function registerCrmExtensionDataRoutes(app) {
  app.get(
    '/crm-extension-data/settings',
    requirePermission('crm.settings.manage'),
    controller.getSettings
  );

  app.put(
    '/crm-extension-data/settings',
    requirePermission('crm.settings.manage'),
    controller.setSettings
  );

  app.get(
    '/crm-extension-data/values/:record/:recordId',
    requireRecordPermission('read'),
    controller.getValues
  );

  app.put(
    '/crm-extension-data/values/:record/:recordId',
    requireRecordPermission('write'),
    controller.setValues
  );
};
