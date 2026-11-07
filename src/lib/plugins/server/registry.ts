import type { LoadedPlugin } from '@/lib/plugins/server/types';

const loadedPlugins = new Map<string, LoadedPlugin>();

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
