'use strict';

const {
  CRM_MANIFEST_PERMISSIONS
} = require('./utils/tenant-role.util');
const { requireTenantContext } = require('./middleware/tenant.middleware');
const { resolveClientIdAsync } = require('./utils/tenant.util');
const { registerAllModels } = require('./register-models');
const TenantService = require('./services/tenant.service');
const TaskService = require('./services/task.service');
const CronScheduler = require('./utils/cron-scheduler.util');
const registerActivityRoutes = require('./routes/activity.routes');
const ActivityLocationLog = require('./models/ActivityLocationLog');
const {
  extensionHost,
  listRegisteredExtensions,
  getExtension,
  getExtensionUiSummary,
  enrichHostSlotsFromRequest,
  setHostSlots,
  isExtensionEnabled
} = require('./extension-host');

/**
 * Plugin server entry point.
 *
 * OpenExt loads this file after:
 *   1. Registering auth middleware (JWT cookie → req.user)
 *   2. Auto-loading all files in api/models/
 *   3. Auto-loading all files in api/routes/
 *
 * Use register() for plugin-wide middleware or setup that must run
 * after routes are mounted. Use boot() for startup tasks after all
 * plugins are registered.
 */
module.exports = {
  /**
   * Unauthenticated API prefixes (relative to /api/plugins/openext-crm-suite/).
   * OpenNext CMS auth middleware reads this before enforcing login.
   */
  publicApiPaths: [
    'quotations/public',
    'invoices/public'
  ],

  /**
   * OpenNext CMS extension host (Dashboard → Extensions).
   * Safe no-op if CMS has no extensions module.
   */
  extensionHost,

  /**
   * Called once when the plugin backend is loaded or re-enabled.
   * @param {{ app: import('@/lib/plugins/server/router').PluginApp, cms: object }} context
   */
  async register({ app, cms }) {
    /** Fresh schemas after plugin reload — prevents stale Mongoose models dropping new fields. */
    await registerAllModels(cms);
    if (cms?.models?.register && ActivityLocationLog.name && ActivityLocationLog.schema) {
      try {
        cms.models.register(ActivityLocationLog.name, ActivityLocationLog.schema);
      } catch {
        /* ignore if already registered */
      }
    }
    app.use(requireTenantContext);

    // Activity standalone and periodic location logging routes
    if (typeof registerActivityRoutes === 'function') {
      registerActivityRoutes(app);
    }

    /** List extensions currently registered with this host. */
    app.get('/extensions', async (_req, res) => {
      try {
        res.json({ success: true, data: listRegisteredExtensions() });
      } catch (err) {
        res.status(500).json({
          success: false,
          error: err?.message || 'Failed to list extensions'
        });
      }
    });

    /** UI summary: CMS contributions + optional ui/host-slots.json per extension. */
    app.get('/extensions/ui', async (req, res) => {
      try {
        const data = await enrichHostSlotsFromRequest(req);
        res.json({ success: true, data: data || getExtensionUiSummary() });
      } catch (err) {
        res.status(500).json({
          success: false,
          error: err?.message || 'Failed to load extension UI summary'
        });
      }
    });

    /** Browser posts host-slots.json after fetch — seeds request types + server cache. */
    app.post('/extensions/:extensionId/host-slots', async (req, res) => {
      try {
        const extensionId = String(req.params.extensionId || '');
        if (!extensionId || !isExtensionEnabled(extensionId)) {
          return res.status(404).json({ success: false, error: 'Extension not registered' });
        }
        setHostSlots(extensionId, req.body && typeof req.body === 'object' ? req.body : {});
        return res.json({ success: true, data: { extensionId } });
      } catch (err) {
        return res.status(500).json({
          success: false,
          error: err?.message || 'Failed to cache host slots'
        });
      }
    });

    app.get('/extensions/:extensionId', async (req, res) => {
      try {
        const row = getExtension(req.params.extensionId);
        if (!row) {
          return res.status(404).json({ success: false, error: 'Extension not registered' });
        }
        return res.json({ success: true, data: row });
      } catch (err) {
        return res.status(500).json({
          success: false,
          error: err?.message || 'Failed to load extension'
        });
      }
    });

    /** Resolve and enforce CRM role permissions and scopes self-contained in CRM plugin. */
    app.use(async (req, res, next) => {
      if (req.user) {
        try {
          await resolveClientIdAsync(req);
          req.permissions = await TenantService.resolvePermissionsForMembership(req);
          req.roles = Array.isArray(req.roles) && req.roles.length > 0
            ? req.roles
            : (req.tenantMembership?.role ? [req.tenantMembership.role] : []);
        } catch (error) {
          cms.logger.error('CRM permission resolution failed:', error?.message || error);
          res.status(503).json({
            success: false,
            error: 'CRM permissions are temporarily unavailable'
          });
          return;
        }
      }
      await next();
    });

    app.use(async (req, _res, next) => {
      cms.logger.info(`${req.method} ${req.path}`);
      await next();
    });

    // Won lead lock (salesFlow.lockWonLead): user writes to a Won / converted lead are refused.
    app.use(require('./utils/lead-lock.util').guard);

    cms.logger.info(
      `Root CRM registered — ${app.getRouteCount()} route(s) loaded`
    );
  },

  /**
   * Called after every enabled plugin has finished register().
   */
  async boot({ cms }) {
    await syncPluginRoles(cms);

    // Schedule automated client task review reminders (runs hourly: '0 * * * *')
    CronScheduler.scheduleJob('task-client-reminders', '0 * * * *', async () => {
      try {
        const summary = await TaskService.processAutoClientRemindersForAllTenants(cms);
        const logger = cms.logger;
        if (summary.enabledTenants === 0) {
          logger?.info?.(
            '[CRM Cron] Auto client reminders skipped — enable "Automatic client reminders" in Settings → Tasks for each tenant.'
          );
        } else {
          logger?.info?.(`[CRM Cron] ${summary.message}`);
        }
      } catch (err) {
        cms.logger?.warn?.('[CRM Cron] Auto client reminder run error:', err?.message || err);
      }
    }, { logger: cms.logger });

    // Daily jobs of the active extension per tenant (manifest `schedules`, CRM 3.33.0), 07:00 server time.
    CronScheduler.scheduleJob('extension-daily-schedules', '0 7 * * *', async () => {
      try {
        const summary = await require('./services/extension-schedule.service').runAll(cms, 'daily');
        cms.logger?.info?.(`[CRM Cron] Extension daily jobs: ${summary.ran} ran, ${summary.failed} failed`);
      } catch (err) {
        cms.logger?.warn?.('[CRM Cron] Extension daily jobs error:', err?.message || err);
      }
    }, { logger: cms.logger });

    const activeJobs = CronScheduler.getActiveJobs();
    cms.logger.info(
      `Root CRM boot complete — reminder cron: ${JSON.stringify(activeJobs)}`
    );
  },

  /**
   * Called when the plugin is disabled or uninstalled.
   */
  shutdown() {
    CronScheduler.stopAllJobs();
    console.log('[plugin:openext-crm-suite] shutdown');
  }
};

