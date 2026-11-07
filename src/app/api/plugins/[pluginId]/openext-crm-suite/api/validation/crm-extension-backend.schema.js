'use strict';

/**
 * Validation for the `api/` folder of a full CRM workspace extension package.
 *
 *   api/routes.json        REQUIRED when any route is shipped — declares every route
 *                          (method, path, permission, handler "routes/file.js#export")
 *   api/routes/*.js        CommonJS modules exporting the handler functions
 *   api/models/*.json      JSON model schemas (built into Mongoose by the CRM)
 *   api/services/*.js      plain CommonJS helpers
 *   api/index.js           optional: exports register(sdk) / shutdown()
 *
 * Routes and their permissions are declared in JSON, never in code, so the
 * CRM can enforce the permission before the handler runs and the handler
 * cannot opt out. JS files are compiled (syntax only, never executed) and run
 * through a static guardrail scan. This is a guardrail, not a sandbox: the
 * package still needs an admin's approval before the CRM loads it.
 */

const vm = require('vm');
const {
  DECLARATION_FIELD_TYPES,
  CHOICE_FIELD_TYPES,
  KEY_RE,
  normalizeField
} = require('./crm-extension-declarations.schema');

const ROUTES_FILE = 'api/routes.json';
const ENTRY_FILE = 'api/index.js';
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ROUTE_PATH_RE = /^\/[a-z0-9_\-/:.]*$/;
const HANDLER_RE = /^((?:routes|services)\/[a-z0-9_\-/]+\.js)#([A-Za-z_$][\w$]*)$/;
const MODEL_NAME_RE = /^[A-Z][A-Za-z0-9]{1,40}$/;
const MODEL_FIELD_TYPES = [...DECLARATION_FIELD_TYPES, 'json', 'ref'];
const CORE_REF_MODELS = ['Lead', 'Client', 'Opportunity', 'Invoice', 'Project', 'Ticket', 'Quotation', 'SalesOrder', 'Contact'];
const RESERVED_MODEL_FIELDS = new Set(['_id', 'id', 'tenantId', 'extensionId', 'isDeleted', 'deletedAt', 'createdAt', 'updatedAt', '__v']);
const RESERVED_WORDS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_ROUTES = 100;
const MAX_MODELS = 30;
const MAX_MODEL_FIELDS = 100;
const MAX_API_BYTES = 1024 * 1024;
const MAX_JS_FILE_BYTES = 512 * 1024;

/**
 * Static guardrail rules. Each hit is an error with the file and line.
 * Scanned on source with comments and plain string literals blanked out, so
 * a comment saying "never use eval" does not reject the package.
 */
