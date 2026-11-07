'use strict';

/**
 * Employee work reports (Tasks → Reports): what each person worked on, built from their time logs.
 *
 *   Who sees it   CRM managers (admins) see everyone in the workspace; project managers see the people
 *                 on their projects and only the hours logged on those projects. Nobody else.
 *   Daily         per task: time-log entries, hours (approved / pending / rejected), check-in and out;
 *                 every log of the day.
 *   Monthly       the same per task for the month, plus one row per day.
 *   Export        the report as PDF or Word (.docx); every export is audited.
 *
 * Every time log is counted and shown with its approval status; approved hours are totalled apart.
 */

const { resolveTenantId, resolveUserId, isClientUser } = require('../utils/tenant.util');
const { resolveUsernames } = require('../utils/user.util');
const { isAdmin } = require('../utils/sales-access.util');
const { isProjectManager } = require('../utils/ticket-access.util');
const { buildEmployeeProjectScope } = require('../utils/project-access.util');
const AuditService = require('./audit.service');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const USER_ID_RE = /^[A-Za-z0-9_.@-]{1,80}$/;
const CLOSED_TASK_STATUSES = ['Completed', 'Cancelled'];
const MAX_LOGS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Timer entries are dated at the server's midnight; widen the query so no time zone loses a log.
const QUERY_PAD_MS = 14 * 60 * 60 * 1000;

