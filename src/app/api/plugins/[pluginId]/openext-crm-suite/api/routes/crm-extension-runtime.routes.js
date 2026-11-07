'use strict';

const { handle } = require('../extension-runtime/runtime');

/**
 * Runtime routes of uploaded CRM workspace extensions (contract §9).
 *
 *   /x/:extensionId/<path>
 *
 * The CMS plugin router has no wildcards and matches by segment count, so one
 * pattern is registered per depth (1–8 segments after the extension id) for
 * every method. Authentication, tenant context and permission resolution run
 * as app-level middleware before these handlers; each path's own permission
 * is checked inside the dispatcher.
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_DEPTH = 8;

module.exports = function registerCrmExtensionRuntimeRoutes(app) {
  for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
    const pattern = `/x/:extensionId/${Array.from({ length: depth }, (_, i) => `:p${i + 1}`).join('/')}`;
    for (const method of METHODS) {
      if (typeof app[method] === 'function') app[method](pattern, handle);
    }
  }
};

module.exports.MAX_DEPTH = MAX_DEPTH;
