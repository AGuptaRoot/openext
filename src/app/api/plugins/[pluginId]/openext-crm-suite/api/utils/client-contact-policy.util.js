'use strict';

const { resolveTenantId } = require('./tenant.util');

/**
 * Client ↔ Contact rule (CRM 3.42.0): for now ONE Client has ONE Contact.
 *
 * The data model already allows more (Contact rows carry companyId + isPrimary; PersonContact keeps
 * clientIds as a list), so the later upgrade "1 Client → many Contacts → 1 Primary" only needs
 * MAX_CONTACTS_PER_CLIENT raised (or made a setting) and the UI to list them — no data change.
 *
 * - The linked Contact is the primary row, else the oldest one. Every client flow (documents,
 *   portal access, detail page) reads it through linkedContact().
 * - A new row is always the primary while the client has none.
 * - Clients that already have more rows (older data, merges) keep them all — nothing is deleted;
 *   only the linked one is shown and used, and no further row can be added.
 */

const MAX_CONTACTS_PER_CLIENT = 1;

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
      'This client already has its contact. A client can have only one contact — edit the existing contact instead.',
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
