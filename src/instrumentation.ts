export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrapBackendPlugins } = await import('@/lib/plugins/server/bootstrap');
    // Start loading backend plugins (the CRM alone is ~1,700 files) without holding up the
    // server: pages that use no plugin (login, dashboard, site pages) answer right away. The
    // plugin API route awaits the same shared bootstrap before it dispatches, so plugin
    // requests still wait until their plugin is loaded. Errors are logged inside.
    void bootstrapBackendPlugins();

    // The built-in default theme is no longer installed here: ThemeManager.renderPage() and
    // the theme preview/sections routes install it on first need (once per process).
  }
}
