/*
 * CRM 3.62.0 — service worker for browser alerts (web push through Firebase Cloud Messaging).
 *
 * Served by the CRM at /api/plugins/openext-crm-suite/push/sw.js and registered by the CRM page with the
 * scope /api/plugins/openext-crm-suite/push/ (a push scope only: it never controls or caches CRM pages).
 * The page passes ?base=<the CRM page path in the CMS>, used to open the right page on a click.
 *
 * It shows each alert FCM delivers (title + text, like the in-app bell) and, on click, focuses an open CRM
 * tab (which moves to the alert's page) or opens the CRM at that page. It stores nothing and sends nothing.
 */
'use strict';

const params = new URL(self.location.href).searchParams;
const rawBase = String(params.get('base') || '');
// Only a path on this site (never another origin).
const BASE = /^\/[A-Za-z0-9/_.-]{0,300}$/.test(rawBase) && !rawBase.startsWith('//') ? rawBase : '/';
const safeLink = (link) => (typeof link === 'string' && /^\/(?!\/)[^\s]{0,300}$/.test(link) ? link : '');

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = {};
  }
  const note = (payload && payload.notification) || {};
  const data = (payload && payload.data) || {};
  const title = String(note.title || data.title || 'CRM alert').slice(0, 120);
  const options = {
    body: String(note.body || data.body || '').slice(0, 500),
    tag: data.notificationId ? `crm-${String(data.notificationId).slice(0, 40)}` : undefined,
    data: { link: safeLink(data.link) }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = safeLink(event.notification.data && event.notification.data.link);
  const target = new URL(BASE + (link ? `?crmOpen=${encodeURIComponent(link)}` : ''), self.location.origin).href;
  const crmPrefix = new URL(BASE, self.location.origin).href.replace(/\/[^/]*$/, '/');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(crmPrefix) && 'focus' in client) {
          if (link) client.postMessage({ type: 'crm-push-open', link });
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
});
