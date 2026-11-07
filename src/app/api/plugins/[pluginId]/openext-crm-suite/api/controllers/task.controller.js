'use strict';

const TaskService = require('../services/task.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: `Invalid ID format (${error.value || 'record'})`, details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] task error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Task operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await TaskService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      unlinkedClient: Boolean(result.unlinkedClient),
      message: result.message || 'Tasks loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const task = await TaskService.getById(req, req.params.id);
    res.json({ success: true, data: task, message: 'Task loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const task = await TaskService.create(req, req.validatedBody);
    const message = task.clientNotifiedAt
      ? `Task created & completion email notification sent to client (${task.clientNotifiedEmail || 'client'})`
      : 'Task created';
    res.status(201).json({ success: true, data: task, message });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const task = await TaskService.update(req, req.params.id, req.validatedBody);
    const message = task.clientNotifiedAt
      ? `Task updated & completion email notification sent to client (${task.clientNotifiedEmail || 'client'})`
      : 'Task updated';
    res.json({ success: true, data: task, message });
  } catch (error) {
    sendError(res, error);
  }
}

async function changeStatus(req, res) {
  try {
    const task = await TaskService.changeStatus(req, req.params.id, req.validatedBody);
    const message = task.clientNotifiedAt
      ? `Task status updated & completion email notification sent to client (${task.clientNotifiedEmail || 'client'})`
      : 'Task status updated';
    res.json({ success: true, data: task, message });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    await TaskService.remove(req, req.params.id);
    res.json({ success: true, data: { deleted: true, id: req.params.id }, message: 'Task deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function archive(req, res) {
  try {
    const task = await TaskService.archiveTask(req, req.params.id);
    res.json({ success: true, data: task, message: 'Task archived' });
  } catch (error) {
    sendError(res, error);
  }
}

async function restore(req, res) {
  try {
    const task = await TaskService.restoreTask(req, req.params.id);
    res.json({ success: true, data: task, message: 'Task restored from archive' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listComments(req, res) {
  try {
    const comments = await TaskService.listComments(req, req.params.id);
    res.json({ success: true, data: comments, message: 'Task comments loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addComment(req, res) {
  try {
    const comment = await TaskService.addComment(req, req.params.id, req.validatedBody.body);
    res.status(201).json({ success: true, data: comment, message: 'Comment added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function sendReminder(req, res) {
  try {
    const task = await TaskService.sendTaskReminderNotification(req, req.params.id);
    const email = task.clientNotifiedEmail || 'client';
    res.json({
      success: true,
      data: task,
      message: `Reminder email successfully sent to client (${email})`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function processAutoReminders(req, res) {
  try {
    // Manual trigger can process current tenant, or all tenants with ?allTenants=1
    const allTenants = String(req.query?.allTenants || req.body?.allTenants || '') === '1'
      || String(req.query?.allTenants || req.body?.allTenants || '').toLowerCase() === 'true';
    const result = allTenants
      ? await TaskService.processAutoClientRemindersForAllTenants(req.cms)
      : await TaskService.processAutoClientReminders(req);
    res.json({
      success: true,
      data: result,
      message: result.message || 'Auto reminders processed'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function processRecurringTasks(req, res) {
  try {
    const result = await TaskService.processRecurringTasks(req);
    res.json({
      success: true,
      data: result,
      message: result.message || 'Recurring tasks processed'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listSubtasks(req, res) {
  try {
    const subtasks = await TaskService.listSubtasks(req, req.params.id);
    res.json({ success: true, data: subtasks, message: 'Subtasks loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addSubtask(req, res) {
  try {
    const subtask = await TaskService.addSubtask(req, req.params.id, req.validatedBody);
    res.status(201).json({ success: true, data: subtask, message: 'Subtask added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateSubtask(req, res) {
  try {
    const subtask = await TaskService.updateSubtask(req, req.params.id, req.params.subtaskId, req.validatedBody);
    res.json({ success: true, data: subtask, message: 'Subtask updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function toggleSubtask(req, res) {
  try {
    const subtask = await TaskService.toggleSubtask(req, req.params.id, req.params.subtaskId);
    res.json({ success: true, data: subtask, message: subtask?.isCompleted ? 'Subtask marked completed' : 'Subtask reopened' });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteSubtask(req, res) {
  try {
    const result = await TaskService.deleteSubtask(req, req.params.id, req.params.subtaskId);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
}

async function processRecurringTasks(req, res) {
  try {
    const result = await TaskService.processRecurringTasks(req);
    res.json({ success: true, data: result, message: result.message || 'Recurring tasks processed' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addFollower(req, res) {
  try {
    const task = await TaskService.addFollower(req, req.params.id, req.validatedBody?.userId || req.body?.userId);
    res.json({ success: true, data: task, message: 'Watcher added to task' });
  } catch (error) {
    sendError(res, error);
  }
}

async function removeFollower(req, res) {
  try {
    const task = await TaskService.removeFollower(req, req.params.id, req.params.userId || req.body?.userId);
    res.json({ success: true, data: task, message: 'Watcher removed from task' });
  } catch (error) {
    sendError(res, error);
  }
}

async function toggleFollower(req, res) {
  try {
    const task = await TaskService.toggleFollower(req, req.params.id, req.validatedBody?.userId || req.body?.userId);
    res.json({ success: true, data: task, message: 'Watcher status updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateFollowers(req, res) {
  try {
    const task = await TaskService.updateFollowers(req, req.params.id, req.validatedBody?.followers || req.body?.followers);
    res.json({ success: true, data: task, message: 'Watchers updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportTasks(req, res) {
  try {
    const result = await TaskService.exportTasks(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  exportTasks,
  get,
  create,
  update,
  changeStatus,
  remove,
  archive,
  restore,
  listComments,
  addComment,
  sendReminder,
  processAutoReminders,
  processRecurringTasks,
  listSubtasks,
  addSubtask,
  updateSubtask,
  toggleSubtask,
  deleteSubtask,
  addFollower,
  removeFollower,
  toggleFollower,
  updateFollowers
};
