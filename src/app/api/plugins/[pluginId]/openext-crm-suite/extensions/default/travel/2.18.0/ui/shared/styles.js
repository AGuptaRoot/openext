/**
 * Component stylesheets. The CRM loads ui/style.css (shared base) itself; each
 * component loads its own .css next to its .js, once per page.
 */

export function useStyles(url) {
  const href = String(url);
  for (const link of document.head.querySelectorAll('link[data-tvx-style]')) {
    if (link.getAttribute('href') === href) return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute('data-tvx-style', '');
  document.head.appendChild(link);
}
