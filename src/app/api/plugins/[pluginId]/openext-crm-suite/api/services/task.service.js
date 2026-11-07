'use strict';

const {
  resolveTenantId,
  resolveUserId,
  isClientUser,
  resolveClientId,
  resolveClientIdAsync,
  applyClientScope,
  applyClientScopeAsync
} = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const { resolveUsernames, resolveUserDesignations } = require('../utils/user.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const ProjectService = require('./project.service');
const {
  assertTaskReadAccess,
  assertTaskWriteAccess,
  applyEmployeeTaskListScope,
  getMemberUserIds
} = require('../utils/project-access.util');
const { buildClientPortalLoginUrl } = require('../utils/public-origin.util');

function renderClientPortalCtaHtml(portalLoginUrl) {
  const safeUrl = String(portalLoginUrl || 'http://localhost:3011/admin/login');
  return `
    <div style="text-align:center; margin:24px 0 16px; padding:18px 16px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px;">
      <p style="margin:0 0 12px 0; color:#1e3a8a; font-size:0.92rem; line-height:1.5;">
        Prefer the portal? Log in to review this task and submit feedback online.
      </p>
      <a href="${safeUrl}" target="_blank" rel="noopener noreferrer"
         style="display:inline-block;background:#2563eb;color:#ffffff;padding:13px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:0.95rem;">
        Open Client Portal →
      </a>
      <p style="font-size:12px;color:#64748b;margin:12px 0 0 0;line-height:1.5;">
        After login, open <strong>Tasks</strong> to check your deliverables.<br/>
        Portal link: <a href="${safeUrl}" style="color:#2563eb;word-break:break-all;">${safeUrl}</a>
      </p>
    </div>
  `;
}

function getTaskModel(req) {
  const Task = req.cms?.models.get('Task');
  if (!Task) throw new Error('Task model is not registered');
  return Task;
}

function getTaskCommentModel(req) {
  return req.cms?.models.get('TaskComment') || null;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function reminderIntervalToMs(type, value) {
  const n = Math.max(1, Number(value) || 1);
  switch (String(type || 'hours').toLowerCase()) {
    case 'days':
      return n * 24 * 60 * 60 * 1000;
    case 'weeks':
      return n * 7 * 24 * 60 * 60 * 1000;
    case 'months':
      return n * 30 * 24 * 60 * 60 * 1000;
    case 'hours':
    default:
      return n * 60 * 60 * 1000;
  }
}

function getTaskReminderIntervalMs(task, defaultHours = 24) {
  if (task && task.reminderScheduleEnabled && Number(task.reminderIntervalValue) > 0) {
    return reminderIntervalToMs(task.reminderIntervalType, task.reminderIntervalValue);
  }
  return Math.max(1, Number(defaultHours) || 24) * 60 * 60 * 1000;
}

function getTaskLastReminderAt(task) {
  return task?.lastReminderSentAt || task?.clientNotifiedAt || task?.updatedAt || null;
}

function isTaskReminderDue(task, defaultHours, now = new Date()) {
  const last = getTaskLastReminderAt(task);
  if (!last) return true;
  const intervalMs = getTaskReminderIntervalMs(task, defaultHours);
  return new Date(last).getTime() <= now.getTime() - intervalMs;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

async function assertValidTaskAssignee(req, projectId, assignedUserId, project = null) {
  const assignee = String(assignedUserId || '').trim();
  if (!assignee || assignee === 'unassigned' || assignee === 'none' || assignee === 'null') {
    return;
  }

  const pId = String(projectId || '').trim();
  if (!pId || !/^[0-9a-fA-F]{24}$/.test(pId)) {
    return; // allow general non-project tasks
  }

  const proj = project || await getProjectContext(req, pId);
  const allowedUserIds = new Set();

  if (proj.createdBy) allowedUserIds.add(String(proj.createdBy));
  if (Array.isArray(proj.assignedTo)) {
    proj.assignedTo.forEach((uid) => uid && allowedUserIds.add(String(uid)));
  } else if (proj.assignedTo) {
    allowedUserIds.add(String(proj.assignedTo));
  }

  const memberIds = await getMemberUserIds(req, pId);
  memberIds.forEach((uid) => uid && allowedUserIds.add(String(uid)));

  if (!allowedUserIds.has(assignee)) {
    throw appError('Tasks can only be assigned to team members who are added to this project. Please add the user to the project members first.', 400);
  }
}

/**
 * Validate that dependsOnTaskId points to another task in the same project.
 * Also rejects self-dependencies and circular dependency chains.
 */
async function assertValidDependsOnTask(req, projectId, dependsOnTaskId, currentTaskId = null) {
  const depId = String(dependsOnTaskId || '').trim();
  if (!depId || depId === 'none' || depId === 'null' || depId === 'undefined') {
    return null;
  }

  if (!/^[0-9a-fA-F]{24}$/.test(depId)) {
    throw appError('Invalid dependsOnTaskId format', 400);
  }

  const currentId = currentTaskId ? String(currentTaskId).trim() : null;
  if (currentId && depId === currentId) {
    throw appError('A task cannot depend on itself', 400);
  }

  const pId = String(projectId || '').trim();
  if (!pId) {
    throw appError('projectId is required when setting a task dependency', 400);
  }

  const Task = getTaskModel(req);
  const dependency = await Task.findOne({
    ...baseFilter(req),
    _id: depId
  })
    .select('_id title status projectId dependsOnTaskId')
    .lean();

  if (!dependency) {
    throw appError('Dependent task was not found', 404);
  }

  if (String(dependency.projectId) !== pId) {
    throw appError('You can only depend on tasks that belong to the same project', 400);
  }

  // Walk the dependency chain to prevent cycles (A → B → … → A)
  let cursor = String(dependency.dependsOnTaskId || '').trim();
  const visited = new Set([depId]);
  let depth = 0;
  while (cursor && /^[0-9a-fA-F]{24}$/.test(cursor) && depth < 25) {
    if (currentId && cursor === currentId) {
      throw appError('This dependency would create a circular chain. Choose a different task.', 400);
    }
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const next = await Task.findOne({
      ...baseFilter(req),
      _id: cursor
    })
      .select('dependsOnTaskId')
      .lean();
    cursor = next ? String(next.dependsOnTaskId || '').trim() : '';
    depth += 1;
  }

  return dependency;
}

async function getValidStatuses(req) {
  try {
    return await SettingService.getTaskStatuses(req);
  } catch {
    return ['To Do', 'In Progress', 'Review', 'Completed', 'On Hold'];
  }
}

async function getValidPriorities(req) {
  try {
    return await SettingService.getTaskPriorities(req);
  } catch {
    return ['Low', 'Medium', 'High', 'Urgent'];
  }
}

function assertValidStatus(status, validStatuses) {
  if (!validStatuses.includes(status)) {
    throw appError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }
}

function assertValidPriority(priority, validPriorities) {
  if (!validPriorities.includes(priority)) {
    throw appError(`Invalid priority. Must be one of: ${validPriorities.join(', ')}`);
  }
}

async function getProjectContext(req, projectId) {
  if (!projectId || !/^[0-9a-fA-F]{24}$/.test(String(projectId))) {
    let name = 'General';
    if (projectId === 'marketing-leads') name = 'Marketing Lead Drip';
    else if (projectId === 'ai-lead-actions') name = 'AI Intelligence Action';
    else if (projectId === 'sample_improvement') name = 'Sample Improvement';
    else if (projectId) name = String(projectId).replace(/[-_]/g, ' ');

    return {
      _id: String(projectId || 'general'),
      name,
      clientId: null,
      tenantId: resolveTenantId(req),
      status: 'In Progress'
    };
  }
  try {
    return await ProjectService.findProjectOrThrow(req, projectId);
  } catch {
    return {
      _id: String(projectId),
      name: String(projectId).replace(/[-_]/g, ' '),
      clientId: null,
      tenantId: resolveTenantId(req),
      status: 'In Progress'
    };
  }
}

async function findTaskOrThrow(req, id) {
  if (!id || !/^[0-9a-fA-F]{24}$/.test(String(id))) {
    throw appError('Task not found', 404);
  }
  const task = await getTaskModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!task) throw appError('Task not found', 404);

  const project = await getProjectContext(req, task.projectId);
  await assertTaskReadAccess(req, task, project);
  return { task, project };
}

async function sendTaskCompletionNotification(req, task, project) {
  try {
    if (!project?.clientId) return null;
    const Company = req.cms?.models.get('Company');
    if (!Company) return null;
    const client = await Company.findOne({
      tenantId: resolveTenantId(req),
      _id: String(project.clientId),
      isDeleted: false
    }).lean();

    if (!client || !client.email) return null;

    const MailService = require('./mail.service');
    const mailConfig = await MailService.resolveMailConfig(req);
    const companyName = mailConfig.fromName || 'Root CRM';

    const subject = `Task Completed: ${task.title} - ${project.name}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0f172a; margin-top: 0;">Task Completed 🎉</h2>
        <p>Dear ${client.name || 'Client'},</p>
        <p>We are pleased to inform you that the following task under project <strong>${project.name}</strong> has been marked as <strong>Completed</strong>:</p>
        <div style="background: #f8fafc; border-left: 4px solid #10b981; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
          <h3 style="margin: 0 0 6px 0; color: #1e293b;">${task.title}</h3>
          ${task.description ? `<p style="margin: 0 0 6px 0; color: #64748b; font-size: 0.9rem;">${task.description}</p>` : ''}
          <div style="font-size: 0.82rem; color: #475569;">
            <span>Status: <strong style="color: #10b981;">Completed</strong></span> · 
            <span>Priority: <strong>${task.priority || 'Medium'}</strong></span>
          </div>
        </div>
        <p>Please review the completed deliverable. If you have any feedback or require revisions, feel free to reply directly to this email.</p>
        ${renderClientPortalCtaHtml(buildClientPortalLoginUrl(req))}
        <p style="color: #64748b; font-size: 0.85rem; margin-top: 24px;">Best regards,<br><strong>${companyName}</strong></p>
      </div>
    `;

    await MailService.sendViaEmailPlugin(req, {
      to: client.email,
      subject,
      html
    });

    const now = new Date();
    const Task = req.cms?.models.get('Task');
    if (Task) {
      await Task.updateOne(
        { tenantId: resolveTenantId(req), _id: String(task._id) },
        {
          $set: {
            clientNotifiedAt: now,
            clientNotifiedEmail: client.email
          }
        }
      );
    }

    task.clientNotifiedAt = now;
    task.clientNotifiedEmail = client.email;

    // Log to Project and Task Audit Log
    await AuditService.log(req, {
      action: 'notification_sent',
      module: 'task',
      recordId: task._id.toString(),
      description: `Completion email notification sent to client (${client.email}) for task: ${task.title}`,
      metadata: {
        projectId: task.projectId,
        taskId: task._id.toString(),
        recipientEmail: client.email,
        sentAt: now
      }
    });

    // Add activity comment in Task comment feed if TaskComment model is available
    const TaskComment = req.cms?.models.get('TaskComment');
    if (TaskComment) {
      try {
        await TaskComment.create({
          tenantId: resolveTenantId(req),
          taskId: String(task._id),
          body: `📧 **Completion notification email sent to client** (${client.email}) on ${now.toLocaleString()}`,
          createdBy: resolveUserId(req) || 'system',
          updatedBy: resolveUserId(req) || 'system'
        });
      } catch (cErr) {
        console.warn('[TaskService] Task comment log warning:', cErr.message);
      }
    }

    return {
      sent: true,
      email: client.email,
      sentAt: now
    };
  } catch (err) {
    console.warn('[TaskService] Failed to send completion notification to client:', err.message);
    return null;
  }
}

async function sendTaskReminderNotification(req, taskId) {
  const { task, project } = await findTaskOrThrow(req, taskId);
  await assertTaskWriteAccess(req, task, project);

  if (!project?.clientId) {
    throw appError('This project is not linked to a client company with an email address', 400);
  }

  const Company = req.cms?.models.get('Company');
  if (!Company) throw appError('Company model not available', 500);

  const client = await Company.findOne({
    tenantId: resolveTenantId(req),
    _id: String(project.clientId),
    isDeleted: false
  }).lean();

  if (!client || !client.email) {
    throw appError('The client company does not have a valid email address configured', 400);
  }

  const MailService = require('./mail.service');
  const mailConfig = await MailService.resolveMailConfig(req);
  const companyName = mailConfig.fromName || 'Root CRM';

  const subject = `Reminder: Client Feedback Requested for Task: ${task.title} - ${project.name}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #0f172a; margin-top: 0;">Task Review Reminder 🔔</h2>
      <p>Dear ${client.name || 'Client'},</p>
      <p>This is a friendly reminder regarding the deliverable for task under project <strong>${project.name}</strong>:</p>
      <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
        <h3 style="margin: 0 0 6px 0; color: #1e293b;">${task.title}</h3>
        ${task.description ? `<p style="margin: 0 0 6px 0; color: #64748b; font-size: 0.9rem;">${task.description}</p>` : ''}
        <div style="font-size: 0.82rem; color: #475569;">
          <span>Status: <strong style="color: #10b981;">${task.status}</strong></span> · 
          <span>Priority: <strong>${task.priority || 'Medium'}</strong></span>
        </div>
      </div>
      <p>We haven't received your feedback yet. Please take a moment to review the completed task and let us know if everything meets your satisfaction or if you require any revisions.</p>
      <p>You can reply directly to this email with your feedback or approval, or use the client portal link below to review your task after login.</p>
      ${renderClientPortalCtaHtml(buildClientPortalLoginUrl(req))}
      <p style="color: #64748b; font-size: 0.85rem; margin-top: 24px;">Best regards,<br><strong>${companyName}</strong></p>
    </div>
  `;

  await MailService.sendViaEmailPlugin(req, {
    to: client.email,
    subject,
    html
  });

  const now = new Date();
  const Task = req.cms?.models.get('Task');
  if (Task) {
    await Task.updateOne(
      { tenantId: resolveTenantId(req), _id: String(task._id) },
      {
        $set: {
          clientNotifiedAt: now,
          clientNotifiedEmail: client.email,
          lastReminderSentAt: now
        },
        $inc: { reminderCount: 1 }
      }
    );
  }

  task.clientNotifiedAt = now;
  task.clientNotifiedEmail = client.email;
  task.lastReminderSentAt = now;
  task.reminderCount = Number(task.reminderCount || 0) + 1;

  await AuditService.log(req, {
    action: 'reminder_sent',
    module: 'task',
    recordId: task._id.toString(),
    description: `Reminder email notification sent to client (${client.email}) for task: ${task.title}`,
    metadata: {
      projectId: task.projectId,
      taskId: task._id.toString(),
      recipientEmail: client.email,
      kind: 'manual',
      sentAt: now
    }
  });

  const TaskComment = req.cms?.models.get('TaskComment');
  if (TaskComment) {
    try {
      await TaskComment.create({
        tenantId: resolveTenantId(req),
        taskId: String(task._id),
        body: `🔔 **Reminder email sent to client** (${client.email}) on ${now.toLocaleString()}`,
        createdBy: resolveUserId(req) || 'system',
        updatedBy: resolveUserId(req) || 'system'
      });
    } catch (cErr) {
      console.warn('[TaskService] Task comment log warning:', cErr.message);
    }
  }

  const enriched = await enrichTask(req, task);
  return {
    ...enriched,
    reminderSent: true,
    clientNotifiedEmail: client.email,
    clientNotifiedAt: now
  };
}

/**
 * Automatically process and send reminder emails to clients for tasks
 * whose client feedback status is 'Awaiting Reply' (or similar pending statuses)
 * and have exceeded the configured reminder threshold hours.
 */
async function processAutoClientReminders(req) {
  const SettingService = require('./setting.service');
  const autoEnabled = await SettingService.getTaskClientReminderAutoEnabled(req);
  const reminderHours = await SettingService.getTaskClientReminderHours(req);

  const tenantId = resolveTenantId(req);

  const Task = req.cms?.models.get('Task');
  const Project = req.cms?.models.get('Project');
  const Company = req.cms?.models.get('Company');

  if (!Task || !Project || !Company) {
    return {
      success: false,
      autoEnabled,
      processedCount: 0,
      sentCount: 0,
      message: 'Required database models not registered'
    };
  }

  // When workspace auto is off, still process tasks with an explicit per-task schedule.
  const query = {
    tenantId,
    isDeleted: false,
    clientFeedbackStatus: {
      $in: [
        'Awaiting Reply',
        'awaiting_reply',
        'Pending Review',
        'Pending Feedback',
        'Not Replied'
      ]
    }
  };
  if (!autoEnabled) {
    query.reminderScheduleEnabled = true;
  }

  const candidateTasks = await Task.find(query).lean();

  if (!autoEnabled && !candidateTasks.length) {
    return {
      success: true,
      autoEnabled: false,
      processedCount: 0,
      sentCount: 0,
      message: 'Automatic client reminders are currently disabled in settings (no per-task schedules active)'
    };
  }

  const now = new Date();
  let sentCount = 0;
  const sentTasks = [];
  let skippedNotDue = 0;

  for (const task of candidateTasks) {
    try {
      if (!autoEnabled && !task.reminderScheduleEnabled) continue;
      if (!isTaskReminderDue(task, reminderHours, now)) {
        skippedNotDue += 1;
        continue;
      }

      const project = await Project.findOne({ tenantId, _id: String(task.projectId), isDeleted: false }).lean();
      if (!project || !project.clientId) continue;

      const client = await Company.findOne({ tenantId, _id: String(project.clientId), isDeleted: false }).lean();
      if (!client || !client.email) continue;

      const MailService = require('./mail.service');
      const mailConfig = await MailService.resolveMailConfig(req);
      const companyName = mailConfig.fromName || 'Root CRM';

      // Check for any downstream tasks waiting on this completed / pending-review task
      const dependentTasks = await Task.find({
        tenantId,
        projectId: String(task.projectId),
        dependsOnTaskId: String(task._id),
        isDeleted: false,
        status: { $ne: 'Completed' }
      }).lean();

      const hasBlockedTasks = dependentTasks.length > 0;
      const scheduleLabel = task.reminderScheduleEnabled && Number(task.reminderIntervalValue) > 0
        ? `Per-task schedule: every ${task.reminderIntervalValue} ${task.reminderIntervalType || 'hours'}`
        : `Workspace default: every ${reminderHours} hours`;
      const subject = hasBlockedTasks
        ? `⚠️ Action Required: Tasks on Hold for ${project.name} — Review Needed for: ${task.title}`
        : `Reminder: Client Feedback Requested for Task: ${task.title} - ${project.name}`;

      const dependentTasksHtml = hasBlockedTasks ? `
        <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
          <h4 style="margin: 0 0 6px 0; color: #991b1b; font-size: 0.95rem;">⏳ Subsequent Tasks Currently On Hold</h4>
          <p style="margin: 0 0 8px 0; color: #7f1d1d; font-size: 0.88rem;">The team has completed <strong>${task.title}</strong>, but the following dependent task(s) cannot start until your review or approval is received:</p>
          <ul style="margin: 0; padding-left: 20px; color: #7f1d1d; font-size: 0.88rem;">
            ${dependentTasks.map((dt) => `<li><strong>${dt.title}</strong> · Status: ${dt.status || 'Pending'} · Priority: ${dt.priority || 'Medium'}</li>`).join('')}
          </ul>
        </div>
      ` : '';

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: ${hasBlockedTasks ? '#b91c1c' : '#0f172a'}; margin-top: 0;">${hasBlockedTasks ? '⚠️ Task Review Needed to Resume Project' : 'Task Review Reminder 🔔'}</h2>
          <p>Dear ${client.name || 'Client'},</p>
          <p>This is an automated reminder regarding the deliverable under project <strong>${project.name}</strong>:</p>
          
          <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
            <h3 style="margin: 0 0 6px 0; color: #1e293b;">${task.title}</h3>
            ${task.description ? `<p style="margin: 0 0 6px 0; color: #64748b; font-size: 0.9rem;">${task.description}</p>` : ''}
            <div style="font-size: 0.82rem; color: #475569;">
              <span>Status: <strong style="color: #10b981;">${task.status}</strong></span> · 
              <span>Priority: <strong>${task.priority || 'Medium'}</strong></span> · 
              <span>Feedback Status: <strong style="color: #d97706;">${task.clientFeedbackStatus}</strong></span>
            </div>
          </div>

          ${dependentTasksHtml}

          <p>Please take a moment to review the completed deliverable and provide your feedback or approval so our team can proceed with the next project phases without delay.</p>
          <p>You can reply directly to this email with your feedback or approval, or use the client portal link below to review your task after login.</p>
          ${renderClientPortalCtaHtml(buildClientPortalLoginUrl(req))}
          <p style="color: #64748b; font-size: 0.85rem; margin-top: 24px;">Best regards,<br><strong>${companyName}</strong></p>
        </div>
      `;

      await MailService.sendViaEmailPlugin(req, {
        to: client.email,
        subject,
        html
      });

      const sentAt = new Date();
      await Task.updateOne(
        { tenantId, _id: String(task._id) },
        {
          $set: {
            lastReminderSentAt: sentAt,
            clientNotifiedAt: sentAt,
            clientNotifiedEmail: client.email
          },
          $inc: { reminderCount: 1 }
        }
      );

      await AuditService.log(req, {
        action: 'auto_reminder_sent',
        module: 'task',
        recordId: String(task._id),
        description: `Automated review reminder email sent to ${client.email} for task: ${task.title} (${scheduleLabel}; Dependent blocked tasks: ${dependentTasks.length})`,
        metadata: {
          projectId: task.projectId,
          taskId: String(task._id),
          recipientEmail: client.email,
          blockedTasksCount: dependentTasks.length,
          scheduleLabel,
          reminderScheduleEnabled: Boolean(task.reminderScheduleEnabled),
          reminderIntervalType: task.reminderIntervalType || null,
          reminderIntervalValue: task.reminderIntervalValue || null,
          kind: 'auto',
          sentAt
        }
      });

      const TaskComment = req.cms?.models.get('TaskComment');
      if (TaskComment) {
        try {
          const blockedNote = hasBlockedTasks
            ? ` (${dependentTasks.length} dependent task(s) currently on hold: ${dependentTasks.map((d) => d.title).join(', ')})`
            : '';
          await TaskComment.create({
            tenantId,
            taskId: String(task._id),
            body: `🤖 **Automatic reminder email sent to client** (${client.email}) — ${scheduleLabel}.${blockedNote}`,
            createdBy: 'system',
            updatedBy: 'system'
          });
        } catch (cErr) {
          console.warn('[TaskService] Task comment log warning:', cErr.message);
        }
      }

      sentCount++;
      sentTasks.push({
        id: String(task._id),
        title: task.title,
        email: client.email,
        blockedTasksCount: dependentTasks.length,
        scheduleLabel
      });
    } catch (taskErr) {
      console.warn(`[TaskService] Auto-reminder error for task ${task._id}:`, taskErr.message);
    }
  }

  return {
    success: true,
    autoEnabled,
    processedCount: candidateTasks.length,
    sentCount,
    skippedNotDue,
    sentTasks,
    message: `Processed ${candidateTasks.length} awaiting-reply tasks. Sent ${sentCount} automatic reminder emails${skippedNotDue ? ` (${skippedNotDue} not due yet)` : ''}.`
  };
}

/**
 * Cron entrypoint: run auto reminders for every known tenant (not only "default").
 */
async function processAutoClientRemindersForAllTenants(cms) {
  const tenantIds = new Set(['default']);
  const Setting = cms?.models?.get?.('Setting');
  const Task = cms?.models?.get?.('Task');

  try {
    if (Setting) {
      const fromSettings = await Setting.distinct('tenantId', { isDeleted: false });
      (fromSettings || []).forEach((id) => {
        if (id) tenantIds.add(String(id));
      });
    }
  } catch (err) {
    console.warn('[TaskService] Could not list Setting tenants for auto reminders:', err?.message || err);
  }

  try {
    if (Task) {
      const fromTasks = await Task.distinct('tenantId', { isDeleted: false });
      (fromTasks || []).forEach((id) => {
        if (id) tenantIds.add(String(id));
      });
    }
  } catch (err) {
    console.warn('[TaskService] Could not list Task tenants for auto reminders:', err?.message || err);
  }

  const results = [];
  let totalSent = 0;
  let enabledTenants = 0;

  for (const tenantId of tenantIds) {
    try {
      const result = await processAutoClientReminders({ cms, tenantId });
      results.push({ tenantId, ...result });
      if (result?.autoEnabled) enabledTenants += 1;
      totalSent += Number(result?.sentCount || 0);
    } catch (err) {
      results.push({
        tenantId,
        success: false,
        autoEnabled: null,
        sentCount: 0,
        message: err?.message || String(err)
      });
    }
  }

  return {
    success: true,
    tenantCount: tenantIds.size,
    enabledTenants,
    sentCount: totalSent,
    results,
    message: `Auto reminders across ${tenantIds.size} tenant(s): ${enabledTenants} enabled, ${totalSent} email(s) sent.`
  };
}

function calculateNextRecurringDate(baseDate, interval = 'month', every = 1) {
  const d = baseDate ? new Date(baseDate) : new Date();
  if (isNaN(d.getTime())) return null;
  const next = new Date(d.getTime());
  const step = Math.max(1, parseInt(every, 10) || 1);
  switch (String(interval).toLowerCase()) {
    case 'day':
      next.setDate(next.getDate() + step);
      break;
    case 'week':
      next.setDate(next.getDate() + (step * 7));
      break;
    case 'month':
      next.setMonth(next.getMonth() + step);
      break;
    case 'quarter':
      next.setMonth(next.getMonth() + (step * 3));
      break;
    case 'year':
      next.setFullYear(next.getFullYear() + step);
      break;
    default:
      next.setMonth(next.getMonth() + step);
      break;
  }
  return next;
}

async function enrichTasks(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const userIds = [
    ...new Set(
      items.flatMap((item) => [
        item.assignedTo,
        item.createdBy,
        ...(Array.isArray(item.followers) ? item.followers : []),
        ...(Array.isArray(item.subtasks) ? item.subtasks.flatMap((st) => [st.assignedTo, st.createdBy, st.completedBy]) : [])
      ].map((value) => String(value || '').trim()))
    )
  ].filter(Boolean);
  const nameMap = await resolveUsernames(req, userIds);
  const designationMap = await resolveUserDesignations(req, userIds);

  const Project = req.cms?.models.get('Project');
  const projectMap = {};
  if (Project) {
    const rawProjectIds = [...new Set(items.map((item) => String(item.projectId || '')).filter(Boolean))];
    const validHexObjectIds = rawProjectIds.filter((pid) => /^[0-9a-fA-F]{24}$/.test(pid));
    if (validHexObjectIds.length) {
      try {
        const projects = await Project.find({
          tenantId: resolveTenantId(req),
          isDeleted: false,
          _id: { $in: validHexObjectIds }
        })
          .select('name clientId')
          .lean();
        for (const project of projects) {
          projectMap[String(project._id)] = project;
        }
      } catch (err) {
        console.warn('[TaskService] Project lookup warning:', err.message);
      }
    }
  }

  const Milestone = req.cms?.models.get('Milestone');
  const milestoneMap = {};
  if (Milestone) {
    const rawMilestoneIds = [...new Set(items.map((item) => String(item.milestoneId || '')).filter(Boolean))];
    const validMilestoneHexIds = rawMilestoneIds.filter((mid) => /^[0-9a-fA-F]{24}$/.test(mid));
    if (validMilestoneHexIds.length) {
      try {
        const milestones = await Milestone.find({
          tenantId: resolveTenantId(req),
          isDeleted: false,
          _id: { $in: validMilestoneHexIds }
        })
          .select('title status')
          .lean();
        for (const m of milestones) {
          milestoneMap[String(m._id)] = m.title;
        }
      } catch (err) {
        console.warn('[TaskService] Milestone lookup warning:', err.message);
      }
    }
  }

  const Task = getTaskModel(req);
  const dependsOnMap = {};
  const rawDependsOnIds = [...new Set(items.map((item) => String(item.dependsOnTaskId || '')).filter(Boolean))];
  const validDependsOnIds = rawDependsOnIds.filter((tid) => /^[0-9a-fA-F]{24}$/.test(tid));
  if (validDependsOnIds.length) {
    try {
      const deps = await Task.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        _id: { $in: validDependsOnIds }
      })
        .select('title status projectId')
        .lean();
      for (const dep of deps) {
        dependsOnMap[String(dep._id)] = dep;
      }
    } catch (err) {
      console.warn('[TaskService] Dependency lookup warning:', err.message);
    }
  }

  return items.map((item) => {
    let pName = projectMap[String(item.projectId)]?.name;
    if (!pName) {
      if (item.projectId === 'marketing-leads') pName = 'Marketing Lead Drip';
      else if (item.projectId === 'ai-lead-actions') pName = 'AI Intelligence Action';
      else if (item.projectId === 'sample_improvement') pName = 'Sample Improvement';
      else pName = item.projectId ? String(item.projectId).replace(/[-_]/g, ' ') : '—';
    }
    const rawName = item.assignedTo ? nameMap[item.assignedTo] || item.assignedTo : '—';
    const desig = item.assignedTo ? designationMap[item.assignedTo]?.designation : '';
    const assignedUsername = desig && rawName !== '—' ? `${rawName} (${desig})` : rawName;

    const followers = (Array.isArray(item.followers) ? item.followers : []).map(String).filter(Boolean);
    const followerUsers = followers.map((uid) => {
      const rawF = nameMap[uid] || uid;
      const fDesig = designationMap[uid]?.designation || '';
      return {
        id: uid,
        username: rawF,
        displayName: fDesig ? `${rawF} (${fDesig})` : rawF,
        designation: fDesig
      };
    });

    const enrichedSubtasks = (Array.isArray(item.subtasks) ? item.subtasks : []).map((st) => {
      const stObj = st.toObject ? st.toObject() : st;
      const stRawName = stObj.assignedTo ? nameMap[stObj.assignedTo] || stObj.assignedTo : '';
      const stDesig = stObj.assignedTo ? designationMap[stObj.assignedTo]?.designation : '';
      const stAssignedUsername = stDesig && stRawName ? `${stRawName} (${stDesig})` : stRawName;
      return {
        ...stObj,
        _id: String(stObj._id || ''),
        assignedUsername: stAssignedUsername,
        assignedUserDesignation: stDesig || '',
        createdUsername: nameMap[stObj.createdBy] || stObj.createdBy || 'System',
        completedUsername: nameMap[stObj.completedBy] || stObj.completedBy || ''
      };
    });

    const dependsOn = item.dependsOnTaskId ? dependsOnMap[String(item.dependsOnTaskId)] : null;
    const dependsOnTaskId = item.dependsOnTaskId ? String(item.dependsOnTaskId) : null;
    const dependsOnCompleted = dependsOn ? String(dependsOn.status || '') === 'Completed' : null;

    return {
      ...item,
      assignedUsername,
      assignedUserDesignation: desig || '',
      projectName: pName,
      milestoneTitle: milestoneMap[String(item.milestoneId)] || null,
      dependsOnTaskId,
      dependsOnTaskTitle: dependsOn?.title || null,
      dependsOnTaskStatus: dependsOn?.status || null,
      dependsOnCompleted,
      isDependencyBlocked: Boolean(dependsOnTaskId && dependsOn && !dependsOnCompleted),
      followers,
      followerUsers,
      followerCount: followers.length,
      subtasks: enrichedSubtasks,
      subtaskCount: enrichedSubtasks.length,
      subtasksCompletedCount: enrichedSubtasks.filter((st) => st.isCompleted).length,
      isRecurring: Boolean(item.isRecurring),
      recurringInterval: item.recurringInterval || 'month',
      recurringEvery: item.recurringEvery || 1,
      recurringTotalCycles: item.recurringTotalCycles || 0,
      recurringCyclesCompleted: item.recurringCyclesCompleted || 0,
      recurringNextDate: item.recurringNextDate || null,
      recurringLastGeneratedAt: item.recurringLastGeneratedAt || null,
      recurringParentTaskId: item.recurringParentTaskId || null,
      notifyClientOnCompletion: Boolean(item.notifyClientOnCompletion),
      clientNotifiedAt: item.clientNotifiedAt || null,
      clientNotifiedEmail: item.clientNotifiedEmail || null,
      lastReminderSentAt: item.lastReminderSentAt || null,
      reminderCount: Number(item.reminderCount) || 0,
      reminderScheduleEnabled: Boolean(item.reminderScheduleEnabled),
      reminderIntervalType: item.reminderIntervalType || 'hours',
      reminderIntervalValue:
        item.reminderIntervalValue === null || item.reminderIntervalValue === undefined
          ? null
          : Number(item.reminderIntervalValue) || null,
      clientFeedbackStatus: item.clientFeedbackStatus || 'Dissatisfied',
      clientSatisfied: item.clientSatisfied ?? (item.clientFeedbackStatus === 'Satisfied' ? true : (item.clientFeedbackStatus === 'Dissatisfied' ? false : null)),
      clientFeedbackNotes: item.clientFeedbackNotes || '',
      isArchived: Boolean(item.isArchived),
      archivedAt: item.archivedAt || null,
      archivedBy: item.archivedBy || null
    };
  });
}

async function enrichTask(req, item) {
  if (!item) return item;
  const [enriched] = await enrichTasks(req, [item]);
  return enriched;
}

async function list(req) {
  const Task = getTaskModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query);
  const filter = baseFilter(req);

  if (req.query?.isRecurring !== undefined) {
    filter.isRecurring = req.query.isRecurring === 'true' || req.query.isRecurring === '1';
  }
  if (req.query?.recurringParentTaskId !== undefined) {
    const parentId = String(req.query.recurringParentTaskId).trim();
    if (parentId === 'none' || parentId === 'null') {
      filter.recurringParentTaskId = { $in: [null, ''] };
    } else if (parentId) {
      filter.recurringParentTaskId = parentId;
    }
  }
  const clientUser = isClientUser(req);
  if (clientUser) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: 'Client email ID not found in CRM records'
      };
    }
    const Project = req.cms?.models.get('Project');
    let clientProjectIds = [];
    if (Project) {
      const clientProjects = await Project.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        clientId: userClientId
      }).select('_id').lean();
      clientProjectIds = clientProjects.map((p) => String(p._id));
    }
    filter.$or = [
      { clientId: userClientId },
      { projectId: { $in: clientProjectIds } }
    ];
  } else if (req.query?.clientId) {
    const targetClientId = String(req.query.clientId).trim();
    const Project = req.cms?.models.get('Project');
    let clientProjectIds = [];
    if (Project) {
      const clientProjects = await Project.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        clientId: targetClientId
      }).select('_id').lean();
      clientProjectIds = clientProjects.map((p) => String(p._id));
    }
    filter.$or = [
      { clientId: targetClientId },
      { projectId: { $in: clientProjectIds } }
    ];
  } else if (req.query?.projectId) {
    filter.projectId = String(req.query.projectId).trim();
  } else {
    // Only show tasks assigned to real projects
    filter.projectId = { $nin: ['ai-lead-actions', 'marketing-leads', 'sample_improvement'] };
  }
  if (req.query?.milestoneId) {
    const rawMid = String(req.query.milestoneId).trim();
    if (rawMid === 'none' || rawMid === 'null' || rawMid === 'unassigned') {
      filter.milestoneId = { $in: [null, ''] };
    } else if (rawMid) {
      filter.milestoneId = rawMid;
    }
  }
  if (req.query?.status) {
    filter.status = String(req.query.status).trim();
  }

  if (req.query?.isProjectDropped === 'true' || req.query?.dropped === 'true') {
    filter.isProjectDropped = true;
  } else if (req.query?.isProjectDropped === 'all') {
    /* no project dropped filter */
  } else {
    filter.isProjectDropped = { $ne: true };
  }

  // Archive visibility: default active only; isArchived=true|1|archived for archived; all|any for both
  const archiveRaw = String(req.query?.isArchived ?? req.query?.archived ?? '').trim().toLowerCase();
  if (archiveRaw === 'true' || archiveRaw === '1' || archiveRaw === 'archived' || archiveRaw === 'yes') {
    filter.isArchived = true;
  } else if (archiveRaw === 'all' || archiveRaw === 'any') {
    /* no archive filter */
  } else {
    filter.isArchived = { $ne: true };
  }

  // Due date shortcuts: open | today | overdue (also accepts overdue=true)
  const dueRaw = String(req.query?.due || '').trim().toLowerCase();
  const overdueRequested =
    dueRaw === 'overdue' ||
    req.query?.overdue === 'true' ||
    req.query?.overdue === true ||
    req.query?.overdue === '1';

  if (overdueRequested) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    filter.dueDate = { $ne: null, $lt: startOfToday };
    if (!req.query?.status) {
      filter.status = { $nin: ['Completed', 'Cancelled'] };
    }
  } else if (dueRaw === 'today') {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    filter.dueDate = { $gte: startOfToday, $lte: endOfToday };
    if (!req.query?.status) {
      filter.status = { $nin: ['Completed', 'Cancelled'] };
    }
  } else if (dueRaw === 'open') {
    if (!req.query?.status) {
      filter.status = { $nin: ['Completed', 'Cancelled'] };
    }
  }

  if (req.query?.clientFeedbackStatus) {
    const rawSt = String(req.query.clientFeedbackStatus).trim();
    if (rawSt === 'Pending Review' || rawSt === 'Pending Feedback') {
      filter.clientFeedbackStatus = { $in: ['Pending Review', 'Pending Feedback'] };
    } else if (rawSt === 'Not Replied' || rawSt === 'Awaiting Reply') {
      filter.clientFeedbackStatus = { $in: ['Not Replied', 'Awaiting Reply'] };
    } else {
      filter.clientFeedbackStatus = rawSt;
    }
  }
  if (req.query?.clientSatisfied !== undefined) {
    filter.clientSatisfied = req.query.clientSatisfied === 'true';
  }
  if (req.query?.assignedTo) {
    filter.assignedTo = String(req.query.assignedTo).trim();
  }
  if (req.query?.follower) {
    filter.followers = String(req.query.follower).trim();
  } else if (req.query?.isFollower === 'true' || req.query?.isFollower === '1' || req.query?.watching === 'true') {
    filter.followers = resolveUserId(req);
  }
  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const searchClause = {
        $or: [
          { title: { $regex: term, $options: 'i' } },
          { description: { $regex: term, $options: 'i' } }
        ]
      };
      if (filter.$or) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: filter.$or }, searchClause);
        delete filter.$or;
      } else if (filter.$and) {
        filter.$and.push(searchClause);
      } else {
        filter.$or = searchClause.$or;
      }
    }
  }

  const scopedFilter = await applyEmployeeTaskListScope(req, filter);
  const [items, total] = await Promise.all([
    Task.find(scopedFilter).sort(sort).skip(skip).limit(limit).lean(),
    Task.countDocuments(scopedFilter)
  ]);

  return {
    items: await enrichTasks(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function listByProject(req, projectId) {
  req.query = { ...(req.query || {}), projectId: String(projectId) };
  return list(req);
}

async function getById(req, id) {
  const { task } = await findTaskOrThrow(req, id);
  return enrichTask(req, task);
}

async function create(req, input) {
  const Task = getTaskModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const validStatuses = await getValidStatuses(req);
  const validPriorities = await getValidPriorities(req);

  if (!input.title) throw appError('Title is required');
  if (!input.projectId) throw appError('projectId is required');

  const project = await getProjectContext(req, input.projectId);
  if (project?.isArchived) {
    throw appError('Cannot create tasks for an archived project. Please restore the project first.', 400);
  }
  await assertTaskWriteAccess(
    req,
    { projectId: input.projectId, assignedTo: input.assignedTo, createdBy: userId },
    project
  );

  const status = input.status || validStatuses[0];
  const priority = input.priority || 'Medium';
  assertValidStatus(status, validStatuses);
  assertValidPriority(priority, validPriorities);

  const assignedUserId = input.assignedTo !== undefined ? String(input.assignedTo).trim() : userId;
  await assertValidTaskAssignee(req, input.projectId, assignedUserId, project);

  let feedbackStatus = input.clientFeedbackStatus || 'Pending Review';
  let clientSatisfied = input.clientSatisfied ?? null;
  if (input.clientSatisfied === true) feedbackStatus = 'Satisfied';
  else if (input.clientSatisfied === false) feedbackStatus = 'Pending Review';
  else if (feedbackStatus === 'Satisfied') clientSatisfied = true;
  else if (feedbackStatus === 'Dissatisfied') clientSatisfied = false;
  else if (feedbackStatus === 'Not Replied' || feedbackStatus === 'Awaiting Reply' || feedbackStatus === 'Pending Feedback' || feedbackStatus === 'Pending Review') clientSatisfied = null;

  const isRecurring = Boolean(input.isRecurring);
  let recurringInterval = 'month';
  let recurringEvery = 1;
  let recurringTotalCycles = 0;
  let recurringNextDate = null;
  const recurringParentTaskId = input.recurringParentTaskId ? String(input.recurringParentTaskId).trim() : null;

  if (isRecurring) {
    recurringInterval = input.recurringInterval ? String(input.recurringInterval).trim().toLowerCase() : 'month';
    recurringEvery = Math.max(1, parseInt(input.recurringEvery, 10) || 1);
    recurringTotalCycles = Math.max(0, parseInt(input.recurringTotalCycles, 10) || 0);
    if (input.recurringNextDate) {
      recurringNextDate = new Date(input.recurringNextDate);
    } else {
      recurringNextDate = calculateNextRecurringDate(
        input.dueDate ? new Date(input.dueDate) : new Date(),
        recurringInterval,
        recurringEvery
      );
    }
  }

  const followers = Array.isArray(input.followers)
    ? [...new Set(input.followers.map(String).map((s) => s.trim()).filter(Boolean))]
    : [];

  const dependsOnTaskId = await assertValidDependsOnTask(
    req,
    input.projectId,
    input.dependsOnTaskId,
    null
  );

  const task = await Task.create({
    tenantId,
    projectId: String(input.projectId),
    milestoneId: input.milestoneId ? String(input.milestoneId).trim() : null,
    dependsOnTaskId: dependsOnTaskId ? String(dependsOnTaskId._id) : null,
    title: String(input.title).trim(),
    description: input.description ? String(input.description).trim() : '',
    status,
    priority,
    assignedTo: assignedUserId,
    dueDate: input.dueDate ? new Date(input.dueDate) : null,
    followers,
    isRecurring,
    recurringInterval,
    recurringEvery,
    recurringTotalCycles,
    recurringCyclesCompleted: 0,
    recurringNextDate,
    recurringLastGeneratedAt: null,
    recurringParentTaskId,
    notifyClientOnCompletion: Boolean(input.notifyClientOnCompletion),
    clientFeedbackStatus: feedbackStatus,
    clientSatisfied,
    clientFeedbackNotes: input.clientFeedbackNotes ? String(input.clientFeedbackNotes).trim() : '',
    createdBy: userId,
    updatedBy: userId
  });

  const doc = task.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'task',
    recordId: doc._id.toString(),
    description: `Task created: ${doc.title}`,
    metadata: { projectId: doc.projectId, status: doc.status, milestoneId: doc.milestoneId, isRecurring: doc.isRecurring }
  });

  if (doc.status === 'Completed' && doc.notifyClientOnCompletion) {
    sendTaskCompletionNotification(req, doc, project);
  }

  return enrichTask(req, doc);
}

async function update(req, id, input) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task: existing, project } = await findTaskOrThrow(req, id);
  if (project?.isArchived) {
    throw appError('Cannot update tasks for an archived project. Please restore the project first.', 400);
  }
  if (existing.isArchived) {
    throw appError('Cannot update an archived task. Please restore the task first.', 400);
  }
  await assertTaskWriteAccess(req, existing, project);

  if (isClientUser(req)) {
    // Client role can only update task client feedback (Satisfied or Not Satisfied / Dissatisfied)
    const clientStatus = input.clientFeedbackStatus !== undefined
      ? String(input.clientFeedbackStatus).trim()
      : (input.clientSatisfied !== undefined ? (input.clientSatisfied ? 'Satisfied' : 'Dissatisfied') : null);

    if (!clientStatus) {
      throw appError('Client can only update client status to "Satisfied" or "Not Satisfied"', 400);
    }

    const normalizedStatus = (clientStatus === 'Satisfied' || clientStatus === 'satisfied')
      ? 'Satisfied'
      : ((clientStatus === 'Dissatisfied' || clientStatus === 'dissatisfied' || clientStatus === 'Not Satisfied' || clientStatus === 'not satisfied') ? 'Dissatisfied' : null);

    if (!normalizedStatus) {
      throw appError('Client can only choose between "Satisfied" and "Not Satisfied"', 400);
    }

    // Check if client attempted to modify non-feedback fields
    const disallowedFields = [
      'title',
      'description',
      'status',
      'priority',
      'assignedTo',
      'dueDate',
      'milestoneId',
      'dependsOnTaskId',
      'hoursEstimate',
      'isRecurring',
      'followers',
      'reminderScheduleEnabled',
      'reminderIntervalType',
      'reminderIntervalValue'
    ];
    for (const f of disallowedFields) {
      if (input[f] !== undefined) {
        throw appError(`Clients cannot modify task field "${f}"`, 403);
      }
    }

    const clientUpdates = {
      clientFeedbackStatus: normalizedStatus,
      clientSatisfied: normalizedStatus === 'Satisfied',
      updatedBy: userId
    };
    if (input.clientFeedbackNotes !== undefined) {
      clientUpdates.clientFeedbackNotes = String(input.clientFeedbackNotes).trim();
    }

    const task = await Task.findOneAndUpdate(
      { ...baseFilter(req), _id: id },
      { $set: clientUpdates },
      { new: true, runValidators: true }
    ).lean();

    await AuditService.log(req, {
      action: 'updated',
      module: 'task',
      recordId: id,
      description: `Client feedback updated to "${normalizedStatus}" on task: ${task.title}`
    });

    return enrichTask(req, task);
  }

  const { hasPermission, isAdmin } = require('../utils/sales-access.util');
  if (!isAdmin(req) && !hasPermission(req, 'crm.tasks.write')) {
    throw appError('Permission denied: Missing permission crm.tasks.write', 403);
  }

  const validStatuses = await getValidStatuses(req);
  const validPriorities = await getValidPriorities(req);
  const updates = { updatedBy: userId };

  if (input.title !== undefined) {
    if (!String(input.title).trim()) throw appError('Title is required');
    updates.title = String(input.title).trim();
  }
  if (input.description !== undefined) updates.description = String(input.description).trim();
  if (input.milestoneId !== undefined) updates.milestoneId = input.milestoneId ? String(input.milestoneId).trim() : null;
  if (input.dependsOnTaskId !== undefined) {
    const dep = await assertValidDependsOnTask(
      req,
      input.projectId || existing.projectId,
      input.dependsOnTaskId,
      id
    );
    updates.dependsOnTaskId = dep ? String(dep._id) : null;
  }
  if (input.status !== undefined) {
    assertValidStatus(String(input.status).trim(), validStatuses);
    updates.status = String(input.status).trim();
    if (updates.status === 'Completed' && input.clientFeedbackStatus === undefined && input.clientSatisfied === undefined) {
      if (!existing.clientFeedbackStatus || existing.clientFeedbackStatus === 'Pending Review' || existing.clientFeedbackStatus === 'Pending Feedback') {
        updates.clientFeedbackStatus = 'Not Replied';
        updates.clientSatisfied = null;
      }
    }
  }
  if (input.priority !== undefined) {
    assertValidPriority(String(input.priority).trim(), validPriorities);
    updates.priority = String(input.priority).trim();
  }
  if (input.assignedTo !== undefined) {
    const trimmedAssignee = String(input.assignedTo).trim();
    await assertValidTaskAssignee(req, input.projectId || existing.projectId, trimmedAssignee, project);
    updates.assignedTo = trimmedAssignee;
  }
  if (input.dueDate !== undefined) {
    updates.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  }
  if (input.notifyClientOnCompletion !== undefined) {
    updates.notifyClientOnCompletion = Boolean(input.notifyClientOnCompletion);
  }
  if (input.reminderScheduleEnabled !== undefined) {
    updates.reminderScheduleEnabled =
      input.reminderScheduleEnabled === true ||
      input.reminderScheduleEnabled === 'true' ||
      input.reminderScheduleEnabled === 1 ||
      input.reminderScheduleEnabled === '1';
  }
  if (input.reminderIntervalType !== undefined) {
    const type = String(input.reminderIntervalType || 'hours').trim().toLowerCase();
    if (!['hours', 'days', 'weeks', 'months'].includes(type)) {
      throw appError('Invalid reminderIntervalType. Allowed: hours, days, weeks, months', 400);
    }
    updates.reminderIntervalType = type;
  }
  if (input.reminderIntervalValue !== undefined) {
    if (input.reminderIntervalValue === null || input.reminderIntervalValue === '') {
      updates.reminderIntervalValue = null;
    } else {
      const num = parseInt(input.reminderIntervalValue, 10);
      if (!Number.isFinite(num) || num < 1) {
        throw appError('reminderIntervalValue must be a positive number', 400);
      }
      updates.reminderIntervalValue = Math.min(8760, num);
    }
  }
  if (input.clientFeedbackStatus !== undefined) {
    updates.clientFeedbackStatus = String(input.clientFeedbackStatus).trim();
    if (updates.clientFeedbackStatus === 'Satisfied') updates.clientSatisfied = true;
    else if (updates.clientFeedbackStatus === 'Dissatisfied') updates.clientSatisfied = false;
    else if (updates.clientFeedbackStatus === 'Pending Review' || updates.clientFeedbackStatus === 'Pending Feedback' || updates.clientFeedbackStatus === 'Not Replied' || updates.clientFeedbackStatus === 'Awaiting Reply') updates.clientSatisfied = null;
  }
  if (input.clientSatisfied !== undefined && updates.clientSatisfied === undefined) {
    updates.clientSatisfied = input.clientSatisfied;
    if (updates.clientSatisfied === true) updates.clientFeedbackStatus = 'Satisfied';
    else if (updates.clientSatisfied === false) updates.clientFeedbackStatus = 'Dissatisfied';
  }
  if (input.clientFeedbackNotes !== undefined) {
    updates.clientFeedbackNotes = String(input.clientFeedbackNotes).trim();
  }

  if (input.followers !== undefined) {
    updates.followers = Array.isArray(input.followers)
      ? [...new Set(input.followers.map(String).map((s) => s.trim()).filter(Boolean))]
      : [];
  }

  if (input.isRecurring !== undefined) {
    updates.isRecurring = Boolean(input.isRecurring);
    if (updates.isRecurring) {
      if (input.recurringInterval !== undefined) updates.recurringInterval = String(input.recurringInterval).trim().toLowerCase();
      if (input.recurringEvery !== undefined) updates.recurringEvery = Math.max(1, parseInt(input.recurringEvery, 10) || 1);
      if (input.recurringTotalCycles !== undefined) updates.recurringTotalCycles = Math.max(0, parseInt(input.recurringTotalCycles, 10) || 0);
      if (input.recurringNextDate !== undefined) {
        updates.recurringNextDate = input.recurringNextDate ? new Date(input.recurringNextDate) : null;
      } else if (!existing.recurringNextDate) {
        updates.recurringNextDate = calculateNextRecurringDate(
          input.dueDate || existing.dueDate || new Date(),
          updates.recurringInterval || existing.recurringInterval || 'month',
          updates.recurringEvery || existing.recurringEvery || 1
        );
      }
    } else {
      updates.recurringNextDate = null;
    }
  } else if (existing.isRecurring) {
    if (input.recurringInterval !== undefined) updates.recurringInterval = String(input.recurringInterval).trim().toLowerCase();
    if (input.recurringEvery !== undefined) updates.recurringEvery = Math.max(1, parseInt(input.recurringEvery, 10) || 1);
    if (input.recurringTotalCycles !== undefined) updates.recurringTotalCycles = Math.max(0, parseInt(input.recurringTotalCycles, 10) || 0);
    if (input.recurringNextDate !== undefined) updates.recurringNextDate = input.recurringNextDate ? new Date(input.recurringNextDate) : null;
  }

  const task = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'task',
    recordId: id,
    description: `Task updated: ${task.title}`
  });

  const isNowCompleted = task.status === 'Completed' && existing.status !== 'Completed';
  const shouldNotify = task.notifyClientOnCompletion && (isNowCompleted || (existing.status === 'Completed' && updates.notifyClientOnCompletion));
  if (shouldNotify) {
    sendTaskCompletionNotification(req, task, project);
  }

  return enrichTask(req, task);
}

async function changeStatus(req, id, status) {
  return update(req, id, typeof status === 'object' ? status : { status });
}

async function remove(req, id) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task: existing, project } = await findTaskOrThrow(req, id);
  const isCompleted =
    String(existing.status || '').toLowerCase() === 'completed' ||
    String(existing.status || '').toLowerCase() === 'done' ||
    Boolean(existing.isCompleted);
  if (isCompleted) {
    throw appError('Cannot delete a completed task.', 400);
  }
  if (project?.isArchived) {
    throw appError('Cannot delete tasks from an archived project. Please restore the project first.', 400);
  }
  if (existing.isArchived) {
    throw appError('Cannot delete an archived task. Restore it first, or keep it archived.', 400);
  }
  await assertTaskWriteAccess(req, existing, project);

  const task = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'deleted',
    module: 'task',
    recordId: id,
    description: `Task deleted: ${existing.title}`
  });

  return task;
}

async function archiveTask(req, id) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task: existing, project } = await findTaskOrThrow(req, id);
  if (project?.isArchived) {
    throw appError('Cannot archive tasks while the project is archived. Restore the project first.', 400);
  }
  await assertTaskWriteAccess(req, existing, project);

  if (existing.isArchived) {
    return enrichTask(req, existing);
  }

  const task = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isArchived: true,
        archivedAt: new Date(),
        archivedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'archived',
    module: 'task',
    recordId: id,
    description: `Task archived: ${existing.title}`,
    metadata: { projectId: existing.projectId }
  });

  return enrichTask(req, task);
}

async function restoreTask(req, id) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task: existing, project } = await findTaskOrThrow(req, id);
  if (project?.isArchived) {
    throw appError('Cannot restore tasks while the project is archived. Restore the project first.', 400);
  }
  await assertTaskWriteAccess(req, existing, project);

  if (!existing.isArchived) {
    return enrichTask(req, existing);
  }

  const task = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isArchived: false,
        archivedAt: null,
        archivedBy: null,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'restored',
    module: 'task',
    recordId: id,
    description: `Task restored from archive: ${existing.title}`,
    metadata: { projectId: existing.projectId }
  });

  return enrichTask(req, task);
}

async function listComments(req, taskId) {
  const TaskComment = getTaskCommentModel(req);
  if (!TaskComment) return [];

  await findTaskOrThrow(req, taskId);

  const rows = await TaskComment.find({
    ...baseFilter(req),
    taskId: String(taskId)
  })
    .sort({ createdAt: 1 })
    .lean();

  const nameMap = await resolveUsernames(
    req,
    rows.map((row) => row.createdBy)
  );

  return rows.map((row) => ({
    ...row,
    username: nameMap[row.createdBy] || row.createdBy || 'System'
  }));
}

async function addComment(req, taskId, body) {
  const TaskComment = getTaskCommentModel(req);
  if (!TaskComment) throw appError('Task comments are not available', 503);

  const { task, project } = await findTaskOrThrow(req, taskId);
  if (project?.isArchived) {
    throw appError('Cannot add comments to an archived project task. Please restore the project first.', 400);
  }
  if (task.isArchived) {
    throw appError('Cannot add comments to an archived task. Please restore the task first.', 400);
  }
  await assertTaskWriteAccess(req, task, project);

  const text = String(body || '').trim();
  if (!text) throw appError('Comment body is required');

  const userId = resolveUserId(req);
  const comment = await TaskComment.create({
    tenantId: resolveTenantId(req),
    taskId: String(taskId),
    body: text,
    createdBy: userId,
    updatedBy: userId
  });

  const doc = comment.toObject();
  await AuditService.log(req, {
    action: 'comment_added',
    module: 'task',
    recordId: String(taskId),
    description: `Comment added on task: ${task.title}`
  });

  const nameMap = await resolveUsernames(req, [userId]);
  return { ...doc, username: nameMap[userId] || userId };
}

async function listSubtasks(req, taskId) {
  const { task, project } = await findTaskOrThrow(req, taskId);
  await assertTaskReadAccess(req, task, project);
  const enriched = await enrichTask(req, task);
  return enriched.subtasks || [];
}

async function addSubtask(req, taskId, input) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task, project } = await findTaskOrThrow(req, taskId);
  if (project?.isArchived) {
    throw appError('Cannot add subtasks for an archived project. Please restore the project first.', 400);
  }
  if (task.isArchived) {
    throw appError('Cannot add subtasks to an archived task. Please restore the task first.', 400);
  }
  await assertTaskWriteAccess(req, task, project);

  let assignedTo = input.assignedTo ? String(input.assignedTo).trim() : '';
  if (!assignedTo && task.assignedTo) {
    assignedTo = String(task.assignedTo).trim();
  }
  if (assignedTo) {
    await assertValidTaskAssignee(req, task.projectId, assignedTo, project);
  }

  const crypto = require('crypto');
  const subtaskId = crypto.randomBytes(12).toString('hex');
  const newSubtask = {
    _id: subtaskId,
    title: String(input.title).trim(),
    description: input.description ? String(input.description).trim() : '',
    assignedTo,
    currentDate: input.currentDate ? new Date(input.currentDate) : new Date(),
    isCompleted: Boolean(input.isCompleted),
    completedAt: input.isCompleted ? new Date() : null,
    completedBy: input.isCompleted ? userId : null,
    createdBy: userId
  };

  const updated = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: taskId },
    { $push: { subtasks: newSubtask }, $set: { updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'subtask_created',
    module: 'task',
    recordId: String(taskId),
    description: `Subtask added: "${newSubtask.title}" to task "${task.title}"`
  });

  const enriched = await enrichTask(req, updated);
  return enriched.subtasks.find((st) => String(st._id) === subtaskId) || newSubtask;
}

async function updateSubtask(req, taskId, subtaskId, input) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task, project } = await findTaskOrThrow(req, taskId);
  if (project?.isArchived) {
    throw appError('Cannot update subtasks for an archived project. Please restore the project first.', 400);
  }
  if (task.isArchived) {
    throw appError('Cannot update subtasks on an archived task. Please restore the task first.', 400);
  }
  await assertTaskWriteAccess(req, task, project);

  const stId = String(subtaskId).trim();
  const existingSubtask = (task.subtasks || []).find((st) => String(st._id) === stId);
  if (!existingSubtask) throw appError('Subtask not found', 404);

  const updateFields = { 'subtasks.$.updatedAt': new Date(), updatedBy: userId };

  if (input.title !== undefined) {
    if (!String(input.title).trim()) throw appError('Subtask title is required');
    updateFields['subtasks.$.title'] = String(input.title).trim();
  }
  if (input.description !== undefined) {
    updateFields['subtasks.$.description'] = String(input.description).trim();
  }
  if (input.assignedTo !== undefined) {
    const assignedTo = String(input.assignedTo).trim();
    if (assignedTo) {
      await assertValidTaskAssignee(req, task.projectId, assignedTo, project);
    }
    updateFields['subtasks.$.assignedTo'] = assignedTo;
  }
  if (input.currentDate !== undefined) {
    updateFields['subtasks.$.currentDate'] = new Date(input.currentDate);
  }
  if (input.isCompleted !== undefined) {
    const completed = Boolean(input.isCompleted);
    updateFields['subtasks.$.isCompleted'] = completed;
    updateFields['subtasks.$.completedAt'] = completed ? new Date() : null;
    updateFields['subtasks.$.completedBy'] = completed ? userId : null;
  }

  const updated = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: taskId, 'subtasks._id': stId },
    { $set: updateFields },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'subtask_updated',
    module: 'task',
    recordId: String(taskId),
    description: `Subtask updated in task: ${task.title}`
  });

  const enriched = await enrichTask(req, updated);
  return enriched.subtasks.find((st) => String(st._id) === stId) || null;
}

async function toggleSubtask(req, taskId, subtaskId) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task, project } = await findTaskOrThrow(req, taskId);
  if (project?.isArchived) {
    throw appError('Cannot toggle subtasks for an archived project. Please restore the project first.', 400);
  }
  if (task.isArchived) {
    throw appError('Cannot update subtasks on an archived task. Please restore the task first.', 400);
  }
  await assertTaskWriteAccess(req, task, project);

  const stId = String(subtaskId).trim();
  const existingSubtask = (task.subtasks || []).find((st) => String(st._id) === stId);
  if (!existingSubtask) throw appError('Subtask not found', 404);

  const nextCompleted = !existingSubtask.isCompleted;
  const updateFields = {
    'subtasks.$.isCompleted': nextCompleted,
    'subtasks.$.completedAt': nextCompleted ? new Date() : null,
    'subtasks.$.completedBy': nextCompleted ? userId : null,
    'subtasks.$.updatedAt': new Date(),
    updatedBy: userId
  };

  const updated = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: taskId, 'subtasks._id': stId },
    { $set: updateFields },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: nextCompleted ? 'subtask_completed' : 'subtask_reopened',
    module: 'task',
    recordId: String(taskId),
    description: `Subtask "${existingSubtask.title}" ${nextCompleted ? 'marked completed' : 'reopened'}`
  });

  const enriched = await enrichTask(req, updated);
  return enriched.subtasks.find((st) => String(st._id) === stId) || null;
}

async function deleteSubtask(req, taskId, subtaskId) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task, project } = await findTaskOrThrow(req, taskId);
  if (project?.isArchived) {
    throw appError('Cannot delete subtasks for an archived project. Please restore the project first.', 400);
  }
  if (task.isArchived) {
    throw appError('Cannot delete subtasks from an archived task. Please restore the task first.', 400);
  }
  await assertTaskWriteAccess(req, task, project);

  const stId = String(subtaskId).trim();
  const existingSubtask = (task.subtasks || []).find((st) => String(st._id) === stId);
  if (!existingSubtask) throw appError('Subtask not found', 404);

  await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: taskId },
    { $pull: { subtasks: { _id: stId } }, $set: { updatedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'subtask_deleted',
    module: 'task',
    recordId: String(taskId),
    description: `Subtask deleted from task: ${task.title}`
  });

  return { success: true, message: 'Subtask deleted successfully' };
}

async function processRecurringTasks(req = {}) {
  const Task = getTaskModel(req);
  const now = new Date();
  const tenantId = resolveTenantId(req);
  const filter = {
    isDeleted: false,
    isRecurring: true,
    recurringNextDate: { $lte: now }
  };
  if (tenantId) filter.tenantId = tenantId;

  const recurringTasks = await Task.find(filter);
  const createdTasks = [];

  for (const master of recurringTasks) {
    try {
      const totalCycles = master.recurringTotalCycles || 0;
      const completedCycles = master.recurringCyclesCompleted || 0;

      if (totalCycles > 0 && completedCycles >= totalCycles) {
        master.isRecurring = false;
        master.recurringNextDate = null;
        await master.save();
        continue;
      }

      // Determine due date for new child task
      let childDueDate = null;
      if (master.dueDate && master.recurringNextDate) {
        childDueDate = new Date(master.recurringNextDate);
      } else if (master.dueDate) {
        childDueDate = calculateNextRecurringDate(master.dueDate, master.recurringInterval, master.recurringEvery);
      }

      const validStatuses = await getValidStatuses(req);
      const initialStatus = validStatuses[0] || 'To Do';

      const childDoc = await Task.create({
        tenantId: master.tenantId,
        projectId: master.projectId,
        milestoneId: master.milestoneId || null,
        title: master.title,
        description: master.description || '',
        status: initialStatus,
        priority: master.priority || 'Medium',
        assignedTo: master.assignedTo || '',
        startDate: new Date(),
        dueDate: childDueDate,
        hoursEstimate: master.hoursEstimate || 0,
        tags: master.tags || [],
        category: master.category || '',
        followers: master.followers || [],
        isRecurring: false,
        recurringParentTaskId: master._id.toString(),
        notifyClientOnCompletion: Boolean(master.notifyClientOnCompletion),
        clientFeedbackStatus: 'Pending Review',
        clientSatisfied: null,
        createdBy: master.createdBy || 'system',
        updatedBy: 'system'
      });

      createdTasks.push(childDoc);

      const newCyclesCompleted = completedCycles + 1;
      master.recurringCyclesCompleted = newCyclesCompleted;
      master.recurringLastGeneratedAt = now;

      if (totalCycles > 0 && newCyclesCompleted >= totalCycles) {
        master.isRecurring = false;
        master.recurringNextDate = null;
      } else {
        master.recurringNextDate = calculateNextRecurringDate(
          master.recurringNextDate || now,
          master.recurringInterval || 'month',
          master.recurringEvery || 1
        );
      }

      await master.save();

      await AuditService.log(req, {
        action: 'recurring_task_generated',
        module: 'task',
        recordId: String(childDoc._id),
        description: `Recurring task instance generated: "${childDoc.title}" from recurring schedule #${master._id}`,
        metadata: {
          parentTaskId: String(master._id),
          cycle: newCyclesCompleted,
          totalCycles
        }
      });
    } catch (err) {
      console.warn(`[TaskService] Recurring task generation error for task ${master._id}:`, err.message);
    }
  }

  return {
    success: true,
    processedCount: recurringTasks.length,
    generatedCount: createdTasks.length,
    tasks: createdTasks,
    message: `Processed ${recurringTasks.length} recurring schedules. Generated ${createdTasks.length} new tasks.`
  };
}

