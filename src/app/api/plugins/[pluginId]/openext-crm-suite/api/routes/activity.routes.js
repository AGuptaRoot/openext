'use strict';

const activityController = require('../controllers/activity.controller');
const { requirePermission } = require('../middleware/permission.middleware');

module.exports = function registerActivityRoutes(app) {
  if (!app) return;
  if (app._activityRoutesRegistered) return;
  app._activityRoutesRegistered = true;

  // Standalone Activity Detail Query with Role Restriction
  app.get('/api/activities/:id', requirePermission('crm.leads.read'), activityController.getActivityById);
  app.get('/activities/:id', requirePermission('crm.leads.read'), activityController.getActivityById);

  // Periodic Location Log Endpoints
  app.post('/api/activities/:id/location-logs', requirePermission('crm.leads.write'), activityController.createLocationLog);
  app.post('/activities/:id/location-logs', requirePermission('crm.leads.write'), activityController.createLocationLog);

  app.get('/api/activities/:id/location-logs', requirePermission('crm.leads.read'), activityController.listLocationLogs);
  app.get('/activities/:id/location-logs', requirePermission('crm.leads.read'), activityController.listLocationLogs);

  // Goal Location Endpoints
  if (typeof app.put === 'function') {
    app.put('/api/activities/:id/goal-location', requirePermission('crm.leads.write'), activityController.updateGoalLocation);
    app.put('/activities/:id/goal-location', requirePermission('crm.leads.write'), activityController.updateGoalLocation);
  }
  if (typeof app.patch === 'function') {
    app.patch('/api/activities/:id/goal-location', requirePermission('crm.leads.write'), activityController.updateGoalLocation);
    app.patch('/activities/:id/goal-location', requirePermission('crm.leads.write'), activityController.updateGoalLocation);
  }

  // Standalone Activity Update Endpoints
  if (typeof app.put === 'function') {
    app.put('/api/activities/:id', requirePermission('crm.leads.write'), activityController.updateActivity);
    app.put('/activities/:id', requirePermission('crm.leads.write'), activityController.updateActivity);
  }
  if (typeof app.patch === 'function') {
    app.patch('/api/activities/:id', requirePermission('crm.leads.write'), activityController.updateActivity);
    app.patch('/activities/:id', requirePermission('crm.leads.write'), activityController.updateActivity);
  }
};
