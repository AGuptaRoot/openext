'use strict';

/**
 * CRM 3.63.0 — shift alerts for project work (Project Delivery: Projects → Tasks → Time Logs).
 *
 * A project member can have a shift on the project's Members tab (next to the hourly rate):
 *   shiftStart "HH:mm", shiftHours (0.5–16; the end is start + hours, may pass midnight), shiftDays (0 = Sunday … 6).
 *
 * Every 5 minutes (index.js cron "shift-alerts"), for each project In Progress and each member with a shift
 * who has at least one open task assigned in that project (only they can start its timer):
 *   - "Start your timer": once per shift, from 15 minutes after the shift starts until it ends, when the
 *     member has not started any timer since the shift began (a lunch break after working is not reminded)
 *     and none is running (one timer at a time is the CRM rule).
 *   - "Your hourly shift is over": once per shift, 5 minutes after the shift ends (up to an hour later, so a
 *     restart never sends an old one); "Please stop your timer" is added when a timer is still running.
 *     The timer is never stopped by the CRM.
 * Times are the tenant's time zone (Settings → timezone, default Asia/Kolkata). Each alert goes to the bell and
 * the user's phones / browsers (types timer_reminder and shift_over, which the user can switch off).
 */

const ID_RE = /^[a-f0-9]{24}$/i;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const REMIND_AFTER_MIN = 15;
const OVER_AFTER_MIN = 5;
const OVER_WINDOW_MIN = 60;
const DEFAULT_DAYS = Object.freeze([1, 2, 3, 4, 5, 6]);
const PROJECT_LIMIT = 500;

const settle = async (q) => (q && typeof q.lean === 'function' ? q.lean() : q);
const text = (v, max = 120) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);

function model(req, name) {
  return req && req.cms && req.cms.models && typeof req.cms.models.get === 'function' ? req.cms.models.get(name) : null;
}

/**
 * A member shift from input → { shiftStart, shiftHours, shiftDays } or an error text.
 * Empty start or 0 hours = no shift (all three cleared).
 */
