/** Small DOM and data helpers shared by every Travel Agency component. */

export function h(tag, attrs, children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of [].concat(children === undefined ? [] : children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function slug(text, fallback) {
  const out = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  return /^[a-z]/.test(out) ? out : out ? `f_${out}` : fallback;
}

export function uniqueKey(base, taken) {
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

export function sortByOrder(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

export function isEmpty(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

export function errorText(err) {
  if (!err) return 'Something went wrong';
  if (Array.isArray(err.details) && err.details.length) return err.details.join(' · ');
  return err.message || String(err);
}
