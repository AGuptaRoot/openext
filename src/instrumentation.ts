export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrapBackendPlugins } = await import('@/lib/plugins/server/bootstrap');
    // Start loading backend plugins (the CRM alone is ~1,700 files) without holding up the
    // server: pages that use no plugin (login, dashboard, site pages) answer right away. The
    // plugin API route awaits the same shared bootstrap before it dispatches, so plugin
    // requests still wait until their plugin is loaded. Errors are logged inside.
    void bootstrapBackendPlugins();

    const { themeManager } = await import('@/modules/themeEngine/ThemeManager');
    await themeManager.ensureDefaultThemeReady().catch((err) => {
      console.error('[themeEngine] Failed to seed default theme on startup:', err);
    });
  }
}