function appError(message, status = 400, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

function getModel(req, name, required = true) {
  const Model = req.cms?.models.get(name) || null;
  if (!Model && required) throw new Error(`${name} model is not registered`);
  return Model;
}

/** Work reports are for CRM managers (admins) and project managers. */
function canViewReports(req) {
  if (!req?.user || isClientUser(req)) return false;
  return isAdmin(req) || isProjectManager(req);
}

function assertCanViewReports(req) {
  if (!canViewReports(req)) {
    throw appError('Work reports are available to project managers and CRM managers', 403, 'REPORT_FORBIDDEN');
  }
}

/** A valid IANA zone from the browser, else UTC. Used to place timer entries on the right day. */
function resolveTimeZone(value) {
  const zone = str(value).slice(0, 64);
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

function dateIn(at, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The day a log belongs to: a timer entry by its check-in in the viewer's zone, a manual entry by its date. */
function dayKeyOf(log, timeZone) {
  if (log.checkInTime) {
    const at = new Date(log.checkInTime);
    if (!Number.isNaN(at.getTime())) return dateIn(at, timeZone);
  }
  const d = new Date(log.workDate);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * @returns {{ period: 'day'|'month', key: string, from: string, to: string, days: string[], label: string }}
 */
function resolvePeriod(query = {}, timeZone = 'UTC') {
  const period = str(query.period).toLowerCase() === 'month' ? 'month' : 'day';
  if (period === 'month') {
    const month = str(query.month) || dateIn(new Date(), timeZone).slice(0, 7);
    if (!MONTH_RE.test(month)) throw appError('month must be YYYY-MM');
    const [y, m] = month.split('-').map(Number);
    if (m < 1 || m > 12) throw appError('month must be YYYY-MM');
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const days = Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return { period, key: month, from: days[0], to: days[days.length - 1], days, label };
  }
  const date = str(query.date) || dateIn(new Date(), timeZone);
  const at = new Date(`${date}T00:00:00Z`);
  if (!DAY_RE.test(date) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date) {
    throw appError('date must be YYYY-MM-DD');
  }
  const label = at.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { period, key: date, from: date, to: date, days: [date], label };
}

/** null = every project (CRM manager); otherwise the projects this project manager manages or belongs to. */
async function scopedProjectIds(req) {
  if (isAdmin(req)) return null;
  const Project = getModel(req, 'Project');
  const rows = await Project.find({ tenantId: resolveTenantId(req), isDeleted: false, ...(await buildEmployeeProjectScope(req)) })
    .select('_id')
    .lean();
  return rows.map((p) => String(p._id));
}

const projectClause = (projectIds) => (projectIds === null ? {} : { projectId: { $in: projectIds } });
const employeeOf = (log) => str(log.createdBy);

async function findLogs(req, { projectIds, from, to, userId = '' }) {
  const TimeLog = getModel(req, 'TimeLog');
  const filter = {
    tenantId: resolveTenantId(req),
    isDeleted: false,
    ...projectClause(projectIds),
    workDate: {
      $gte: new Date(new Date(`${from}T00:00:00Z`).getTime() - QUERY_PAD_MS),
      $lt: new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY_MS + QUERY_PAD_MS)
    }
  };
  if (userId) filter.createdBy = userId;
  return TimeLog.find(filter)
    .select('taskId projectId workDate hours description isBillable checkInTime checkOutTime status entryType approvalStatus createdBy createdAt')
    .sort({ workDate: 1, checkInTime: 1, createdAt: 1 })
    .limit(MAX_LOGS)
    .lean();
}

/** Everyone a report may be about: project members and task assignees in scope. */
async function staffInScope(req, projectIds) {
  const tenantId = resolveTenantId(req);
  const ids = new Set();
  const ProjectMember = getModel(req, 'ProjectMember', false);
  if (ProjectMember) {
    const rows = await ProjectMember.find({ tenantId, isDeleted: false, ...projectClause(projectIds) }).select('userId').limit(5000).lean();
    rows.forEach((r) => str(r.userId) && ids.add(str(r.userId)));
  }
  const Task = getModel(req, 'Task', false);
  if (Task) {
    const rows = await Task.find({ tenantId, isDeleted: false, ...projectClause(projectIds), assignedTo: { $nin: ['', null] } })
      .select('assignedTo')
      .limit(5000)
      .lean();
    rows.forEach((r) => str(r.assignedTo) && ids.add(str(r.assignedTo)));
  }
  ids.delete('system');
  return ids;
}

const emptyTotals = () => ({
  hours: 0,
  approvedHours: 0,
  pendingHours: 0,
  rejectedHours: 0,
  billableHours: 0,
  entries: 0,
  tasks: new Set(),
  projects: new Set(),
  days: new Set(),
  running: false
});

function addLog(totals, log, dayKey) {
  // A running timer holds a placeholder; its hours count once it is checked out.
  const hours = log.status === 'Running' ? 0 : Number(log.hours) || 0;
  totals.hours += hours;
  totals.entries += 1;
  const approval = str(log.approvalStatus) || 'Approved';
  if (approval === 'Approved') totals.approvedHours += hours;
  else if (approval === 'Rejected') totals.rejectedHours += hours;
  else totals.pendingHours += hours; // Draft and Pending: not approved yet
  if (log.isBillable !== false) totals.billableHours += hours;
  if (log.taskId) totals.tasks.add(str(log.taskId));
  if (log.projectId) totals.projects.add(str(log.projectId));
  if (dayKey) totals.days.add(dayKey);
  if (log.status === 'Running') totals.running = true;
}

const finishTotals = (t) => ({
  hours: round2(t.hours),
  approvedHours: round2(t.approvedHours),
  pendingHours: round2(t.pendingHours),
  rejectedHours: round2(t.rejectedHours),
  billableHours: round2(t.billableHours),
  entries: t.entries,
  tasks: t.tasks.size,
  projects: t.projects.size,
  daysWorked: t.days.size,
  running: t.running
});

/**
 * The Reports tab: every employee in scope with the chosen day's work and the month to date.
 * @param {object} query  { date: YYYY-MM-DD, tz }
 */
async function listEmployees(req, query = {}) {
  assertCanViewReports(req);
  const timeZone = resolveTimeZone(query.tz);
  const day = resolvePeriod({ period: 'day', date: query.date }, timeZone);
  const month = resolvePeriod({ period: 'month', month: day.key.slice(0, 7) }, timeZone);
  const projectIds = await scopedProjectIds(req);

  const logs = await findLogs(req, { projectIds, from: month.from, to: month.to });
  const people = new Map();
  const entry = (id) => {
    if (!people.has(id)) people.set(id, { day: emptyTotals(), month: emptyTotals() });
    return people.get(id);
  };
  for (const id of await staffInScope(req, projectIds)) entry(id);
  for (const log of logs) {
    const key = dayKeyOf(log, timeZone);
    if (!key.startsWith(month.key)) continue;
    const id = employeeOf(log);
    if (!id || id === 'system') continue;
    const person = entry(id);
    addLog(person.month, log, key);
    if (key === day.key) addLog(person.day, log, key);
  }

  // Open tasks assigned to each person (on the projects in scope).
  const openTasks = {};
  const Task = getModel(req, 'Task', false);
  if (Task && people.size) {
    const rows = await Task.find({
      tenantId: resolveTenantId(req),
      isDeleted: false,
      isArchived: { $ne: true },
      ...projectClause(projectIds),
      assignedTo: { $in: [...people.keys()] },
      status: { $nin: CLOSED_TASK_STATUSES }
    })
      .select('assignedTo')
      .limit(10000)
      .lean();
    rows.forEach((r) => {
      const id = str(r.assignedTo);
      openTasks[id] = (openTasks[id] || 0) + 1;
    });
  }

  const names = await resolveUsernames(req, [...people.keys()]);
  const items = [...people.entries()]
    .map(([userId, p]) => ({
      userId,
      name: names[userId] || userId,
      today: finishTotals(p.day),
      month: finishTotals(p.month),
      openTasks: openTasks[userId] || 0
    }))
    .sort((a, b) => b.today.hours - a.today.hours || b.month.hours - a.month.hours || a.name.localeCompare(b.name));

  return {
    date: day.key,
    dateLabel: day.label,
    month: month.key,
    monthLabel: month.label,
    timeZone,
    scope: projectIds === null ? 'all' : 'projects',
    items,
    totals: {
      employees: items.length,
      activeToday: items.filter((i) => i.today.entries > 0).length,
      hoursToday: round2(items.reduce((n, i) => n + i.today.hours, 0)),
      hoursMonth: round2(items.reduce((n, i) => n + i.month.hours, 0))
    }
  };
}

const stamp = (log) => new Date(log.checkInTime || log.createdAt || log.workDate || 0).getTime() || 0;

function earliest(a, b) {
  return !a || (b && b < a) ? b : a;
}
function latest(a, b) {
  return !a || (b && b > a) ? b : a;
}

/**
 * One employee's daily or monthly report.
 * @param {string} userId
 * @param {object} query  { period: 'day'|'month', date, month, tz }
 */
async function getEmployeeReport(req, userId, query = {}) {
  assertCanViewReports(req);
  const employeeId = str(userId);
  if (!USER_ID_RE.test(employeeId) || employeeId === 'system') throw appError('Employee not found', 404, 'NOT_FOUND');
  const timeZone = resolveTimeZone(query.tz);
  const range = resolvePeriod(query, timeZone);
  const projectIds = await scopedProjectIds(req);
  const tenantId = resolveTenantId(req);

  const logs = (await findLogs(req, { projectIds, from: range.from, to: range.to, userId: employeeId }))
    .map((log) => ({ ...log, dayKey: dayKeyOf(log, timeZone) }))
    .filter((log) => log.dayKey >= range.from && log.dayKey <= range.to)
    // In the order the work happened: by day, then check-in (manual entries by when they were saved).
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey) || stamp(a) - stamp(b));

  // Somebody outside this manager's projects (or this workspace) has no report here.
  if (!logs.length && !(await staffInScope(req, projectIds)).has(employeeId)) {
    const TimeLog = getModel(req, 'TimeLog');
    const ever = await TimeLog.findOne({ tenantId, isDeleted: false, createdBy: employeeId, ...projectClause(projectIds) }).select('_id').lean();
    if (!ever) throw appError('Employee not found', 404, 'NOT_FOUND');
  }

  const Task = getModel(req, 'Task', false);
  const Project = getModel(req, 'Project', false);

  // Open tasks assigned to them: what they are working towards.
  const assigned = Task
    ? await Task.find({
        tenantId,
        isDeleted: false,
        isArchived: { $ne: true },
        ...projectClause(projectIds),
        assignedTo: employeeId,
        status: { $nin: CLOSED_TASK_STATUSES }
      })
        .select('title status priority dueDate projectId')
        .sort({ dueDate: 1, createdAt: -1 })
        .limit(100)
        .lean()
    : [];

  const taskIds = [...new Set([...logs.map((l) => str(l.taskId)), ...assigned.map((t) => String(t._id))])].filter(Boolean);
  const tasks = Task && taskIds.length
    ? await Task.find({ tenantId, _id: { $in: taskIds } }).select('title status priority dueDate projectId').lean()
    : [];
  const taskMap = Object.fromEntries(tasks.map((t) => [String(t._id), t]));
  const projectIdsUsed = [...new Set([...logs.map((l) => str(l.projectId)), ...tasks.map((t) => str(t.projectId))])].filter(Boolean);
  const projects = Project && projectIdsUsed.length
    ? await Project.find({ tenantId, _id: { $in: projectIdsUsed } }).select('name').lean()
    : [];
  const projectName = Object.fromEntries(projects.map((p) => [String(p._id), p.name || 'Project']));

  const total = emptyTotals();
  const perTask = new Map();
  const perDay = new Map();
  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, { totals: emptyTotals(), firstStart: null, lastEnd: null, projectId: '' });
    return map.get(key);
  };
  for (const log of logs) {
    const start = log.checkInTime ? new Date(log.checkInTime) : null;
    const end = log.checkOutTime ? new Date(log.checkOutTime) : null;
    addLog(total, log, log.dayKey);
    for (const b of [bucket(perTask, str(log.taskId)), bucket(perDay, log.dayKey)]) {
      addLog(b.totals, log, log.dayKey);
      b.firstStart = earliest(b.firstStart, start);
      b.lastEnd = latest(b.lastEnd, end);
      if (!b.projectId) b.projectId = str(log.projectId);
    }
  }

  const taskRows = [...perTask.entries()]
    .map(([taskId, t]) => {
      const task = taskMap[taskId] || {};
      const pid = str(task.projectId) || t.projectId;
      const totals = finishTotals(t.totals);
      return {
        taskId,
        title: task.title || 'Task',
        status: task.status || '',
        priority: task.priority || '',
        dueDate: task.dueDate || null,
        projectId: pid,
        projectName: projectName[pid] || '',
        entries: totals.entries,
        hours: totals.hours,
        approvedHours: totals.approvedHours,
        pendingHours: totals.pendingHours,
        rejectedHours: totals.rejectedHours,
        billableHours: totals.billableHours,
        daysWorked: totals.daysWorked,
        running: totals.running,
        firstStart: t.firstStart,
        lastEnd: t.lastEnd
      };
    })
    .sort((a, b) => b.hours - a.hours || b.entries - a.entries);

  const days = range.period === 'month'
    ? range.days.map((date) => {
        const d = perDay.get(date);
        const totals = finishTotals(d ? d.totals : emptyTotals());
        return {
          date,
          hours: totals.hours,
          approvedHours: totals.approvedHours,
          entries: totals.entries,
          tasks: totals.tasks,
          firstStart: d?.firstStart || null,
          lastEnd: d?.lastEnd || null
        };
      })
    : [];

  const summary = finishTotals(total);
  const names = await resolveUsernames(req, [employeeId]);
  return {
    employee: { userId: employeeId, name: names[employeeId] || employeeId },
    period: range.period,
    key: range.key,
    from: range.from,
    to: range.to,
    label: range.label,
    timeZone,
    summary: {
      ...summary,
      averageHoursPerDay: summary.daysWorked ? round2(summary.hours / summary.daysWorked) : 0
    },
    tasks: taskRows,
    days,
    logs: logs.map((log) => {
      const taskId = str(log.taskId);
      const pid = str(log.projectId) || str(taskMap[taskId]?.projectId);
      return {
        _id: String(log._id),
        date: log.dayKey,
        taskId,
        taskTitle: taskMap[taskId]?.title || 'Task',
        projectName: projectName[pid] || '',
        hours: log.status === 'Running' ? 0 : round2(log.hours),
        checkInTime: log.checkInTime || null,
        checkOutTime: log.checkOutTime || null,
        status: log.status || 'Completed',
        entryType: log.entryType || 'manual',
        approvalStatus: log.approvalStatus || 'Approved',
        isBillable: log.isBillable !== false,
        description: str(log.description).slice(0, 2000)
      };
    }),
    assignedOpenTasks: assigned.map((t) => ({
      taskId: String(t._id),
      title: t.title || 'Task',
      status: t.status || '',
      priority: t.priority || '',
      dueDate: t.dueDate || null,
      projectName: projectName[str(t.projectId)] || '',
      workedInPeriod: perTask.has(String(t._id))
    })),
    truncated: logs.length >= MAX_LOGS
  };
}

