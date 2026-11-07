/**
 * Base class for Travel Agency web components (light DOM, no Shadow DOM, so
 * ui/style.css applies). The entry sets `element.ctx` and appends it; the
 * component starts once it has both a ctx and a place in the page.
 *
 * Every component also gets:
 *  - a theme: the attribute data-tvx-theme="light|dark" on the element (the CSS variables
 *    --tvx-* in ui/style.css follow it). It is our own attribute, not data-theme, so the CRM's
 *    dark-mode detection never mistakes one of our elements for the page. It follows
 *    ctx.onThemeChange when the CRM offers it, otherwise it watches the page (class "dark" or
 *    data-theme="dark" on <html> / <body>);
 *  - onCleanup(fn): run when the element leaves the page (unsubscribe, remove listeners, timers).
 */

import { h, errorText } from './dom.js';

/** The page's own theme marker (html / body), as the CRM sets it. */
export function pageTheme() {
  const marks = [document.documentElement, document.body].filter(Boolean);
  const dark = marks.some((el) => el.classList.contains('dark') || el.getAttribute('data-theme') === 'dark');
  return dark ? 'dark' : 'light';
}

export class TravelElement extends HTMLElement {
  get ctx() {
    return this._ctx;
  }

  set ctx(value) {
    this._ctx = value;
    this._start();
  }

  connectedCallback() {
    this._start();
  }

  disconnectedCallback() {
    const list = this._cleanups || [];
    this._cleanups = [];
    for (const fn of list.reverse()) {
      try {
        fn();
      } catch {
        /* a cleanup never stops the others */
      }
    }
  }

  /** Run `fn` when this element leaves the page. */
  onCleanup(fn) {
    if (typeof fn !== 'function') return;
    (this._cleanups || (this._cleanups = [])).push(fn);
  }

  /** Set the theme attribute ('dark' or 'light'). */
  setTheme(theme) {
    this.setAttribute('data-tvx-theme', theme === 'dark' ? 'dark' : 'light');
  }

  _watchTheme(ctx) {
    this.setTheme(ctx.theme === 'dark' ? 'dark' : ctx.theme === 'light' ? 'light' : pageTheme());
    if (typeof ctx.onThemeChange === 'function') {
      subscribe(this, ctx, 'onThemeChange', (theme) => this.setTheme(theme));
      return;
    }
    const Observer = (typeof window !== 'undefined' && window.MutationObserver) || globalThis.MutationObserver;
    if (typeof Observer !== 'function') return;
    const observer = new Observer(() => this.setTheme(pageTheme()));
    for (const el of [document.documentElement, document.body].filter(Boolean)) {
      observer.observe(el, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }
    this.onCleanup(() => observer.disconnect());
  }

  _start() {
    if (this._started || !this._ctx || !this.isConnected) return;
    this._started = true;
    try {
      this._watchTheme(this._ctx);
    } catch {
      /* theme is cosmetic */
    }
    try {
      this.start(this._ctx);
    } catch (err) {
      this.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', text: errorText(err) }));
    }
  }

  /** Subclasses render into `this`. */
  start() {}
}

/**
 * Subscribe to a ctx event (ctx.onValuesChanged, ctx.onSettingsChanged, ctx.onThemeChange, …) for as
 * long as `root` is on the page. Does nothing when the CRM does not offer the event.
 */
export function subscribe(root, ctx, name, callback) {
  if (!ctx || typeof ctx[name] !== 'function') return;
  const off = ctx[name](callback);
  if (typeof off === 'function' && root && typeof root.onCleanup === 'function') root.onCleanup(off);
}

/**
 * Tag names are global and cannot be redefined until the page reloads, so they
 * carry the major version; a later 1.x keeps working with an already defined tag.
 */
export function defineOnce(tag, cls) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
  return tag;
}
