'use strict';

/**
 * In-memory CommonJS loader for an approved extension's `api/` folder.
 *
 * Files come from the verified extension folder (package-folder.js); they are
 * compiled in memory, never required from disk with Node's loader.
 *
 * Each package gets its own vm context:
 *   - code generation from strings is disabled (eval, new Function throw),
 *   - only a few harmless globals exist (console → logger, timers, URL, …),
 *   - `require` resolves only to files of the same package under api/,
 *   - `module`, `exports` and `require` are created inside the context, so
 *     their constructors are the context's own (disabled) Function,
 *   - module top-level code runs with a synchronous time limit.
 *
 * This is a guardrail, not a security boundary: the SDK object comes from the
 * host realm. The real control is the admin's approval of the exact checksum,
 * plus the static scan done at upload.
 */

const vm = require('vm');
const { resolveRelative } = require('../validation/crm-extension-backend.schema');

const MODULE_TIMEOUT_MS = 2000;

function sandboxError(message, code = 'EXTENSION_LOAD_FAILED') {
  const error = new Error(message);
  error.status = 503;
  error.code = code;
  error.isRuntimeError = true; // message is safe to show to the admin
  return error;
}

function createContext(logger, extensionId) {
  const tag = `[crm-ext:${extensionId}]`;
  const fmt = (args) =>
    args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ')
      .slice(0, 2000);
  const safeConsole = {
    log: (...args) => logger.info(`${tag} ${fmt(args)}`),
    info: (...args) => logger.info(`${tag} ${fmt(args)}`),
    warn: (...args) => logger.warn(`${tag} ${fmt(args)}`),
    error: (...args) => logger.error(`${tag} ${fmt(args)}`)
  };
  const timers = new Set();
  const sandboxGlobals = {
    console: safeConsole,
    setTimeout: (fn, ms, ...rest) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        try { fn(...rest); } catch (error) { safeConsole.error('timer error:', error && error.message); }
      }, Math.min(Math.max(Number(ms) || 0, 0), 30000));
      timers.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
      clearTimeout(handle);
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder
  };
  const context = vm.createContext(sandboxGlobals, {
    name: `crm-extension:${extensionId}`,
    codeGeneration: { strings: false, wasm: false }
  });
  return { context, timers };
}

/**
 * @param {object} opts
 * @param {string} opts.extensionId
 * @param {Map<string, Buffer>} opts.files   api/ files by package path (e.g. "api/routes/a.js")
 * @param {{ info: Function, warn: Function, error: Function }} opts.logger
 * @returns {{ require: (path: string) => any, toContext: (value: any) => any, dispose: () => void }}
 */
