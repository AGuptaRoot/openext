'use strict';

/**
 * CRM 3.69.0 — a core module the active extension hides (manifest `hiddenModules`) cannot be changed through
 * the API either: 409 with a code, like OPPORTUNITIES_HIDDEN. Reads stay open (history is kept).
 * Same style as permission.middleware: return nothing to go on, or send the answer.
 */

const MESSAGES = Object.freeze({
  activities: {
    code: 'ACTIVITIES_HIDDEN',
    message: 'Activities are turned off by the active extension.'
  }
});

function refuseWhenHidden(moduleId) {
  const id = String(moduleId || '').trim().toLowerCase();
  const answer = MESSAGES[id] || { code: 'MODULE_HIDDEN', message: 'This module is turned off by the active extension.' };
  return async (req, res) => {
    const hidden = await require('../services/crm-extension.service').hidesModule(req, id);
    if (!hidden) return;
    res.status(409).json({ success: false, error: answer.message, code: answer.code });
  };
}

module.exports = { refuseWhenHidden };
