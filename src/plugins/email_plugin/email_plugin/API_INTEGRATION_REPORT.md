# Email Service Plugin — API Integration Report & Technical Guide

This document serves as the comprehensive technical specification and integration manual for the **Email Service Plugin** in OpenNext CMS. It provides full API documentation, authentication details, request/response payloads, multi-language code samples, and troubleshooting procedures for sending emails via API.

---

## 📋 Executive Summary

The Email Service Plugin enables OpenNext CMS applications and external clients to configure SMTP settings, transmit transactional HTML/plain-text emails via API endpoints, test mail server connectivity, and audit email logs stored in MongoDB.

### Key Capabilities
- **Transactional Mail Delivery**: Send plain-text or rich HTML emails via `POST /mail/send`.
- **Dynamic SMTP Configuration**: Securely manage SMTP server details, authentication credentials, default sender name/address, and default recipient.
- **Connection Diagnostics**: Live SMTP handshake verification (`POST /settings/test`).
- **Audit Logging**: Automatic tracking of email statuses (`sent` or `failed`), body previews, timestamps, error messages, and sender identities.

---

## 🔒 Authentication & Authorization

All endpoints in this plugin require an authenticated session or valid API bearer token attached to the incoming Express request (`req.user`). Access is restricted using permission badges.

### Required Permissions

| Endpoint | Method | Required Permission | Description |
| :--- | :--- | :--- | :--- |
| `/mail/send` | `POST` | `email.send` | Trigger email sending via SMTP |
| `/settings` | `GET` | `email.read` | View public SMTP configuration status |
| `/settings` | `PUT` | `email.configure` | Update SMTP settings and test connection |
| `/settings/test` | `POST` | `email.configure` | Test SMTP credentials |
| `/mail/logs` | `GET` | `email.read` | View email delivery logs |
| `/mail/logs/:id` | `DELETE` | `email.configure` | Delete a specific email log record |

> [!NOTE]
> Users with Administrator role (`req.user.role <= 1`) automatically bypass permission checks and have full access to all endpoints.

---

## 📡 API Endpoint Reference

### 1. Send Email

Sends an email using the stored SMTP configuration.