function createPackageRuntime({ extensionId, files, logger }) {
  const { context, timers } = createContext(logger, extensionId);
  const cache = new Map();
  const loading = new Set();

  /*
   * Isolation rule: extension code must never hold an object, function,
   * promise or error created in the CRM's own realm. Any such value leads back
   * to the CRM's Function constructor (value.constructor.constructor) and from
   * there to `process` and the whole database. Everything handed to the
   * extension is therefore built inside the context by the factories below:
   * values cross as JSON text, errors cross as { message, status, code }.
   */
  const toText = (value, isError) => {
    if (isError) {
      const e = value && typeof value === 'object' ? value : { message: String(value) };
      return JSON.stringify({
        message: String(e.message || 'Extension error').slice(0, 500),
        status: Number(e.status) || undefined,
        code: e.code ? String(e.code).slice(0, 60) : undefined,
        details: Array.isArray(e.details) ? e.details.map(String).slice(0, 20) : undefined,
        isRuntimeError: Boolean(e.isRuntimeError)
      });
    }
    if (value === undefined) return undefined;
    const text = JSON.stringify(value);
    if (text !== undefined && text.length > 4 * 1024 * 1024) {
      throw sandboxError('A value handed to the extension is larger than 4 MB', 'PAYLOAD_TOO_LARGE');
    }
    return text;
  };
  const isThenable = (value) => Boolean(value) && typeof value.then === 'function';

  const factories = vm.runInContext(
    `(function (toText, isThenable) {
      'use strict';
      const parse = (t) => (t === undefined ? undefined : JSON.parse(t));
      const rebuild = (t) => {
        const info = JSON.parse(t);
        const error = new Error(info.message);
        if (info.status) error.status = info.status;
        if (info.code) error.code = info.code;
        if (info.details) error.details = info.details;
        if (info.isRuntimeError) error.isRuntimeError = true;
        return error;
      };
      // Every hand-off is inside try/catch: a host error object is only ever
      // passed to toText (host side), never returned or thrown to the extension.
      function wrapFn(host) {
        return function () {
          let result;
          try {
            result = host.apply(undefined, arguments);
          } catch (e) {
            throw rebuild(toText(e, true));
          }
          if (isThenable(result)) {
            return (async function () {
              let text;
              try {
                text = toText(await result);
              } catch (e) {
                throw rebuild(toText(e, true));
              }
              return parse(text);
            })();
          }
          let text;
          try {
            text = toText(result);
          } catch (e) {
            throw rebuild(toText(e, true));
          }
          return parse(text);
        };
      }
      return {
        wrapFn: wrapFn,
        object: function () { return {}; },
        freeze: function (o) { return Object.freeze(o); },
        module: function () { return { exports: {} }; },
        parse: parse,
        makeError: function (status, message, code) {
          const error = new Error(String(message));
          error.status = status;
          if (code) error.code = String(code);
          error.isRuntimeError = true;
          return error;
        },
        requireFor: function (host) {
          return function require(p) {
            try {
              return host(String(p));
            } catch (e) {
              throw rebuild(toText(e, true));
            }
          };
        }
      };
    })`,
    context
  )(toText, isThenable);

  const makeRequire = factories.requireFor;
  const makeModule = factories.module;
  const parseInContext = (text) => factories.parse(text);

  /**
   * Rebuild a host value (the SDK) inside the context: plain data is copied as
   * JSON, functions become context functions that call the host one and copy
   * results and errors back across. `sdk.error` gets a context-native builder.
   */
  function wrapHost(value, pathKey = '') {
    if (typeof value === 'function') return factories.wrapFn(value);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return parseInContext(JSON.stringify(value));
    const out = factories.object();
    for (const [key, member] of Object.entries(value)) {
      const childKey = pathKey ? `${pathKey}.${key}` : key;
      if (childKey === 'error' && typeof member === 'function') {
        out[key] = factories.makeError;
      } else {
        out[key] = wrapHost(member, childKey);
      }
    }
    return factories.freeze(out);
  }

  function load(path) {
    if (cache.has(path)) return cache.get(path).exports;
    if (!files.has(path)) throw sandboxError(`${path} is not part of the package`);
    if (loading.has(path)) {
      // Circular require: hand back the partial exports, as Node does.
      return cache.get(path)?.exports;
    }

    const source = files.get(path).toString('utf8');
    if (path.endsWith('.json')) {
      const value = parseInContext(source);
      cache.set(path, { exports: value });
      return value;
    }

    const module = makeModule();
    cache.set(path, module);
    loading.add(path);
    try {
      const requireFn = makeRequire((request) => {
        if (!/^\.{1,2}\//.test(request)) throw sandboxError(`require("${request}") is not allowed in extensions`, 'REQUIRE_BLOCKED');
        const target = resolveRelative(path, request);
        if (!target.startsWith('api/')) throw sandboxError(`require("${request}") points outside api/`, 'REQUIRE_BLOCKED');
        return load(target);
      });
      const dirname = path.split('/').slice(0, -1).join('/');
      context.__crmExt = { module, require: requireFn, filename: path, dirname };
      const script = new vm.Script(
        `(function (exports, require, module, __filename, __dirname) {${source}\n}).call(` +
          '__crmExt.module.exports, __crmExt.module.exports, __crmExt.require, __crmExt.module, __crmExt.filename, __crmExt.dirname)',
        { filename: `crm-ext://${extensionId}/${path}` }
      );
      script.runInContext(context, { timeout: MODULE_TIMEOUT_MS, breakOnSigint: false });
    } catch (error) {
      cache.delete(path);
      if (error && error.code && String(error.code).startsWith('ERR_SCRIPT_EXECUTION_TIMEOUT')) {
        throw sandboxError(`${path} took longer than ${MODULE_TIMEOUT_MS} ms to load`, 'EXTENSION_LOAD_TIMEOUT');
      }
      throw error && error.status ? error : sandboxError(`${path} failed to load: ${(error && error.message) || error}`);
    } finally {
      delete context.__crmExt;
      loading.delete(path);
    }
    return module.exports;
  }

  return {
    require: load,
    /** Copy a JSON-safe value into the context (so its prototypes are the context's). */
    toContext(value) {
      return value === undefined ? undefined : parseInContext(JSON.stringify(value));
    },
    /** The SDK (or any host object) rebuilt inside the context; see the isolation rule above. */
    wrapHost(value) {
      return wrapHost(value);
    },
    dispose() {
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
      cache.clear();
    }
  };
}

module.exports = { createPackageRuntime, MODULE_TIMEOUT_MS };
