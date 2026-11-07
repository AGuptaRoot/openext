# Razorpay Payment Gateway Plugin

Connect **your own Razorpay account** (Key ID + Key Secret). Other plugins in your workspace can create orders and verify payments without storing Razorpay credentials themselves.

## Security

Razorpay **Key Secret** is protected with multiple layers:

| Layer | Protection |
|-------|------------|
| **Encryption at rest** | AES-256-GCM (`enc:v1:` prefix in MongoDB) |
| **Key derivation** | scrypt from `CREDENTIAL_ENCRYPTION_KEY` (or strong `JWT_SECRET`) |
| **API responses** | Secret never returned; Key ID shown masked (`rzp_…xxxx`) |
| **Mongoose** | `keySecret` field uses `select: false` |
| **Permissions** | Only `payments.configure` can save credentials |
| **Uninstall** | All stored credentials deleted from database |
| **Logs** | Key patterns redacted in server error logs |
| **Migration** | Legacy plaintext secrets auto-encrypted on boot |

### Required `.env` setup

```bash
# Recommended — dedicated encryption key (32+ bytes)
openssl rand -base64 32
```

```env
CREDENTIAL_ENCRYPTION_KEY=your-generated-base64-key
```

If unset, a strong `JWT_SECRET` is used as fallback. **Do not change the encryption key** after saving credentials without re-entering Razorpay keys.

## Install

1. Zip the `razorpay-payment-gateway` folder (root must contain `manifest.json`).
2. In Next CMS: **Dashboard → Plugins → Install** and upload the zip.
3. Enable the plugin and open it from the sidebar.
4. Paste your Razorpay API keys and click **Save connection**.

### Upgrading from 1.1.x (iframe UI)

From 1.2.0 the admin screen uses the CMS **Mount API** (no iframe): `manifest.adminMount`
points to `ui/admin/mount.js`, which exports `mount(el, ctx)` / `unmount()`, and
`ui/admin/styles.css` is injected by the CMS scoped to `#plugin-root`. The old
`ui/admin/index.html` is removed.

The CMS cannot replace an installed plugin in place, so remove 1.1.x from
**Dashboard → Plugins** and upload 1.2.0. Uninstalling deletes the stored credentials
(see **Security → Uninstall**), so re-enter the Key ID and Secret after upgrading.

### Admin UI and roles

The **Payments** page reads `ctx.features` from the plugin role (`api/roles.js`):
`configure` shows **Save connection**, `test` shows **Test connection**; other roles see the
status read-only. The server still checks `payments.configure` on every change.

Get keys from [Razorpay Dashboard → API Keys](https://dashboard.razorpay.com/app/keys).

## API (for other plugins)

Base path: `/api/plugins/razorpay-payment-gateway`

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| GET | `/status` | `payments.read` or `payments.integrate` | Gateway configured + mode |
| GET | `/settings` | `payments.read` or `payments.configure` | Admin settings (no secret) |
| PUT | `/settings` | `payments.configure` | Save Key ID / Secret |
| POST | `/settings/test` | `payments.configure` | Test API connection |
| POST | `/orders` | `payments.create_order` or `payments.integrate` | Create Razorpay order |
| POST | `/verify` | `payments.verify` or `payments.integrate` | Verify payment signature |
| POST | `/integration/orders` | same as `/orders` | Adds `sourcePlugin` to notes |
| POST | `/integration/verify` | same as `/verify` | Integration alias |

### Create order (from another plugin UI)

```javascript
const res = await fetch('/api/plugins/razorpay-payment-gateway/integration/orders', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    amount: 50000,        // paise (₹500.00)
    currency: 'INR',
    receipt: 'invoice-42',
    sourcePlugin: 'my-crm-plugin',
    notes: { invoiceId: '42' },
  }),
});
const { data } = await res.json();
// data.order.id, data.keyId — open Razorpay Checkout
```

### Public checkout (website visitors)

```javascript
const res = await fetch('/api/payments/razorpay/public-config');
const { keyId, currency, businessName } = await res.json();
```

Then use [Razorpay Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/) with `keyId` and the order id from `/integration/orders`.

### Verify after payment

```javascript
await fetch('/api/plugins/razorpay-payment-gateway/integration/verify', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  }),
});
```

## Server-side (Next CMS code / API routes)

```typescript
import {
  createRazorpayOrder,
  verifyRazorpayPayment,
  isRazorpayGatewayConfigured,
} from '@/lib/payments/razorpayGateway';

if (await isRazorpayGatewayConfigured()) {
  const { order, keyId } = await createRazorpayOrder({
    amount: 50000,
    receipt: 'inv-1',
    notes: { source: 'crm' },
  });
}
```

## Permissions

- `payments.configure` — save Razorpay keys
- `payments.create_order` — create orders
- `payments.verify` — verify payments
- `payments.integrate` — create + verify (for plugin integrators)
- `payments.read` — read status/settings

Assign roles via the plugin’s `api/roles.js` or your workspace role manager.

## Amounts

Razorpay expects **smallest currency unit** (e.g. paise for INR). ₹500 = `50000`.