async function syncPluginRoles(cms) {
  try {
    const conn = await cms?.database?.user?.();
    if (!conn) return;
    const db = conn.db || conn;
    if (typeof db.collection !== 'function') return;

    const rolesManifest = require('./roles');
    const roleDefinitions = {
      100: rolesManifest.roles.find((r) => r.id === 'crm-manager'),
      101: rolesManifest.roles.find((r) => r.id === 'sales-manager'),
      102: rolesManifest.roles.find((r) => r.id === 'sales-representative'),
      103: rolesManifest.roles.find((r) => r.id === 'project-manager'),
      104: rolesManifest.roles.find((r) => r.id === 'crm-employee'),
      105: rolesManifest.roles.find((r) => r.id === 'finance-manager')
    };

    const standardCapabilities = [
      'dashboard.view',
      'profile.edit',
      'plugins.view',
      'plugins.manage',
      'plugins.use'
    ];

    for (const [valStr, roleDef] of Object.entries(roleDefinitions)) {
      const roleValue = Number(valStr);
      if (!roleDef) continue;

      const formattedPages = Array.isArray(roleDef.pages)
        ? roleDef.pages.map((p) => {
            if (typeof p === 'string') {
              const manifestPage = rolesManifest.pages.find((mp) => mp.id === p);
              return {
                id: p,
                features: manifestPage?.features || ['view-stats']
              };
            }
            return p;
          })
        : [{ id: '*', features: '*' }];

      const pluginPageAccess = [
        {
          pluginId: 'openext-crm-suite',
          pages: formattedPages,
          permissions: roleDef.permissions
        }
      ];

      await db.collection('roles').updateOne(
        { value: roleValue },
        {
          $set: {
            name: roleDef.name,
            baseRole: roleDef.baseRole || 2,
            type: 'plugin',
            pluginId: 'openext-crm-suite',
            allowedPlugins: ['openext-crm-suite'],
            capabilities: standardCapabilities,
            pluginPageAccess: pluginPageAccess,
            permissions: roleDef.permissions
          }
        },
        { upsert: false }
      );
    }
  } catch (err) {
    cms?.logger?.warn?.('Plugin roles auto-sync skipped:', err?.message || err);
  }
}