- **URL**: `/mail/send`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`, `Authorization: Bearer <token>`
- **Required Permission**: `email.send`

#### Request Payload Schema

```json
{
  "to": "recipient@example.com",
  "subject": "Notification Subject",
  "text": "Plain text content of the email",
  "html": "<h1>HTML Content</h1><p>Rich text message body.</p>"
}
```

#### Field Details

| Field | Type | Required? | Description |
| :--- | :--- | :--- | :--- |
| `to` | `string` | Optional* | Recipient email address. If omitted, defaults to configured `recipientEmail`. |
| `subject` | `string` | **Yes** | Subject line of the email. |
| `text` | `string` | Optional** | Plain text body of the email. |
| `html` | `string` | Optional** | HTML body of the email. |

*\* If no `recipientEmail` is set in the plugin configuration, `to` is mandatory.*  
*\*\* At least one of `text` or `html` must be provided.*

#### Response Examples

##### Success (`201 Created`)
```json
{
  "success": true,
  "message": "Email sent successfully",
  "messageId": "<c54b2a8d-19df-8b21-4f10-91283abc4567@example.com>",
  "logId": "65c3e981f21a4b2c12a89001"
}
```

##### Error: SMTP Not Configured (`400 Bad Request`)
```json
{
  "message": "SMTP is not configured. Open SMTP Settings and save your mail server credentials first."
}
```

##### Error: Invalid Recipient (`400 Bad Request`)
```json
{
  "message": "Recipient email is not a valid email address."
}
```

##### Error: Missing Permissions (`403 Forbidden`)
```json
{
  "message": "Missing permission: email.send"
}
```

---

### 2. Get SMTP Settings

Fetches public SMTP configuration state (passwords and credentials are automatically sanitized).

- **URL**: `/settings`
- **Method**: `GET`
- **Required Permission**: `email.read`

#### Response Example (`200 OK`)
```json
{
  "settings": {
    "host": "smtp.mailtrap.io",
    "port": 587,
    "secure": false,
    "fromName": "App Support",
    "fromEmail": "support@example.com",
    "recipientEmail": "admin@example.com",
    "replyTo": "no-reply@example.com",
    "hasCredentials": true,
    "isConfigured": true,
    "userPreview": "su…io"
  }
}
```

---

### 3. Update SMTP Settings

Updates the SMTP credentials and tests the connection immediately.

- **URL**: `/settings`
- **Method**: `PUT`
- **Headers**: `Content-Type: application/json`
- **Required Permission**: `email.configure`

#### Request Payload Schema

```json
{
  "host": "smtp.gmail.com",
  "port": 587,
  "secure": false,
  "user": "your-email@gmail.com",
  "password": "your-app-password",
  "fromName": "Marketing Team",
  "fromEmail": "marketing@example.com",
  "recipientEmail": "leads@example.com",
  "replyTo": "support@example.com"
}
```

#### Response Example (`200 OK`)
```json
{
  "settings": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "fromName": "Marketing Team",
    "fromEmail": "marketing@example.com",
    "recipientEmail": "leads@example.com",
    "replyTo": "support@example.com",
    "hasCredentials": true,
    "isConfigured": true,
    "userPreview": "yo…om"
  },
  "connection": {
    "ok": true,
    "message": "SMTP connection verified successfully."
  },
  "message": "SMTP settings saved and connection verified"
}
```

---

### 4. Test SMTP Connection

Tests connection parameters without requiring saved configuration.

- **URL**: `/settings/test`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **Required Permission**: `email.configure`

#### Request Payload Schema (Optional Overrides)

```json
{
  "useSaved": true,
  "host": "smtp.mailgun.org",
  "port": 587,
  "user": "postmaster@mg.example.com",
  "password": "secretpassword"
}
```

#### Response Example (`200 OK`)
```json
{
  "connection": {
    "ok": true,
    "message": "SMTP connection verified successfully."
  }
}
```

---

### 5. Fetch Email Logs

Lists historical email send logs with pagination limits.

- **URL**: `/mail/logs?limit=20`
- **Method**: `GET`
- **Query Parameters**: `limit` (integer, optional, min: 1, max: 200, default: 50)
- **Required Permission**: `email.read`

#### Response Example (`200 OK`)
```json
{
  "logs": [
    {
      "id": "65c3e981f21a4b2c12a89001",
      "to": "user@example.com",
      "subject": "Welcome to our Service!",
      "status": "sent",
      "error": "",
      "bodyPreview": "Welcome to our Service! Thank you for joining...",
      "sentBy": "admin@example.com",
      "createdAt": "2026-08-12T14:55:00.000Z"
    },
    {
      "id": "65c3e800f21a4b2c12a88999",
      "to": "invalid-address",
      "status": "failed",
      "error": "Recipient email is not a valid email address.",
      "bodyPreview": "Test mail...",
      "sentBy": "system@example.com",
      "createdAt": "2026-08-12T14:50:00.000Z"
    }
  ]
}
```

---

### 6. Delete Email Log

Deletes an audit log entry by ID.

- **URL**: `/mail/logs/:id`
- **Method**: `DELETE`
- **Required Permission**: `email.configure`

#### Response Examples
- **Success (`200 OK`)**: `{ "message": "Log entry deleted" }`
- **Not Found (`404 Not Found`)**: `{ "message": "Log entry not found" }`

---

## 💻 Integration Code Examples

### 1. cURL Command

```bash
curl -X POST "https://your-cms-domain.com/mail/send" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -d '{
    "to": "client@example.com",
    "subject": "Order Confirmation #1094",
    "html": "<h2>Thank you for your order!</h2><p>Your order #1094 has been shipped.</p>",
    "text": "Thank you for your order! Your order #1094 has been shipped."
  }'
```

---

### 2. JavaScript / Node.js (Fetch API)

```javascript
async function sendNotificationEmail(recipient, subject, contentHtml) {
  const endpoint = 'https://your-cms-domain.com/mail/send';
  const token = process.env.CMS_API_TOKEN;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: recipient,
      subject: subject,
      html: contentHtml,
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`Email delivery failed: ${result.message}`);
  }

  console.log('Email sent! Message ID:', result.messageId, 'Log ID:', result.logId);
  return result;
}

// Usage Example
sendNotificationEmail(
  'customer@example.com',
  'Welcome to the Platform',
  '<h1>Welcome!</h1><p>We are glad to have you on board.</p>'
).catch(console.error);
```

---

### 3. TypeScript Integration

```typescript
interface SendMailPayload {
  to?: string;
  subject: string;
  text?: string;
  html?: string;
}

interface SendMailResponse {
  success: boolean;
  message: string;
  messageId: string;
  logId: string;
}

