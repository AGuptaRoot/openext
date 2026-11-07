'use strict';

/**
 * The signed-in user's in-app notifications (services/notification.service.js, CRM 3.33.0).
 *
 * GET  /notifications             { items (newest 30), unread }
 * POST /notifications/:id/read
 * POST /notifications/read-all
 *
 * Only the user's own rows of their tenant; client (portal) users get none.
 */

const NotificationService = require('../services/notification.service');

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
};
