/**
 * OpenNext CMS — Email Service Plugin
 * Native in-DOM mount module (without iframe)
 *
 * Exports:
 *   export async function mount(element, ctx)
 *   export function unmount(element)
 */

const mounts = new WeakMap();

/**
 * Mount the Email Plugin into the given host element.
 * @param {HTMLElement} element
 * @param {{ pluginId?: string; pageId?: string; apiBase?: string; assetBase?: string; [key: string]: any }} ctx
 */
export async function mount(element, ctx = {}) {
  // Always clean up any existing mount on this element
  unmount(element);

  const abortController = new AbortController();
  const pluginId = ctx.pluginId || 'email_plugin';
  const apiBase = (ctx.apiBase || `/api/plugins/${pluginId}`).replace(/\/+$/, '');

  const root = document.createElement('div');
  root.className = 'email-plugin-root';
  element.appendChild(root);

  const instance = {
    abortController,
    cleanup() {
      try {
        abortController.abort();
      } catch {
        // Ignore abort errors
      }
    },
  };
  mounts.set(element, instance);

  // Helper for API calls with abort signal and credentials
  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    const res = await fetch(`${apiBase}${path}`, {
      credentials: 'include',
      signal: abortController.signal,
      ...options,
      headers,
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      throw new Error((data && data.message) || `Request failed (${res.status})`);
    }

    return data;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  function formatDate(value) {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  }

  // Active view: ctx.pageId ('send' | 'settings' | 'logs') defaulting to 'send'
  let currentTab = (ctx.pageId === 'settings' || ctx.pageId === 'logs') ? ctx.pageId : 'send';

  function renderShell() {
    root.innerHTML = `
      <nav class="email-nav-tabs" role="tablist" aria-label="Email Navigation">
        <button type="button" class="email-nav-tab ${currentTab === 'send' ? 'active' : ''}" data-tab="send" role="tab" aria-selected="${currentTab === 'send'}">Send Email</button>
        <button type="button" class="email-nav-tab ${currentTab === 'settings' ? 'active' : ''}" data-tab="settings" role="tab" aria-selected="${currentTab === 'settings'}">SMTP Settings</button>
        <button type="button" class="email-nav-tab ${currentTab === 'logs' ? 'active' : ''}" data-tab="logs" role="tab" aria-selected="${currentTab === 'logs'}">Logs</button>
      </nav>
      <div class="email-view-container"></div>
    `;

    const tabButtons = root.querySelectorAll('.email-nav-tab');
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        if (tab && tab !== currentTab) {
          currentTab = tab;
          tabButtons.forEach((b) => {
            const isActive = b.getAttribute('data-tab') === currentTab;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-selected', String(isActive));
          });
          renderActiveView();
        }
      });
    });

    renderActiveView();
  }

  function renderActiveView() {
    const viewContainer = root.querySelector('.email-view-container');
    if (!viewContainer) return;
    viewContainer.replaceChildren();

    if (currentTab === 'send') {
      mountSendView(viewContainer);
    } else if (currentTab === 'settings') {
      mountSettingsView(viewContainer);
    } else if (currentTab === 'logs') {
      mountLogsView(viewContainer);
    }
  }

  /* ==========================================================================
     SEND EMAIL VIEW
     ========================================================================== */
  function mountSendView(viewEl) {
    viewEl.innerHTML = `
      <h1>Send Email</h1>
      <p class="subtitle">Compose and send emails through your configured SMTP server.</p>

      <div id="email-config-alert" class="alert warning" hidden>
        SMTP is not configured yet. Open <strong>SMTP Settings</strong> in the tab or sidebar and save your
        mail server credentials first.
      </div>

      <div class="card">
        <h2>Compose message</h2>
        <form id="email-send-form">
          <label for="email-to">To</label>
          <input id="email-to" name="to" type="email" placeholder="recipient@example.com" required />

          <label for="email-subject">Subject</label>
          <input id="email-subject" name="subject" type="text" placeholder="Email subject" required />

          <label for="email-text">Message (plain text)</label>
          <textarea
            id="email-text"
            name="text"
            placeholder="Write your message here…"
            required
          ></textarea>
          <p class="hint">HTML is optional. Plain text is used when HTML is not provided.</p>

          <label for="email-html">HTML body (optional)</label>
          <textarea
            id="email-html"
            name="html"
            placeholder="<p>Hello,</p><p>Your HTML content…</p>"
          ></textarea>

          <div class="toolbar">
            <button type="submit" id="email-send-btn">Send email</button>
            <span class="status" id="email-send-status"></span>
          </div>
        </form>
      </div>
    `;

    const statusEl = viewEl.querySelector('#email-send-status');
    const configAlert = viewEl.querySelector('#email-config-alert');
    const sendBtn = viewEl.querySelector('#email-send-btn');
    const form = viewEl.querySelector('#email-send-form');

    function setStatus(message, type) {
      if (!statusEl) return;
      statusEl.textContent = message;
      statusEl.className = 'status' + (type ? ' ' + type : '');
    }

    async function checkConfig() {
      try {
        const data = await api('/settings');
        if (abortController.signal.aborted) return false;
        const configured = Boolean(data.settings && data.settings.isConfigured);
        if (configAlert) configAlert.hidden = configured;
        if (sendBtn) sendBtn.disabled = !configured;
        return configured;
      } catch (err) {
        if (abortController.signal.aborted) return false;
        setStatus(err.message, 'error');
        return false;
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus('Sending…');
      if (sendBtn) sendBtn.disabled = true;

      const payload = {
        to: viewEl.querySelector('#email-to').value.trim(),
        subject: viewEl.querySelector('#email-subject').value.trim(),
        text: viewEl.querySelector('#email-text').value.trim(),
        html: viewEl.querySelector('#email-html').value.trim(),
      };

      try {
        await api('/mail/send', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        viewEl.querySelector('#email-subject').value = '';
        viewEl.querySelector('#email-text').value = '';
        viewEl.querySelector('#email-html').value = '';
        setStatus('Email sent successfully', 'success');
      } catch (error) {
        if (abortController.signal.aborted) return;
        setStatus(error.message, 'error');
      } finally {
        const configured = await checkConfig();
        if (sendBtn) sendBtn.disabled = !configured;
      }
    });

    checkConfig();
  }

  /* ==========================================================================
     SMTP SETTINGS VIEW
     ========================================================================== */
  function mountSettingsView(viewEl) {
    viewEl.innerHTML = `
      <h1>SMTP Settings</h1>
      <p class="subtitle">
        Configure your outgoing mail server. Credentials are stored securely in the CMS database.
      </p>

      <div class="card">
        <h2>Mail server</h2>
        <form id="email-settings-form">
          <div class="form-grid">
            <div>
              <label for="email-host">SMTP host</label>
              <input id="email-host" name="host" type="text" placeholder="smtp.gmail.com" required />
            </div>
            <div>
              <label for="email-port">Port</label>
              <input id="email-port" name="port" type="number" min="1" max="65535" value="587" required />
            </div>
          </div>

          <div class="checkbox-row">
            <input id="email-secure" name="secure" type="checkbox" />
            <label for="email-secure">Use SSL/TLS (typically port 465)</label>
          </div>

          <div class="form-grid">
            <div>
              <label for="email-user">Username</label>
              <input id="email-user" name="user" type="text" placeholder="smtp-user@example.com" />
            </div>
            <div>
              <label for="email-password">Password</label>
              <input
                id="email-password"
                name="password"
                type="password"
                placeholder="Leave blank to keep saved password"
                autocomplete="new-password"
              />
            </div>
          </div>

          <div class="form-grid">
            <div>
              <label for="email-fromName">From name</label>
              <input id="email-fromName" name="fromName" type="text" placeholder="My Website" />
            </div>
            <div>
              <label for="email-fromEmail">From email</label>
              <input
                id="email-fromEmail"
                name="fromEmail"
                type="email"
                placeholder="noreply@example.com"
                required
              />
            </div>
          </div>

          <label for="email-recipientEmail">Website recipient email</label>
          <input
            id="email-recipientEmail"
            name="recipientEmail"
            type="email"
            placeholder="owner@example.com"
          />

          <label for="email-replyTo">Reply-to (optional)</label>
          <input id="email-replyTo" name="replyTo" type="email" placeholder="support@example.com" />

          <div class="toolbar">
            <button type="submit" id="email-save-btn">Save &amp; verify</button>
            <button type="button" class="secondary" id="email-test-btn">Test connection</button>
            <span class="status" id="email-settings-status"></span>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Status</h2>
        <p id="email-connection-status">Loading…</p>
        <p class="hint">
          Common ports: <code>587</code> (STARTTLS), <code>465</code> (SSL), <code>25</code> (legacy).
        </p>
      </div>
    `;

    const statusEl = viewEl.querySelector('#email-settings-status');
    const connectionStatus = viewEl.querySelector('#email-connection-status');
    const form = viewEl.querySelector('#email-settings-form');
    const testBtn = viewEl.querySelector('#email-test-btn');
    let hasSavedPassword = false;

    function setStatus(message, type) {
      if (!statusEl) return;
      statusEl.textContent = message;
      statusEl.className = 'status' + (type ? ' ' + type : '');
    }

    function readFormPayload(includeEmptyPassword) {
      const portRaw = parseInt(viewEl.querySelector('#email-port').value, 10);
      const passVal = viewEl.querySelector('#email-password').value;

      return {
        host: viewEl.querySelector('#email-host').value.trim(),
        port: isNaN(portRaw) ? 587 : portRaw,
        secure: viewEl.querySelector('#email-secure').checked,
        user: viewEl.querySelector('#email-user').value.trim(),
        password: passVal,
        fromName: viewEl.querySelector('#email-fromName').value.trim(),
        fromEmail: viewEl.querySelector('#email-fromEmail').value.trim(),
        recipientEmail: viewEl.querySelector('#email-recipientEmail').value.trim(),
        replyTo: viewEl.querySelector('#email-replyTo').value.trim(),
        useSaved: includeEmptyPassword && !passVal.trim(),
      };
    }

    function renderConnection(settings, connection) {
      if (!connectionStatus) return;
      if (settings && settings.isConfigured) {
        const badge = connection && connection.ok ? 'ok' : (connection ? 'fail' : 'ok');
        const label = connection && connection.ok ? 'Connected' : (connection ? 'Connection failed' : 'Configured');
        connectionStatus.innerHTML =
          '<span class="badge ' +
          badge +
          '">' +
          label +
          '</span> Sending as <strong>' +
          escapeHtml(settings.fromEmail) +
          '</strong> via <code>' +
          escapeHtml(settings.host) +
          ':' +
          escapeHtml(settings.port) +
          '</code>';
      } else {
        connectionStatus.textContent = 'SMTP is not configured yet.';
      }
    }

    async function loadSettings() {
      try {
        const data = await api('/settings');
        if (abortController.signal.aborted) return;
        const settings = data.settings || {};

        viewEl.querySelector('#email-host').value = settings.host || '';
        viewEl.querySelector('#email-port').value = settings.port || 587;
        viewEl.querySelector('#email-secure').checked = Boolean(settings.secure);
        viewEl.querySelector('#email-fromName').value = settings.fromName || '';
        viewEl.querySelector('#email-fromEmail').value = settings.fromEmail || '';
        viewEl.querySelector('#email-recipientEmail').value = settings.recipientEmail || '';
        viewEl.querySelector('#email-replyTo').value = settings.replyTo || '';

        hasSavedPassword = Boolean(settings.hasCredentials);
        if (settings.userPreview) {
          viewEl.querySelector('#email-user').placeholder = 'Saved: ' + settings.userPreview;
        }

        renderConnection(settings, null);
      } catch (err) {
        if (abortController.signal.aborted) return;
        if (connectionStatus) connectionStatus.textContent = err.message;
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus('Saving…');

      const payload = readFormPayload(false);
      if (!payload.password && !hasSavedPassword) {
        setStatus('Password is required for first-time setup', 'error');
        return;
      }
      if (!payload.password) {
        delete payload.password;
      }

      try {
        const data = await api('/settings', {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        viewEl.querySelector('#email-password').value = '';
        hasSavedPassword = true;
        setStatus(data.message || 'Settings saved', data.connection && data.connection.ok ? 'success' : 'error');
        renderConnection(data.settings, data.connection);
      } catch (error) {
        if (abortController.signal.aborted) return;
        setStatus(error.message, 'error');
      }
    });

    testBtn.addEventListener('click', async () => {
      setStatus('Testing SMTP…');

      const payload = readFormPayload(true);
      if (payload.password) {
        delete payload.useSaved;
      } else {
        delete payload.password;
      }

      try {
        const data = await api('/settings/test', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const conn = data.connection || {};
        setStatus(conn.message || (conn.ok ? 'Connection successful' : 'Connection failed'), conn.ok ? 'success' : 'error');
      } catch (error) {
        if (abortController.signal.aborted) return;
        setStatus(error.message, 'error');
      }
    });

    loadSettings();
  }

  /* ==========================================================================
     LOGS VIEW
     ========================================================================== */
  function mountLogsView(viewEl) {
    viewEl.innerHTML = `
      <h1>Email Logs</h1>
      <p class="subtitle">Recent emails sent through this plugin.</p>

      <div class="card">
        <div class="toolbar" style="margin-bottom: 16px">
          <button type="button" class="secondary" id="email-refresh-btn">Refresh</button>
          <span class="status" id="email-logs-status">Loading…</span>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>To</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Preview</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="email-logs-body"></tbody>
          </table>
        </div>

        <p id="email-empty-state" class="empty" hidden>No emails sent yet.</p>
      </div>
    `;

    const statusEl = viewEl.querySelector('#email-logs-status');
    const logsBody = viewEl.querySelector('#email-logs-body');
    const emptyState = viewEl.querySelector('#email-empty-state');
    const refreshBtn = viewEl.querySelector('#email-refresh-btn');

    function setStatus(message, type) {
      if (!statusEl) return;
      statusEl.textContent = message;
      statusEl.className = 'status' + (type ? ' ' + type : '');
    }

    async function loadLogs() {
      setStatus('Loading…');
      if (logsBody) logsBody.innerHTML = '';

      try {
        const data = await api('/mail/logs?limit=100');
        if (abortController.signal.aborted) return;
        const logs = data.logs || [];

        if (logs.length === 0) {
          if (emptyState) {
            emptyState.hidden = false;
            emptyState.textContent = 'No emails sent yet.';
          }
          setStatus('0 entries');
          return;
        }

        if (emptyState) emptyState.hidden = true;
        if (logsBody) {
          logsBody.innerHTML = logs
            .map((log) => {
              const badgeClass = log.status === 'sent' ? 'ok' : 'fail';
              const statusLabel = log.status === 'sent' ? 'Sent' : 'Failed';
              const preview = log.bodyPreview || (log.error ? log.error : '—');

              return (
                '<tr>' +
                '<td>' + escapeHtml(formatDate(log.createdAt)) + '</td>' +
                '<td>' + escapeHtml(log.to) + '</td>' +
                '<td>' + escapeHtml(log.subject) + '</td>' +
                '<td><span class="badge ' + badgeClass + '">' + statusLabel + '</span></td>' +
                '<td>' + escapeHtml(preview) + '</td>' +
                '<td><button type="button" class="danger delete-btn" data-id="' + escapeHtml(log.id) + '">Delete</button></td>' +
                '</tr>'
              );
            })
            .join('');
        }

        setStatus(logs.length + ' entr' + (logs.length === 1 ? 'y' : 'ies'));
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (emptyState) {
          emptyState.hidden = false;
          emptyState.textContent = error.message;
        }
        setStatus(error.message, 'error');
      }
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', loadLogs);
    }

    if (logsBody) {
      logsBody.addEventListener('click', async (event) => {
        const deleteBtn = event.target.closest('.delete-btn');
        if (!deleteBtn) return;

        const logId = deleteBtn.getAttribute('data-id');
        if (!logId) return;
        if (!confirm('Delete this log entry?')) return;

        setStatus('Deleting…');
        try {
          await api('/mail/logs/' + encodeURIComponent(logId), {
            method: 'DELETE',
          });
          await loadLogs();
        } catch (error) {
          if (abortController.signal.aborted) return;
          setStatus(error.message, 'error');
        }
      });
    }

    loadLogs();
  }

  // Initial render
  renderShell();

  return {
    unmount() {
      unmount(element);
    },
  };
}

/**
 * Cleanly unmount the Email Plugin from the host element.
 * @param {HTMLElement} element
 */
export function unmount(element) {
  if (!element) return;
  const instance = mounts.get(element);
  if (instance) {
    if (typeof instance.cleanup === 'function') {
      instance.cleanup();
    }
    mounts.delete(element);
  }
  element.replaceChildren();
}
