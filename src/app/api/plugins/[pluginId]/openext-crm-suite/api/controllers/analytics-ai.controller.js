'use strict';

const AnalyticsAiService = require('../services/analytics-ai.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] analytics-ai error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Analytics & AI operation failed',
    details: error.details || []
  });
}

async function salesAnalytics(req, res) {
  try {
    const data = await AnalyticsAiService.getExecutiveSalesAnalytics(req, req.query);
    res.json({ success: true, data, message: 'Executive sales analytics and forecasting loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function customerBehavior(req, res) {
  try {
    const data = await AnalyticsAiService.getCustomerBehaviorAndDemand(req, req.query);
    res.json({ success: true, data, message: 'Customer behavior and product demand insights loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function nextBestActions(req, res) {
  try {
    const data = await AnalyticsAiService.getNextBestActions(req, req.query);
    res.json({ success: true, data: data.recommendations, total: data.totalGenerated, message: 'AI Next-Best-Actions loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function applyAction(req, res) {
  try {
    const { leadId, targetStage, notes, expectedRevenue } = req.body;
    const result = await AnalyticsAiService.applyNextBestAction(req, { leadId, targetStage, notes, expectedRevenue });
    res.json({ success: true, data: result, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  salesAnalytics,
  customerBehavior,
  nextBestActions,
  applyAction
};
