'use strict';

const { asObject } = require('../validation/common.util');

/**
 * Shared request validation middleware.
 *
 * Schemas live in api/validation/*.schema.js and return:
 *   { ok: true, value } | { ok: false, errors: string[] }
 *
 * Usage:
 *   app.post('/leads', requirePermission('...'), validateBody(validateLeadCreate), controller.create);
 */
function validateBody(validator, options = {}) {
  const { target = 'validatedBody', mergeParams = null } = options;

  if (typeof validator !== 'function') {
    throw new Error('validateBody requires a validator function');
  }

  return async (req, res) => {
    let payload = asObject(req.body);

    if (typeof mergeParams === 'function') {
      payload = { ...payload, ...mergeParams(req) };
    }

    const result = validator(payload, req);

    if (!result || result.ok !== true) {
      const details = Array.isArray(result?.errors) ? result.errors : ['Validation failed'];
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details
      });
      return;
    }

    req[target] = result.value;
  };
}

module.exports = {
  validateBody
};
