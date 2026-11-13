'use strict';

/**
 * GET /services   every service and its requirement form
 * PUT /services   check and save the services list (Services & Forms page)
 */

const { normalizeServices, readServices } = require('../services/catalog.js');

exports.list = async (req, sdk) => {
  return { services: await readServices(sdk) };
};

exports.save = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!Array.isArray(body.services)) throw sdk.error(400, 'Send { services: [...] }', 'INVALID_SERVICES');
  const { services, errors } = normalizeServices(body.services);
  if (errors.length) throw sdk.error(400, errors.slice(0, 6).join(' · '), 'INVALID_SERVICES');
  await sdk.settings.set({ services });
  await sdk.audit('updated', `Saved ${services.length} travel services and their requirement forms`, {
    services: services.map((s) => s.key)
  });
  return { services };
};