async function addFollower(req, taskId, followerUserId) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task, project } = await findTaskOrThrow(req, taskId);
  await assertTaskReadAccess(req, task, project);

  const targetUserId = String(followerUserId || userId).trim();
  if (!targetUserId) throw appError('Target user ID is required', 400);

  const updated = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: taskId },
    { $addToSet: { followers: targetUserId }, $set: { updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'task_follower_added',
    module: 'task',
    recordId: String(taskId),
    description: `User "${targetUserId}" added as watcher/follower to task: "${task.title}"`
  });

  return enrichTask(req, updated);
}

async function removeFollower(req, taskId, followerUserId) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task, project } = await findTaskOrThrow(req, taskId);
  await assertTaskReadAccess(req, task, project);

  const targetUserId = String(followerUserId || userId).trim();
  if (!targetUserId) throw appError('Target user ID is required', 400);

  const updated = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: taskId },
    { $pull: { followers: targetUserId }, $set: { updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'task_follower_removed',
    module: 'task',
    recordId: String(taskId),
    description: `User "${targetUserId}" removed from watchers on task: "${task.title}"`
  });

  return enrichTask(req, updated);
}

async function toggleFollower(req, taskId, followerUserId) {
  const userId = resolveUserId(req);
  const targetUserId = String(followerUserId || userId).trim();
  const { task } = await findTaskOrThrow(req, taskId);

  const currentFollowers = Array.isArray(task.followers) ? task.followers.map(String) : [];
  if (currentFollowers.includes(targetUserId)) {
    return removeFollower(req, taskId, targetUserId);
  }
  return addFollower(req, taskId, targetUserId);
}

