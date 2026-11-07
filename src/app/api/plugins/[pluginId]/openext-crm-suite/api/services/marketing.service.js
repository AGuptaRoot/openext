const { resolveTenantId, resolveUserId, isClientUser } = require('../utils/tenant.util');
const MailService = require('./mail.service');
const AuditService = require('./audit.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function getCampaignModel(req) {
  const model = req.cms?.models?.get('Campaign');
  if (model) return model;
  try {
    return require('../models/Campaign.js');
  } catch {
    throw appError('Campaign model is not registered', 500);
  }
}

function getLeadModel(req) {
  const model = req.cms?.models?.get('Lead');
  if (model) return model;
  try {
    return require('../models/Lead.js');
  } catch {
    return null;
  }
}

function getClientModel(req) {
  // In Root CRM, clients are registered under 'Company' model (or 'Client')
  const model = req.cms?.models?.get('Company') || req.cms?.models?.get('Client');
  if (model) return model;
  try {
    return require('../models/Company.js');
  } catch {
    return null;
  }
}

function getSalesOrderModel(req) {
  const model = req.cms?.models?.get('SalesOrder');
  if (model) return model;
  try {
    return require('../models/SalesOrder.js');
  } catch {
    return null;
  }
}

function getTaskModel(req) {
  const model = req.cms?.models?.get('Task');
  if (model) return model;
  try {
    return require('../models/Task.js');
  } catch {
    return null;
  }
}

function getLeadEventModel(req) {
  const model = req.cms?.models?.get('LeadEvent');
  if (model) return model;
  try {
    return require('../models/LeadEvent.js');
  } catch {
    return null;
  }
}

function getReEngagementRequestModel(req) {
  const model = req.cms?.models?.get('ReEngagementRequest');
  if (model) return model;
  try {
    return require('../models/ReEngagementRequest.js');
  } catch {
    return null;
  }
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function getAppBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const protocol = req.headers?.['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers?.['x-forwarded-host'] || req.get?.('host') || 'localhost:3000';
  return `${protocol}://${host}`;
}

function buildTrackingUrl(req, campaignId, leadId) {
  const base = getAppBaseUrl(req);
  return `${base}/api/plugins/openext-crm-suite/marketing/track/click?campaignId=${encodeURIComponent(campaignId)}&leadId=${encodeURIComponent(leadId || '')}`;
}

/**
 * Replaces dynamic merge tags like {{name}}, {{company}}, {{email}}, {{phone}}
 */
function renderTemplate(templateString, context = {}) {
  if (!templateString) return '';
  return String(templateString).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const value = context[key];
    return value == null ? '' : String(value);
  });
}

/**
 * Renders email template with context and injects the interactive CTA button.
 */
function renderEmailBodyWithCta(campaignContent, context = {}, trackingUrl = '') {
  let rendered = renderTemplate(campaignContent, {
    ...context,
    cta_link: trackingUrl,
    cta_button: trackingUrl
      ? `<div style="margin: 24px 0; text-align: center;"><a href="${trackingUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-family: sans-serif; font-size: 15px;">👉 Click Here — I am Interested / Request Quote</a></div>`
      : ''
  });

  // If email does not contain the tracking link, automatically append the interactive CTA button
  if (trackingUrl && !rendered.includes('/marketing/track/click')) {
    rendered += `
      <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; font-family: sans-serif;">
        <p style="margin: 0 0 12px 0; font-size: 14px; color: #475569;">Interested in reconnecting or discussing your project?</p>
        <a href="${trackingUrl}" style="background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #ffffff; padding: 12px 26px; text-decoration: none; border-radius: 8px; font-weight: 700; display: inline-block; font-size: 15px; box-shadow: 0 4px 10px rgba(37,99,235,0.25);">
          👉 Click Here: I am Interested / Request Quote
        </a>
      </div>
    `;
  }

  return rendered;
}

/**
 * List campaigns with pagination and filtering.
 */
