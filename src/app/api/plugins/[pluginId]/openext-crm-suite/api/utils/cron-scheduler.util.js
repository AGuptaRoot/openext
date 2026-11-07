'use strict';

/**
 * Automated Cron & Task Scheduler Utility for Root CRM.
 *
 * Automatically leverages 'node-cron' when available in the environment,
 * with a reliable, zero-dependency interval fallback for continuous background jobs.
 */

let nodeCron = null;
try {
  nodeCron = require('node-cron');
} catch {
  nodeCron = null;
}

const activeJobs = new Map();

/**
 * Converts a 5-part cron expression (e.g. '0 * * * *') to millisecond interval if falling back.
 */
function parseCronToIntervalMs(cronExpr) {
  const parts = String(cronExpr || '').trim().split(/\s+/);
  if (parts.length < 5) return 60 * 60 * 1000; // default 1 hour

  const [min, hour] = parts;
  if (min.startsWith('*/')) {
    const mins = parseInt(min.replace('*/', ''), 10) || 15;
    return Math.max(1, mins) * 60 * 1000;
  }
  if (min === '*' || min === '0') {
    if (hour.startsWith('*/')) {
      const hrs = parseInt(hour.replace('*/', ''), 10) || 1;
      return Math.max(1, hrs) * 60 * 60 * 1000;
    }
    return 60 * 60 * 1000; // hourly
  }
  return 60 * 60 * 1000;
}

/**
 * Schedules a recurring cron job.
 *
 * @param {string} jobName Unique name identifier for the job
 * @param {string} cronExpression Standard cron expression (e.g. '0 * * * *' for hourly)
 * @param {Function} taskFn Async callback function to execute on schedule
 * @param {Object} options Optional settings (logger, timezone)
 */
function scheduleJob(jobName, cronExpression, taskFn, options = {}) {
  stopJob(jobName);

  const logger = options.logger || console;

  if (nodeCron && typeof nodeCron.schedule === 'function') {
    try {
      const task = nodeCron.schedule(cronExpression, async () => {
        try {
          await taskFn();
        } catch (err) {
          logger.error?.(`[CRM Cron] Error executing job '${jobName}':`, err?.message || err);
        }
      }, {
        timezone: options.timezone || 'UTC'
      });

      activeJobs.set(jobName, {
        type: 'node-cron',
        job: task,
        cronExpression
      });

      logger.info?.(`[CRM Cron] Scheduled '${jobName}' via node-cron (${cronExpression})`);
      return;
    } catch (cronErr) {
      logger.warn?.(`[CRM Cron] node-cron initialization fallback for '${jobName}':`, cronErr?.message || cronErr);
    }
  }

  // Interval-based fallback scheduler
  const intervalMs = parseCronToIntervalMs(cronExpression);
  if (!nodeCron) {
    logger.warn?.(
      `[CRM Cron] node-cron module not available — using interval fallback for '${jobName}'`
    );
  }
  const timer = setInterval(async () => {
    try {
      await taskFn();
    } catch (err) {
      logger.error?.(`[CRM Cron Fallback] Error executing job '${jobName}':`, err?.message || err);
    }
  }, intervalMs);

  // Unref timer in Node so it doesn't hold process open during tests
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  activeJobs.set(jobName, {
    type: 'interval',
    job: timer,
    intervalMs
  });

  logger.info?.(`[CRM Cron] Scheduled '${jobName}' via interval scheduler (every ${Math.round(intervalMs / 60000)}m)`);
}

/**
 * Stops a specific active cron job by name.
 */
function stopJob(jobName) {
  if (!activeJobs.has(jobName)) return;

  const entry = activeJobs.get(jobName);
  try {
    if (entry.type === 'node-cron' && entry.job && typeof entry.job.stop === 'function') {
      entry.job.stop();
    } else if (entry.type === 'interval' && entry.job) {
      clearInterval(entry.job);
    }
  } catch (_) {}

  activeJobs.delete(jobName);
}

/**
 * Stops and cleans up all scheduled cron jobs (used during plugin shutdown).
 */
function stopAllJobs() {
  for (const jobName of activeJobs.keys()) {
    stopJob(jobName);
  }
}

/**
 * Returns list of currently active scheduled jobs.
 */
function getActiveJobs() {
  return Array.from(activeJobs.entries()).map(([name, data]) => ({
    name,
    type: data.type,
    cronExpression: data.cronExpression || null,
    intervalMs: data.intervalMs || null
  }));
}

module.exports = {
  scheduleJob,
  stopJob,
  stopAllJobs,
  getActiveJobs
};