function parseShift(source = {}) {
  const has = (k) => source[k] !== undefined;
  if (!has('shiftStart') && !has('shiftHours') && !has('shiftDays')) return { value: null };
  const start = String(source.shiftStart === null || source.shiftStart === undefined ? '' : source.shiftStart).trim();
  const hoursRaw = source.shiftHours === null || source.shiftHours === undefined || source.shiftHours === '' ? 0 : Number(source.shiftHours);
  if (!start && !hoursRaw) return { value: { shiftStart: '', shiftHours: 0, shiftDays: [...DEFAULT_DAYS] } };
  if (!TIME_RE.test(start)) return { error: 'Shift start must be a time like 10:00' };
  if (!Number.isFinite(hoursRaw) || hoursRaw < 0.5 || hoursRaw > 16) return { error: 'Shift hours must be between 0.5 and 16' };
  const hours = Math.round(hoursRaw * 4) / 4;
  let days = source.shiftDays === undefined || source.shiftDays === null ? [...DEFAULT_DAYS] : source.shiftDays;
  if (!Array.isArray(days)) return { error: 'Shift days must be a list of week days (0 = Sunday … 6 = Saturday)' };
  days = [...new Set(days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!days.length) return { error: 'Pick at least one shift day' };
  return { value: { shiftStart: start, shiftHours: hours, shiftDays: days } };
}

/** "HH:mm" + hours → "HH:mm" end (next day shown as "02:00 (next day)"). */
function shiftEnd(start, hours) {
  const m = TIME_RE.exec(String(start || ''));
  if (!m) return '';
  const total = Number(m[1]) * 60 + Number(m[2]) + Math.round(Number(hours || 0) * 60);
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}${total >= 1440 ? ' (next day)' : ''}`;
}

/** Wall-clock minutes (as if the tenant's local time were UTC) — simple day / weekday maths. */
function wallMinutes(now, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  }
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
  return Date.UTC(get('year'), get('month') - 1, get('day')) / 60000 + (get('hour') % 24) * 60 + get('minute');
}

/**
 * The member's shift that is relevant now (it started today or yesterday — a night shift) →
 * { dateKey, startWall, endWall } list (wall minutes).
 */
function shiftsAround(member, nowWall) {
  const m = TIME_RE.exec(String(member.shiftStart || ''));
  const hours = Number(member.shiftHours || 0);
  if (!m || !(hours > 0)) return [];
  const days = Array.isArray(member.shiftDays) && member.shiftDays.length ? member.shiftDays.map(Number) : DEFAULT_DAYS;
  const today = Math.floor(nowWall / 1440) * 1440;
  const out = [];
  for (const dayStart of [today - 1440, today]) {
    const weekday = new Date(dayStart * 60000).getUTCDay();
    if (!days.includes(weekday)) continue;
    const startWall = dayStart + Number(m[1]) * 60 + Number(m[2]);
    out.push({ dateKey: new Date(dayStart * 60000).toISOString().slice(0, 10), startWall, endWall: startWall + Math.round(hours * 60) });
  }
  return out;
}

/**
 * What to send to one member now: 'remind' | 'over' | null, with the shift.
 * startedSince(startWall) → true when the member started a timer at or after that moment.
 */
function dueAlert(member, nowWall, timerRunning, startedSince = () => false) {
  for (const s of shiftsAround(member, nowWall)) {
    if (nowWall >= s.endWall + OVER_AFTER_MIN && nowWall < s.endWall + OVER_AFTER_MIN + OVER_WINDOW_MIN) return { kind: 'over', shift: s };
    if (!timerRunning && nowWall >= s.startWall + REMIND_AFTER_MIN && nowWall < s.endWall && !startedSince(s.startWall)) return { kind: 'remind', shift: s };
  }
  return null;
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function shiftAlertsForTenant(cms, tenantId, now = new Date()) {
  const req = { cms, tenantId, headers: {}, user: null };
  const out = { reminders: 0, over: 0 };
  const Project = model(req, 'Project');
  const Member = model(req, 'ProjectMember');
  const Task = model(req, 'Task');
  const TimeLog = model(req, 'TimeLog');
  if (!Project || !Member || !Task) return out;

  let pq = Project.find({ tenantId, status: 'In Progress', isDeleted: { $ne: true } });
  if (pq && typeof pq.select === 'function') pq = pq.select('_id name');
  if (pq && typeof pq.limit === 'function') pq = pq.limit(PROJECT_LIMIT);
  const projects = (await settle(pq)) || [];
  if (!projects.length) return out;
  const projectIds = projects.map((p) => String(p._id));
  const members = ((await settle(Member.find({ tenantId, projectId: { $in: projectIds }, isDeleted: { $ne: true }, shiftHours: { $gt: 0 } }))) || [])
    .filter((m) => ID_RE.test(String(m.userId || '')) && TIME_RE.test(String(m.shiftStart || '')));
  if (!members.length) return out;

  let tq = Task.find({ tenantId, projectId: { $in: [...new Set(members.map((m) => String(m.projectId)))] }, isDeleted: { $ne: true }, status: { $ne: 'Completed' } });
  if (tq && typeof tq.select === 'function') tq = tq.select('projectId assignedTo');
  const tasks = (await settle(tq)) || [];
  const hasOpenTask = (m) => tasks.some((t) => String(t.projectId) === String(m.projectId) && same(t.assignedTo, m.userId));

  const userIds = [...new Set(members.map((m) => String(m.userId)))];
  const running = TimeLog ? ((await settle(TimeLog.find({ tenantId, status: 'Running', isDeleted: { $ne: true }, createdBy: { $in: userIds } }))) || []) : [];
  const runningBy = new Set(running.map((r) => String(r.createdBy)));
  // Timers started in the last 2 days (a shift can begin yesterday), to know who already started this shift.
  const recent = TimeLog
    ? ((await settle(TimeLog.find({ tenantId, isDeleted: { $ne: true }, createdBy: { $in: userIds }, checkInTime: { $gte: new Date(now.getTime() - 48 * 3600000) } }))) || [])
    : [];

  const settings = await require('./setting.service').getAll(req).catch(() => ({}));
  const timeZone = String((settings && (settings.timezone || settings.time_zone)) || 'Asia/Kolkata');
  const nowWall = wallMinutes(now, timeZone);
  // A wall-clock minute of the tenant → the real moment (now minus the difference).
  const realOf = (wall) => new Date(now.getTime() - (nowWall - wall) * 60000);
  const startedSince = (userId) => (startWall) => {
    const from = realOf(startWall).getTime();
    return recent.some((r) => String(r.createdBy) === userId && r.checkInTime && new Date(r.checkInTime).getTime() >= from);
  };
  const nameOf = new Map(projects.map((p) => [String(p._id), text(p.name, 80) || 'Project']));
  const notify = require('./notification.service').notify;

  for (const m of members) {
    if (!hasOpenTask(m)) continue;
    const userId = String(m.userId);
    const timerRunning = runningBy.has(userId);
    const due = dueAlert(m, nowWall, timerRunning, startedSince(userId));
    if (!due) continue;
    const projectId = String(m.projectId);
    const project = nameOf.get(projectId) || 'Project';
    const window = `${m.shiftStart}–${shiftEnd(m.shiftStart, m.shiftHours)}`;
    const alert = due.kind === 'remind'
      ? {
          type: 'timer_reminder',
          title: 'Start your timer',
          message: `Your shift on ${project} started at ${m.shiftStart}. No timer is running yet: start the timer on your task.`,
          link: `/projects/${projectId}`,
          linkLabel: 'Open project',
          key: `timer_reminder:${projectId}:${userId}:${due.shift.dateKey}`
        }
      : {
          type: 'shift_over',
          title: 'Your hourly shift is over',
          message: `Your hourly shift is over (${project}, ${window}).${timerRunning ? ' Please stop your timer.' : ''}`,
          link: `/projects/${projectId}`,
          linkLabel: 'Open project',
          key: `shift_over:${projectId}:${userId}:${due.shift.dateKey}`
        };
    try {
      const r = await notify(req, { ...alert, userIds: [userId] });
      if (r && r.sent) out[due.kind === 'remind' ? 'reminders' : 'over'] += r.sent;
    } catch {
      /* one member never stops the others */
    }
  }
  return out;
}

async function shiftSweep(cms, now = new Date()) {
  const { tenantIds } = require('./extension-schedule.service');
  const total = { tenants: 0, reminders: 0, over: 0 };
  for (const tenantId of await tenantIds(cms)) {
    try {
      const r = await shiftAlertsForTenant(cms, tenantId, now);
      total.tenants += 1;
      total.reminders += r.reminders;
      total.over += r.over;
    } catch {
      /* one tenant never stops the others */
    }
  }
  return total;
}

module.exports = {
  parseShift,
  shiftEnd,
  shiftAlertsForTenant,
  shiftSweep,
  _internal: { wallMinutes, shiftsAround, dueAlert, DEFAULT_DAYS }
};
