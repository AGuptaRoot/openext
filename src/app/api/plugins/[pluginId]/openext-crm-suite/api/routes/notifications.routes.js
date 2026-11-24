'use strict';

/**
 * The signed-in user's in-app notifications (services/notification.service.js, CRM 3.33.0).
 *
 * GET  /notifications             { items (newest 30), unread }
 * POST /notifications/:id/read
 * POST /notifications/read-all
 *
 * Only the user's own rows of their tenant; client (portal) users get none.
 *
 * CRM 3.59.0 — push notifications to the mobile app (services/push.service.js), staff only:
 * POST   /devices/register      { token, platform: android|ios, appVersion?, deviceName? }  after login / token refresh
 * POST   /devices/unregister    { token }                                                  on logout
 * POST   /devices/status        { token } → { registered }: is this browser saved for me (3.64.8, My Alerts)
 * GET    /devices               my phones (never the tokens)
 * DELETE /devices/:id           remove one of my phones
 * GET    /devices/preferences   my push on/off per alert type
 * PUT    /devices/preferences   { off: [types] } or { types: [{ type, enabled }] }
 * POST   /devices/test          a test push to my phones (checks the Firebase key)
 * GET    /devices/web-config    browser alerts: Firebase web config + Web Push public key (3.62.0)
 * GET    /push/sw.js            the CRM service worker for browser alerts (public JavaScript, no data)
 * GET    /settings/integrations/fcm   status (hint only)           crm.settings.manage
 * PUT    /settings/integrations/fcm   { serviceAccount } | { clearKey: true }   crm.settings.manage
 */

const NotificationService = require('../services/notification.service');
const PushService = require('../services/push.service');
const { requirePermission } = require('../middleware/permission.middleware');

/** Push routes: the message and code of 4xx answers; a 5xx keeps its code but a generic text. */
function sendPush(res, work, status = 200) {
  return Promise.resolve()
    .then(() => work())
    .then(
      (data) => res.status(status).json({ success: true, data }),
      (error) => {
        const code = Number(error && error.status) || 500;
        const body = { success: false, error: code >= 500 && !(error && error.code) ? 'Push request failed' : String((error && error.message) || 'Request failed') };
        if (error && error.code) body.code = String(error.code);
        res.status(code).json(body);
      }
    );
}

function send(res, work) {
  return work.then(
    (data) => res.json({ success: true, data }),
    (error) => {
      const status = Number(error && error.status) || 500;
      if (status >= 500) console.error('[plugin:openext-crm-suite] notifications:', error && error.message);
      res.status(status).json({ success: false, error: status >= 500 ? 'Notifications could not be loaded' : String(error.message || 'Request failed') });
    }
  );
}

module.exports = function registerNotificationRoutes(app) {
  app.get('/notifications', (req, res) => send(res, NotificationService.list(req)));
  app.post('/notifications/read-all', (req, res) => send(res, NotificationService.markAllRead(req)));
  app.post('/notifications/:id/read', (req, res) => send(res, NotificationService.markRead(req, req.params.id)));

  app.post('/devices/register', (req, res) => sendPush(res, () => PushService.registerDevice(req, req.body || {}), 201));
  app.post('/devices/unregister', (req, res) => sendPush(res, () => PushService.unregisterDevice(req, req.body || {})));
  app.post('/devices/status', (req, res) => sendPush(res, () => PushService.deviceStatus(req, req.body || {})));
  app.get('/devices/preferences', (req, res) => sendPush(res, () => PushService.getPreferences(req)));
  app.put('/devices/preferences', (req, res) => sendPush(res, () => PushService.setPreferences(req, req.body || {})));
  app.post('/devices/test', (req, res) => sendPush(res, () => PushService.sendTest(req)));
  app.get('/devices/web-config', (req, res) => sendPush(res, () => PushService.getWebClientConfig(req)));
  app.get('/devices', (req, res) => sendPush(res, () => PushService.listDevices(req)));
  // CRM 3.62.0: served as JavaScript so the browser can register it (scope /api/plugins/<id>/push/).
  app.get('/push/sw.js', (req, res) => {
    res.status(200);
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(PushService.serviceWorkerSource());
  });
  app.delete('/devices/:id', (req, res) => sendPush(res, () => PushService.removeDevice(req, req.params.id)));

  app.get('/settings/integrations/fcm', requirePermission('crm.settings.manage'), (req, res) => sendPush(res, () => PushService.getIntegration(req)));
  app.put('/settings/integrations/fcm', requirePermission('crm.settings.manage'), (req, res) => sendPush(res, () => PushService.updateIntegration(req, req.body || {})));
};