const FORBIDDEN_PATTERNS = [
  { re: /\brequire\s*\.\s*(cache|main|resolve|extensions)\b/, message: 'require.cache / require.resolve are not allowed' },
  { re: /\bmodule\s*\.\s*(constructor|require|parent|children|paths|load)\b/, message: 'module internals are not allowed' },
  { re: /\beval\s*\(/, message: 'eval() is not allowed' },
  { re: /\bnew\s+Function\s*\(/, message: 'new Function() is not allowed' },
  { re: /\bFunction\s*\(\s*['"`]/, message: 'Function() is not allowed' },
  { re: /\bprocess\s*[.[]/, message: 'process.* is not allowed (settings come from sdk.settings)' },
  { re: /\bglobalThis\b/, message: 'globalThis is not allowed' },
  { re: /\bglobal\s*[.[]/, message: 'global.* is not allowed' },
  { re: /\bimport\s*\(/, message: 'dynamic import() is not allowed' },
  { re: /^\s*import\s+[\w{*]/m, message: 'ESM import is not allowed; api/ files are CommonJS' },
  { re: /\b(child_process|worker_threads|node:[a-z_]+)\b/, message: 'Node built-in modules are not available to extensions' },
  { re: /__proto__/, message: '__proto__ is not allowed' },
  { re: /\.\s*constructor\s*[([]/, message: 'constructor access is not allowed' },
  { re: /\bReflect\s*\.\s*(construct|defineProperty|setPrototypeOf)\b/, message: 'Reflect.* mutation is not allowed' },
  { re: /\bObject\s*\.\s*setPrototypeOf\b/, message: 'Object.setPrototypeOf is not allowed' },
  { re: /\bWebAssembly\b/, message: 'WebAssembly is not allowed' },
  { re: /\bdebugger\b/, message: 'debugger statements are not allowed' },
  { re: /\bsetInterval\s*\(/, message: 'setInterval is not allowed; use sdk.jobs' },
  { re: /\bfetch\s*\(/, message: 'fetch() is not allowed; use sdk.http (allow-listed domains)' },
  { re: /\bXMLHttpRequest\b|\bWebSocket\b/, message: 'network globals are not allowed; use sdk.http' },
  { re: /\bBuffer\s*\.\s*allocUnsafe\b/, message: 'Buffer.allocUnsafe is not allowed' }
];

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* ---------------------------------------------------------------- JS scanning */

/**
 * Blank out comments and '…' / "…" string contents, keeping line numbers.
 * Template literals are left intact because `${}` can hold code. Regex
 * literals are not tracked; an unusual regex may cause a false rejection,
 * which is the safe direction.
 */
function blankCommentsAndStrings(code) {
  const out = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') { out.push(' '); i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out.push(code[i] === '\n' ? '\n' : ' '); i += 1; }
      if (i < n) { out.push('  '); i += 2; }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      out.push(ch);
      i += 1;
      while (i < n && code[i] !== ch) {
        if (code[i] === '\\') { out.push(' '); i += 1; if (i < n) { out.push(code[i] === '\n' ? '\n' : ' '); i += 1; } continue; }
        if (code[i] === '\n') break;
        out.push(' ');
        i += 1;
      }
      if (i < n && code[i] === ch) { out.push(ch); i += 1; }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** Resolve a relative require from `fromPath` (e.g. api/routes/a.js) to a package path. */
function resolveRelative(fromPath, request) {
  const parts = fromPath.split('/').slice(0, -1);
  for (const segment of request.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  let resolved = parts.join('/');
  if (!/\.(js|cjs|json)$/.test(resolved)) resolved += '.js';
  return resolved;
}

/**
 * Every require() must be a string literal relative path that resolves to a
 * file inside api/. Uses the blanked text to find real calls (not ones in
 * comments) and the original text to read the literal.
 */
function checkRequires(path, code, blanked, apiFiles) {
  const errors = [];
  const re = /\brequire\s*\(/g;
  let match;
  while ((match = re.exec(blanked))) {
    const line = lineOf(blanked, match.index);
    const rest = code.slice(match.index + match[0].length);
    const literal = /^\s*(['"])([^'"\n]*)\1\s*\)/.exec(rest);
    if (!literal) {
      errors.push(`${path}:${line}: require() must be called with a plain string path`);
      continue;
    }
    const request = literal[2];
    if (!/^\.{1,2}\//.test(request)) {
      errors.push(`${path}:${line}: require("${request}") is not allowed; only relative files inside api/ can be required`);
      continue;
    }
    const target = resolveRelative(path, request);
    if (!target.startsWith('api/')) {
      errors.push(`${path}:${line}: require("${request}") points outside api/`);
    } else if (apiFiles && !apiFiles.has(target)) {
      errors.push(`${path}:${line}: require("${request}") resolves to ${target}, which is not in the package`);
    }
  }
  return errors;
}

/** Compile only (never run) and scan one CommonJS source. Returns error strings. */
function scanJavaScript(path, source, apiFiles) {
  const errors = [];
  const code = source.toString('utf8');
  if (code.length > MAX_JS_FILE_BYTES) errors.push(`${path}: file is larger than ${MAX_JS_FILE_BYTES / 1024} KB`);

  try {
    // Same wrapper Node uses for CommonJS, so top-level `return` and
    // `module`/`exports` references compile. Nothing is executed.
    // eslint-disable-next-line no-new
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {\n${code}\n})`, {
      filename: path
    });
  } catch (error) {
    errors.push(`${path}: syntax error — ${error.message}`);
    return errors;
  }

  const blanked = blankCommentsAndStrings(code);
  errors.push(...checkRequires(path, code, blanked, apiFiles));
  for (const rule of FORBIDDEN_PATTERNS) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    let match;
    let hits = 0;
    while ((match = re.exec(blanked)) && hits < 3) {
      errors.push(`${path}:${lineOf(blanked, match.index)}: ${rule.message}`);
      hits += 1;
      if (!re.global) break;
    }
  }
  return errors;
}

/* ------------------------------------------------------------------- models */

function validateModelFile(path, raw, errors, context) {
  const source = isObject(raw) ? raw : null;
  if (!source) {
    errors.push(`${path} must be a JSON object with "name" and "fields"`);
    return null;
  }
  const name = str(source.name);
  if (!MODEL_NAME_RE.test(name)) errors.push(`${path}: name must be PascalCase, 2–41 characters (e.g. "Contract")`);
  if (CORE_REF_MODELS.includes(name)) errors.push(`${path}: name "${name}" is reserved for a CRM core model`);

  const fieldsRaw = isObject(source.fields)
    ? Object.entries(source.fields).map(([key, def]) => ({ key, ...(isObject(def) ? def : { type: def }) }))
    : Array.isArray(source.fields)
      ? source.fields
      : null;
  if (!fieldsRaw || !fieldsRaw.length) {
    errors.push(`${path}: fields must be a non-empty object or list`);
    return null;
  }
  if (fieldsRaw.length > MAX_MODEL_FIELDS) errors.push(`${path}: more than ${MAX_MODEL_FIELDS} fields`);

  const keys = new Set();
  const fields = fieldsRaw.map((fieldRaw, index) => {
    const def = isObject(fieldRaw) ? fieldRaw : {};
    const rawKey = str(def.key);
    const key = rawKey.toLowerCase();
    const where = `${path}`;
    const reserved = [...RESERVED_MODEL_FIELDS, ...RESERVED_WORDS].some((r) => r.toLowerCase() === key);
    if (reserved) {
      errors.push(`${where}: field "${rawKey}" is reserved and added by the CRM`);
    }
    const type = str(def.type).toLowerCase() || 'text';
    let field;
    if (type === 'json') {
      if (!KEY_RE.test(key)) errors.push(`${where} field ${index + 1}: key "${key}" is invalid`);
      field = { key, label: str(def.label) || key, type: 'json', required: def.required === true, options: [] };
    } else if (type === 'ref') {
      if (!KEY_RE.test(key)) errors.push(`${where} field ${index + 1}: key "${key}" is invalid`);
      const ref = str(def.ref);
      const known = context.modelNames.has(ref) || CORE_REF_MODELS.includes(ref);
      if (!ref || !known) {
        errors.push(`${where}: field "${key}" ref "${ref}" must be a model in this package or one of ${CORE_REF_MODELS.join(', ')}`);
      }
      field = { key, label: str(def.label) || key, type: 'ref', ref, required: def.required === true, options: [] };
    } else {
      field = normalizeField({ ...def, label: str(def.label) || key }, index, where, errors, { allowedTypes: MODEL_FIELD_TYPES });
    }
    if (keys.has(field.key)) errors.push(`${where}: duplicate field "${field.key}"`);
    keys.add(field.key);
    field.index = def.index === true;
    field.unique = def.unique === true;
    field.showInList = def.showInList === true || field.showInList === true;
    return field;
  });

  const titleField = str(source.titleField) || (fields.find((f) => f.type === 'text') || {}).key || '';
  if (titleField && !keys.has(titleField)) errors.push(`${path}: titleField "${titleField}" is not a declared field`);

  return {
    name,
    label: str(source.label) || name,
    pluralLabel: str(source.pluralLabel) || `${str(source.label) || name}s`,
    titleField,
    fields,
    permissions: {
      read: str(isObject(source.permissions) ? source.permissions.read : '') || '',
      write: str(isObject(source.permissions) ? source.permissions.write : '') || ''
    }
  };
}

/* ------------------------------------------------------------------- routes */

function validateRoutesFile(raw, errors, context) {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.routes) ? raw.routes : null;
  if (!list) {
    errors.push(`${ROUTES_FILE} must be a list of routes (or an object with "routes")`);
    return [];
  }
  if (!list.length) errors.push(`${ROUTES_FILE} declares no routes`);
  if (list.length > MAX_ROUTES) errors.push(`${ROUTES_FILE} declares more than ${MAX_ROUTES} routes`);

  const seen = new Set();
  const routes = [];
  list.forEach((routeRaw, index) => {
    const source = isObject(routeRaw) ? routeRaw : {};
    const method = str(source.method).toUpperCase();
    const path = str(source.path);
    const where = `${ROUTES_FILE} route ${index + 1}${method || path ? ` (${method} ${path})` : ''}`;
    if (!HTTP_METHODS.includes(method)) errors.push(`${where}: method must be one of ${HTTP_METHODS.join(', ')}`);
    if (!ROUTE_PATH_RE.test(path) || path.includes('//')) {
      errors.push(`${where}: path must start with "/" and use lowercase letters, numbers, "-", "_", "." or ":params"`);
    }
    if (/^\/x(\/|$)/.test(path)) errors.push(`${where}: paths cannot start with "/x" (reserved)`);
    if (/(^|\/)_/.test(path)) errors.push(`${where}: path segments cannot start with "_" (reserved for /_models and /_settings)`);
    if (path === '/' || !path.split('/').filter(Boolean).length) errors.push(`${where}: path needs at least one segment`);
    if (path.split('/').filter(Boolean).length > 8) errors.push(`${where}: path can have at most 8 segments`);
    if (path.length > 200) errors.push(`${where}: path is longer than 200 characters`);
    const permission = str(source.permission);
    if (!permission) {
      errors.push(`${where}: permission is required (a CRM permission or one this package defines)`);
    } else if (!context.permissionKeys.has(permission)) {
      errors.push(`${where}: permission "${permission}" is not a CRM permission or one this package defines`);
    }
    const handler = str(source.handler);
    const handlerMatch = HANDLER_RE.exec(handler);
    if (!handlerMatch) {
      errors.push(`${where}: handler must look like "routes/contracts.js#list"`);
    } else if (!context.apiFiles.has(`api/${handlerMatch[1]}`)) {
      errors.push(`${where}: handler file api/${handlerMatch[1]} is not in the package`);
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) errors.push(`${where}: duplicate route`);
    seen.add(key);

    routes.push({
      method,
      path,
      permission,
      handler,
      handlerFile: handlerMatch ? `api/${handlerMatch[1]}` : '',
      handlerExport: handlerMatch ? handlerMatch[2] : '',
      summary: str(source.summary).slice(0, 160),
      timeoutMs: Number.isInteger(source.timeoutMs) && source.timeoutMs > 0 ? Math.min(source.timeoutMs, 30000) : 10000
    });
  });
  return routes;
}

/* ------------------------------------------------------------------- entry */

/**
 * Validate everything under `api/`.
 *
 * @param {Map<string, Buffer>} files         every package file by relative path (all areas)
 * @param {object} context
 * @param {Set<string>} context.permissionKeys CRM permission keys plus the ones this package defines
 * @param {string} context.entryApi            manifest `entry.api` (default api/index.js) or ''
 * @param {(text: string, label: string, errors: string[]) => any} context.parseJson
 */
function validateBackend(files, context) {
  const errors = [];
  const warnings = [];
  const apiFiles = new Map([...files.entries()].filter(([path]) => path.startsWith('api/')));
  if (!apiFiles.size) {
    return { errors, warnings, backend: null };
  }

  let totalBytes = 0;
  for (const data of apiFiles.values()) totalBytes += data.length;
  if (totalBytes > MAX_API_BYTES) errors.push(`api/ is larger than ${MAX_API_BYTES / 1024} KB`);

  // Folder discipline.
  for (const path of apiFiles.keys()) {
    const rel = path.slice(4);
    if (rel.startsWith('migrations/')) {
      errors.push(`${path}: migrations are not supported by this CRM version; remove api/migrations/`);
    } else if (rel.startsWith('models/') && rel.endsWith('.js')) {
      errors.push(`${path}: JavaScript model factories are not supported; declare the model in api/models/<Name>.json`);
    } else if (!/^(index\.js|routes\.json|routes\/[^/]+\.js|services\/[^/]+\.js|models\/[^/]+\.json|package\.json|README\.md)$/.test(rel)) {
      errors.push(`${path}: unexpected file; api/ may hold index.js, routes.json, routes/*.js, services/*.js and models/*.json`);
    }
  }

  // Models first so routes.json and tabs can reference them.
  const modelNames = new Set();
  const modelFiles = [...apiFiles.keys()].filter((p) => /^api\/models\/[^/]+\.json$/.test(p)).sort();
  if (modelFiles.length > MAX_MODELS) errors.push(`api/models/ has more than ${MAX_MODELS} models`);
  const parsedModels = [];
  for (const path of modelFiles) {
    const raw = context.parseJson(apiFiles.get(path).toString('utf8').replace(/^﻿/, ''), path, errors);
    if (raw && isObject(raw) && MODEL_NAME_RE.test(str(raw.name))) modelNames.add(str(raw.name));
    parsedModels.push([path, raw]);
  }
  const models = [];
  for (const [path, raw] of parsedModels) {
    if (raw === null) continue;
    const model = validateModelFile(path, raw, errors, { modelNames });
    if (model) {
      if (models.some((m) => m.name === model.name)) errors.push(`${path}: duplicate model name "${model.name}"`);
      for (const perm of [model.permissions.read, model.permissions.write]) {
        if (perm && !context.permissionKeys.has(perm)) {
          errors.push(`${path}: permission "${perm}" is not a CRM permission or one this package defines`);
        }
      }
      models.push(model);
    }
  }

  // Routes.
  const jsFiles = [...apiFiles.keys()].filter((p) => p.endsWith('.js')).sort();
  const hasRoutesJson = apiFiles.has(ROUTES_FILE);
  const hasRouteModules = jsFiles.some((p) => p.startsWith('api/routes/'));
  let routes = [];
  if (hasRoutesJson) {
    const raw = context.parseJson(apiFiles.get(ROUTES_FILE).toString('utf8').replace(/^﻿/, ''), ROUTES_FILE, errors);
    if (raw !== null) routes = validateRoutesFile(raw, errors, { permissionKeys: context.permissionKeys, apiFiles });
  } else if (hasRouteModules) {
    errors.push(`${ROUTES_FILE} is required when api/routes/ modules are shipped`);
  }
  for (const path of jsFiles.filter((p) => p.startsWith('api/routes/'))) {
    if (!routes.some((r) => r.handlerFile === path)) warnings.push(`${path} is not referenced by any route in ${ROUTES_FILE}`);
  }

  // Entry.
  const entryApi = context.entryApi || (apiFiles.has(ENTRY_FILE) ? ENTRY_FILE : '');
  if (entryApi && !apiFiles.has(entryApi)) errors.push(`entry.api "${entryApi}" is not in the package`);
  if (entryApi && !entryApi.endsWith('.js')) errors.push(`entry.api must be a .js file`);

  // Compile + scan every JS file.
  for (const path of jsFiles) {
    const code = apiFiles.get(path);
    for (const message of scanJavaScript(path, code, apiFiles)) errors.push(message);
    const text = code.toString('utf8');
    if (!/\b(module\.exports|exports\.[A-Za-z_$])/.test(text)) {
      errors.push(`${path}: must be CommonJS and export something (module.exports / exports.name)`);
    }
  }

  const requiresTrust = jsFiles.length > 0;
  if (!requiresTrust && !models.length) warnings.push('api/ contains no models or code');

  return {
    errors,
    warnings,
    backend: {
      entry: entryApi,
      routes,
      models,
      files: [...apiFiles.keys()].sort(),
      jsFiles,
      totalBytes,
      requiresTrust
    }
  };
}

module.exports = {
  ROUTES_FILE,
  ENTRY_FILE,
  HTTP_METHODS,
  CORE_REF_MODELS,
  MODEL_FIELD_TYPES,
  CHOICE_FIELD_TYPES,
  FORBIDDEN_PATTERNS,
  blankCommentsAndStrings,
  scanJavaScript,
  resolveRelative,
  validateModelFile,
  validateRoutesFile,
  validateBackend
};
