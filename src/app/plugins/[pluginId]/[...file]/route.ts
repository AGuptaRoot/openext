import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import { hasBlockedExtension, isSafeRelativePath } from '@/lib/plugins/manifest';
import { getPluginDirectory } from '@/lib/plugins/storage';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // text/javascript is preferred for browser ES module dynamic import()
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{1,62}[a-z0-9]$/;

/**
 * Bundler output under an `assets/` folder whose name carries a content hash
 * (e.g. `assets/index-COhsltjI.js`): a new build gets a new name, so the file can be
 * cached for good. Every other file (mount.js, index.html, ...) keeps its name across
 * versions and is revalidated on each load instead.
 */
const HASHED_ASSET_PATTERN = /(^|\/)assets\/[^/]*-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

function isPathInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pluginId: string; file: string[] }> }
) {
  const { pluginId, file } = await params;
  const relativePath = file.join('/');

  if (
    !PLUGIN_ID_PATTERN.test(pluginId) ||
    !isSafeRelativePath(relativePath) ||
    hasBlockedExtension(relativePath)
  ) {
    return NextResponse.json({ message: 'Invalid plugin asset path' }, { status: 400 });
  }

  const pluginDir = getPluginDirectory(pluginId);
  const assetPath = path.join(pluginDir, relativePath);

  if (!isPathInside(pluginDir, assetPath)) {
    return NextResponse.json({ message: 'Invalid plugin asset path' }, { status: 400 });
  }

  try {
    const fileBuffer = await fs.readFile(assetPath);
    const ext = path.extname(assetPath).toLowerCase();
    // From the content, not the file time: deployed files can all share one timestamp.
    const etag = `"${createHash('sha1').update(fileBuffer).digest('base64url')}"`;
    const headers = {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': HASHED_ASSET_PATTERN.test(relativePath)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      ETag: etag,
    };

    // Unchanged since the browser's copy: answer without the body (the CRM bundle is ~5 MB).
    const ifNoneMatch = request.headers.get('if-none-match');
    // Proxies that compress the response (Railway, Vercel) may weaken the tag to W/"…".
    if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      return new NextResponse(null, { status: 304, headers });
    }

    return new NextResponse(new Uint8Array(fileBuffer), { headers });
  } catch {
    return NextResponse.json({ message: 'Plugin asset not found' }, { status: 404 });
  }
}
