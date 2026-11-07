'use strict';

function attachTenantFromRecord(req, record) {
  const tenantId = String(record?.tenantId || '').trim();
  if (!tenantId) return;
  req.tenantId = tenantId;
  req.tenant = { tenantId, status: 'active' };
}

module.exports = {
  attachTenantFromRecord
};
