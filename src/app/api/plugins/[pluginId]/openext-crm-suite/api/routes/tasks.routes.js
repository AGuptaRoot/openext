'use strict';



const taskController = require('../controllers/task.controller.js');
const taskTemplateController = require('../controllers/task-template.controller.js');
const timeLogController = require('../controllers/time-log.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateTaskCreate,
  validateTaskUpdate,
  validateTaskStatusChange,
  validateTaskComment,
  validateSubtaskCreate,
  validateSubtaskUpdate,
  validateTaskFollower,
  validateTaskFollowers
} = require('../validation/task.schema');
const {
  validateTaskTemplateCreate,
  validateTaskTemplateUpdate,
  validateTaskTemplateInstantiate
} = require('../validation/task-template.schema');
const { validateTimeLogCreate } = require('../validation/time-log.schema');

module.exports = function registerTasksRoutes(app) {
  app.get(
    '/tasks/export',
    requireAnyPermission('crm.tasks.export', 'crm.tasks.read', 'crm.tasks.write'),
    taskController.exportTasks
  );
  /* Task Templates Routes (must precede /tasks/:id) */
  app.get('/tasks/templates', requirePermission('crm.tasks.read'), taskTemplateController.list);
  app.get('/tasks/templates/:id', requirePermission('crm.tasks.read'), taskTemplateController.get);
  app.post(
    '/tasks/templates',
    requirePermission('crm.tasks.write'),
    validateBody(validateTaskTemplateCreate),
    taskTemplateController.create
  );
  app.put(
    '/tasks/templates/:id',
    requirePermission('crm.tasks.write'),
    validateBody(validateTaskTemplateUpdate),
    taskTemplateController.update
  );
  app.delete('/tasks/templates/:id', requirePermission('crm.tasks.delete'), taskTemplateController.remove);
  app.post(
    '/tasks/templates/:id/instantiate',
    requirePermission('crm.tasks.write'),
    validateBody(validateTaskTemplateInstantiate),
    taskTemplateController.instantiate
  );

  app.get('/tasks', requirePermission('crm.tasks.read'), taskController.list);

  app.post(

    '/tasks',

    requirePermission('crm.tasks.write'),

    validateBody(validateTaskCreate),

    taskController.create

  );



  app.post(

    '/tasks/:id/status',

    requirePermission('crm.tasks.write'),

    validateBody(validateTaskStatusChange),

    taskController.changeStatus

  );



  app.post(
    '/tasks/:id/comments',
    requireAnyPermission('crm.tasks.write', 'crm.tasks.read'),
    validateBody(validateTaskComment),
    taskController.addComment
  );

  app.get('/tasks/:id/comments', requirePermission('crm.tasks.read'), taskController.listComments);



  /* Subtask Endpoints */

  app.get('/tasks/:id/subtasks', requirePermission('crm.tasks.read'), taskController.listSubtasks);

  app.post(

    '/tasks/:id/subtasks',

    requirePermission('crm.tasks.write'),

    validateBody(validateSubtaskCreate),

    taskController.addSubtask

  );

  app.put(

    '/tasks/:id/subtasks/:subtaskId',

    requirePermission('crm.tasks.write'),

    validateBody(validateSubtaskUpdate),

    taskController.updateSubtask

  );

  app.patch(

    '/tasks/:id/subtasks/:subtaskId/toggle',

    requirePermission('crm.tasks.write'),

    taskController.toggleSubtask

  );

  app.delete(

    '/tasks/:id/subtasks/:subtaskId',

    requirePermission('crm.tasks.write'),

    taskController.deleteSubtask

  );



  app.get('/tasks/:id/time-logs', requirePermission('crm.time.read'), timeLogController.listByTask);

  app.get('/tasks/:id/time-summary', requirePermission('crm.time.read'), timeLogController.taskSummary);

  app.post(

    '/tasks/:id/time-logs',

    requirePermission('crm.time.write'),

    validateBody(validateTimeLogCreate, { mergeParams: (req) => ({ taskId: req.params.id }) }),

    timeLogController.create

  );



  app.post(
    '/tasks/recurring/process',
    requirePermission('crm.tasks.write'),
    taskController.processRecurringTasks
  );

  app.get(
    '/tasks/recurring/process',
    requirePermission('crm.tasks.read'),
    taskController.processRecurringTasks
  );

  app.post(
    '/tasks/auto-reminders/process',
    requirePermission('crm.tasks.write'),
    taskController.processAutoReminders
  );

  app.get(
    '/tasks/auto-reminders/process',
    requirePermission('crm.tasks.read'),
    taskController.processAutoReminders
  );

  app.get('/tasks/:id', requirePermission('crm.tasks.read'), taskController.get);

  app.post(

    '/tasks/:id/send-reminder',

    requirePermission('crm.tasks.write'),

    taskController.sendReminder

  );

  app.put(
    '/tasks/:id',
    requireAnyPermission('crm.tasks.write', 'crm.tasks.read'),
    validateBody(validateTaskUpdate),
    taskController.update
  );

  app.post(
    '/tasks/:id/archive',
    requirePermission('crm.tasks.write'),
    taskController.archive
  );

  app.post(
    '/tasks/:id/restore',
    requirePermission('crm.tasks.write'),
    taskController.restore
  );

  app.post(
    '/tasks/:id/save-as-template',
    requirePermission('crm.tasks.write'),
    taskTemplateController.saveAsTemplate
  );

  app.post(
    '/tasks/:id/followers',
    requirePermission('crm.tasks.write'),
    validateBody(validateTaskFollower),
    taskController.addFollower
  );

  app.delete(
    '/tasks/:id/followers/:userId',
    requirePermission('crm.tasks.write'),
    taskController.removeFollower
  );

  app.post(
    '/tasks/:id/toggle-follow',
    requirePermission('crm.tasks.read'),
    taskController.toggleFollower
  );

  app.put(
    '/tasks/:id/followers',
    requirePermission('crm.tasks.write'),
    validateBody(validateTaskFollowers),
    taskController.updateFollowers
  );

  app.delete('/tasks/:id', requirePermission('crm.tasks.delete'), taskController.remove);

};
