/**
 * Razorpay Payment Gateway — OpenNext CMS Mount API module (no iframe).
 *
 * The CMS imports this ESM file and calls mount(el, ctx) with its own #plugin-root div.
 * manifest.styles (ui/admin/styles.css) is injected by the CMS under @scope (#plugin-root).
 *
 * Security: the Key Secret is write-only — it is never read back, rendered or logged here.
 * The server (api/routes/settings.js) enforces every permission; ctx.features only hides
 * controls the signed-in role cannot use.
 */

const PLUGIN_ID = 'razorpay-payment-gateway';

const CURRENCIES = [
  ['INR', 'INR — Indian Rupee'],
  ['USD', 'USD — US Dollar'],
  ['EUR', 'EUR — Euro'],
  ['GBP', 'GBP — British Pound'],
  ['SGD', 'SGD — Singapore Dollar'],
  ['AED', 'AED — UAE Dirham'],
];

const instances = new WeakMap();
let nextMountId = 1;

/** A role may use a feature when the CMS grants all ('*'), sends no list, or lists it. */
function hasFeature(features, feature) {
  if (features === '*' || features == null) return true;
  if (!Array.isArray(features) || features.length === 0) return true;
  return features.includes(feature);
}

/** Small element builder: never parses HTML, so no value can inject markup. */
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'hidden') node.hidden = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function mount(element, ctx = {}) {
  if (!element) throw new Error('Razorpay Payment Gateway: a mount element is required');
  if (instances.has(element)) unmount(element);

  const uid = `rzp-${nextMountId++}`;
  const apiBase = String(ctx.apiBase || `/api/plugins/${PLUGIN_ID}/`).replace(/\/+$/, '');
  const canConfigure = hasFeature(ctx.features, 'configure');
  const canTest = hasFeature(ctx.features, 'test');
  const controller = new AbortController();
  let alive = true;

  instances.set(element, {
    cleanup() {
      alive = false;
      try {
        controller.abort();
      } catch (_) {
        /* already aborted */
      }
    },
  });

  // ---------- markup ----------
  const banner = h('div', { className: 'rzp-alert', role: 'status', hidden: true });
  const formStatus = h('span', { className: 'rzp-status', 'aria-live': 'polite' });

  const keyIdInput = h('input', {
    id: `${uid}-keyId`,
    name: 'keyId',
    type: 'text',
    placeholder: 'rzp_test_… or rzp_live_…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const keyIdPreview = h('p', { className: 'rzp-masked', hidden: true });
  const secretInput = h('input', {
    id: `${uid}-keySecret`,
    name: 'keySecret',
    type: 'password',
    placeholder: 'Leave blank to keep existing secret',
    autocomplete: 'new-password',
  });
  const secretHint = h('p', {
    className: 'rzp-hint',
    hidden: true,
    text: 'A secret is already saved — enter a new value only to replace it.',
  });
  const businessInput = h('input', {
    id: `${uid}-businessName`,
    name: 'businessName',
    type: 'text',
    placeholder: 'Your business',
    maxlength: '120',
  });
  const currencySelect = h(
    'select',
    { id: `${uid}-currency`, name: 'defaultCurrency' },
    CURRENCIES.map(([value, label]) => h('option', { value, text: label }))
  );

  const saveBtn = h('button', { type: 'submit', className: 'rzp-btn', text: 'Save connection' });
  const testBtn = h('button', {
    type: 'button',
    className: 'rzp-btn rzp-btn-secondary',
    text: 'Test connection',
  });

  const form = h(
    'form',
    { className: 'rzp-form', novalidate: true },
    h('label', { for: keyIdInput.id, text: 'Key ID' }),
    keyIdPreview,
    keyIdInput,
    h('label', { for: secretInput.id, text: 'Key Secret' }),
    secretInput,
    secretHint,
    h('label', { for: businessInput.id, text: 'Business name (checkout)' }),
    businessInput,
    h('label', { for: currencySelect.id, text: 'Default currency' }),
    currencySelect,
    h(
      'div',
      { className: 'rzp-toolbar' },
      canConfigure ? saveBtn : null,
      canTest ? testBtn : null,
      formStatus
    )
  );

  const readOnlyNote = canConfigure
    ? null
    : h('p', {
        className: 'rzp-hint',
        text: 'You can view the connection status. Ask a Payments Admin to change the Razorpay keys.',
      });

  const snippet = h('pre', { className: 'rzp-code' });
  snippet.textContent = [
    `POST ${apiBase}/integration/orders`,
    '{',
    '  "amount": 50000,',
    '  "currency": "INR",',
    '  "receipt": "invoice-42",',
    '  "sourcePlugin": "your-plugin-id",',
    '  "notes": { "invoiceId": "42" }',
    '}',
    '',
    'Public checkout Key ID:',
    'GET /api/payments/razorpay/public-config',
  ].join('\n');

  const root = h(
    'div',
    { className: 'rzp-plugin-root' },
    h('h1', { className: 'rzp-title', text: 'Razorpay Payment Gateway' }),
    h('p', {
      className: 'rzp-subtitle',
      text: 'Connect your Razorpay account once. Other plugins can accept payments through this gateway.',
    }),
    banner,
    h(
      'section',
      { className: 'rzp-card' },
      h('h2', { text: 'Account connection' }),
      h(
        'p',
        { className: 'rzp-hint' },
        'Get API keys from ',
        h('a', {
          href: 'https://dashboard.razorpay.com/app/keys',
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Razorpay Dashboard → API Keys',
        }),
        '. Use test keys (',
        h('code', { text: 'rzp_test_…' }),
        ') while developing.'
      ),
      readOnlyNote,
      form
    ),
    h(
      'section',
      { className: 'rzp-card' },
      h('h2', { text: 'Integration for other plugins' }),
      h('p', {
        className: 'rzp-hint',
        text:
          'After you connect Razorpay here, any plugin can create orders and verify payments via the gateway APIs (authenticated) or via CMS helpers on the server.',
      }),
      snippet
    )
  );

  for (const field of [keyIdInput, secretInput, businessInput, currencySelect]) {
    field.disabled = !canConfigure;
  }

  element.replaceChildren(root);

  // ---------- behaviour ----------
  function setFormStatus(message, type) {
    if (!alive) return;
    formStatus.textContent = message || '';
    formStatus.className = 'rzp-status' + (type ? ` is-${type}` : '');
  }

  function showBanner(message, type) {
    if (!alive) return;
    banner.hidden = !message;
    banner.textContent = message || '';
    banner.className = `rzp-alert is-${type || 'info'}`;
  }

  function setBusy(busy) {
    saveBtn.disabled = busy;
    testBtn.disabled = busy;
  }

  async function api(path, options = {}) {
    const response = await fetch(apiBase + path, {
      credentials: 'include',
      signal: controller.signal,
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok || (data && data.success === false)) {
      const fallback =
        response.status === 403
          ? 'You do not have permission for this action.'
          : `Request failed (${response.status})`;
      throw new Error((data && data.message) || fallback);
    }
    return data || {};
  }

  const isAbort = (error) => error && error.name === 'AbortError';

  async function loadSettings() {
    setFormStatus('Loading…');
    try {
      const result = await api('/settings');
      if (!alive) return;
      const data = result.data || {};
      keyIdInput.value = '';
      secretInput.value = '';
      businessInput.value = data.businessName || '';
      currencySelect.value = CURRENCIES.some(([code]) => code === data.defaultCurrency)
        ? data.defaultCurrency
        : 'INR';

      if (data.configured && data.keyIdPreview) {
        keyIdPreview.hidden = false;
        keyIdPreview.textContent = `Saved Key ID: ${data.keyIdPreview}`;
        keyIdInput.placeholder = 'Enter new Key ID to replace';
      } else {
        keyIdPreview.hidden = true;
        keyIdPreview.textContent = '';
        keyIdInput.placeholder = 'rzp_test_… or rzp_live_…';
      }
      secretHint.hidden = !data.hasKeySecret;

      if (data.configured) {
        showBanner(
          `Connected (${data.mode === 'live' ? 'live' : 'test'} mode). Other plugins can accept payments.`,
          'success'
        );
      } else {
        showBanner('Not connected — add your Razorpay Key ID and Secret below.', 'warning');
      }
      setFormStatus('');
    } catch (error) {
      if (isAbort(error)) return;
      setFormStatus(error.message, 'error');
      showBanner(error.message, 'error');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canConfigure) return;

    const payload = {
      businessName: businessInput.value.trim(),
      defaultCurrency: currencySelect.value,
    };
    const keyId = keyIdInput.value.trim();
    if (keyId) {
      if (!/^rzp_[A-Za-z0-9_]+$/.test(keyId)) {
        setFormStatus('Key ID should look like rzp_test_… or rzp_live_…', 'error');
        keyIdInput.focus();
        return;
      }
      payload.keyId = keyId;
    }
    const secret = secretInput.value.trim();
    if (secret) payload.keySecret = secret;

    setBusy(true);
    setFormStatus('Saving…');
    try {
      const result = await api('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      secretInput.value = '';
      await loadSettings();
      setFormStatus(result.message || 'Saved', 'success');
    } catch (error) {
      if (isAbort(error)) return;
      setFormStatus(error.message, 'error');
    } finally {
      // Never keep a typed secret in the DOM longer than needed.
      secretInput.value = '';
      if (alive) setBusy(false);
    }
  });

  testBtn.addEventListener('click', async () => {
    setBusy(true);
    setFormStatus('Testing…');
    try {
      const result = await api('/settings/test', { method: 'POST' });
      setFormStatus(result.message || 'Connection OK', 'success');
    } catch (error) {
      if (isAbort(error)) return;
      setFormStatus(error.message, 'error');
    } finally {
      if (alive) setBusy(false);
    }
  });

  await loadSettings();

  return {
    root,
    unmount: () => unmount(element),
  };
}

export function unmount(element) {
  if (!element) return;
  const instance = instances.get(element);
  if (instance) instance.cleanup();
  instances.delete(element);
  element.replaceChildren();
}

export default { mount, unmount };