async function listCampaigns(req, query = {}) {
  if (isClientUser(req)) {
    const page = Math.max(1, parseInt(query.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || 15, 10)));
    return {
      items: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0
      },
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  const Campaign = getCampaignModel(req);
  const page = Math.max(1, parseInt(query.page || 1, 10));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || 15, 10)));
  const skip = (page - 1) * limit;

  const filter = { ...baseFilter(req) };
  if (query.status) filter.status = String(query.status).trim();
  if (query.type) filter.type = String(query.type).trim();
  if (query.search) {
    const term = String(query.search).trim();
    filter.$or = [
      { name: { $regex: term, $options: 'i' } },
      { subject: { $regex: term, $options: 'i' } }
    ];
  }

  const [items, total] = await Promise.all([
    Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Campaign.countDocuments(filter)
  ]);

  return {
    items: items.map((c) => ({
      ...c,
      id: String(c._id)
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
}

/**
 * Get campaign by ID.
 */
async function getCampaignById(req, id) {
  if (isClientUser(req)) {
    throw appError('Campaign not found', 404);
  }
  const Campaign = getCampaignModel(req);
  const campaign = await Campaign.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!campaign) throw appError('Campaign not found', 404);
  return { ...campaign, id: String(campaign._id) };
}

/**
 * Create a new marketing campaign.
 */
async function createCampaign(req, input) {
  const Campaign = getCampaignModel(req);
  const userId = resolveUserId(req);

  const name = String(input.name || '').trim();
  if (!name) throw appError('Campaign name is required', 400);

  const subject = String(input.subject || '').trim();
  if (!subject) throw appError('Email subject is required', 400);

  const content = String(input.content || '').trim();
  if (!content) throw appError('Email content is required', 400);

  const newCampaign = await Campaign.create({
    tenantId: resolveTenantId(req),
    name,
    type: input.type || 'Lost Lead Re-engagement',
    targetAudience: input.targetAudience || 'Lost Leads',
    status: input.status || 'Draft',
    subject,
    content,
    scheduledDate: input.scheduledDate ? new Date(input.scheduledDate) : null,
    createdBy: userId,
    updatedBy: userId
  });

  return { ...newCampaign.toObject(), id: String(newCampaign._id) };
}

/**
 * Update an existing campaign.
 */
async function updateCampaign(req, id, input) {
  const Campaign = getCampaignModel(req);
  const userId = resolveUserId(req);

  const existing = await Campaign.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Campaign not found', 404);

  const updates = { updatedBy: userId };
  if (input.name) updates.name = String(input.name).trim();
  if (input.type) updates.type = String(input.type).trim();
  if (input.targetAudience) updates.targetAudience = String(input.targetAudience).trim();
  if (input.status) updates.status = String(input.status).trim();
  if (input.subject) updates.subject = String(input.subject).trim();
  if (input.content) updates.content = String(input.content).trim();
  if (input.scheduledDate !== undefined) {
    updates.scheduledDate = input.scheduledDate ? new Date(input.scheduledDate) : null;
  }

  const updated = await Campaign.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  return { ...updated, id: String(updated._id) };
}

/**
 * Soft delete a campaign.
 */
async function deleteCampaign(req, id) {
  const Campaign = getCampaignModel(req);
  const userId = resolveUserId(req);

  const campaign = await Campaign.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!campaign) throw appError('Campaign not found', 404);

  await Campaign.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId } }
  );

  return { success: true, id };
}

/**
 * Resolves audience contacts matching a campaign segment.
 */
async function getAudienceRecipients(req, targetAudience) {
  if (isClientUser(req)) return [];
  const Lead = getLeadModel(req);
  const Client = getClientModel(req);
  const SalesOrder = getSalesOrderModel(req);
  const filter = baseFilter(req);

  let recipients = [];

  if (targetAudience === 'Lost Leads') {
    const leads = Lead
      ? await Lead.find({
        ...filter,
        $or: [{ stage: 'Lost' }, { status: 'Lost' }, { 'qualification.status': 'Rejected' }]
      }).lean()
      : [];

    recipients = leads
      .filter((l) => isValidEmail(l.email))
      .map((l) => ({
        id: String(l._id),
        name: l.name || 'Valued Customer',
        company: l.company || l.name || '',
        email: l.email.trim().toLowerCase(),
        phone: l.phone || '',
        type: 'lead'
      }));
  } else if (targetAudience === 'Unqualified Leads') {
    const leads = Lead
      ? await Lead.find({
        ...filter,
        $or: [{ 'qualification.status': 'Rejected' }, { stage: 'Unqualified' }, { status: 'Unqualified' }]
      }).lean()
      : [];

    recipients = leads
      .filter((l) => isValidEmail(l.email))
      .map((l) => ({
        id: String(l._id),
        name: l.name || 'Valued Customer',
        company: l.company || l.name || '',
        email: l.email.trim().toLowerCase(),
        phone: l.phone || '',
        type: 'lead'
      }));
  } else if (targetAudience === 'Dormant Clients (>90 days)') {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const activeOrderClientIds = SalesOrder
      ? await SalesOrder.distinct('clientId', {
        ...filter,
        createdAt: { $gte: ninetyDaysAgo }
      })
      : [];
    const recentClientSet = new Set(activeOrderClientIds.map((id) => String(id)));

    const clients = Client ? await Client.find(filter).lean() : [];
    recipients = clients
      .filter((c) => !recentClientSet.has(String(c._id)) && isValidEmail(c.email))
      .map((c) => ({
        id: String(c._id),
        name: c.name || 'Valued Client',
        company: c.companyName || c.name || '',
        email: c.email.trim().toLowerCase(),
        phone: c.phone || '',
        type: 'client'
      }));
  } else {
    // All Contacts (Leads + Clients)
    const [leads, clients] = await Promise.all([
      Lead ? Lead.find(filter).lean() : Promise.resolve([]),
      Client ? Client.find(filter).lean() : Promise.resolve([])
    ]);

    const leadRecipients = leads.filter((l) => isValidEmail(l.email)).map((l) => ({
      id: String(l._id),
      name: l.name || 'Contact',
      company: l.company || l.name || '',
      email: l.email.trim().toLowerCase(),
      phone: l.phone || '',
      type: 'lead'
    }));

    const clientRecipients = clients.filter((c) => isValidEmail(c.email)).map((c) => ({
      id: String(c._id),
      name: c.name || 'Client',
      company: c.companyName || c.name || '',
      email: c.email.trim().toLowerCase(),
      phone: c.phone || '',
      type: 'client'
    }));

    const seenEmails = new Set();
    recipients = [...leadRecipients, ...clientRecipients].filter((r) => {
      if (seenEmails.has(r.email)) return false;
      seenEmails.add(r.email);
      return true;
    });
  }

  return recipients;
}

