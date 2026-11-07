'use strict';

const MarketingService = require('../services/marketing.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] marketing error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Marketing campaign operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await MarketingService.listCampaigns(req, req.query);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) {
    sendError(res, error);
  }
}

async function getById(req, res) {
  try {
    const campaign = await MarketingService.getCampaignById(req, req.params.id);
    res.json({ success: true, data: campaign });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const campaign = await MarketingService.createCampaign(req, req.body);
    res.status(201).json({ success: true, data: campaign, message: 'Marketing campaign created successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const campaign = await MarketingService.updateCampaign(req, req.params.id, req.body);
    res.json({ success: true, data: campaign, message: 'Marketing campaign updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await MarketingService.deleteCampaign(req, req.params.id);
    res.json({ success: true, data: result, message: 'Marketing campaign deleted successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function audienceStats(req, res) {
  try {
    const stats = await MarketingService.getAudienceStats(req);
    res.json({ success: true, data: stats, message: 'Audience segment statistics loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function execute(req, res) {
  try {
    const result = await MarketingService.executeCampaign(req, req.params.id);
    res.json({ success: true, data: result, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

async function sendTest(req, res) {
  try {
    const { email } = req.body;
    const result = await MarketingService.sendTestCampaign(req, req.params.id, email);
    res.json({ success: true, data: result, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

async function reEngage(req, res) {
  try {
    const { campaignId, leadId, targetStage, actionType, notes } = req.body;
    const result = await MarketingService.reEngageLead(req, { campaignId, leadId, targetStage, actionType, notes });
    res.json({ success: true, data: result, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

async function simulateReEngage(req, res) {
  try {
    const result = await MarketingService.simulateReEngagement(req, req.params.id);
    res.json({ success: true, data: result, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

async function analytics(req, res) {
  try {
    const result = await MarketingService.getMarketingAnalytics(req, req.query);
    res.json({ success: true, data: result, message: 'Marketing analytics loaded successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function eligibleLeads(req, res) {
  try {
    const leads = await MarketingService.getEligibleLeadsForReEngagement(req);
    res.json({ success: true, data: leads, message: 'Eligible leads loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function activity(req, res) {
  try {
    const items = await MarketingService.listActivity(req, req.query || {});
    res.json({ success: true, data: items, message: 'Marketing activity loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

// Manager Approval Workflow Endpoints
async function createRequest(req, res) {
  try {
    const { campaignId, leadId, actionType, notes } = req.body;
    const result = await MarketingService.createReEngagementRequest(req, { campaignId, leadId, actionType, notes });
    res.status(201).json({ success: true, data: result.request, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

async function listRequests(req, res) {
  try {
    const result = await MarketingService.listReEngagementRequests(req, req.query);
    res.json({ success: true, data: result.items, pendingCount: result.pendingCount, message: 'Approval requests loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function approveRequest(req, res) {
  try {
    const result = await MarketingService.approveReEngagementRequest(req, req.params.id);
    res.json({ success: true, data: result.request, lead: result.lead, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

async function rejectRequest(req, res) {
  try {
    const { reason } = req.body || {};
    const result = await MarketingService.rejectReEngagementRequest(req, req.params.id, reason);
    res.json({ success: true, data: result.request, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

// Public Click Tracker for Email Links
async function trackClick(req, res) {
  try {
    const { campaignId, leadId, redirect } = req.query;
    await MarketingService.trackCustomerEmailClick(req, { campaignId, leadId, redirectUrl: redirect });

    if (redirect && (redirect.startsWith('http://') || redirect.startsWith('https://'))) {
      return res.redirect(redirect);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Request Received - Thank You</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #ffffff; border-radius: 16px; padding: 40px; max-width: 460px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); text-align: center; border: 1px solid #e2e8f0; }
          .icon { width: 64px; height: 64px; background: #ecfdf5; color: #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; margin: 0 auto 20px; font-weight: bold; }
          h2 { color: #0f172a; margin: 0 0 10px; font-size: 22px; font-weight: 800; }
          p { color: #64748b; font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
          .badge { display: inline-block; background: #f1f5f9; color: #334155; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <h2>Thank You! Request Received</h2>
          <p>We have received your interest. Our CRM team and sales specialists have been notified and will reach out to you within 24 hours.</p>
          <div class="badge">🚀 Priority Follow-up Active</div>
        </div>
      </body>
      </html>
    `);
  } catch {
    res.status(400).send('Invalid or expired tracking link');
  }
}

async function exportMarketing(req, res) {
  try {
    const result = await MarketingService.exportMarketing(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  exportMarketing,
  getById,
  create,
  update,
  remove,
  audienceStats,
  execute,
  sendTest,
  reEngage,
  simulateReEngage,
  analytics,
  eligibleLeads,
  activity,
  createRequest,
  listRequests,
  approveRequest,
  rejectRequest,
  trackClick
};
