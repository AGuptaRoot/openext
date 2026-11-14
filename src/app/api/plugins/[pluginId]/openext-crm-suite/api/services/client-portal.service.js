'use strict';

const crypto = require('node:crypto');
const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const ClientService = require('./client.service');
const PortalContact = require('../utils/portal-contact.util');
const {
  PORTAL_STATUSES,
  PORTAL_ROLES,
  PORTAL_MODULE_PERMISSIONS
} = require('../models/ClientPortalAccess');

function getPortalModel(req) {
  const ClientPortalAccess = req.cms?.models.get('ClientPortalAccess');
  if (!ClientPortalAccess) throw new Error('ClientPortalAccess model is not registered');
  return ClientPortalAccess;
}

function getContactModel(req) {
  const Contact = req.cms?.models.get('Contact');
  if (!Contact) throw new Error('Contact model is not registered');
  return Contact;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function hashPassword(password) {
  let bcrypt = null;
  try {
    bcrypt = require('bcryptjs');
  } catch (_) {}
  if (!bcrypt) {
    try {
      bcrypt = require('C:/Users/AdarshGupta/Documents/OpenExt/openNext gitlab/node_modules/bcryptjs');
    } catch (_) {}
  }
  if (bcrypt && typeof bcrypt.hashSync === 'function') {
    return bcrypt.hashSync(password, 10);
  }
  return crypto.createHash('sha256').update(password).digest('hex');
}

function isPortalApprover(req) {
  if (!req) return false;
  const userRole = req.user?.role;
  if (typeof userRole === 'number') {
    if (userRole <= 1 || userRole === 100 || userRole === 101) return true;
  }
  const roleStr = String(userRole || req.tenantMembership?.role || req.role || '').toLowerCase();
  const permissions = Array.isArray(req.permissions) ? req.permissions : [];
  return (
    Boolean(req.user?.isAdmin) ||
    Boolean(req.isAdmin) ||
    roleStr === 'crm-manager' ||
    roleStr === 'sales-manager' ||
    roleStr === 'admin' ||
    roleStr === 'superadmin' ||
    permissions.includes('crm.users.manage') ||
    permissions.includes('crm.portal.approve')
  );
}

async function createOrUpdateCmsClientUser(req, { username, email, password, phone, clientId, leadId }) {
  try {
    const conn = await req.cms?.database?.user?.();
    if (!conn) return null;

    const col = conn.db?.collection('users') || (typeof conn.collection === 'function' ? conn.collection('users') : null);
    if (!col) return null;

    const hashedPassword = hashPassword(password);
    const filter = { email: email.toLowerCase() };
    const existing = await col.findOne(filter);

    if (existing) {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: {
            username: username || existing.username,
            password: hashedPassword,
            phoneNumber: phone || existing.phoneNumber,
            role: 'client',
            userType: 'client',
            isClient: true,
            isClientUser: true,
            active: true,
            onboardingCompleted: true,
            ...(clientId ? { clientId: String(clientId) } : {}),
            ...(leadId ? { leadId: String(leadId) } : {})
          }
        }
      );
      return existing._id ? String(existing._id) : null;
    }

    const newDoc = {
      username: username || email.split('@')[0],
      email: email.toLowerCase(),
      password: hashedPassword,
      phoneNumber: phone || '',
      role: 'client',
      userType: 'client',
      isClient: true,
      isClientUser: true,
      active: true,
      onboardingCompleted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(clientId ? { clientId: String(clientId) } : {}),
      ...(leadId ? { leadId: String(leadId) } : {})
    };

    const insertResult = await col.insertOne(newDoc);
    return insertResult?.insertedId ? String(insertResult.insertedId) : null;
  } catch (err) {
    req.cms?.logger?.warn?.('[ClientPortalService] CMS User sync on approval skipped:', err?.message || err);
    return null;
  }
}

async function listPortalAccess(req, clientId) {
  await ClientService.getById(req, clientId);
  const ClientPortalAccess = getPortalModel(req);
  return ClientPortalAccess.find({ ...baseFilter(req), clientId: String(clientId) })
    .sort({ createdAt: -1 })
    .lean();
}

