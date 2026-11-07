'use strict';

const { resolveTenantId } = require('./tenant.util');

/**
 * Portal contact assignment (CRM 3.36.0).
 *
 * Once a Contact has been given a portal user (a direct invite, or an approved request), the Contact
 * carries `IsportalAssigned: true`. Lead, Opportunity and Client pages stop offering Create / Assign
 * Portal for it, and every invite / approval is refused for it here, so a second portal user is never
 * made for the same Contact even when the page is bypassed. When the last portal user of that Contact
 * is revoked, the flag is cleared again so access can be granted anew (as before).
 */

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
/** Statuses of an access row that has a portal user behind it. */
const ASSIGNED_STATUSES = ['Active', 'Invited', 'Suspended'];

function getModel(req, name) {
  return req?.cms?.models?.get?.(name) || null;
}

function lean(q) {
  return q && typeof q.lean === 'function' ? q.lean() : q;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * The Contact(s) a portal invitation is for: the given contact id when it is a Contact, else the
 * Contacts with that email (duplicates are allowed, so there may be more than one).
 */
async function findContacts(req, { contactId, email } = {}) {
  const PersonContact = getModel(req, 'PersonContact');
  if (!PersonContact) return [];
  const tenantId = resolveTenantId(req);
  const id = String(contactId || '').trim();
  if (OBJECT_ID_RE.test(id)) {
    const one = await lean(PersonContact.findOne({ tenantId, _id: id, isDeleted: false }));
    if (one) return [one];
  }
  const mail = normalizeEmail(email);
  if (!mail) return [];
  const list = await lean(PersonContact.find({ tenantId, email: mail, isDeleted: false }));
  return Array.isArray(list) ? list : [];
}

async function isAssigned(req, ref) {
  const contacts = await findContacts(req, ref);
  return contacts.some((c) => c && c.IsportalAssigned === true);
}

/** Refuses a portal creation / assignment for a Contact that already has its portal user (409). */
async function assertNotAssigned(req, ref) {
  if (await isAssigned(req, ref)) {
    const error = new Error('This contact already has a client portal user. Portal access cannot be assigned again.');
    error.status = 409;
    error.code = 'PORTAL_ALREADY_ASSIGNED';
    throw error;
  }
}

async function setFlag(req, ref, value) {
  const PersonContact = getModel(req, 'PersonContact');
  if (!PersonContact) return 0;
  const contacts = await findContacts(req, ref);
  const ids = contacts.map((c) => String(c._id)).filter(Boolean);
  if (!ids.length) return 0;
  const set = value
    ? { IsportalAssigned: true, portalAssignedAt: new Date() }
    : { IsportalAssigned: false, portalAssignedAt: null };
  await PersonContact.updateMany({ tenantId: resolveTenantId(req), _id: { $in: ids } }, { $set: set });
  return ids.length;
}

/** After a portal user was created for the Contact. Never fails the portal action itself. */
async function markAssigned(req, ref) {
  try {
    return await setFlag(req, ref, true);
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] portal contact flag not saved:', error?.message || error);
    return 0;
  }
}

/** After a revoke: clears the flag when no portal user is left for that email. */
async function releaseIfUnused(req, ref) {
  try {
    const ClientPortalAccess = getModel(req, 'ClientPortalAccess');
    const mail = normalizeEmail(ref && ref.email);
    if (ClientPortalAccess && mail) {
      const left = await lean(ClientPortalAccess.findOne({
        tenantId: resolveTenantId(req),
        email: mail,
        isDeleted: false,
        status: { $in: ASSIGNED_STATUSES }
      }));
      if (left) return 0;
    }
    return await setFlag(req, ref, false);
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] portal contact flag not cleared:', error?.message || error);
    return 0;
  }
}

module.exports = { findContacts, isAssigned, assertNotAssigned, markAssigned, releaseIfUnused, ASSIGNED_STATUSES };
