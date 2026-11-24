import type { LoadedPlugin } from '@/lib/plugins/server/types';

/**
 * One registry per server process. Next.js compiles instrumentation (which loads the plugins
 * at startup) separately from the API routes, so a plain module-level Map would give each its
 * own copy: plugins loaded at startup would be invisible to the plugin route, which then loaded
 * them all again on the first request.
 */
const registryGlobal = globalThis as typeof globalThis & {
  __openextLoadedPlugins?: Map<string, LoadedPlugin>;
};
const loadedPlugins = (registryGlobal.__openextLoadedPlugins ??= new Map<string, LoadedPlugin>());

export function getLoadedPlugin(pluginId: string): LoadedPlugin | undefined {
  return loadedPlugins.get(pluginId);
}

export function getAllLoadedPlugins(): LoadedPlugin[] {
  return [...loadedPlugins.values()];
}

export function setLoadedPlugin(plugin: LoadedPlugin): void {
  loadedPlugins.set(plugin.pluginId, plugin);
}

export function removeLoadedPlugin(pluginId: string): LoadedPlugin | undefined {
  const existing = loadedPlugins.get(pluginId);
  loadedPlugins.delete(pluginId);
  return existing;
}

/**
 * Make sure a loaded plugin's SDK holds a live user DB connection before its code runs.
 * After a MongoDB drop the CMS reconnects, but the SDK would otherwise keep the old one.
 */
export async function refreshPluginDatabase(pluginId: string): Promise<void> {
  const loaded = loadedPlugins.get(pluginId);
  if (loaded?.cms) await loaded.cms.database.user();
}

export function clearLoadedPlugins(): void {
  loadedPlugins.clear();
}