async function sendPortalInvitationEmail(req, { clientName, email, username, password, portalRole }) {
  try {
    const MailService = require('./mail.service');
    const mailConfig = await MailService.resolveMailConfig(req);
    const companyName = mailConfig.fromName || 'Root CRM';

    const { buildClientPortalLoginUrl } = require('../utils/public-origin.util');
    const loginUrl = buildClientPortalLoginUrl(req);

    const subject = `Welcome to the Client Portal - Your Login Credentials for ${clientName || 'Account'}`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff; color: #1e293b;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="font-size: 2.2rem; margin-bottom: 10px;">🔐</div>
          <h2 style="color: #0f172a; margin: 0 0 8px 0; font-size: 1.5rem; font-weight: 800;">Welcome to Your Client Portal</h2>
          <p style="color: #64748b; margin: 0; font-size: 0.95rem; line-height: 1.5;">
            You have been granted secure portal access by <strong>${companyName}</strong>. You can now track ongoing projects, view milestones &amp; tasks, accept quotations, download invoices, make payments, and raise support tickets online.
          </p>
        </div>

        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin-bottom: 24px;">
          <h3 style="margin: 0 0 14px 0; color: #0f172a; font-size: 1rem; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">
            Your Login Credentials
          </h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
            <tr>
              <td style="padding: 7px 0; color: #64748b; width: 140px; font-weight: 500;">Portal Login URL:</td>
              <td style="padding: 7px 0; font-weight: 600;"><a href="${loginUrl}" style="color: #2563eb; text-decoration: none;">${loginUrl}</a></td>
            </tr>
            <tr>
              <td style="padding: 7px 0; color: #64748b; font-weight: 500;">Registered Email:</td>
              <td style="padding: 7px 0; font-weight: 600; color: #0f172a;">${email}</td>
            </tr>
            <tr>
              <td style="padding: 7px 0; color: #64748b; font-weight: 500;">Username:</td>
              <td style="padding: 7px 0; font-weight: 600; color: #0f172a;">${username}</td>
            </tr>
            <tr>
              <td style="padding: 7px 0; color: #64748b; font-weight: 500;">Initial Password:</td>
              <td style="padding: 7px 0; font-weight: 700; color: #2563eb; font-family: monospace; font-size: 1.05rem;">${password}</td>
            </tr>
            <tr>
              <td style="padding: 7px 0; color: #64748b; font-weight: 500;">Portal Role:</td>
              <td style="padding: 7px 0; font-weight: 600; color: #0f172a;">${portalRole}</td>
            </tr>
          </table>
        </div>

        <div style="text-align: center; margin-bottom: 24px;">
          <a href="${loginUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 13px 32px; border-radius: 8px; font-weight: 700; text-decoration: none; font-size: 1rem; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">
            Login to Client Portal →
          </a>
        </div>

        <div style="border-top: 1px solid #f1f5f9; padding-top: 16px; text-align: center;">
          <p style="color: #64748b; font-size: 0.82rem; line-height: 1.5; margin: 0;">
            🔒 For security, please change your password after logging in for the first time.<br>
            If you did not expect this invitation, please contact your account manager.
          </p>
        </div>
      </div>
    `;

    await MailService.sendViaEmailPlugin(req, {
      to: email,
      subject,
      html
    });

    return { sent: true };
  } catch (err) {
    console.warn('[ClientPortalService] Failed to send invitation email:', err?.message || err);
    return { sent: false, error: err?.message || String(err) };
  }
}

/**
 * CRM 3.49.0: the client's Contact row a portal invitation is for — by its id / directory id, else by email.
 * A client without any Contact rows (older data) may still use the client record's own email.
 */
async function clientContactFor(req, clientId, { contactId = '', email = '' } = {}) {
  const Contact = getContactModel(req);
  const q = Contact.find({ tenantId: resolveTenantId(req), companyId: String(clientId), isDeleted: false });
  const rows = (await (q && typeof q.lean === 'function' ? q.lean() : q)) || [];
  const id = String(contactId || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  if (id) {
    const byId = rows.find((r) => String(r._id) === id || String(r.personContactId || '') === id);
    // A contact of this client invited under another email is refused; an unknown id falls back to the email.
    if (byId) return !mail || String(byId.email || '').trim().toLowerCase() === mail ? byId : null;
  }
  if (!mail) return null;
  const byEmail = rows.find((r) => String(r.email || '').trim().toLowerCase() === mail);
  if (byEmail) return byEmail;
  if (!rows.length) {
    const client = await ClientService.getById(req, clientId).catch(() => null);
    if (client && String(client.email || '').trim().toLowerCase() === mail) return { email: mail, personContactId: '' };
  }
  return null;
}

async function inviteContact(req, clientId, input = {}) {
  const client = await ClientService.getById(req, clientId);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  let contactId = String(input.contactId || '').trim();
  let email = String(input.email || '').trim().toLowerCase();
  // CRM 3.49.0: a client's portal user is one of ITS contacts — the Primary or a Secondary one — and sees the
  // client's quotations, invoices and bookings. Any other email is refused. The portal user is tied to that
  // Contact (its directory id), so its IsportalAssigned flag is found from every lead / client of it.
  const contact = await clientContactFor(req, clientId, { contactId, email });
  if (!contact) {
    const error = appError('Choose one of this client’s contacts (Primary or Secondary). Add the person as a contact of the client first.', 422);
    error.code = 'PORTAL_NOT_CLIENT_CONTACT';
    throw error;
  }
  if (!email) email = String(contact.email || '').trim().toLowerCase();
  contactId = String(contact.personContactId || '').trim();
  const contactName = String(input.name || input.contactName || contact.name || '').trim();
  const username = String(input.username || '').trim() || email.split('@')[0];
  const initialPassword = String(input.password || input.initialPassword || '').trim() || crypto.randomBytes(6).toString('base64url');
  const phone = String(input.phone || contact.phone || '').trim();
  const portalRole = PORTAL_ROLES.includes(input.portalRole) ? input.portalRole : 'Standard';

  if (!email) throw appError('Email is required for client portal invitation', 422);
  await PortalContact.assertNotAssigned(req, { contactId, email });

  const ClientPortalAccess = getPortalModel(req);
  const existing = await ClientPortalAccess.findOne({
    tenantId,
    clientId: String(clientId),
    email,
    isDeleted: false
  }).lean();

  if (existing) {
    if (existing.status === 'Suspended') {
      throw appError('This portal user is currently suspended. Use reinstate to restore access.', 409);
    }
    if (existing.status === 'Active') {
      throw appError('This client contact already has active portal access.', 409);
    }
  }

  const invitationToken = crypto.randomBytes(24).toString('hex');
  const invitationExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  let allowedPermissions = Array.isArray(input.allowedPermissions) && input.allowedPermissions.length
    ? input.allowedPermissions.filter((p) => PORTAL_MODULE_PERMISSIONS.includes(p))
    : ['invoices', 'contracts', 'projects', 'documents', 'tickets'];

  const needsApproval = !isPortalApprover(req) || Boolean(input.requestOnly);
  const targetStatus = needsApproval ? 'Pending_Approval' : 'Invited';

  let doc;
  if (existing) {
    doc = await ClientPortalAccess.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          contactId: contactId || existing.contactId,
          contactName: contactName || existing.contactName,
          username: username || existing.username,
          initialPassword: needsApproval ? '' : (initialPassword || existing.initialPassword),
          stagedPassword: needsApproval ? (initialPassword || existing.stagedPassword) : '',
          phone: phone || existing.phone,
          portalRole,
          allowedPermissions,
          invitationToken,
          invitationExpiresAt,
          invitedAt: new Date(),
          invitedBy: userId,
          requestedBy: needsApproval ? userId : (existing.requestedBy || null),
          requestedAt: needsApproval ? new Date() : (existing.requestedAt || null),
          approvedBy: !needsApproval ? userId : null,
          approvedAt: !needsApproval ? new Date() : null,
          rejectionReason: '',
          status: targetStatus,
          updatedBy: userId
        }
      },
      { new: true }
    );
  } else {
    doc = await ClientPortalAccess.create({
      tenantId,
      clientId: String(clientId),
      contactId: contactId || `contact_${Date.now()}`,
      contactName: contactName || client.name,
      username,
      initialPassword: needsApproval ? '' : initialPassword,
      stagedPassword: needsApproval ? initialPassword : '',
      email,
      phone,
      status: targetStatus,
      portalRole,
      allowedPermissions,
      invitationToken,
      invitationExpiresAt,
      invitedAt: new Date(),
      invitedBy: userId,
      requestedBy: needsApproval ? userId : null,
      requestedAt: needsApproval ? new Date() : null,
      approvedBy: !needsApproval ? userId : null,
      approvedAt: !needsApproval ? new Date() : null,
      createdBy: userId,
      updatedBy: userId
    });
  }

  const { buildClientPortalLoginUrl } = require('../utils/public-origin.util');
  const loginUrl = buildClientPortalLoginUrl(req);

  const result = doc.toObject ? doc.toObject() : doc;
  result.loginCredentials = {
    username: result.username || username,
    email: result.email,
    password: initialPassword,
    loginUrl
  };
  result.requiresApproval = needsApproval;

  if (needsApproval) {
    result.emailSent = false;
    await AuditService.log(req, {
      action: 'client_portal_requested',
      module: 'client',
      recordId: String(clientId),
      description: `Submitted client portal access request for ${email} (Username: ${username})`,
      metadata: { clientId: String(clientId), email, username, portalRole, accessId: result._id.toString() }
    });
    return result;
  }

  // Manager direct invite: Create CMS user and dispatch invitation email
  const cmsUserId = await createOrUpdateCmsClientUser(req, {
    username: result.username || username,
    email,
    password: initialPassword,
    phone,
    clientId: String(clientId)
  });
  if (cmsUserId && doc.set) {
    doc.cmsUserId = cmsUserId;
    await doc.save();
  }
  await PortalContact.markAssigned(req, { contactId, email });

  const mailResult = await sendPortalInvitationEmail(req, {
    clientName: client.name || client.companyName || 'Client',
    email,
    username: result.username || username,
    password: initialPassword,
    portalRole
  });

  result.emailSent = mailResult.sent;
  if (!mailResult.sent) {
    result.emailError = mailResult.error;
  }

  await AuditService.log(req, {
    action: 'client_portal_invited',
    module: 'client',
    recordId: String(clientId),
    description: `Sent client portal invitation to ${email} (Username: ${username}, Role: ${portalRole})`,
    metadata: { clientId: String(clientId), email, username, portalRole, accessId: result._id.toString(), emailSent: mailResult.sent }
  });

  return result;
}

/* ------------------------------------------------------------------ *
 * Lead-side portal access
 *
 * A lead whose deal has reached Requirement Confirmed can be given portal
 * credentials without being converted into a client first — converting is a
 * separate, deliberate step and this must not trigger it. The access row is
 * therefore keyed on leadId with no clientId, and the lead's stage is never
 * touched here.
 * ------------------------------------------------------------------ */

/** Lead record, with the caller's read access enforced. */
async function loadLeadOrThrow(req, leadId) {
  const LeadService = require('./lead.service');
  return LeadService.getById(req, leadId, { includeQuality: false });
}

function leadDisplayName(lead) {
  return (
    lead?.company || lead?.name || lead?.contactName || 'Lead'
  );
}

async function listLeadPortalAccess(req, leadId) {
  await loadLeadOrThrow(req, leadId);
  const ClientPortalAccess = getPortalModel(req);
  return ClientPortalAccess.find({ ...baseFilter(req), leadId: String(leadId) })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Whether this lead has a deal far enough along to be given portal access.
 *
 * Returns a reason string when it does not, so the caller can show the same
 * sentence the button's tooltip uses.
 */
async function describeLeadPortalBlock(req, leadId) {
  const Opportunity = req.cms?.models.get('Opportunity');
  // Without the model registered there is nothing to check against; allow it
  // rather than blocking the flow on a deployment detail.
  if (!Opportunity) return '';

  let deals = [];
  try {
    deals = await Opportunity.find({
      ...baseFilter(req),
      leadId: String(leadId)
    }).lean();
  } catch {
    return '';
  }
  if (!deals || !deals.length) {
    return 'Create an opportunity for this lead before sending portal access.';
  }

  const PipelineService = require('./opportunity-pipeline.service');
  for (const deal of deals) {
    const reached = await PipelineService.isStageAtOrAfterRequirementConfirmed(
      req,
      deal.stage,
      deal.pipelineId
    ).catch(() => false);
    if (reached) return '';
  }
  return 'Portal access can be sent once the deal reaches Requirement Confirmed.';
}

/**
 * Create (or refresh) portal credentials for a lead and email them over.
 *
 * Deliberately does not convert the lead, create a client, or move the lead's
 * stage — the caller asked for portal access, nothing else.
 */
/**
 * Open (or close) the lead's deals to the portal.
 *
 * The flag lives on the opportunity because a lead has no Client record to
 * hang it on: a portal login resolves to a lead and then asks "does one of
 * their deals allow this?". Every deal of the lead is set, so whichever one is
 * inspected gives the same answer.
 */
async function setLeadPortalFlag(req, leadId, enabled) {
  const Opportunity = req.cms?.models.get('Opportunity');
  const Lead = req.cms?.models.get('Lead');
  const userId = resolveUserId(req);
  let modifiedCount = 0;
  try {
    if (Opportunity && typeof Opportunity.updateMany === 'function') {
      const result = await Opportunity.updateMany(
        { ...baseFilter(req), leadId: String(leadId) },
        {
          $set: {
            isPortal: Boolean(enabled),
            portalEnabledAt: enabled ? new Date() : null,
            portalEnabledBy: enabled ? userId : '',
            updatedBy: userId
          }
        }
      );
      modifiedCount = result?.modifiedCount || 0;
    }
  } catch {
    // The invitation still stands; the flag can be re-applied by resending.
  }

  try {
    if (Lead && typeof Lead.updateOne === 'function') {
      await Lead.updateOne(
        { ...baseFilter(req), _id: String(leadId) },
        {
          $set: {
            isPortal: Boolean(enabled),
            portalEnabledAt: enabled ? new Date() : null,
            portalEnabledBy: enabled ? userId : '',
            updatedBy: userId
          }
        }
      );
    }
  } catch {
    // Lead isPortal flag sync failure handled gracefully
  }

  return modifiedCount;
}

async function inviteLeadContact(req, leadId, input = {}) {
  const lead = await loadLeadOrThrow(req, leadId);
  const { assertLeadWriteAccess } = require('../utils/sales-access.util');
  assertLeadWriteAccess(req, lead);

  const blocked = await describeLeadPortalBlock(req, leadId);
  if (blocked) throw appError(blocked, 409);

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const email = String(input.email || lead.email || '').trim().toLowerCase();
  if (!email) throw appError('Email is required for client portal invitation', 422);
  await PortalContact.assertNotAssigned(req, { contactId: lead.contactId, email });
  const username = String(input.username || '').trim() || email.split('@')[0];
  const initialPassword =
    String(input.password || input.initialPassword || '').trim() ||
    crypto.randomBytes(6).toString('base64url');
  const portalRole = PORTAL_ROLES.includes(input.portalRole) ? input.portalRole : 'Standard';
  const allowedPermissions = ['invoices', 'contracts', 'projects', 'documents', 'tickets'];

  const ClientPortalAccess = getPortalModel(req);
  const existing = await ClientPortalAccess.findOne({
    tenantId,
    leadId: String(leadId),
    email,
    isDeleted: false
  }).lean();

  if (existing && existing.status === 'Suspended') {
    throw appError('This portal user is currently suspended. Use reinstate to restore access.', 409);
  }

  const invitationToken = crypto.randomBytes(24).toString('hex');
  const invitationExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const needsApproval = !isPortalApprover(req) || Boolean(input.requestOnly);
  const targetStatus = needsApproval ? 'Pending_Approval' : 'Invited';

  let doc;
  if (existing) {
    doc = await ClientPortalAccess.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          contactName: lead.name || lead.contactName || existing.contactName,
          username,
          initialPassword: needsApproval ? '' : (initialPassword || existing.initialPassword),
          stagedPassword: needsApproval ? (initialPassword || existing.stagedPassword) : '',
          phone: String(input.phone || lead.phone || existing.phone || '').trim(),
          portalRole,
          invitationToken,
          invitationExpiresAt,
          invitedAt: new Date(),
          invitedBy: userId,
          requestedBy: needsApproval ? userId : (existing.requestedBy || null),
          requestedAt: needsApproval ? new Date() : (existing.requestedAt || null),
          approvedBy: !needsApproval ? userId : null,
          approvedAt: !needsApproval ? new Date() : null,
          rejectionReason: '',
          status: targetStatus,
          updatedBy: userId
        }
      },
      { new: true }
    );
  } else {
    doc = await ClientPortalAccess.create({
      tenantId,
      // Left blank on purpose: granting portal access must not turn the lead
      // into a client, and must not look like it did.
      clientId: '',
      leadId: String(leadId),
      contactId: '',
      contactName: lead.name || lead.contactName || leadDisplayName(lead),
      username,
      initialPassword: needsApproval ? '' : initialPassword,
      stagedPassword: needsApproval ? initialPassword : '',
      email,
      phone: String(input.phone || lead.phone || '').trim(),
      status: targetStatus,
      portalRole,
      allowedPermissions,
      invitationToken,
      invitationExpiresAt,
      invitedAt: new Date(),
      invitedBy: userId,
      requestedBy: needsApproval ? userId : null,
      requestedAt: needsApproval ? new Date() : null,
      approvedBy: !needsApproval ? userId : null,
      approvedAt: !needsApproval ? new Date() : null,
      createdBy: userId,
      updatedBy: userId
    });
  }

  const { buildClientPortalLoginUrl } = require('../utils/public-origin.util');
  const result = doc.toObject ? doc.toObject() : doc;
  result.loginCredentials = {
    username: result.username || username,
    email: result.email,
    password: initialPassword,
    loginUrl: buildClientPortalLoginUrl(req)
  };
  result.requiresApproval = needsApproval;

  if (needsApproval) {
    result.emailSent = false;
    await AuditService.log(req, {
      action: 'lead_portal_requested',
      module: 'lead',
      recordId: String(leadId),
      description: `Submitted lead portal access request for ${email} (Username: ${username})`,
      metadata: { leadId: String(leadId), email, username, portalRole, accessId: result._id.toString() }
    });
    return result;
  }

  // Manager direct invite: Create CMS user and dispatch invitation email
  const cmsUserId = await createOrUpdateCmsClientUser(req, {
    username: result.username || username,
    email,
    password: initialPassword,
    phone: String(input.phone || lead.phone || '').trim(),
    leadId: String(leadId)
  });
  if (cmsUserId && doc.set) {
    doc.cmsUserId = cmsUserId;
    await doc.save();
  }
  await PortalContact.markAssigned(req, { contactId: lead.contactId, email });

  const mailResult = await sendPortalInvitationEmail(req, {
    clientName: leadDisplayName(lead),
    email,
    username: result.username || username,
    password: initialPassword,
    portalRole
  });
  result.emailSent = mailResult.sent;
  if (!mailResult.sent) result.emailError = mailResult.error;

  // Opens the lead's deals so the invited address can actually sign in.
  const flaggedDeals = await setLeadPortalFlag(req, leadId, true);
  result.portalEnabledOpportunities = flaggedDeals;

  await AuditService.log(req, {
    action: 'lead_portal_invited',
    module: 'lead',
    recordId: String(leadId),
    description: `Sent client portal invitation to ${email} (Username: ${username})`,
    metadata: {
      leadId: String(leadId),
      email,
      username,
      portalRole,
      accessId: String(result._id),
      emailSent: mailResult.sent,
      leadStageUnchanged: lead.stage || '',
      portalEnabledOpportunities: flaggedDeals
    }
  });

  return result;
}

/**
 * Withdraw a lead's portal access.
 *
 * The invitation row is deactivated and, once no usable invitation is left for
 * that lead, the deals are closed to the portal again so the login resolves to
 * nothing instead of silently keeping its old scope.
 */
async function revokeLeadPortalAccess(req, leadId, accessId) {
  const lead = await loadLeadOrThrow(req, leadId);
  const { assertLeadWriteAccess } = require('../utils/sales-access.util');
  assertLeadWriteAccess(req, lead);

  const ClientPortalAccess = getPortalModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const existing = await ClientPortalAccess.findOne({
    tenantId,
    _id: String(accessId),
    leadId: String(leadId),
    isDeleted: false
  }).lean();
  if (!existing) throw appError('Portal access not found for this lead', 404);

  await ClientPortalAccess.findOneAndUpdate(
    { _id: existing._id },
    {
      $set: {
        status: 'Deactivated',
        invitationToken: null,
        invitationExpiresAt: null,
        updatedBy: userId
      }
    },
    { new: true }
  );

  const remaining = await ClientPortalAccess.find({
    tenantId,
    leadId: String(leadId),
    isDeleted: false,
    status: { $nin: ['Deactivated', 'Suspended'] }
  }).lean();

  let closedDeals = 0;
  if (!remaining || !remaining.length) {
    closedDeals = await setLeadPortalFlag(req, leadId, false);
  }
  await PortalContact.releaseIfUnused(req, { contactId: lead.contactId, email: existing.email });

  await AuditService.log(req, {
    action: 'lead_portal_revoked',
    module: 'lead',
    recordId: String(leadId),
    description: `Revoked client portal access for ${existing.email}`,
    metadata: {
      leadId: String(leadId),
      email: existing.email,
      accessId: String(existing._id),
      portalClosedOpportunities: closedDeals
    }
  });

  return { accessId: String(existing._id), portalClosedOpportunities: closedDeals };
}

async function resendInvitation(req, clientId, accessId) {
  const client = await ClientService.getById(req, clientId);
  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const existing = await ClientPortalAccess.findOne({
    ...baseFilter(req),
    _id: accessId,
    clientId: String(clientId)
  });

  if (!existing) throw appError('Portal access record not found', 404);
  if (existing.status === 'Suspended') throw appError('Cannot resend invitation to a suspended user', 409);

  const invitationToken = crypto.randomBytes(24).toString('hex');
  const invitationExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  existing.invitationToken = invitationToken;
  existing.invitationExpiresAt = invitationExpiresAt;
  existing.invitedAt = new Date();
  existing.invitedBy = userId;
  existing.status = 'Invited';
  existing.updatedBy = userId;
  await existing.save();

  const mailResult = await sendPortalInvitationEmail(req, {
    clientName: client.name || client.companyName || 'Client',
    email: existing.email,
    username: existing.username || existing.email.split('@')[0],
    password: existing.initialPassword || '******',
    portalRole: existing.portalRole || 'Standard'
  });

  const resObj = existing.toObject ? existing.toObject() : existing;
  resObj.emailSent = mailResult.sent;
  if (!mailResult.sent) {
    resObj.emailError = mailResult.error;
  }

  await AuditService.log(req, {
    action: 'client_portal_invitation_resent',
    module: 'client',
    recordId: String(clientId),
    description: `Resent client portal invitation to ${existing.email}`,
    metadata: { clientId: String(clientId), email: existing.email, accessId: String(accessId), emailSent: mailResult.sent }
  });

  return resObj;
}

async function activatePortalAccess(req, clientId, accessId) {
  await ClientService.getById(req, clientId);
  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const updated = await ClientPortalAccess.findOneAndUpdate(
    { ...baseFilter(req), _id: accessId, clientId: String(clientId) },
    {
      $set: {
        status: 'Active',
        activatedAt: new Date(),
        invitationToken: null,
        invitationExpiresAt: null,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (!updated) throw appError('Portal access record not found', 404);

  await AuditService.log(req, {
    action: 'client_portal_activated',
    module: 'client',
    recordId: String(clientId),
    description: `Activated client portal access for ${updated.email}`,
    metadata: { clientId: String(clientId), email: updated.email, accessId: String(accessId) }
  });

  return updated;
}

async function suspendPortalAccess(req, clientId, accessId, reason = '') {
  await ClientService.getById(req, clientId);
  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const updated = await ClientPortalAccess.findOneAndUpdate(
    { ...baseFilter(req), _id: accessId, clientId: String(clientId) },
    {
      $set: {
        status: 'Suspended',
        suspendedAt: new Date(),
        suspendedBy: userId,
        suspensionReason: String(reason || 'Suspended by admin').slice(0, 500),
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (!updated) throw appError('Portal access record not found', 404);

  await AuditService.log(req, {
    action: 'client_portal_suspended',
    module: 'client',
    recordId: String(clientId),
    description: `Suspended client portal access for ${updated.email}: ${reason || 'Administrative action'}`,
    metadata: { clientId: String(clientId), email: updated.email, accessId: String(accessId), reason }
  });

  return updated;
}

async function reinstatePortalAccess(req, clientId, accessId) {
  await ClientService.getById(req, clientId);
  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const updated = await ClientPortalAccess.findOneAndUpdate(
    { ...baseFilter(req), _id: accessId, clientId: String(clientId) },
    {
      $set: {
        status: 'Active',
        suspendedAt: null,
        suspendedBy: null,
        suspensionReason: '',
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (!updated) throw appError('Portal access record not found', 404);

  await AuditService.log(req, {
    action: 'client_portal_reinstated',
    module: 'client',
    recordId: String(clientId),
    description: `Reinstated client portal access for ${updated.email}`,
    metadata: { clientId: String(clientId), email: updated.email, accessId: String(accessId) }
  });

  return updated;
}

async function updatePermissions(req, clientId, accessId, payload = {}) {
  await ClientService.getById(req, clientId);
  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const updateSet = { updatedBy: userId };
  if (payload.portalRole && PORTAL_ROLES.includes(payload.portalRole)) {
    updateSet.portalRole = payload.portalRole;
  }
  if (Array.isArray(payload.allowedPermissions)) {
    updateSet.allowedPermissions = payload.allowedPermissions.filter((p) =>
      PORTAL_MODULE_PERMISSIONS.includes(p)
    );
  }
  if (payload.twoFactorEnabled !== undefined) {
    updateSet.twoFactorEnabled = Boolean(payload.twoFactorEnabled);
  }

  const updated = await ClientPortalAccess.findOneAndUpdate(
    { ...baseFilter(req), _id: accessId, clientId: String(clientId) },
    { $set: updateSet },
    { new: true }
  ).lean();

  if (!updated) throw appError('Portal access record not found', 404);

  await AuditService.log(req, {
    action: 'client_portal_permissions_updated',
    module: 'client',
    recordId: String(clientId),
    description: `Updated portal access permissions for ${updated.email}`,
    metadata: { clientId: String(clientId), email: updated.email, accessId: String(accessId) }
  });

  return updated;
}

async function revokePortalAccess(req, clientId, accessId) {
  await ClientService.getById(req, clientId);
  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const existing = await ClientPortalAccess.findOne({
    ...baseFilter(req),
    _id: accessId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Portal access record not found', 404);

  await ClientPortalAccess.findOneAndUpdate(
    { ...baseFilter(req), _id: accessId },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        status: 'Deactivated',
        updatedBy: userId
      }
    }
  );

  await PortalContact.releaseIfUnused(req, { contactId: existing.contactId, email: existing.email });

  await AuditService.log(req, {
    action: 'client_portal_revoked',
    module: 'client',
    recordId: String(clientId),
    description: `Revoked portal access for ${existing.email}`,
    metadata: { clientId: String(clientId), email: existing.email, accessId: String(accessId) }
  });

  return { success: true, message: 'Portal access revoked' };
}

/** The Contact an access row is for: the lead's contact (lead portal) or the row's own contact id, and its email. */
async function portalContactRef(req, access) {
  let contactId = String(access.contactId || '');
  if (access.leadId) {
    try {
      const lead = await loadLeadOrThrow(req, access.leadId);
      if (lead && lead.contactId) contactId = String(lead.contactId);
    } catch (_) {}
  }
  return { contactId, email: access.email };
}

/** Whether the lead's Contact already has its portal user (Lead / Opportunity pages hide Create Portal). */
async function leadContactPortalAssigned(req, leadId) {
  const lead = await loadLeadOrThrow(req, leadId);
  return PortalContact.isAssigned(req, { contactId: lead.contactId, email: lead.email });
}

async function approvePortalAccess(req, clientIdOrLeadId, accessId) {
  if (!isPortalApprover(req)) {
    throw appError('Only Sales Managers and Administrators can approve portal access requests', 403);
  }

  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const existing = await ClientPortalAccess.findOne({
    ...baseFilter(req),
    _id: accessId
  });

  if (!existing) throw appError('Portal access request not found', 404);
  if (existing.status !== 'Pending_Approval') {
    throw appError(`Cannot approve portal request with status: ${existing.status}`, 409);
  }

  const contactRef = await portalContactRef(req, existing);
  await PortalContact.assertNotAssigned(req, contactRef);

  const targetPassword = existing.stagedPassword || existing.initialPassword || crypto.randomBytes(6).toString('base64url');
  const targetUsername = existing.username || existing.email.split('@')[0];

  // 1. Create or update CMS user with client role
  const cmsUserId = await createOrUpdateCmsClientUser(req, {
    username: targetUsername,
    email: existing.email,
    password: targetPassword,
    phone: existing.phone,
    clientId: existing.clientId,
    leadId: existing.leadId
  });

  // 2. If this is a lead portal, open opportunity portal flags
  if (existing.leadId) {
    await setLeadPortalFlag(req, existing.leadId, true);
  }

  // 3. Update ClientPortalAccess record
  existing.status = 'Active';
  existing.approvedBy = userId;
  existing.approvedAt = new Date();
  existing.activatedAt = new Date();
  existing.cmsUserId = cmsUserId || existing.cmsUserId || null;
  existing.stagedPassword = '';
  existing.initialPassword = ''; // Wipe plaintext
  existing.rejectionReason = '';
  existing.updatedBy = userId;
  await existing.save();
  await PortalContact.markAssigned(req, contactRef);

  // 4. Send email to client
  let clientName = existing.contactName || 'Client';
  if (existing.clientId) {
    try {
      const client = await ClientService.getById(req, existing.clientId);
      if (client?.name) clientName = client.name;
    } catch (_) {}
  } else if (existing.leadId) {
    try {
      const lead = await loadLeadOrThrow(req, existing.leadId);
      if (lead) clientName = leadDisplayName(lead);
    } catch (_) {}
  }

  const mailResult = await sendPortalInvitationEmail(req, {
    clientName,
    email: existing.email,
    username: targetUsername,
    password: targetPassword,
    portalRole: existing.portalRole || 'Standard'
  });

  const resObj = existing.toObject ? existing.toObject() : existing;
  resObj.emailSent = mailResult.sent;
  if (!mailResult.sent) {
    resObj.emailError = mailResult.error;
  }

  await AuditService.log(req, {
    action: 'client_portal_approved',
    module: existing.clientId ? 'client' : 'lead',
    recordId: String(existing.clientId || existing.leadId || ''),
    description: `Approved portal access for ${existing.email} (Username: ${targetUsername})`,
    metadata: {
      email: existing.email,
      username: targetUsername,
      accessId: String(accessId),
      approvedBy: userId,
      emailSent: mailResult.sent
    }
  });

  return resObj;
}

async function rejectPortalAccess(req, clientIdOrLeadId, accessId, input = {}) {
  if (!isPortalApprover(req)) {
    throw appError('Only Sales Managers and Administrators can reject portal access requests', 403);
  }

  const reason = String(input.reason || input.rejectionReason || '').trim();
  if (!reason) {
    throw appError('Rejection reason is required', 422);
  }

  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const existing = await ClientPortalAccess.findOne({
    ...baseFilter(req),
    _id: accessId
  });

  if (!existing) throw appError('Portal access request not found', 404);
  if (existing.status !== 'Pending_Approval') {
    throw appError(`Cannot reject portal request with status: ${existing.status}`, 409);
  }

  existing.status = 'Rejected';
  existing.rejectionReason = reason.slice(0, 500);
  existing.rejectedBy = userId;
  existing.rejectedAt = new Date();
  existing.stagedPassword = '';
  existing.updatedBy = userId;
  await existing.save();

  await AuditService.log(req, {
    action: 'client_portal_rejected',
    module: existing.clientId ? 'client' : 'lead',
    recordId: String(existing.clientId || existing.leadId || ''),
    description: `Rejected portal access request for ${existing.email}: ${reason}`,
    metadata: {
      email: existing.email,
      accessId: String(accessId),
      rejectedBy: userId,
      reason
    }
  });

  return existing.toObject ? existing.toObject() : existing;
}

async function resubmitPortalAccess(req, clientIdOrLeadId, accessId, input = {}) {
  const ClientPortalAccess = getPortalModel(req);
  const userId = resolveUserId(req);

  const existing = await ClientPortalAccess.findOne({
    ...baseFilter(req),
    _id: accessId
  });

  if (!existing) throw appError('Portal access request not found', 404);
  if (existing.status !== 'Rejected') {
    throw appError('Only rejected portal requests can be resubmitted', 409);
  }
  // The Contact got its portal user meanwhile (another lead, client or request): no second request.
  await PortalContact.assertNotAssigned(req, await portalContactRef(req, existing));

  const username = String(input.username || existing.username || '').trim();
  const password = String(input.password || input.initialPassword || '').trim() || crypto.randomBytes(6).toString('base64url');
  const phone = input.phone !== undefined ? String(input.phone).trim() : existing.phone;

  existing.status = 'Pending_Approval';
  existing.username = username;
  existing.stagedPassword = password;
  existing.phone = phone;
  existing.rejectionReason = '';
  existing.rejectedBy = null;
  existing.rejectedAt = null;
  existing.requestedBy = userId;
  existing.requestedAt = new Date();
  existing.updatedBy = userId;
  await existing.save();

  await AuditService.log(req, {
    action: 'client_portal_resubmitted',
    module: existing.clientId ? 'client' : 'lead',
    recordId: String(existing.clientId || existing.leadId || ''),
    description: `Resubmitted portal access request for ${existing.email}`,
    metadata: {
      email: existing.email,
      accessId: String(accessId),
      requestedBy: userId
    }
  });

  return existing.toObject ? existing.toObject() : existing;
}

async function listPendingApprovals(req) {
  const ClientPortalAccess = getPortalModel(req);
  const rows = await ClientPortalAccess.find({
    ...baseFilter(req),
    status: 'Pending_Approval'
  })
    .sort({ requestedAt: -1, createdAt: -1 })
    .lean();

  if (!rows.length) return [];

  const { resolveUsernames } = require('../utils/user.util');
  const requesterIds = rows.map((r) => r.requestedBy).filter(Boolean);
  const userMap = await resolveUsernames(req, requesterIds);

  const clientIds = rows.map((r) => r.clientId).filter(Boolean);
  const leadIds = rows.map((r) => r.leadId).filter(Boolean);

  const ClientModel = req.cms?.models.get('Client') || req.cms?.models.get('Company');
  const LeadModel = req.cms?.models.get('Lead');

  const clientMap = {};
  if (ClientModel && clientIds.length) {
    try {
      const clients = await ClientModel.find({
        ...baseFilter(req),
        _id: { $in: clientIds }
      }).select('name companyName email').lean();
      for (const c of clients) {
        clientMap[String(c._id)] = c.name || c.companyName || c.email;
      }
    } catch (_) {}
  }

  const leadMap = {};
  if (LeadModel && leadIds.length) {
    try {
      const leads = await LeadModel.find({
        ...baseFilter(req),
        _id: { $in: leadIds }
      }).select('name company contactName email').lean();
      for (const l of leads) {
        leadMap[String(l._id)] = l.company || l.name || l.contactName || l.email;
      }
    } catch (_) {}
  }

  return rows.map((r) => {
    const isLead = Boolean(r.leadId);
    const targetId = isLead ? r.leadId : r.clientId;
    const accountName = isLead ? leadMap[r.leadId] || r.contactName || 'Lead' : clientMap[r.clientId] || r.contactName || 'Client';
    const requesterName = r.requestedBy ? userMap[r.requestedBy] || r.requestedBy : 'Sales Rep';

    return {
      _id: String(r._id),
      id: String(r._id),
      email: r.email,
      username: r.username,
      contactName: r.contactName,
      phone: r.phone,
      portalRole: r.portalRole,
      status: r.status,
      isLead,
      targetId,
      clientId: r.clientId || null,
      leadId: r.leadId || null,
      accountName,
      requestedBy: r.requestedBy,
      requestedByName: requesterName,
      requestedAt: r.requestedAt || r.createdAt,
      createdAt: r.createdAt
    };
  });
}

module.exports = {
  clientContactFor,
  leadContactPortalAssigned,
  listPortalAccess,
  inviteContact,
  listLeadPortalAccess,
  inviteLeadContact,
  revokeLeadPortalAccess,
  setLeadPortalFlag,
  describeLeadPortalBlock,
  resendInvitation,
  activatePortalAccess,
  suspendPortalAccess,
  reinstatePortalAccess,
  updatePermissions,
  revokePortalAccess,
  approvePortalAccess,
  rejectPortalAccess,
  resubmitPortalAccess,
  listPendingApprovals,
  isPortalApprover,
  createOrUpdateCmsClientUser,
  PORTAL_STATUSES,
  PORTAL_ROLES,
  PORTAL_MODULE_PERMISSIONS
};
