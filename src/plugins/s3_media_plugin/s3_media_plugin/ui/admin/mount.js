/**
 * S3 Media Library - Native In-DOM Mount Module for OpenNext CMS
 * Exports mount() and unmount() for seamless host DOM mounting without an iframe.
 */

const activeInstances = new WeakMap();
let nextMountId = 1;

/**
 * Escapes HTML characters to prevent XSS.
 * @param {string|number} value
 * @returns {string}
 */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value == null ? '' : value);
  return div.innerHTML;
}

/**
 * Check if filename appears to be an image format.
 * @param {string} name
 * @returns {boolean}
 */
function isProbablyImage(name) {
  return /\.(jpe?g|png|webp|gif|avif|svg)$/i.test(String(name || ''));
}

/**
 * Mount the S3 Media Library plugin into the given DOM element.
 * @param {HTMLElement} element
 * @param {Object} [ctx]
 * @returns {Promise<{ root: HTMLElement, unmount: Function }>}
 */
export async function mount(element, ctx = {}) {
  if (!element) {
    throw new Error('Target DOM element is required to mount s3-media-plugin');
  }

  // Cleanup any active instance already on this element
  if (activeInstances.has(element)) {
    unmount(element);
  }

  const mountId = nextMountId++;
  const rawApiBase =
    (ctx && ctx.apiBase) ||
    '/api/plugins/' + ((ctx && ctx.pluginId) || 's3_media_plugin');
  const apiBase = String(rawApiBase).replace(/\/+$/, '');
  const abortController = new AbortController();

  let isMounted = true;
  let isConfigured = false;

  const instanceState = {
    mountId,
    abortController,
    cleanup() {
      isMounted = false;
      try {
        abortController.abort();
      } catch (_) {
        // Ignore abort errors
      }
    },
  };
  activeInstances.set(element, instanceState);

  /**
   * Safe fetch client scoped to apiBase
   * @param {string} path
   * @param {RequestInit} [options]
   */
  async function api(path, options = {}) {
    if (!isMounted) return null;

    const response = await fetch(apiBase + path, {
      credentials: 'include',
      signal: abortController.signal,
      ...options,
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      throw new Error((data && data.message) || `Request failed (${response.status})`);
    }

    return data;
  }

  function mediaViewSrc(item) {
    return `${apiBase}/media/${encodeURIComponent(item.encodedKey)}/file`;
  }

  // Root wrapper with s3-plugin-root namespace
  const rootEl = document.createElement('div');
  rootEl.className = 's3-plugin-root';

  const fileInputId = `s3-file-input-${mountId}`;
  const folderInputId = `s3-folder-input-${mountId}`;

  rootEl.innerHTML = `
    <div class="s3-header">
      <h1 class="s3-title">S3 Media Library</h1>
      <p class="subtitle">
        When AWS credentials are configured, every upload is stored only in Amazon S3 — never on the
        local server disk.
      </p>
    </div>

    <div class="alert warning s3-storage-banner" hidden></div>

    <div class="alert warning s3-config-alert" hidden>
      S3 is not configured. Open <strong>Dashboard → Settings → Config</strong> and save your AWS
      credentials (bucket and/or Access Point ARN) under <strong>AWS S3 Media Storage</strong>.
      Until then, uploads from this plugin are blocked (no local fallback).
    </div>

    <div class="card s3-upload-card">
      <h2>Upload to Amazon S3</h2>
      <form class="s3-upload-form">
        <label for="${fileInputId}">Choose file (any type — max 50MB)</label>
        <input id="${fileInputId}" name="file" type="file" required />
        <label for="${folderInputId}">Optional folder under your S3 prefix</label>
        <input id="${folderInputId}" name="folder" type="text" placeholder="e.g. gallery, docs, brand" />
        <div class="toolbar">
          <button type="submit" class="s3-upload-btn">Upload to S3</button>
          <button type="button" class="secondary s3-refresh-btn">Refresh from S3</button>
          <span class="status s3-status">Loading…</span>
        </div>
      </form>
    </div>

    <div class="card s3-media-card">
      <h2>Objects in S3</h2>
      <div class="grid s3-media-grid"></div>
      <p class="empty s3-empty-state" hidden>No objects found in your S3 prefix yet.</p>
    </div>
  `;

  // References to inner controls
  const statusEl = rootEl.querySelector('.s3-status');
  const gridEl = rootEl.querySelector('.s3-media-grid');
  const emptyEl = rootEl.querySelector('.s3-empty-state');
  const configAlert = rootEl.querySelector('.s3-config-alert');
  const storageBanner = rootEl.querySelector('.s3-storage-banner');
  const uploadForm = rootEl.querySelector('.s3-upload-form');
  const uploadBtn = rootEl.querySelector('.s3-upload-btn');
  const refreshBtn = rootEl.querySelector('.s3-refresh-btn');
  const fileInput = rootEl.querySelector(`#${fileInputId}`);
  const folderInput = rootEl.querySelector(`#${folderInputId}`);

  function setStatus(message, type) {
    if (!isMounted || !statusEl) return;
    statusEl.textContent = message;
    statusEl.className = 'status s3-status' + (type ? ' ' + type : '');
  }

  async function loadSettings() {
    try {
      const data = await api('/settings');
      if (!isMounted || !data) return false;

      isConfigured = !!(data.settings && data.settings.isConfigured);
      const status = data.status || {};

      configAlert.hidden = isConfigured;

      if (isConfigured && status.storage === 's3') {
        storageBanner.hidden = false;
        storageBanner.className = 'alert success s3-storage-banner';
        storageBanner.innerHTML =
          '<strong>Active storage: Amazon S3</strong> — ' +
          escapeHtml(status.message || 'All uploads from this plugin are stored in S3 only.');
      } else {
        storageBanner.hidden = true;
      }

      uploadBtn.disabled = !isConfigured;
      return isConfigured;
    } catch (err) {
      if (!isMounted) return false;
      setStatus(err.message, 'error');
      uploadBtn.disabled = true;
      return false;
    }
  }

  async function loadMedia() {
    if (!isMounted) return;
    setStatus('Loading from S3…');
    gridEl.innerHTML = '';

    try {
      const data = await api('/media?imagesOnly=false');
      if (!isMounted || !data) return;

      const media = data.media || [];

      if (media.length === 0) {
        emptyEl.hidden = false;
        emptyEl.textContent = 'No objects found in your S3 prefix yet.';
        setStatus('0 objects in S3');
        return;
      }

      emptyEl.hidden = true;
      gridEl.innerHTML = media
        .map((item) => {
          const previewUrl = mediaViewSrc(item);
          const copyUrl = item.filePath || item.url || '';
          const showImage = isProbablyImage(item.originalName);
          const previewHtml = showImage
            ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(item.originalName)}" loading="lazy" />`
            : `<div class="file-placeholder">${escapeHtml(item.originalName)}</div>`;

          return `
            <article class="media-item">
              ${previewHtml}
              <div class="media-body">
                <p class="media-name" title="${escapeHtml(item.originalName)}">${escapeHtml(item.originalName)}</p>
                <div class="media-actions">
                  <button type="button" class="secondary copy-btn" data-url="${escapeHtml(copyUrl)}">Copy S3 URL</button>
                  <button type="button" class="danger delete-btn" data-key="${escapeHtml(item.encodedKey)}">Delete</button>
                </div>
              </div>
            </article>
          `;
        })
        .join('');

      setStatus(`${media.length} object${media.length === 1 ? '' : 's'} in S3`);
    } catch (error) {
      if (!isMounted) return;
      emptyEl.hidden = false;
      emptyEl.textContent = error.message;
      setStatus(error.message, 'error');
    }
  }

  // Handle file uploads
  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files && fileInput.files[0];

    if (!file) {
      setStatus('Choose a file first', 'error');
      return;
    }

    setStatus('Uploading to Amazon S3…');
    uploadBtn.disabled = true;

    const formData = new FormData();
    formData.append('file', file);
    if (folderInput && folderInput.value.trim()) {
      formData.append('folder', folderInput.value.trim());
    }

    try {
      const data = await api('/media/upload', {
        method: 'POST',
        body: formData,
      });

      if (!isMounted) return;
      fileInput.value = '';
      setStatus(
        'Stored in S3: ' +
          (data && data.asset && data.asset.originalName ? data.asset.originalName : 'success'),
        'success'
      );
      await loadMedia();
    } catch (error) {
      if (!isMounted) return;
      setStatus(error.message, 'error');
    } finally {
      if (isMounted) {
        uploadBtn.disabled = !(await loadSettings());
      }
    }
  });

  // Handle manual refresh
  refreshBtn.addEventListener('click', () => {
    loadMedia();
  });

  // Handle copy & delete button interactions in grid
  gridEl.addEventListener('click', async (event) => {
    const copyBtn = event.target.closest('.copy-btn');
    if (copyBtn) {
      const url = copyBtn.getAttribute('data-url');
      if (url) {
        try {
          await navigator.clipboard.writeText(url);
          setStatus('Durable S3 URL copied', 'success');
        } catch (err) {
          setStatus('Failed to copy: ' + (err && err.message ? err.message : String(err)), 'error');
        }
      }
      return;
    }

    const deleteBtn = event.target.closest('.delete-btn');
    if (!deleteBtn) return;

    const encodedKey = deleteBtn.getAttribute('data-key');
    if (!encodedKey) return;
    if (!window.confirm('Delete this object from S3?')) return;

    setStatus('Deleting from S3…');
    try {
      await api('/media/' + encodeURIComponent(encodedKey), { method: 'DELETE' });
      if (!isMounted) return;
      setStatus('Object deleted from S3', 'success');
      await loadMedia();
    } catch (error) {
      if (!isMounted) return;
      setStatus(error.message, 'error');
    }
  });

  // Clean mount into target element
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren(rootEl);
  } else {
    element.innerHTML = '';
    element.appendChild(rootEl);
  }

  // Load initial settings and media
  try {
    await Promise.all([loadSettings(), loadMedia()]);
  } catch (err) {
    if (isMounted) {
      setStatus(err.message, 'error');
    }
  }

  return {
    root: rootEl,
    unmount: () => unmount(element),
  };
}

/**
 * Unmount and clean up s3-media-plugin from the given element.
 * @param {HTMLElement} element
 */
export function unmount(element) {
  if (!element) return;
  const instance = activeInstances.get(element);
  if (instance && typeof instance.cleanup === 'function') {
    instance.cleanup();
  }
  activeInstances.delete(element);
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren();
  } else {
    element.innerHTML = '';
  }
}

export default {
  mount,
  unmount,
};
