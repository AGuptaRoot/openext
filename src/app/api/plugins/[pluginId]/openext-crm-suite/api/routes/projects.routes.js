'use strict';

const projectController = require('../controllers/project.controller.js');
const projectTemplateController = require('../controllers/project-template.controller.js');
const milestoneController = require('../controllers/milestone.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateProjectCreate,
  validateProjectUpdate,
  validateProjectMember,
  validateProjectMemberUpdate
} = require('../validation/project.schema');
const { validateMilestoneCreate } = require('../validation/milestone.schema');

module.exports = function registerProjectsRoutes(app) {
  app.get(
    '/projects/export',
    requireAnyPermission('crm.projects.export', 'crm.projects.read', 'crm.projects.write'),
    projectController.exportProjects
  );
  app.get('/projects/templates', requirePermission('crm.projects.read'), projectTemplateController.list);
  app.get('/projects/templates/:id', requirePermission('crm.projects.read'), projectTemplateController.get);
  app.post('/projects/templates', requirePermission('crm.projects.write'), projectTemplateController.create);
  app.put('/projects/templates/:id', requirePermission('crm.projects.write'), projectTemplateController.update);
  app.delete('/projects/templates/:id', requirePermission('crm.projects.delete'), projectTemplateController.remove);
  app.post('/projects/templates/:id/instantiate', requirePermission('crm.projects.write'), projectTemplateController.instantiate);

  app.get('/projects', requirePermission('crm.projects.read'), projectController.list);

  app.get('/projects/categories', requirePermission('crm.projects.read'), projectController.listCategories);
  app.post('/projects/categories', requirePermission('crm.projects.write'), projectController.addCategory);

  app.get('/projects/labels', requirePermission('crm.projects.read'), projectController.listLabels);
  app.post('/projects/labels', requirePermission('crm.projects.write'), projectController.addLabel);

  app.get('/projects/tags', requirePermission('crm.projects.read'), projectController.listTags);
  app.post('/projects/tags', requirePermission('crm.projects.write'), projectController.addTag);

  app.get('/projects/statuses', requirePermission('crm.projects.read'), projectController.listStatuses);
  app.post('/projects/statuses', requirePermission('crm.projects.write'), projectController.addStatus);

  app.get('/projects/priorities', requirePermission('crm.projects.read'), projectController.listPriorities);
  app.post('/projects/priorities', requirePermission('crm.projects.write'), projectController.addPriority);

  app.get('/projects/custom-fields', requirePermission('crm.projects.read'), projectController.listCustomFields);
  app.post('/projects/custom-fields', requirePermission('crm.projects.write'), projectController.addCustomField);

  app.post(
    '/projects',
    requirePermission('crm.projects.write'),
    validateBody(validateProjectCreate),
    projectController.create
  );

  app.get('/projects/:id/overview', requirePermission('crm.projects.read'), projectController.getOverview);

  app.get('/projects/:id/activity', requirePermission('crm.projects.read'), projectController.getActivity);

  app.get('/projects/:id/tasks', requirePermission('crm.tasks.read'), projectController.listTasks);

  app.get('/projects/:id/members', requirePermission('crm.projects.read'), projectController.listMembers);

  app.post(
    '/projects/:id/members',
    requirePermission('crm.projects.write'),
    validateBody(validateProjectMember),
    projectController.addMember
  );

  app.put(
    '/projects/:id/members/:userId',
    requirePermission('crm.projects.write'),
    validateBody(validateProjectMemberUpdate),
    projectController.updateMember
  );

  app.delete(
    '/projects/:id/members/:userId',
    requirePermission('crm.projects.write'),
    projectController.removeMember
  );

  app.get('/projects/:projectId/milestones', requirePermission('crm.projects.read'), milestoneController.listByProject);

  app.post(
    '/projects/:projectId/milestones',
    requirePermission('crm.projects.write'),
    validateBody(validateMilestoneCreate),
    milestoneController.create
  );

  app.post('/projects/:id/archive', requirePermission('crm.projects.write'), projectController.archive);
  app.post('/projects/:id/restore', requirePermission('crm.projects.write'), projectController.restore);
  app.post('/projects/:id/drop', requirePermission('crm.projects.delete'), projectController.drop);
  app.post('/projects/:id/reactivate', requirePermission('crm.projects.write'), projectController.reactivate);

  app.get('/projects/:id/documents', requirePermission('crm.projects.read'), projectController.listDocuments);
  app.post('/projects/:id/documents/upload', requirePermission('crm.projects.write'), projectController.uploadDocument);
  app.post('/projects/:id/documents', requirePermission('crm.projects.write'), projectController.createDocument);
  app.delete('/projects/:id/documents/:documentId', requirePermission('crm.projects.write'), projectController.deleteDocument);

  app.get('/projects/:id', requirePermission('crm.projects.read'), projectController.get);

  app.put(
    '/projects/:id',
    requirePermission('crm.projects.write'),
    validateBody(validateProjectUpdate),
    projectController.update
  );

  app.delete('/projects/:id', requirePermission('crm.projects.delete'), projectController.remove);
};