/**
 * Execute email automation drip campaign dispatch.
 */
async function executeCampaign(req, campaignId) {
  const Campaign = getCampaignModel(req);
  const campaign = await Campaign.findOne({ ...baseFilter(req), _id: campaignId });
  if (!campaign) throw appError('Campaign not found', 404);

  const recipients = await getAudienceRecipients(req, campaign.targetAudience);
  if (!recipients.length) {
    return {
      success: true,
      sentCount: 0,
      totalRecipients: 0,
      message: `No recipients with valid email addresses found for segment "${campaign.targetAudience}".`
    };
  }

  let sentCount = 0;
  const maxBatch = 500;
  const dispatchBatch = recipients.slice(0, maxBatch);

  for (const recipient of dispatchBatch) {
    const personalizedSubject = renderTemplate(campaign.subject, recipient);
    const personalizedHtml = renderTemplate(campaign.content, recipient);

    try {
      await MailService.sendViaEmailPlugin(req, {
        to: recipient.email,
        subject: personalizedSubject,
        html: personalizedHtml
      });
      sentCount += 1;

      // Log Lead Activity if recipient is a lead
      if (recipient.type === 'lead') {
        try {
          const LeadEvent = getLeadEventModel(req);
          if (LeadEvent) {
            await LeadEvent.create({
              tenantId: resolveTenantId(req),
              leadId: recipient.id,
              type: 'email',
              title: `Campaign Drip: ${campaign.name}`,
              description: `Automated email sent to ${recipient.email}. Subject: "${personalizedSubject}"`,
              createdBy: resolveUserId(req)
            });
          }
        } catch {
          // Ignore event log failure
        }
      }
    } catch (err) {
      console.warn(`[Marketing Engine] Failed dispatch to ${recipient.email}:`, err.message);
    }
  }

  if (sentCount === 0 && recipients.length > 0) {
    throw appError('Dispatch failed: No emails were sent. Please ensure the Email Service Plugin is enabled and SMTP settings are configured in OpenExt.', 400);
  }

  // Update Campaign Stats and Status
  campaign.stats = campaign.stats || {};
  campaign.stats.sent = (campaign.stats.sent || 0) + sentCount;
  campaign.executedAt = new Date();
  campaign.status = 'Active';
  await campaign.save();

  // Record Audit Trail
  try {
    await AuditService.log({
      req,
      action: 'execute',
      module: 'marketing',
      recordId: String(campaign._id),
      summary: `Dispatched marketing campaign "${campaign.name}" to ${sentCount} recipient(s)`
    });
  } catch {
    // Ignore audit log error
  }

  return {
    success: true,
    sentCount,
    totalRecipients: recipients.length,
    message: `Dispatched campaign "${campaign.name}" to ${sentCount} recipient(s).`
  };
}

/**
 * Send a sample/test email for preview before launching batch drip.
 */
async function sendTestCampaign(req, campaignId, testEmail) {
  if (!isValidEmail(testEmail)) {
    throw appError('Valid test recipient email address is required', 400);
  }

  const campaign = await getCampaignById(req, campaignId);
  const sampleContext = {
    name: 'Sample Contact',
    company: 'Demo Company Ltd',
    email: testEmail.trim().toLowerCase(),
    phone: '+91 9876543210'
  };

  const subject = `[TEST] ${renderTemplate(campaign.subject, sampleContext)}`;
  const html = `
    <div style="padding: 12px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 6px; margin-bottom: 16px; font-family: sans-serif; font-size: 13px; color: #92400e;">
      <strong>⚠️ Marketing Drip Preview:</strong> This is a test preview of campaign <em>"${campaign.name}"</em> sent to verify template rendering.
    </div>
    ${renderTemplate(campaign.content, sampleContext)}
  `;

  await MailService.sendViaEmailPlugin(req, {
    to: testEmail.trim().toLowerCase(),
    subject,
    html
  });

  return {
    success: true,
    to: testEmail,
    message: `Test email sent to ${testEmail}`
  };
}