async function updateFollowers(req, taskId, followersList) {
  const Task = getTaskModel(req);
  const userId = resolveUserId(req);
  const { task, project } = await findTaskOrThrow(req, taskId);
  await assertTaskWriteAccess(req, task, project);

  const normalized = Array.isArray(followersList)
    ? [...new Set(followersList.map(String).map((s) => s.trim()).filter(Boolean))]
    : [];

  const updated = await Task.findOneAndUpdate(
    { ...baseFilter(req), _id: taskId },
    { $set: { followers: normalized, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'task_followers_updated',
    module: 'task',
    recordId: String(taskId),
    description: `Updated watchers (${normalized.length}) on task: "${task.title}"`
  });

  return enrichTask(req, updated);
}

async function exportTasks(req, query = {}) {
  const Task = getTaskModel(req);
  let filter = baseFilter(req);

  if (query.status) {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  if (query.priority) {
    const p = toLiteralSearchTerm(String(query.priority).trim());
    if (p) filter.priority = new RegExp(`^${p}$`, 'i');
  }
  if (query.projectId) filter.projectId = String(query.projectId).trim();
  if (query.assignedTo) filter.assignedTo = String(query.assignedTo).trim();
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { title: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } }
      ];
    }
  }

  filter = applyEmployeeTaskListScope(req, filter);

  const raw = await Task.find(filter).sort({ createdAt: -1 }).lean();
  const enriched = await enrichTasks(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'task',
    recordId: 'export',
    description: `Exported ${enriched.length} tasks in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `tasks_export_${nowStr}.json`,
      content: JSON.stringify(enriched, null, 2),
      data: enriched,
      count: enriched.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'ID',
    'Task Title',
    'Project Name',
    'Status',
    'Priority',
    'Assignees',
    'Due Date',
    'Start Date',
    'Estimated Hours',
    'Logged Hours',
    'Billable',
    'Tags',
    'Created At',
    'Updated At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const t of enriched) {
    const assignees = Array.isArray(t.assignedUserNames)
      ? t.assignedUserNames.join('; ')
      : (Array.isArray(t.assignedTo) ? t.assignedTo.join('; ') : (t.assignedTo || ''));
    rows.push(
      [
        t._id,
        t.title || '',
        t.projectName || '',
        t.status || '',
        t.priority || '',
        assignees,
        t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : '',
        t.startDate ? new Date(t.startDate).toISOString().slice(0, 10) : '',
        Number(t.estimatedHours || t.hours || 0),
        Number(t.loggedHours || 0),
        t.billable ? 'Yes' : 'No',
        Array.isArray(t.tags) ? t.tags.join('; ') : (t.tags || ''),
        t.createdAt ? new Date(t.createdAt).toISOString() : '',
        t.updatedAt ? new Date(t.updatedAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `tasks_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  list,
  listByProject,
  getById,
  create,
  update,
  changeStatus,
  remove,
  archiveTask,
  restoreTask,
  listComments,
  addComment,
  sendTaskReminderNotification,
  processAutoClientReminders,
  processAutoClientRemindersForAllTenants,
  processRecurringTasks,
  calculateNextRecurringDate,
  listSubtasks,
  addSubtask,
  updateSubtask,
  toggleSubtask,
  deleteSubtask,
  addFollower,
  removeFollower,
  toggleFollower,
  updateFollowers,
  enrichTasks,
  getValidStatuses,
  getValidPriorities,
  exportTasks
};