// ------------------------------------------------------------------------------------------ export

const hrs = (n) => `${round2(n).toFixed(2)} h`;

function timeLabel(value, timeZone) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function spanLabel(first, last, timeZone) {
  return !first && !last ? 'Manual' : `${timeLabel(first, timeZone)} - ${timeLabel(last, timeZone)}`;
}

function dateLabel(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toISOString().slice(0, 10);
}

/** Splits rows into tables of at most `size` rows (the document renderers' table limit). */
function chunkedTables(heading, columns, rows, size = 100) {
  if (!rows.length) return [{ heading, text: 'None.' }];
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push({ heading: i ? `${heading} (continued)` : heading, table: { columns, rows: rows.slice(i, i + size) } });
  }
  return out;
}

/** The report as a pdf-document / docx-document description. */
function buildReportDocument(report, { generatedBy = '' } = {}) {
  const { summary, timeZone } = report;
  const daily = report.period === 'day';
  const meta = [
    { label: 'Employee', value: report.employee.name },
    { label: daily ? 'Date' : 'Month', value: report.label },
    { label: 'Total hours', value: hrs(summary.hours) },
    { label: 'Approved hours', value: hrs(summary.approvedHours) },
    { label: 'Pending / rejected', value: `${hrs(summary.pendingHours)} / ${hrs(summary.rejectedHours)}` },
    { label: 'Billable hours', value: hrs(summary.billableHours) },
    { label: 'Time-log entries', value: String(summary.entries) },
    { label: 'Tasks worked on', value: String(summary.tasks) },
    { label: 'Projects', value: String(summary.projects) }
  ];
  if (!daily) {
    meta.push({ label: 'Days worked', value: String(summary.daysWorked) });
    meta.push({ label: 'Average per day worked', value: hrs(summary.averageHoursPerDay) });
  }
  meta.push({ label: 'Times shown in', value: timeZone });

  // The time log comes last: it is the longest and may be cut at the renderers' block limit.
  const blocks = [];
  blocks.push(...chunkedTables(
    'Tasks worked on',
    daily ? ['Task', 'Project', 'Status', 'Entries', 'Hours', 'In - out'] : ['Task', 'Project', 'Status', 'Entries', 'Hours', 'Days'],
    report.tasks.map((t) => [
      t.title,
      t.projectName || '-',
      t.status || '-',
      String(t.entries),
      `${hrs(t.hours)}${t.pendingHours ? ` (${hrs(t.pendingHours)} pending)` : ''}`,
      daily ? spanLabel(t.firstStart, t.lastEnd, timeZone) : String(t.daysWorked)
    ])
  ));
  if (!daily) {
    blocks.push(...chunkedTables(
      'Day by day',
      ['Date', 'Entries', 'Tasks', 'Hours', 'Approved', 'In - out'],
      report.days.filter((d) => d.entries > 0).map((d) => [
        d.date,
        String(d.entries),
        String(d.tasks),
        hrs(d.hours),
        hrs(d.approvedHours),
        spanLabel(d.firstStart, d.lastEnd, timeZone)
      ])
    ));
  }
  blocks.push(...chunkedTables(
    'Open tasks assigned',
    ['Task', 'Project', 'Status', 'Priority', 'Due', 'Worked'],
    report.assignedOpenTasks.map((t) => [t.title, t.projectName || '-', t.status || '-', t.priority || '-', dateLabel(t.dueDate), t.workedInPeriod ? 'Yes' : 'No'])
  ));
  const logBlocks = chunkedTables(
    'Time log',
    ['Date', 'Task', 'In - out', 'Hours', 'Approval', 'Work done'],
    report.logs.map((l) => [
      l.date,
      l.taskTitle,
      l.status === 'Running'
        ? `${timeLabel(l.checkInTime, timeZone)} - running`
        : (l.checkInTime ? `${timeLabel(l.checkInTime, timeZone)} - ${timeLabel(l.checkOutTime, timeZone)}` : 'Manual'),
      hrs(l.hours),
      l.approvalStatus,
      l.description || '-'
    ])
  );
  const room = Math.max(0, 40 - blocks.length);
  const logCut = logBlocks.length > room;
  blocks.push(...logBlocks.slice(0, room));

  const notes = [];
  if (report.truncated) notes.push(`only the first ${MAX_LOGS} entries are included`);
  if (logCut) notes.push(`the time log shows the first ${room * 100} entries`);
  return {
    title: daily ? 'Daily Work Report' : 'Monthly Work Report',
    reference: `${report.employee.name} - ${report.key}`.slice(0, 60),
    meta,
    blocks,
    footer: [
      `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${generatedBy ? ` by ${generatedBy}` : ''}`,
      ...notes
    ].join(' - ')
  };
}