/**
 * Phase 3: Module 1 Re-Entry Loop & Sales Alerts
 * Automatically transitions a lost/cold lead back into the active pipeline,
 * resets qualification checklist, assigns an urgent priority follow-up task,
 * and updates campaign re-engagement and attributed revenue metrics.
 */
async function reEngageLead(req, { campaignId, leadId, targetStage = 'Contacted', actionType = 'Win-Back Stage Update', notes = '' }) {
  const Campaign = getCampaignModel(req);
  const Lead = getLeadModel(req);
  const Task = getTaskModel(req);
  const LeadEvent = getLeadEventModel(req);

  if (!Lead) throw appError('Lead model is not available', 500);

  const campaign = await Campaign.findOne({ ...baseFilter(req), _id: campaignId });
  if (!campaign) throw appError('Campaign not found', 404);

  const lead = await Lead.findOne({ ...baseFilter(req), _id: leadId });
  if (!lead) throw appError('Lead not found', 404);

  const previousStage = lead.stage || 'Lost';
  const userId = resolveUserId(req);

  const validStages = ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation'];
  const newStage = validStages.includes(targetStage) ? targetStage : 'Contacted';

  // 1. Transition Lead Stage back into Active Sales Funnel (Direct Stage Change)
  lead.stage = newStage;
  lead.status = newStage;
  lead.qualification = lead.qualification || {};
  lead.qualification.status = newStage === 'Qualified' ? 'Qualified' : 'In Review';
  lead.qualification.qualificationNotes = `Won-back via Campaign "${campaign.name}" (${actionType}). ${notes}`.trim();
  lead.qualification.rejectionReason = '';
  lead.qualification.updatedAt = new Date();
  lead.qualification.updatedBy = userId;
  await lead.save();

  // 2. Log Activity Timeline Event on Lead (feeds /marketing/activity)
  if (LeadEvent) {
    try {
      await LeadEvent.create({
        tenantId: resolveTenantId(req),
        leadId: String(lead._id),
        title: `🔥 Pipeline Win-Back: ${campaign.name}`,
        eventType: 'Other',
        eventDate: new Date(),
        status: 'Completed',
        description: `Lead stage updated from "${previousStage}" to "${newStage}" via ${actionType}.`,
        createdBy: userId,
        updatedBy: userId
      });
    } catch {
      // Ignore event logging error
    }
  }

  // 3. Update Campaign Performance Metrics
  campaign.stats = campaign.stats || {};
  campaign.stats.reEngagedLeads = (campaign.stats.reEngagedLeads || 0) + 1;
  const attributedRevenue = lead.expectedRevenue || lead.qualification?.expectedRevenue || 50000;
  campaign.stats.revenueGenerated = (campaign.stats.revenueGenerated || 0) + attributedRevenue;
  await campaign.save();

  // 4. Record CRM Audit Log
  try {
    await AuditService.log({
      req,
      action: 're-engage',
      module: 'marketing',
      recordId: String(campaign._id),
      summary: `Lead "${lead.name}" stage updated from "${previousStage}" to "${newStage}" via marketing campaign "${campaign.name}"`
    });
  } catch {
    // Ignore audit log error
  }

  return {
    success: true,
    lead: {
      id: String(lead._id),
      name: lead.name,
      company: lead.company,
      stage: lead.stage,
      previousStage
    },
    campaignStats: campaign.stats,
    message: `Lead "${lead.name}" stage successfully updated to "${newStage}" and re-entered active sales pipeline!`
  };
}

/**
 * Simulates a live re-engagement event on an existing lost/unqualified lead for testing.
 */
async function simulateReEngagement(req, campaignId) {
  const Lead = getLeadModel(req);
  if (!Lead) throw appError('Lead model is not available', 500);

  const filter = baseFilter(req);

  // Pick a lost, unqualified, or any available lead
  let candidateLead = await Lead.findOne({
    ...filter,
    $or: [{ stage: 'Lost' }, { status: 'Lost' }, { 'qualification.status': 'Rejected' }]
  }).sort({ updatedAt: -1 });

  if (!candidateLead) {
    candidateLead = await Lead.findOne(filter).sort({ createdAt: -1 });
  }

  if (!candidateLead) {
    throw appError('No leads available in CRM to simulate re-engagement. Please create a lead first.', 404);
  }

  return reEngageLead(req, {
    campaignId,
    leadId: String(candidateLead._id),
    actionType: 'Simulated CTA Click & Reply',
    notes: 'Customer clicked "Request Quote" link in drip email.'
  });
}

/**
 * Creates a pending re-engagement approval request for the CRM Manager dashboard.
 */
