'use strict';

const controller = require('../controllers/data-quality.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

module.exports = function registerDataQualityRoutes(app) {
  // CRM 3.58.1: the export holds every lead and client of the tenant (with PAN): data-quality users only
  // (was also open to anyone with crm.leads.read, e.g. a Sales Representative).
  app.get('/data-quality/export', requireAnyPermission('crm.dataQuality.read', 'crm.dataQuality.manage'), controller.exportDataQuality);
  app.get('/data-quality', requirePermission('crm.dataQuality.manage'), controller.list);
  app.get('/data-quality/rules', requirePermission('crm.dataQuality.manage'), controller.getRules);
  app.put('/data-quality/rules', requirePermission('crm.dataQuality.manage'), controller.updateRules);
};
