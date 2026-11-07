'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiUrl } from '@/lib/apiClient';
import {
  NATIVE_PLUGIN_NAV_ATTRIBUTE,
  PLUGIN_NAV_CHANGED_EVENT,
  parsePluginDynamicNav,
  type PluginDynamicNav,
} from '@/lib/plugins/dynamicNav';

async function fetchPluginNav(pluginId: string): Promise<PluginDynamicNav | null> {
  try {
    const response = await fetch(apiUrl(`/api/plugins/${encodeURIComponent(pluginId)}/admin-nav`), {
      credentials: 'include',
      cache: 'no-store',
    });
    // 404: plugin has no dynamic nav. Other errors: keep the manifest nav for now.
    if (!response.ok) return null;
    return parsePluginDynamicNav(pluginId, await response.json());
  } catch {
    return null;
  }
}

/**
 * Dynamic sidebar items (added pages, hidden modules) for the given uploaded plugins.
 * Loaded with the dashboard, so they show on first load and on every page, and
 * reloaded when a plugin dispatches `cms:plugin-nav-changed` (detail: { pluginId }).
 */
export function usePluginDynamicNav(pluginIds: string[]): Map<string, PluginDynamicNav> {
  const [navByPlugin, setNavByPlugin] = useState<Map<string, PluginDynamicNav>>(new Map());
  const idsKey = useMemo(() => [...new Set(pluginIds)].sort().join('|'), [pluginIds]);

  // Tell plugin UIs that the host renders their dynamic nav, so they skip DOM injection.
  useEffect(() => {
    document.documentElement.setAttribute(NATIVE_PLUGIN_NAV_ATTRIBUTE, 'true');
  }, []);

  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : [];
    let cancelled = false;

    const load = async (only?: string) => {
      const targets = only ? ids.filter((id) => id === only) : ids;
      if (!targets.length) return;
      const results = await Promise.all(targets.map(async (id) => [id, await fetchPluginNav(id)] as const));
      if (cancelled) return;
      setNavByPlugin((previous) => {
        const next = new Map(only ? previous : []);
        for (const [id, nav] of results) {
          if (nav) next.set(id, nav);
          else if (!only) next.delete(id);
        }
        return next;
      });
    };

    void load();

    const onChanged = (event: Event) => {
      const pluginId = (event as CustomEvent<{ pluginId?: string }>).detail?.pluginId;
      void load(typeof pluginId === 'string' && pluginId ? pluginId : undefined);
    };
    window.addEventListener(PLUGIN_NAV_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(PLUGIN_NAV_CHANGED_EVENT, onChanged);
    };
  }, [idsKey]);

  return navByPlugin;
}
