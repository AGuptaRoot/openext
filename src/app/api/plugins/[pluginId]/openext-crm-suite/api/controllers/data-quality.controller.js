'use strict';

const DataQualityCenterService = require('../services/data-quality-center.service');
const SettingService = require('../services/setting.service');

async function list(req, res) {
  try {
    const result = await DataQualityCenterService.getCenter(req, req.query || {});
    res.json({
      success: true,
      data: result.items,
      summary: result.summary,
      pagination: result.pagination,
      meta: result.meta,
      message: 'Data-quality review queue loaded'
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error('[plugin:openext-crm-suite] data quality center:', error);
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Failed to load data-quality center' : error.message
    });
  }
}

async function getRules(req, res) {
  try {
    const rules = await SettingService.getDataQualityRules(req);
    res.json({ success: true, data: rules });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Failed to load data-quality rules' : error.message
    });
  }
}

async function updateRules(req, res) {
  try {
    const updated = await SettingService.updateDataQualityRules(req, req.body || {});
    res.json({ success: true, data: updated, message: 'Data-quality rules updated' });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Failed to update data-quality rules' : error.message
    });
  }
}

async function exportDataQuality(req, res) {
  try {
    const result = await DataQualityCenterService.exportDataQuality(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Failed to export data quality center' : error.message
    });
  }
}

module.exports = {
  list,
  exportDataQuality,
  getRules,
  updateRules
};