async function createReEngagementRequest(req, { campaignId, leadId, actionType = 'Email Button Click', notes = '' }) {
  const RequestModel = getReEngagementRequestModel(req);
  const Lead = getLeadModel(req);
  const Campaign = getCampaignModel(req);

  if (!RequestModel) throw appError('ReEngagementRequest model is not available', 500);

  const campaign = await Campaign.findOne({ ...baseFilter(req), _id: campaignId });
  const lead = Lead ? await Lead.findOne({ ...baseFilter(req), _id: leadId }) : null;

  if (!campaign) throw appError('Campaign not found', 404);
  if (!lead) throw appError('Lead not found', 404);

  // Check if a pending request already exists for this lead and campaign
  const existingPending = await RequestModel.findOne({
    tenantId: resolveTenantId(req),
    campaignId: String(campaign._id),
    leadId: String(lead._id),
    status: 'Pending'
  });

  if (existingPending) {
    return { success: true, request: existingPending, message: 'Request is already pending approval by CRM Manager' };
  }

  const expectedRev = lead.expectedRevenue || lead.qualification?.expectedRevenue || 0;

  const newRequest = await RequestModel.create({
    tenantId: resolveTenantId(req),
    campaignId: String(campaign._id),
    campaignName: campaign.name,
    leadId: String(lead._id),
    leadName: lead.name,
    leadCompany: lead.company || lead.name,
    leadEmail: lead.email,
    expectedRevenue: expectedRev,
    actionType,
    notes,
    status: 'Pending'
  });

  return {
    success: true,
    request: newRequest,
    message: `Interest request for "${lead.name}" submitted to CRM Manager dashboard for approval.`
  };
}

/**
 * Lists re-engagement requests for CRM Manager approval queue.
 */
async function listReEngagementRequests(req, query = {}) {
  if (isClientUser(req)) return { items: [], pendingCount: 0 };
  const RequestModel = getReEngagementRequestModel(req);
  if (!RequestModel) return { items: [], pendingCount: 0 };

  const filter = { tenantId: resolveTenantId(req) };
  if (query.status) {
    filter.status = String(query.status).trim();
  }

  const [items, pendingCount] = await Promise.all([
    RequestModel.find(filter).sort({ createdAt: -1 }).limit(100).lean(),
    RequestModel.countDocuments({ tenantId: resolveTenantId(req), status: 'Pending' })
  ]);

  return {
    items: items.map((r) => ({ ...r, id: String(r._id) })),
    pendingCount
  };
}

/**
 * CRM Manager approves a pending re-engagement request.
 * Moves lead stage from Lost -> Contacted, schedules 24h task, and credits revenue.
 */
async function approveReEngagementRequest(req, requestId) {
  const RequestModel = getReEngagementRequestModel(req);
  if (!RequestModel) throw appError('ReEngagementRequest model not available', 500);

  const request = await RequestModel.findOne({
    tenantId: resolveTenantId(req),
    _id: requestId
  });

  if (!request) throw appError('Re-engagement request not found', 404);
  if (request.status === 'Approved') throw appError('Request has already been approved', 400);

  // Execute the pipeline stage conversion and task creation
  const reEngageRes = await reEngageLead(req, {
    campaignId: request.campaignId,
    leadId: request.leadId,
    actionType: request.actionType,
    notes: request.notes || 'Approved by CRM Manager from dashboard'
  });

  request.status = 'Approved';
  request.reviewedBy = resolveUserId(req);
  request.reviewedAt = new Date();
  request.createdTaskId = reEngageRes.taskId;
  await request.save();

  return {
    success: true,
    request,
    lead: reEngageRes.lead,
    message: `Request approved! Customer "${request.leadName}" has been re-activated into sales pipeline (Stage: Contacted).`
  };
}

/**
 * CRM Manager rejects / dismisses a pending re-engagement request.
 */
async function rejectReEngagementRequest(req, requestId, reason = '') {
  const RequestModel = getReEngagementRequestModel(req);
  if (!RequestModel) throw appError('ReEngagementRequest model not available', 500);

  const request = await RequestModel.findOne({
    tenantId: resolveTenantId(req),
    _id: requestId
  });

  if (!request) throw appError('Re-engagement request not found', 404);

  request.status = 'Rejected';
  request.rejectionReason = reason || 'Dismissed by CRM Manager';
  request.reviewedBy = resolveUserId(req);
  request.reviewedAt = new Date();
  await request.save();

  return {
    success: true,
    request,
    message: `Request dismissed. Customer "${request.leadName}" remains in Lost stage.`
  };
}

/**
 * Handles real-time email button clicks from recipients.
 * Creates a Pending Approval request on the CRM Manager dashboard.
 */
async function trackCustomerEmailClick(req, { campaignId, leadId, redirectUrl }) {
  if (campaignId && leadId) {
    try {
      await createReEngagementRequest(req, {
        campaignId,
        leadId,
        actionType: 'Email CTA Button Click',
        notes: 'Customer clicked the interactive interest button in their email message.'
      });
    } catch (err) {
      console.warn('[Marketing Click Track] Error creating approval request:', err.message);
    }
  }
  return {
    success: true,
    redirectUrl: redirectUrl || null
  };
}

