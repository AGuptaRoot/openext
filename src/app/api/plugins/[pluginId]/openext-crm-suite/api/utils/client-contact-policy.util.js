'use strict';

const { resolveTenantId } = require('./tenant.util');

/**
 * Client ↔ Contact rule.
 *
 * CRM 3.46.0: ONE Client has ONE Primary Contact and any number of Secondary Contacts (up to
 * MAX_CONTACTS_PER_CLIENT, a safety cap). CRM 3.42.0 allowed only one; no data changed between them
 * (Contact rows carry companyId + isPrimary; PersonContact keeps clientIds as a list).
 *
 * - The linked (Primary) Contact is the primary row, else the oldest one. Every client flow (documents,
 *   portal access, quotations) reads it through linkedContact().
 * - A new row is always the primary while the client has none; later rows are Secondary unless asked.
 * - The primary moves only by making another row primary; removing the primary promotes the oldest one left.
 * - The client keeps at least one Contact.
 */

const MAX_CONTACTS_PER_CLIENT = 50;

function getContactModel(req) {
  return req?.cms?.models?.get?.('Contact') || null;
}

function lean(q) {
  return q && typeof q.lean === 'function' ? q.lean() : q;
}

function rowsFilter(req, companyId) {
  return { tenantId: resolveTenantId(req), companyId: String(companyId), isDeleted: false };
}

function codedError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  return error;
}

async function countContacts(req, companyId) {
  const Contact = getContactModel(req);
  if (!Contact || !companyId) return 0;
  if (typeof Contact.countDocuments === 'function') return Contact.countDocuments(rowsFilter(req, companyId));
  const rows = await lean(Contact.find(rowsFilter(req, companyId)));
  return Array.isArray(rows) ? rows.length : 0;
}

/** The client's linked Contact row (primary, else oldest), or null. */
async function linkedContact(req, companyId) {
  const Contact = getContactModel(req);
  if (!Contact || !companyId) return null;
  const query = Contact.findOne(rowsFilter(req, companyId));
  const sorted = query && typeof query.sort === 'function' ? query.sort({ isPrimary: -1, createdAt: 1 }) : query;
  return (await lean(sorted)) || null;
}

/** Refuses another Contact for a client that already has its Contact (409 CLIENT_CONTACT_LIMIT). */
async function assertCanAddContact(req, companyId) {
  const count = await countContacts(req, companyId);
  if (count >= MAX_CONTACTS_PER_CLIENT) {
    throw codedError(
      `This client already has ${MAX_CONTACTS_PER_CLIENT} contacts, the most a client can have. Remove one first.`,
      409,
      'CLIENT_CONTACT_LIMIT'
    );
  }
  return count;
}

/** Refuses removing the client's only Contact (409 CLIENT_CONTACT_REQUIRED); extra older rows may go. */
async function assertCanRemoveContact(req, companyId) {
  const count = await countContacts(req, companyId);
  if (count <= 1) {
    throw codedError(
      'A client must keep its contact. Edit the contact to change its details.',
      409,
      'CLIENT_CONTACT_REQUIRED'
    );
  }
  return count;
}

module.exports = {
  MAX_CONTACTS_PER_CLIENT,
  countContacts,
  linkedContact,
  assertCanAddContact,
  assertCanRemoveContact
};
