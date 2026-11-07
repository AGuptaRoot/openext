'use strict';

const TenantService = require('../services/tenant.service');

async function requireTenantContext(req, res, next) {
  const normalizedPath = String(req?.path || '').replace(/^\/+|\/+$/g, '');
  const isPublicPortalPath =
    /^quotations\/public\//.test(normalizedPath) ||
    /^invoices\/public\//.test(normalizedPath);

  if (normalizedPath === 'health' || isPublicPortalPath) {
    await next();
    return;
  }

  try {
    await TenantService.attachTenantContext(req);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      req?.cms?.logger?.error?.('CRM tenant context failed:', error?.message || error);
    }
    res.status(status).json({
      success: false,
      error: error.message || 'Tenant context could not be established',
      details: error.details || []
    });
    return;
  }

  await next();
}

module.exports = {
  requireTenantContext
};