interface ErrorResponse {
  message: string;
}

export async function sendEmail(
  baseUrl: string,
  authToken: string,
  payload: SendMailPayload
): Promise<SendMailResponse> {
  const res = await fetch(`${baseUrl}/mail/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorData = (await res.json()) as ErrorResponse;
    throw new Error(`Email Plugin API Error [${res.status}]: ${errorData.message}`);
  }

  return (await res.json()) as SendMailResponse;
}
```

---

### 4. Python Integration (`requests`)

```python
import requests

def send_email(cms_url, auth_token, recipient, subject, html_body, text_body=None):
    url = f"{cms_url.rstrip('/')}/mail/send"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {auth_token}"
    }
    payload = {
        "to": recipient,
        "subject": subject,
        "html": html_body,
    }
    if text_body:
        payload["text"] = text_body

    response = requests.post(url, json=payload, headers=headers)
    
    if response.status_code == 201:
        data = response.json()
        print(f"Email sent successfully! Log ID: {data.get('logId')}")
        return data
    else:
        error_msg = response.json().get('message', 'Unknown error')
        raise Exception(f"Failed to send email ({response.status_code}): {error_msg}")

# Usage Example
if __name__ == "__main__":
    send_email(
        cms_url="https://your-cms-domain.com",
        auth_token="YOUR_API_TOKEN",
        recipient="user@example.com",
        subject="Password Reset Request",
        html_body="<p>Click <a href='https://example.com/reset'>here</a> to reset your password.</p>"
    )
```

---

## 🗄️ Database Schemas Reference

### 1. `EmailConfig` Schema
Stores SMTP settings in MongoDB.

```javascript
{
  host: { type: String, default: '', trim: true },
  port: { type: Number, default: 587 },
  secure: { type: Boolean, default: false },
  user: { type: String, default: '', trim: true },
  password: { type: String, default: '', trim: true },
  fromName: { type: String, default: '', trim: true },
  fromEmail: { type: String, default: '', trim: true },
  recipientEmail: { type: String, default: '', trim: true },
  replyTo: { type: String, default: '', trim: true },
  createdAt: Date,
  updatedAt: Date
}
```

### 2. `EmailLog` Schema
Stores historical records of sent and failed emails. Index on `createdAt: -1`.

```javascript
{
  to: { type: String, required: true, trim: true },
  subject: { type: String, default: '', trim: true },
  status: { type: String, enum: ['sent', 'failed'], required: true },
  error: { type: String, default: '' },
  bodyPreview: { type: String, default: '' },
  sentBy: { type: String, default: '' },
  createdAt: Date,
  updatedAt: Date
}
```

---

## 🔄 End-to-End Workflow Checklist

1. **Step 1: Check Configuration**  
   Call `GET /settings` to confirm `isConfigured: true`.
2. **Step 2: Save Credentials (if needed)**  
   If not configured, call `PUT /settings` with SMTP server credentials.
3. **Step 3: Verify Transport**  
   Call `POST /settings/test` to verify connection to the mail host.
4. **Step 4: Dispatch Email**  
   Call `POST /mail/send` with `to`, `subject`, and `html`/`text`.
5. **Step 5: Verify Delivery Log**  
   Call `GET /mail/logs?limit=5` to verify log status is `sent`.

---

## 🛠️ Troubleshooting & Error Matrix

| HTTP Status | Reason | Resolution |
| :--- | :--- | :--- |
| `400 Bad Request` | `"SMTP is not configured..."` | Set host, port, user, password, and fromEmail via `PUT /settings` first. |
| `400 Bad Request` | `"Recipient email is required."` | Include `"to": "email@domain.com"` in payload or set `recipientEmail` in settings. |
| `400 Bad Request` | `"Subject is required."` | Provide a non-empty `subject` string in request body. |
| `400 Bad Request` | `"Email body is required (plain text or HTML)."` | Supply at least one of `text` or `html` parameters. |
| `400 Bad Request` | `"Invalid login: 535 5.7.8 Error..."` | SMTP user/password is invalid or app-specific password is required (e.g. Gmail). |
| `403 Forbidden` | `"Missing permission: email.send"` | Assign `email.send` permission to the user role or use an Admin account. |
| `500 Server Error` | `"nodemailer is not installed"` | Run `npm install nodemailer` in the CMS root project. |

---

*Document version: 1.0.0 | Generated for Email Service Plugin v1.0.1*
