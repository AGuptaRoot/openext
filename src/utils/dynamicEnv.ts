// utils/dynamicEnv.ts
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

type EnvCache = {
  mtimeMs: number;
  values: Record<string, string>;
};

let cache: EnvCache | null = null;

/** Real process environment (e.g. variables set in the Vercel dashboard). */
function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Environment values for the CMS.
 *
 * Reads the on-disk `.env` (written by the install wizard) and layers it over
 * `process.env`. On hosts without a `.env` file (Vercel, Docker with injected
 * env vars) this falls back to `process.env` instead of returning nothing.
 */
export function getDynamicEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(envPath);
  } catch {
    return processEnv();
  }

  if (!cache || cache.mtimeMs !== stat.mtimeMs) {
    const envContent = fs.readFileSync(envPath);
    cache = { mtimeMs: stat.mtimeMs, values: dotenv.parse(envContent) };
  }

  return { ...processEnv(), ...cache.values };
}
