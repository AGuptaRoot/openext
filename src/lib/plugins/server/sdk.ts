import type mongoose from 'mongoose';
import { getUserDbConnection, getPageDbConnection } from '@/utils/db';
import { isMysql, isPostgres } from '@/lib/db/config';
import type { AuthUser } from '@/lib/api/auth';
import type { PluginApp } from '@/lib/plugins/server/router';

export interface CmsSdk {
  pluginId: string;
  database: {
    user: () => Promise<mongoose.Connection>;
    page: () => Promise<mongoose.Connection>;
  };
  models: {
    register: (name: string, schema: mongoose.Schema) => mongoose.Model<unknown>;
    get: (name: string) => mongoose.Model<unknown> | undefined;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  permissions: {
    list: () => string[];
    has: (permission: string) => boolean;
  };
  events: {
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: (payload?: unknown) => void) => void;
  };
}

const eventHandlers = new Map<string, Set<(payload?: unknown) => void>>();

/**
 * Database access used by the SDK. Injectable for tests only; plugins never see it.
 * @internal
 */
export interface CmsSdkDbDeps {
  getUserDbConnection: () => Promise<mongoose.Connection>;
  getPageDbConnection: () => Promise<mongoose.Connection>;
  /** MySQL/Postgres adapters have no Mongo readyState; their connection is kept as-is. */
  isSqlAdapter: () => boolean;
}

const defaultDbDeps: CmsSdkDbDeps = {
  getUserDbConnection,
  getPageDbConnection,
  isSqlAdapter: () => isMysql() || isPostgres(),
};

export function createCmsSdk(
  pluginId: string,
  permissions: string[],
  user: AuthUser | null,
  dbDeps: CmsSdkDbDeps = defaultDbDeps
): CmsSdk {
  const registeredModels = new Map<string, mongoose.Model<unknown>>();
  /** Schema per model so a model can be re-created on a new connection after a reconnect. */
  const registeredSchemas = new Map<string, mongoose.Schema>();
  /** Connection each cached model was created on. */
  const modelConnections = new Map<string, mongoose.Connection>();
  let userConn: mongoose.Connection | null = null;
  let pageConn: mongoose.Connection | null = null;
  let userRefreshing: Promise<mongoose.Connection> | null = null;

  /** A connection is usable when it exists and (for Mongo) is fully connected. */
  function isLive(conn: mongoose.Connection | null): conn is mongoose.Connection {
    if (!conn) return false;
    if (dbDeps.isSqlAdapter()) return true;
    return conn.readyState === 1;
  }

  async function resolveUserConn(): Promise<mongoose.Connection> {
    if (isLive(userConn)) return userConn;
    if (userRefreshing) return userRefreshing;
    const hadConnection = userConn !== null;
    userRefreshing = (async () => {
      const next = await dbDeps.getUserDbConnection();
      if (hadConnection && next !== userConn) {
        console.warn(`[plugin-sdk] user DB reconnected for ${pluginId}`);
      }
      userConn = next;
      return next;
    })();
    try {
      return await userRefreshing;
    } finally {
      userRefreshing = null;
    }
  }

  /**
   * Return the cached model when it is bound to the current user connection;
   * otherwise re-create it on the current connection from its stored schema.
   */
  function bindToCurrentConnection(modelName: string): mongoose.Model<unknown> | undefined {
    const cached = registeredModels.get(modelName);
    if (!cached || !userConn || modelConnections.get(modelName) === userConn) return cached;
    const schema = registeredSchemas.get(modelName);
    if (!schema) return cached;
    const rebound =
      (userConn.models[modelName] as mongoose.Model<unknown>) ||
      userConn.model<unknown>(modelName, schema);
    registeredModels.set(modelName, rebound);
    modelConnections.set(modelName, userConn);
    return rebound;
  }

  return {
    pluginId,
    database: {
      user: resolveUserConn,
      async page() {
        if (!isLive(pageConn)) {
          const hadConnection = pageConn !== null;
          const next = await dbDeps.getPageDbConnection();
          if (hadConnection && next !== pageConn) {
            console.warn(`[plugin-sdk] page DB reconnected for ${pluginId}`);
          }
          pageConn = next;
        }
        return pageConn;
      },
    },
    models: {
      register(name: string, schema: mongoose.Schema) {
        const modelName = `${pluginId}_${name}`;
        if (!userConn) {
          throw new Error('Call cms.database.user() before registering models');
        }
        registeredSchemas.set(modelName, schema);
        // Honor connection.deleteModel(): drop SDK cache when the connection model is gone
        // so plugins can re-register an updated schema on reload.
        if (
          registeredModels.has(modelName) &&
          modelConnections.get(modelName) === userConn &&
          userConn.models?.[modelName]
        ) {
          return registeredModels.get(modelName)!;
        }
        registeredModels.delete(modelName);
        const model =
          (userConn.models[modelName] as mongoose.Model<unknown>) ||
          userConn.model<unknown>(modelName, schema);
        registeredModels.set(modelName, model);
        modelConnections.set(modelName, userConn);
        return model;
      },
      get(name: string) {
        // Synchronous by contract. Requests refresh the connection before plugin code
        // runs (refreshPluginDatabase); for code outside requests (cron jobs started in
        // boot()) start a background refresh so the following calls recover.
        if (userConn && !isLive(userConn)) {
          void resolveUserConn().catch((error) =>
            console.error(`[plugin-sdk] user DB refresh failed for ${pluginId}:`, error)
          );
        }
        return bindToCurrentConnection(`${pluginId}_${name}`);
      },
    },
    logger: {
      info: (...args: unknown[]) => console.log(`[plugin:${pluginId}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args),
    },
    permissions: {
      list: () => [...permissions],
      has(permission: string) {
        if (!user) return false;
        if (typeof user.role === 'number' && user.role <= 1) return true;
        return permissions.includes(permission);
      },
    },
    events: {
      emit(event: string, payload?: unknown) {
        const handlers = eventHandlers.get(`${pluginId}:${event}`);
        handlers?.forEach((handler) => handler(payload));
      },
      on(event: string, handler: (payload?: unknown) => void) {
        const key = `${pluginId}:${event}`;
        if (!eventHandlers.has(key)) eventHandlers.set(key, new Set());
        eventHandlers.get(key)!.add(handler);
      },
    },
  };
}

export function createAuthMiddleware(
  app: PluginApp,
  requiredPermissions: string[] = [],
  publicPaths: string[] = []
): void {
  app.use(async (req, res, next) => {
    const normalizedPath = req.path.replace(/\/+/g, '/').replace(/^\//, '') || '';
    const isPublic = publicPaths.some(
      (publicPath) =>
        normalizedPath === publicPath.replace(/^\//, '') ||
        normalizedPath.startsWith(`${publicPath.replace(/^\//, '')}/`)
    );

    if (!isPublic && !req.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (requiredPermissions.length > 0 && req.user) {
      const isAdmin = typeof req.user.role === 'number' && req.user.role <= 1;
      const hasPermission = requiredPermissions.some((perm) => req.permissions.includes(perm));
      if (!isAdmin && !hasPermission) {
        res.status(403).json({ message: 'Forbidden' });
        return;
      }
    }

    await next();
  });
}