/**
 * @param {object} query  { period, date, month, tz, format: 'pdf'|'docx' }
 * @returns {{ buffer: Buffer, filename: string, contentType: string }}
 */
async function exportEmployeeReport(req, userId, query = {}) {
  const format = str(query.format).toLowerCase() === 'docx' ? 'docx' : 'pdf';
  const report = await getEmployeeReport(req, userId, query);
  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req).catch(() => ({}));
  const company = {
    name: settings.company_name,
    address: settings.company_address,
    phone: settings.company_phone,
    email: settings.company_email
  };
  const viewerId = resolveUserId(req);
  const viewer = viewerId ? (await resolveUsernames(req, [viewerId]))[viewerId] : '';
  const doc = buildReportDocument(report, { generatedBy: viewer && viewer !== viewerId ? viewer : '' });
  const buffer = format === 'docx'
    ? require('../utils/docx-document.util').renderDocumentDocx(doc, company)
    : require('../utils/pdf-document.util').renderDocumentPdf(doc, company);

  await AuditService.log(req, {
    action: 'exported',
    module: 'work_report',
    recordId: report.employee.userId,
    description: `Exported the ${report.period === 'day' ? 'daily' : 'monthly'} work report for ${report.key} as ${format.toUpperCase()}`,
    metadata: { employeeId: report.employee.userId, period: report.period, key: report.key, format, entries: report.summary.entries }
  });

  const safeName = report.employee.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'employee';
  return {
    buffer,
    filename: `work-report-${safeName}-${report.key}.${format}`,
    contentType: format === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf'
  };
}

module.exports = {
  canViewReports,
  listEmployees,
  getEmployeeReport,
  exportEmployeeReport,
  buildReportDocument,
  resolvePeriod,
  dayKeyOf
};