/**
 * Pipeline re-entry / win-back activity feed for Marketing Automation UI.
 * Sourced from approved re-engagement requests and lead timeline win-back events.
 */
async function listActivity(req, query = {}) {
  if (isClientUser(req)) return [];

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const tenantId = resolveTenantId(req);
  const events = [];
  const seen = new Set();

  const pushEvent = (item) => {
    const key = `${item.leadId}|${item.campaignId || item.campaignName}|${String(item.createdAt).slice(0, 16)}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(item);
  };

  const RequestModel = getReEngagementRequestModel(req);
  if (RequestModel) {
    try {
      const approved = await RequestModel.find({
        tenantId,
        status: { $in: ['Approved', 'Completed'] }
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(limit)
        .lean();

      for (const row of approved) {
        const createdAt = row.updatedAt || row.createdAt || new Date();
        pushEvent({
          _id: String(row._id),
          leadId: String(row.leadId || ''),
          leadName: row.leadName || 'Unknown lead',
          leadCompany: row.leadCompany || '',
          campaignId: String(row.campaignId || ''),
          campaignName: row.campaignName || 'Campaign',
          previousStage: row.previousStage || 'Lost',
          newStage: row.newStage || 'Contacted',
          actionType: row.actionType || 'Win-Back',
          expectedRevenue: Number(row.expectedRevenue || 0),
          createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt)
        });
      }
    } catch {
      // Ignore request feed errors
    }
  }

  const LeadEvent = getLeadEventModel(req);
  const Lead = getLeadModel(req);
  if (LeadEvent) {
    try {
      const leadEvents = await LeadEvent.find({
        tenantId,
        isDeleted: { $ne: true },
        title: { $regex: /Pipeline Win-Back/i }
      })
        .sort({ createdAt: -1, eventDate: -1 })
        .limit(limit)
        .lean();

      for (const ev of leadEvents) {
        const desc = String(ev.description || '');
        const stageMatch = desc.match(/from "([^"]+)" to "([^"]+)"/i);
        const actionMatch = desc.match(/via (.+?)\.?$/i);
        let leadName = '';
        let leadCompany = '';
        let expectedRevenue = 0;
        if (Lead && ev.leadId) {
          try {
            const lead = await Lead.findOne({ ...baseFilter(req), _id: ev.leadId }).lean();
            if (lead) {
              leadName = lead.name || '';
              leadCompany = lead.company || '';
              expectedRevenue = Number(lead.expectedRevenue || lead.qualification?.expectedRevenue || 0);
            }
          } catch {
            // Ignore lead lookup
          }
        }
        const campaignName = String(ev.title || '')
          .replace(/^🔥\s*Pipeline Win-Back:\s*/i, '')
          .trim() || 'Campaign';
        const createdAt = ev.createdAt || ev.eventDate || new Date();
        pushEvent({
          _id: String(ev._id),
          leadId: String(ev.leadId || ''),
          leadName: leadName || 'Unknown lead',
          leadCompany,
          campaignId: '',
          campaignName,
          previousStage: stageMatch?.[1] || 'Lost',
          newStage: stageMatch?.[2] || 'Contacted',
          actionType: (actionMatch?.[1] || 'Win-Back Stage Update').replace(/\.$/, ''),
          expectedRevenue,
          createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt)
        });
      }
    } catch {
      // Ignore lead-event feed errors
    }
  }

  events.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return events.slice(0, limit);
}

/**
 * Returns list of eligible lost / unqualified leads for the Interactive Re-Entry Selector.
 */
async function getEligibleLeadsForReEngagement(req) {
  const Lead = getLeadModel(req);
  if (!Lead) return [];

  const filter = baseFilter(req);
  const leads = await Lead.find({
    ...filter,
    $or: [
      { stage: 'Lost' },
      { status: 'Lost' },
      { 'qualification.status': 'Rejected' },
      { stage: 'Unqualified' }
    ]
  })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  return leads.map((l) => ({
    id: String(l._id),
    name: l.name,
    company: l.company || l.name,
    email: l.email,
    stage: l.stage || 'Lost',
    expectedRevenue: l.expectedRevenue || l.qualification?.expectedRevenue || 0
  }));
}

/**
 * Get real-time audience contact segment counts.
 */
async function getAudienceStats(req) {
  if (isClientUser(req)) {
    return {
      lostLeads: 0,
      unqualifiedLeads: 0,
      dormantClients: 0,
      totalContacts: 0
    };
  }
  const Lead = getLeadModel(req);
  const Client = getClientModel(req);
  const SalesOrder = getSalesOrderModel(req);

  const filter = baseFilter(req);

  // 1. Lost Leads
  const lostLeadsCount = Lead
    ? await Lead.countDocuments({
      ...filter,
      $or: [{ stage: 'Lost' }, { status: 'Lost' }, { 'qualification.status': 'Rejected' }]
    })
    : 0;

  // 2. Unqualified Leads
  const unqualifiedLeadsCount = Lead
    ? await Lead.countDocuments({
      ...filter,
      $or: [{ 'qualification.status': 'Rejected' }, { stage: 'Unqualified' }, { status: 'Unqualified' }]
    })
    : 0;

  // 3. Dormant Clients (No orders in past 90 days)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const activeClients = Client ? await Client.find(filter).select('_id').lean() : [];
  const recentOrderClientIds = SalesOrder
    ? await SalesOrder.distinct('clientId', {
      ...filter,
      createdAt: { $gte: ninetyDaysAgo }
    })
    : [];

  const recentClientSet = new Set(recentOrderClientIds.map((id) => String(id)));
  const dormantClientsCount = activeClients.filter((c) => !recentClientSet.has(String(c._id))).length;

  const totalContactsCount = (Lead ? await Lead.countDocuments(filter) : 0) + activeClients.length;

  return {
    lostLeads: lostLeadsCount,
    unqualifiedLeads: unqualifiedLeadsCount,
    dormantClients: dormantClientsCount,
    totalContacts: totalContactsCount
  };
}

/**
 * Phase 4: Executive Marketing Analytics & ROI Attribution Engine
 */
async function getMarketingAnalytics(req, query = {}) {
  if (isClientUser(req)) {
    return {
      summary: {
        activeCampaigns: 0,
        totalCampaigns: 0,
        totalSent: 0,
        totalReEngaged: 0,
        totalAttributedRevenue: 0,
        overallEngagementRate: 0,
        avgRevenuePerReEngaged: 0
      },
      audienceStats: { lostLeads: 0, unqualifiedLeads: 0, dormantClients: 0, totalContacts: 0 },
      typeBreakdown: [],
      segmentBreakdown: [],
      leaderboard: [],
      funnel: { totalContactsInCRM: 0, dispatchedEmails: 0, reEngagedLeads: 0, attributedPipelineRevenue: 0 }
    };
  }
  const Campaign = getCampaignModel(req);
  const filter = { ...baseFilter(req) };

  if (query.type) filter.type = String(query.type).trim();
  if (query.status) filter.status = String(query.status).trim();

  const campaigns = await Campaign.find(filter).lean();
  const audienceStats = await getAudienceStats(req);

  // Overall Performance
  const totalCampaigns = campaigns.length;
  const activeCampaigns = campaigns.filter((c) => c.status === 'Active').length;
  const draftCampaigns = campaigns.filter((c) => c.status === 'Draft').length;
  const completedCampaigns = campaigns.filter((c) => c.status === 'Completed').length;

  const totalSent = campaigns.reduce((acc, c) => acc + (c.stats?.sent || 0), 0);
  const totalReEngaged = campaigns.reduce((acc, c) => acc + (c.stats?.reEngagedLeads || 0), 0);
  const totalAttributedRevenue = campaigns.reduce((acc, c) => acc + (c.stats?.revenueGenerated || 0), 0);

  const overallEngagementRate = totalSent > 0 ? Number(((totalReEngaged / totalSent) * 100).toFixed(1)) : 0;
  const avgRevenuePerReEngaged = totalReEngaged > 0 ? Math.round(totalAttributedRevenue / totalReEngaged) : 0;

  // Breakdown by Campaign Type
  const campaignTypes = [
    'Lost Lead Re-engagement',
    'Repeat Business Nurture',
    'Email Drip',
    'Promotional Announcement'
  ];

  const typeBreakdown = campaignTypes.map((type) => {
    const matching = campaigns.filter((c) => c.type === type);
    const sent = matching.reduce((acc, c) => acc + (c.stats?.sent || 0), 0);
    const reEngaged = matching.reduce((acc, c) => acc + (c.stats?.reEngagedLeads || 0), 0);
    const revenue = matching.reduce((acc, c) => acc + (c.stats?.revenueGenerated || 0), 0);
    const rate = sent > 0 ? Number(((reEngaged / sent) * 100).toFixed(1)) : 0;

    return {
      type,
      campaignCount: matching.length,
      sent,
      reEngaged,
      revenueGenerated: revenue,
      conversionRate: rate
    };
  });

  // Breakdown by Target Audience Segment
  const audienceSegments = [
    'Lost Leads',
    'Unqualified Leads',
    'Dormant Clients (>90 days)',
    'All Contacts'
  ];

  const segmentBreakdown = audienceSegments.map((segment) => {
    const matching = campaigns.filter((c) => c.targetAudience === segment);
    const sent = matching.reduce((acc, c) => acc + (c.stats?.sent || 0), 0);
    const reEngaged = matching.reduce((acc, c) => acc + (c.stats?.reEngagedLeads || 0), 0);
    const revenue = matching.reduce((acc, c) => acc + (c.stats?.revenueGenerated || 0), 0);
    const rate = sent > 0 ? Number(((reEngaged / sent) * 100).toFixed(1)) : 0;

    return {
      segment,
      campaignCount: matching.length,
      sent,
      reEngaged,
      revenueGenerated: revenue,
      conversionRate: rate
    };
  });

  // Top Performing Campaigns Leaderboard
  const leaderboard = [...campaigns]
    .sort((a, b) => (b.stats?.revenueGenerated || 0) - (a.stats?.revenueGenerated || 0) || (b.stats?.reEngagedLeads || 0) - (a.stats?.reEngagedLeads || 0))
    .slice(0, 10)
    .map((c) => {
      const sent = c.stats?.sent || 0;
      const reEngaged = c.stats?.reEngagedLeads || 0;
      const revenue = c.stats?.revenueGenerated || 0;
      const conversionRate = sent > 0 ? Number(((reEngaged / sent) * 100).toFixed(1)) : 0;

      return {
        id: String(c._id),
        name: c.name,
        type: c.type,
        targetAudience: c.targetAudience,
        status: c.status,
        sent,
        reEngaged,
        revenueGenerated: revenue,
        conversionRate,
        executedAt: c.executedAt
      };
    });

  // Conversion Funnel
  const funnel = {
    totalContactsInCRM: audienceStats.totalContacts || 0,
    dispatchedEmails: totalSent,
    reEngagedLeads: totalReEngaged,
    attributedPipelineRevenue: totalAttributedRevenue
  };

  return {
    summary: {
      totalCampaigns,
      activeCampaigns,
      draftCampaigns,
      completedCampaigns,
      totalSent,
      totalReEngaged,
      overallEngagementRate,
      totalAttributedRevenue,
      avgRevenuePerReEngaged
    },
    audienceStats,
    typeBreakdown,
    segmentBreakdown,
    leaderboard,
    funnel
  };
}

async function exportMarketing(req, query = {}) {
  if (isClientUser(req)) {
    const format = String(query.format || 'csv').trim().toLowerCase();
    const nowStr = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      return {
        contentType: 'application/json; charset=utf-8',
        format: 'json',
        filename: `marketing_campaigns_export_${nowStr}.json`,
        content: JSON.stringify([], null, 2),
        data: [],
        count: 0
      };
    }
    return {
      contentType: 'text/csv; charset=utf-8',
      format: 'csv',
      filename: `marketing_campaigns_export_${nowStr}.csv`,
      content: '',
      data: '',
      count: 0
    };
  }
  const Campaign = getCampaignModel(req);
  let filter = baseFilter(req);

  if (query.status) filter.status = String(query.status).trim();
  if (query.type) filter.type = String(query.type).trim();
  if (query.search) {
    const s = String(query.search).trim();
    filter.$or = [
      { name: { $regex: s, $options: 'i' } },
      { subject: { $regex: s, $options: 'i' } }
    ];
  }

  const raw = await Campaign.find(filter).sort({ createdAt: -1 }).lean();

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'marketing',
    recordId: 'export',
    description: `Exported ${raw.length} marketing campaigns in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `marketing_campaigns_export_${nowStr}.json`,
      content: JSON.stringify(raw, null, 2),
      data: raw,
      count: raw.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'ID',
    'Campaign Name',
    'Type',
    'Target Audience',
    'Status',
    'Email Subject',
    'Sent Count',
    'Re-Engaged Count',
    'Conversion Count',
    'Attributed Revenue',
    'Scheduled Date',
    'Executed Date',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const c of raw) {
    rows.push(
      [
        c._id,
        c.name || '',
        c.type || '',
        c.targetAudience || c.segment || '',
        c.status || '',
        c.subject || '',
        Number(c.metrics?.sentCount || c.sentCount || 0),
        Number(c.metrics?.reEngagedCount || c.reEngagedCount || 0),
        Number(c.metrics?.conversionCount || c.conversionCount || 0),
        Number(c.metrics?.attributedRevenue || c.attributedRevenue || 0),
        c.scheduledAt ? new Date(c.scheduledAt).toISOString().slice(0, 10) : '',
        c.executedAt ? new Date(c.executedAt).toISOString().slice(0, 10) : '',
        c.createdAt ? new Date(c.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `marketing_campaigns_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: raw.length
  };
}

module.exports = {
  listCampaigns,
  getCampaignById,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getAudienceRecipients,
  executeCampaign,
  sendTestCampaign,
  reEngageLead,
  simulateReEngagement,
  createReEngagementRequest,
  listReEngagementRequests,
  approveReEngagementRequest,
  rejectReEngagementRequest,
  trackCustomerEmailClick,
  getEligibleLeadsForReEngagement,
  listActivity,
  getAudienceStats,
  getMarketingAnalytics,
  renderTemplate,
  exportMarketing
};
