'use strict';

const controller = require('../controllers/data-quality.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

module.exports = function registerDataQualityRoutes(app) {
  app.get('/data-quality/export', requireAnyPermission('crm.dataQuality.export', 'crm.dataQuality.manage', 'crm.leads.read'), controller.exportDataQuality);
  app.get('/data-quality', requirePermission('crm.dataQuality.manage'), controller.list);
  app.get('/data-quality/rules', requirePermission('crm.dataQuality.manage'), controller.getRules);
  app.put('/data-quality/rules', requirePermission('crm.dataQuality.manage'), controller.updateRules);
};
