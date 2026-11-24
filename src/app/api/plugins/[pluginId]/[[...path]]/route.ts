import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api/auth';
import { bootstrapBackendPlugins } from '@/lib/plugins/server/bootstrap';
import { getLoadedPlugin, refreshPluginDatabase } from '@/lib/plugins/server/registry';
import { buildPluginRequest, pluginResponseToNext } from '@/lib/plugins/server/dispatch';
import { getUserDbConnection, getPluginModel } from '@/utils/db';
import { assertSafePluginId } from '@/lib/plugins/uploaded-lifecycle';
import { resolveUserPermissions } from '@/lib/plugins/server/permissions';

type RouteContext = {
  params: Promise<{ pluginId: string; path?: string[] }>;
};

/**
 * A CRM page sends ~10 API calls at once and each needs the plugin's row (active, permissions).
 * Reuse it for a few seconds instead of a database round trip per call; enabling, disabling or
 * updating a plugin shows within that time.
 */
const PLUGIN_ROW_TTL_MS = 5_000;
type PluginRow = Awaited<ReturnType<typeof readPluginRow>>;
const pluginRowCache = new Map<string, { at: number; row: Promise<PluginRow> }>();

async function readPluginRow(pluginId: string) {
  await getUserDbConnection();
  const PluginModel = getPluginModel();
  return PluginModel.findOne({ pluginId }).lean();
}

function getPluginRow(pluginId: string): Promise<PluginRow> {
  const cached = pluginRowCache.get(pluginId);
  if (cached && Date.now() - cached.at < PLUGIN_ROW_TTL_MS) return cached.row;
  const row = readPluginRow(pluginId);
  pluginRowCache.set(pluginId, { at: Date.now(), row });
  // A failed read is not reused.
  row.catch(() => pluginRowCache.delete(pluginId));
  return row;
}

async function ensurePluginBackendReady(pluginId: string) {
  await bootstrapBackendPlugins();
  const plugin = await getPluginRow(pluginId);

  if (!plugin) {
    return { error: NextResponse.json({ message: 'Plugin not found' }, { status: 404 }) };
  }

  if (!plugin.hasBackend) {
    return {
      error: NextResponse.json({ message: 'Plugin does not expose backend APIs' }, { status: 404 }),
    };
  }

  if (!plugin.isActive) {
    return { error: NextResponse.json({ message: 'Plugin is disabled' }, { status: 403 }) };
  }

  const loaded = getLoadedPlugin(pluginId);
  if (!loaded) {
    return {
      error: NextResponse.json(
        { message: plugin.loadError || 'Plugin backend is not loaded' },
        { status: 503 }
      ),
    };
  }

  return { plugin, loaded };
}

async function handlePluginRequest(req: NextRequest, context: RouteContext) {
  const params = await context.params;
  const pluginId = assertSafePluginId(params.pluginId);
  const pathSegments = params.path || [];

  const ready = await ensurePluginBackendReady(pluginId);
  if (ready.error) return ready.error;

  const user = await getAuthUser();
  const permissions = resolveUserPermissions(
    pluginId,
    ready.plugin!.permissions || [],
    user?.role
  );

  // Start every request on a live DB connection (the SDK may hold one that dropped).
  await refreshPluginDatabase(pluginId);

  const pluginReq = await buildPluginRequest({
    req,
    pluginId,
    pathSegments,
    user,
    permissions,
    roles: typeof user?.role === 'number' ? [String(user.role)] : [],
  });

  const pluginRes = await ready.loaded!.app.handle(pluginReq);
  return pluginResponseToNext(pluginRes);
}

export async function GET(req: NextRequest, context: RouteContext) {
  return handlePluginRequest(req, context);
}

export async function POST(req: NextRequest, context: RouteContext) {
  return handlePluginRequest(req, context);
}

export async function PUT(req: NextRequest, context: RouteContext) {
  return handlePluginRequest(req, context);
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  return handlePluginRequest(req, context);
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  return handlePluginRequest(req, context);
}
