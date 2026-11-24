export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrapBackendPlugins } = await import('@/lib/plugins/server/bootstrap');
    // Start loading backend plugins (the CRM alone is ~1,700 files) without holding up the
    // server: pages that use no plugin (login, dashboard, site pages) answer right away. The
    // plugin API route awaits the same shared load (bootstrap.ts keeps it per process), so
    // plugin requests wait until their plugin is loaded. Errors are logged inside.
    void bootstrapBackendPlugins();

    // The built-in default theme is installed on first need (ThemeManager.renderPage and the
    // theme preview/sections routes). On a long-running server (Railway, `npm start`) also
    // prepare it now in the background, so the first visitor after a restart doesn't wait.
    // Skipped on Vercel, where it would compete with the cold start's first request.
    if (!process.env.VERCEL) {
      void import('@/modules/themeEngine/ThemeManager')
        .then(({ themeManager }) => themeManager.ensureDefaultThemeReady())
        .catch((err) => {
          console.error('[themeEngine] Failed to prepare the default theme on startup:', err);
        });
    }
  }
}
