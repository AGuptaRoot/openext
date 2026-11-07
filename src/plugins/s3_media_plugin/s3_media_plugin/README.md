# S3 Media Storage Plugin

Stores **all media uploaded through this plugin in Amazon S3** once AWS credentials are configured. Nothing is written to the local server disk.

## Setup

1. Install and activate the plugin in NextCMS.
2. Open **Dashboard → Settings → Config → AWS S3 Media Storage**.
3. Enter:
   - S3 bucket name **or** Access Point ARN
   - AWS region
   - Access key ID + secret access key
   - Optional: custom endpoint, object prefix, public/CDN URL base
4. Save and run **Test connection**.

When configuration succeeds, the plugin admin page shows **Active storage: Amazon S3**.

## Behavior

| State | What happens |
| --- | --- |
| Credentials **not** saved | Uploads are rejected (no local fallback) |
| Credentials **saved** | Every upload goes to your S3 bucket / Access Point only |

- Durable URLs use `publicUrlBase` (or the default S3/Access Point URL) — temporary signed URLs are for preview only.
- Credentials are encrypted at rest when possible.
- Optional folder segments are stored under your configured prefix (e.g. `nextcms-media/gallery/...`).

## Plugin API

Base path: `/api/plugins/s3_media_plugin`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/settings` | Public config + storage status |
| `GET` | `/settings/status` | Whether storage mode is `s3` |
| `PUT` | `/settings` | Save AWS credentials |
| `POST` | `/settings/test` | Test connection |
| `GET` | `/media` | List objects (`?imagesOnly=false` for all files) |
| `POST` | `/media/upload` | Upload any file to S3 |
| `POST` | `/media/upload-buffer` | Upload base64 payload to S3 |
| `GET` | `/media/:encodedKey/file` | Stream object from S3 |
| `DELETE` | `/media/:encodedKey` | Delete object from S3 |

### Upload example

```http
POST /api/plugins/s3_media_plugin/media/upload
Content-Type: multipart/form-data

file=<binary>
folder=gallery
```

Response includes durable `url` / `filePath` pointing at S3 (or your CDN base).

## Storage provider for other plugins (1.7.0)

Other plugins (e.g. the OpenNext CRM) store their private files in this plugin's bucket on the server,
through `api/storage-provider.js` — not through the HTTP routes and without ever reading the AWS keys:

| Call | Purpose |
| --- | --- |
| `status(cms)` | `{ configured, bucket, region, usesAccessPoint }` (never keys) |
| `put(cms, key, buffer, contentType)` | Store bytes under the caller's key (private, `no-store`) |
| `get(cms, key)` | `{ buffer, contentType, contentLength }` |
| `remove(cms, key)` | Delete the object |

Keys must be outside this plugin's media prefix (e.g. `crm-private/...`), so private files never appear
in the media gallery and no public URL is made for them.

## Permissions

- `s3.read` — list / download
- `s3.write` — upload / delete
- `s3.configure` — save credentials
