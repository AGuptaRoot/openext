'use strict';

/**
 * sdk.documents (capability "documents.pdf"): an extension describes a document (title, rows,
 * text, tables) and the CRM draws it as PDF with the workspace's company details, then keeps it as
 * one of the extension's private files (same store and encryption as sdk.files).
 */

const { renderDocumentPdf } = require('../utils/pdf-document.util');
const { runtimeError } = require('./values');

const SEGMENT_RE = /^[A-Za-z0-9_-]{1,60}$/;

function createDocumentsApi(req, def, { tenantId, userId }) {
  const files = require('./private-files').createFilesApi(req, def, { tenantId, userId });
  return Object.freeze({
    /**
     * @param {object} doc  { title, reference, meta, blocks, footer, watermark, recordType, recordId, name }
     * @returns {{ id, name, mimeType, size, recordType, recordId, createdAt }}
     */
    async pdf(doc = {}) {
      const recordType = String(doc.recordType || '');
      const recordId = String(doc.recordId || '');
      if (!SEGMENT_RE.test(recordType) || !SEGMENT_RE.test(recordId)) {
        throw runtimeError(400, 'documents.pdf: recordType and recordId are required', 'INVALID_DOCUMENT');
      }
      const SettingService = require('../services/setting.service');
      const settings = await SettingService.getAll(req).catch(() => ({}));
      let buffer;
      try {
        buffer = renderDocumentPdf(doc, {
          name: settings.company_name,
          address: settings.company_address,
          phone: settings.company_phone,
          email: settings.company_email
        });
      } catch (error) {
        throw runtimeError(Number(error.status) || 500, String(error.message || 'documents.pdf failed').slice(0, 300), error.code || 'INVALID_DOCUMENT');
      }
      const name = String(doc.name || doc.reference || doc.title || 'document').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 80) || 'document';
      return files.save({
        data: buffer.toString('base64'),
        mimeType: 'application/pdf',
        name: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`,
        recordType,
        recordId
      });
    }
  });
}

module.exports = { createDocumentsApi };
