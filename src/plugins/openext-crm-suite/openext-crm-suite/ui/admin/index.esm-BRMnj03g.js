const he = () => {
};
/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const Y = function(t) {
  const e = [];
  let n = 0;
  for (let r = 0; r < t.length; r++) {
    let s = t.charCodeAt(r);
    s < 128 ? e[n++] = s : s < 2048 ? (e[n++] = s >> 6 | 192, e[n++] = s & 63 | 128) : (s & 64512) === 55296 && r + 1 < t.length && (t.charCodeAt(r + 1) & 64512) === 56320 ? (s = 65536 + ((s & 1023) << 10) + (t.charCodeAt(++r) & 1023), e[n++] = s >> 18 | 240, e[n++] = s >> 12 & 63 | 128, e[n++] = s >> 6 & 63 | 128, e[n++] = s & 63 | 128) : (e[n++] = s >> 12 | 224, e[n++] = s >> 6 & 63 | 128, e[n++] = s & 63 | 128);
  }
  return e;
}, fe = function(t) {
  const e = [];
  let n = 0, r = 0;
  for (; n < t.length; ) {
    const s = t[n++];
    if (s < 128)
      e[r++] = String.fromCharCode(s);
    else if (s > 191 && s < 224) {
      const i = t[n++];
      e[r++] = String.fromCharCode((s & 31) << 6 | i & 63);
    } else if (s > 239 && s < 365) {
      const i = t[n++], a = t[n++], c = t[n++], o = ((s & 7) << 18 | (i & 63) << 12 | (a & 63) << 6 | c & 63) - 65536;
      e[r++] = String.fromCharCode(55296 + (o >> 10)), e[r++] = String.fromCharCode(56320 + (o & 1023));
    } else {
      const i = t[n++], a = t[n++];
      e[r++] = String.fromCharCode((s & 15) << 12 | (i & 63) << 6 | a & 63);
    }
  }
  return e.join("");
}, X = {
  /**
   * Maps bytes to characters.
   */
  byteToCharMap_: null,
  /**
   * Maps characters to bytes.
   */
  charToByteMap_: null,
  /**
   * Maps bytes to websafe characters.
   * @private
   */
  byteToCharMapWebSafe_: null,
  /**
   * Maps websafe characters to bytes.
   * @private
   */
  charToByteMapWebSafe_: null,
  /**
   * Our default alphabet, shared between
   * ENCODED_VALS and ENCODED_VALS_WEBSAFE
   */
  ENCODED_VALS_BASE: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  /**
   * Our default alphabet. Value 64 (=) is special; it means "nothing."
   */
  get ENCODED_VALS() {
    return this.ENCODED_VALS_BASE + "+/=";
  },
  /**
   * Our websafe alphabet.
   */
  get ENCODED_VALS_WEBSAFE() {
    return this.ENCODED_VALS_BASE + "-_.";
  },
  /**
   * Whether this browser supports the atob and btoa functions. This extension
   * started at Mozilla but is now implemented by many browsers. We use the
   * ASSUME_* variables to avoid pulling in the full useragent detection library
   * but still allowing the standard per-browser compilations.
   *
   */
  HAS_NATIVE_SUPPORT: typeof atob == "function",
  /**
   * Base64-encode an array of bytes.
   *
   * @param input An array of bytes (numbers with
   *     value in [0, 255]) to encode.
   * @param webSafe Boolean indicating we should use the
   *     alternative alphabet.
   * @return The base64 encoded string.
   */
  encodeByteArray(t, e) {
    if (!Array.isArray(t))
      throw Error("encodeByteArray takes an array as a parameter");
    this.init_();
    const n = e ? this.byteToCharMapWebSafe_ : this.byteToCharMap_, r = [];
    for (let s = 0; s < t.length; s += 3) {
      const i = t[s], a = s + 1 < t.length, c = a ? t[s + 1] : 0, o = s + 2 < t.length, h = o ? t[s + 2] : 0, b = i >> 2, p = (i & 3) << 4 | c >> 4;
      let y = (c & 15) << 2 | h >> 6, S = h & 63;
      o || (S = 64, a || (y = 64)), r.push(n[b], n[p], n[y], n[S]);
    }
    return r.join("");
  },
  /**
   * Base64-encode a string.
   *
   * @param input A string to encode.
   * @param webSafe If true, we should use the
   *     alternative alphabet.
   * @return The base64 encoded string.
   */
  encodeString(t, e) {
    return this.HAS_NATIVE_SUPPORT && !e ? btoa(t) : this.encodeByteArray(Y(t), e);
  },
  /**
   * Base64-decode a string.
   *
   * @param input to decode.
   * @param webSafe True if we should use the
   *     alternative alphabet.
   * @return string representing the decoded value.
   */
  decodeString(t, e) {
    return this.HAS_NATIVE_SUPPORT && !e ? atob(t) : fe(this.decodeStringToByteArray(t, e));
  },
  /**
   * Base64-decode a string.
   *
   * In base-64 decoding, groups of four characters are converted into three
   * bytes.  If the encoder did not apply padding, the input length may not
   * be a multiple of 4.
   *
   * In this case, the last group will have fewer than 4 characters, and
   * padding will be inferred.  If the group has one or two characters, it decodes
   * to one byte.  If the group has three characters, it decodes to two bytes.
   *
   * @param input Input to decode.
   * @param webSafe True if we should use the web-safe alphabet.
   * @return bytes representing the decoded value.
   */
  decodeStringToByteArray(t, e) {
    this.init_();
    const n = e ? this.charToByteMapWebSafe_ : this.charToByteMap_, r = [];
    for (let s = 0; s < t.length; ) {
      const i = n[t.charAt(s++)], c = s < t.length ? n[t.charAt(s)] : 0;
      ++s;
      const h = s < t.length ? n[t.charAt(s)] : 64;
      ++s;
      const p = s < t.length ? n[t.charAt(s)] : 64;
      if (++s, i == null || c == null || h == null || p == null)
        throw new de();
      const y = i << 2 | c >> 4;
      if (r.push(y), h !== 64) {
        const S = c << 4 & 240 | h >> 2;
        if (r.push(S), p !== 64) {
          const le = h << 6 & 192 | p;
          r.push(le);
        }
      }
    }
    return r;
  },
  /**
   * Lazy static initialization function. Called before
   * accessing any of the static map variables.
   * @private
   */
  init_() {
    if (!this.byteToCharMap_) {
      this.byteToCharMap_ = {}, this.charToByteMap_ = {}, this.byteToCharMapWebSafe_ = {}, this.charToByteMapWebSafe_ = {};
      for (let t = 0; t < this.ENCODED_VALS.length; t++)
        this.byteToCharMap_[t] = this.ENCODED_VALS.charAt(t), this.charToByteMap_[this.byteToCharMap_[t]] = t, this.byteToCharMapWebSafe_[t] = this.ENCODED_VALS_WEBSAFE.charAt(t), this.charToByteMapWebSafe_[this.byteToCharMapWebSafe_[t]] = t, t >= this.ENCODED_VALS_BASE.length && (this.charToByteMap_[this.ENCODED_VALS_WEBSAFE.charAt(t)] = t, this.charToByteMapWebSafe_[this.ENCODED_VALS.charAt(t)] = t);
    }
  }
};
class de extends Error {
  constructor() {
    super(...arguments), this.name = "DecodeBase64StringError";
  }
}
const ue = function(t) {
  const e = Y(t);
  return X.encodeByteArray(e, !0);
}, q = function(t) {
  return ue(t).replace(/\./g, "");
}, Z = function(t) {
  try {
    return X.decodeString(t, !0);
  } catch (e) {
    console.error("base64Decode failed: ", e);
  }
  return null;
};
/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function pe() {
  if (typeof self < "u")
    return self;
  if (typeof window < "u")
    return window;
  if (typeof global < "u")
    return global;
  throw new Error("Unable to locate global object.");
}
/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const me = () => pe().__FIREBASE_DEFAULTS__, ge = () => {
  if (typeof process > "u" || typeof process.env > "u")
    return;
  const t = process.env.__FIREBASE_DEFAULTS__;
  if (t)
    return JSON.parse(t);
}, be = () => {
  if (typeof document > "u")
    return;
  let t;
  try {
    t = document.cookie.match(/__FIREBASE_DEFAULTS__=([^;]+)/);
  } catch {
    return;
  }
  const e = t && Z(t[1]);
  return e && JSON.parse(e);
}, ye = () => {
  try {
    return he() || me() || ge() || be();
  } catch (t) {
    console.info(`Unable to get __FIREBASE_DEFAULTS__ due to: ${t}`);
    return;
  }
}, P = () => {
  var t;
  return (t = ye()) == null ? void 0 : t.config;
};
/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
class Ee {
  constructor() {
    this.reject = () => {
    }, this.resolve = () => {
    }, this.promise = new Promise((e, n) => {
      this.resolve = e, this.reject = n;
    });
  }
  /**
   * Our API internals are not promisified and cannot because our callback APIs have subtle expectations around
   * invoking promises inline, which Promises are forbidden to do. This method accepts an optional node-style callback
   * and returns a node-style callback which will resolve or reject the Deferred's promise.
   */
  wrapCallback(e) {
    return (n, r) => {
      n ? this.reject(n) : this.resolve(r), typeof e == "function" && (this.promise.catch(() => {
      }), e.length === 1 ? e(n) : e(n, r));
    };
  }
}
function _e() {
  return typeof window < "u" || Q();
}
function Q() {
  return typeof WorkerGlobalScope < "u" && typeof self < "u" && self instanceof WorkerGlobalScope;
}
function De() {
  try {
    return typeof indexedDB == "object";
  } catch {
    return !1;
  }
}
function Ce() {
  return new Promise((t, e) => {
    try {
      let n = !0;
      const r = "validate-browser-context-for-indexeddb-analytics-module", s = self.indexedDB.open(r);
      s.onsuccess = () => {
        s.result.close(), n || self.indexedDB.deleteDatabase(r), t(!0);
      }, s.onupgradeneeded = () => {
        n = !1;
      }, s.onerror = () => {
        var i;
        e(((i = s.error) == null ? void 0 : i.message) || "");
      };
    } catch (n) {
      e(n);
    }
  });
}
function Pt() {
  return !(typeof navigator > "u" || !navigator.cookieEnabled);
}
/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const Se = "FirebaseError";
class C extends Error {
  constructor(e, n, r) {
    super(n), this.code = e, this.customData = r, this.name = Se, Object.setPrototypeOf(this, C.prototype), Error.captureStackTrace && Error.captureStackTrace(this, ee.prototype.create);
  }
}
class ee {
  constructor(e, n, r) {
    this.service = e, this.serviceName = n, this.errors = r;
  }
  create(e, ...n) {
    const r = n[0] || {}, s = `${this.service}/${e}`, i = this.errors[e], a = i ? Ie(i, r) : "Error", c = `${this.serviceName}: ${a} (${s}).`;
    return new C(s, c, r);
  }
}
function Ie(t, e) {
  try {
    let n = 0, r = "";
    for (; n < t.length; ) {
      const s = t.indexOf("{$", n);
      if (s === -1) {
        r += t.substring(n);
        break;
      }
      const i = t.indexOf("}", s + 2);
      if (i === -1) {
        r += t.substring(n);
        break;
      }
      const a = t.substring(s + 2, i), c = e[a];
      r += t.substring(n, s) + (c != null ? String(c) : `<${a}?>`), n = i + 1;
    }
    return r;
  } catch {
    return t;
  }
}
function $(t, e) {
  if (t === e)
    return !0;
  const n = Object.keys(t), r = Object.keys(e);
  for (const s of n) {
    if (!r.includes(s))
      return !1;
    const i = t[s], a = e[s];
    if (k(i) && k(a)) {
      if (!$(i, a))
        return !1;
    } else if (i !== a)
      return !1;
  }
  for (const s of r)
    if (!n.includes(s))
      return !1;
  return !0;
}
function k(t) {
  return t !== null && typeof t == "object";
}
/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function Ft(t) {
  return t && t._delegate ? t._delegate : t;
}
class w {
  /**
   *
   * @param name The public service name, e.g. app, auth, firestore, database
   * @param instanceFactory Service factory responsible for creating the public interface
   * @param type whether the service provided by the component is public or private
   */
  constructor(e, n, r) {
    this.name = e, this.instanceFactory = n, this.type = r, this.multipleInstances = !1, this.serviceProps = {}, this.instantiationMode = "LAZY", this.onInstanceCreated = null;
  }
  setInstantiationMode(e) {
    return this.instantiationMode = e, this;
  }
  setMultipleInstances(e) {
    return this.multipleInstances = e, this;
  }
  setServiceProps(e) {
    return this.serviceProps = e, this;
  }
  setInstanceCreatedCallback(e) {
    return this.onInstanceCreated = e, this;
  }
}
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const m = "[DEFAULT]";
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
class we {
  constructor(e, n) {
    this.name = e, this.container = n, this.component = null, this.instances = /* @__PURE__ */ new Map(), this.instancesDeferred = /* @__PURE__ */ new Map(), this.instancesOptions = /* @__PURE__ */ new Map(), this.onInitCallbacks = /* @__PURE__ */ new Map();
  }
  /**
   * @param identifier A provider can provide multiple instances of a service
   * if this.component.multipleInstances is true.
   */
  get(e) {
    const n = this.normalizeInstanceIdentifier(e);
    if (!this.instancesDeferred.has(n)) {
      const r = new Ee();
      if (this.instancesDeferred.set(n, r), this.isInitialized(n) || this.shouldAutoInitialize())
        try {
          const s = this.getOrInitializeService({
            instanceIdentifier: n
          });
          s && r.resolve(s);
        } catch {
        }
    }
    return this.instancesDeferred.get(n).promise;
  }
  getImmediate(e) {
    const n = this.normalizeInstanceIdentifier(e == null ? void 0 : e.identifier), r = (e == null ? void 0 : e.optional) ?? !1;
    if (this.isInitialized(n) || this.shouldAutoInitialize())
      try {
        return this.getOrInitializeService({
          instanceIdentifier: n
        });
      } catch (s) {
        if (r)
          return null;
        throw s;
      }
    else {
      if (r)
        return null;
      throw Error(`Service ${this.name} is not available`);
    }
  }
  getComponent() {
    return this.component;
  }
  setComponent(e) {
    if (e.name !== this.name)
      throw Error(`Mismatching Component ${e.name} for Provider ${this.name}.`);
    if (this.component)
      throw Error(`Component for ${this.name} has already been provided`);
    if (this.component = e, !!this.shouldAutoInitialize()) {
      if (Ae(e))
        try {
          this.getOrInitializeService({ instanceIdentifier: m });
        } catch {
        }
      for (const [n, r] of this.instancesDeferred.entries()) {
        const s = this.normalizeInstanceIdentifier(n);
        try {
          const i = this.getOrInitializeService({
            instanceIdentifier: s
          });
          r.resolve(i);
        } catch {
        }
      }
    }
  }
  clearInstance(e = m) {
    this.instancesDeferred.delete(e), this.instancesOptions.delete(e), this.instances.delete(e);
  }
  // app.delete() will call this method on every provider to delete the services
  // TODO: should we mark the provider as deleted?
  async delete() {
    const e = Array.from(this.instances.values());
    await Promise.all([
      ...e.filter((n) => "INTERNAL" in n).map((n) => n.INTERNAL.delete()),
      ...e.filter((n) => "_delete" in n).map((n) => n._delete())
    ]);
  }
  isComponentSet() {
    return this.component != null;
  }
  isInitialized(e = m) {
    return this.instances.has(e);
  }
  getOptions(e = m) {
    return this.instancesOptions.get(e) || {};
  }
  initialize(e = {}) {
    const { options: n = {} } = e, r = this.normalizeInstanceIdentifier(e.instanceIdentifier);
    if (this.isInitialized(r))
      throw Error(`${this.name}(${r}) has already been initialized`);
    if (!this.isComponentSet())
      throw Error(`Component ${this.name} has not been registered yet`);
    const s = this.getOrInitializeService({
      instanceIdentifier: r,
      options: n
    });
    for (const [i, a] of this.instancesDeferred.entries()) {
      const c = this.normalizeInstanceIdentifier(i);
      r === c && a.resolve(s);
    }
    return s;
  }
  /**
   *
   * @param callback - a function that will be invoked  after the provider has been initialized by calling provider.initialize().
   * The function is invoked SYNCHRONOUSLY, so it should not execute any longrunning tasks in order to not block the program.
   *
   * @param identifier An optional instance identifier
   * @returns a function to unregister the callback
   */
  onInit(e, n) {
    const r = this.normalizeInstanceIdentifier(n), s = this.onInitCallbacks.get(r) ?? /* @__PURE__ */ new Set();
    s.add(e), this.onInitCallbacks.set(r, s);
    const i = this.instances.get(r);
    return i && e(i, r), () => {
      s.delete(e);
    };
  }
  /**
   * Invoke onInit callbacks synchronously
   * @param instance the service instance`
   */
  invokeOnInitCallbacks(e, n) {
    const r = this.onInitCallbacks.get(n);
    if (r)
      for (const s of r)
        try {
          s(e, n);
        } catch {
        }
  }
  getOrInitializeService({ instanceIdentifier: e, options: n = {} }) {
    let r = this.instances.get(e);
    if (!r && this.component && (r = this.component.instanceFactory(this.container, {
      instanceIdentifier: ve(e),
      options: n
    }), this.instances.set(e, r), this.instancesOptions.set(e, n), this.invokeOnInitCallbacks(r, e), this.component.onInstanceCreated))
      try {
        this.component.onInstanceCreated(this.container, e, r);
      } catch {
      }
    return r || null;
  }
  normalizeInstanceIdentifier(e = m) {
    return this.component ? this.component.multipleInstances ? e : m : e;
  }
  shouldAutoInitialize() {
    return !!this.component && this.component.instantiationMode !== "EXPLICIT";
  }
}
function ve(t) {
  return t === m ? void 0 : t;
}
function Ae(t) {
  return t.instantiationMode === "EAGER";
}
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
class te {
  constructor(e) {
    this.name = e, this.providers = /* @__PURE__ */ new Map();
  }
  /**
   *
   * @param component Component being added
   * @param overwrite When a component with the same name has already been registered,
   * if overwrite is true: overwrite the existing component with the new component and create a new
   * provider with the new component. It can be useful in tests where you want to use different mocks
   * for different tests.
   * if overwrite is false: throw an exception
   */
  addComponent(e) {
    const n = this.getProvider(e.name);
    if (n.isComponentSet())
      throw new Error(`Component ${e.name} has already been registered with ${this.name}`);
    n.setComponent(e);
  }
  addOrOverwriteComponent(e) {
    this.getProvider(e.name).isComponentSet() && this.providers.delete(e.name), this.addComponent(e);
  }
  /**
   * getProvider provides a type safe interface where it can only be called with a field name
   * present in NameServiceMapping interface.
   *
   * Firebase SDKs providing services should extend NameServiceMapping interface to register
   * themselves.
   */
  getProvider(e) {
    if (this.providers.has(e))
      return this.providers.get(e);
    const n = new we(e, this);
    return this.providers.set(e, n), n;
  }
  getProviders() {
    return Array.from(this.providers.values());
  }
}
/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const F = [];
var l;
(function(t) {
  t[t.DEBUG = 0] = "DEBUG", t[t.VERBOSE = 1] = "VERBOSE", t[t.INFO = 2] = "INFO", t[t.WARN = 3] = "WARN", t[t.ERROR = 4] = "ERROR", t[t.SILENT = 5] = "SILENT";
})(l || (l = {}));
const ne = {
  debug: l.DEBUG,
  verbose: l.VERBOSE,
  info: l.INFO,
  warn: l.WARN,
  error: l.ERROR,
  silent: l.SILENT
}, Be = l.INFO, Oe = {
  [l.DEBUG]: "log",
  [l.VERBOSE]: "log",
  [l.INFO]: "info",
  [l.WARN]: "warn",
  [l.ERROR]: "error"
}, Te = (t, e, ...n) => {
  if (e < t.logLevel)
    return;
  const r = (/* @__PURE__ */ new Date()).toISOString(), s = Oe[e];
  if (s)
    console[s](`[${r}]  ${t.name}:`, ...n);
  else
    throw new Error(`Attempted to log a message with an invalid logType (value: ${e})`);
};
class Re {
  /**
   * Gives you an instance of a Logger to capture messages according to
   * Firebase's logging scheme.
   *
   * @param name The name that the logs will be associated with
   */
  constructor(e) {
    this.name = e, this._logLevel = Be, this._logHandler = Te, this._userLogHandler = null, F.push(this);
  }
  get logLevel() {
    return this._logLevel;
  }
  set logLevel(e) {
    if (!(e in l))
      throw new TypeError(`Invalid value "${e}" assigned to \`logLevel\``);
    this._logLevel = e;
  }
  // Workaround for setter/getter having to be the same type.
  setLogLevel(e) {
    this._logLevel = typeof e == "string" ? ne[e] : e;
  }
  get logHandler() {
    return this._logHandler;
  }
  set logHandler(e) {
    if (typeof e != "function")
      throw new TypeError("Value assigned to `logHandler` must be a function");
    this._logHandler = e;
  }
  get userLogHandler() {
    return this._userLogHandler;
  }
  set userLogHandler(e) {
    this._userLogHandler = e;
  }
  /**
   * The functions below are all based on the `console` interface
   */
  debug(...e) {
    this._userLogHandler && this._userLogHandler(this, l.DEBUG, ...e), this._logHandler(this, l.DEBUG, ...e);
  }
  log(...e) {
    this._userLogHandler && this._userLogHandler(this, l.VERBOSE, ...e), this._logHandler(this, l.VERBOSE, ...e);
  }
  info(...e) {
    this._userLogHandler && this._userLogHandler(this, l.INFO, ...e), this._logHandler(this, l.INFO, ...e);
  }
  warn(...e) {
    this._userLogHandler && this._userLogHandler(this, l.WARN, ...e), this._logHandler(this, l.WARN, ...e);
  }
  error(...e) {
    this._userLogHandler && this._userLogHandler(this, l.ERROR, ...e), this._logHandler(this, l.ERROR, ...e);
  }
}
function $e(t) {
  F.forEach((e) => {
    e.setLogLevel(t);
  });
}
function Ne(t, e) {
  for (const n of F) {
    let r = null;
    e && e.level && (r = ne[e.level]), t === null ? n.userLogHandler = null : n.userLogHandler = (s, i, ...a) => {
      const c = a.map((o) => {
        if (o == null)
          return null;
        if (typeof o == "string")
          return o;
        if (typeof o == "number" || typeof o == "boolean")
          return o.toString();
        if (o instanceof Error)
          return o.message;
        try {
          return JSON.stringify(o);
        } catch {
          return null;
        }
      }).filter((o) => o).join(" ");
      i >= (r ?? s.logLevel) && t({
        level: l[i].toLowerCase(),
        message: c,
        args: a,
        type: s.name
      });
    };
  }
}
const Me = (t, e) => e.some((n) => t instanceof n);
let V, z;
function xe() {
  return V || (V = [
    IDBDatabase,
    IDBObjectStore,
    IDBIndex,
    IDBCursor,
    IDBTransaction
  ]);
}
function Le() {
  return z || (z = [
    IDBCursor.prototype.advance,
    IDBCursor.prototype.continue,
    IDBCursor.prototype.continuePrimaryKey
  ]);
}
const re = /* @__PURE__ */ new WeakMap(), N = /* @__PURE__ */ new WeakMap(), se = /* @__PURE__ */ new WeakMap(), B = /* @__PURE__ */ new WeakMap(), H = /* @__PURE__ */ new WeakMap();
function Pe(t) {
  const e = new Promise((n, r) => {
    const s = () => {
      t.removeEventListener("success", i), t.removeEventListener("error", a);
    }, i = () => {
      n(d(t.result)), s();
    }, a = () => {
      r(t.error), s();
    };
    t.addEventListener("success", i), t.addEventListener("error", a);
  });
  return e.then((n) => {
    n instanceof IDBCursor && re.set(n, t);
  }).catch(() => {
  }), H.set(e, t), e;
}
function Fe(t) {
  if (N.has(t))
    return;
  const e = new Promise((n, r) => {
    const s = () => {
      t.removeEventListener("complete", i), t.removeEventListener("error", a), t.removeEventListener("abort", a);
    }, i = () => {
      n(), s();
    }, a = () => {
      r(t.error || new DOMException("AbortError", "AbortError")), s();
    };
    t.addEventListener("complete", i), t.addEventListener("error", a), t.addEventListener("abort", a);
  });
  N.set(t, e);
}
let M = {
  get(t, e, n) {
    if (t instanceof IDBTransaction) {
      if (e === "done")
        return N.get(t);
      if (e === "objectStoreNames")
        return t.objectStoreNames || se.get(t);
      if (e === "store")
        return n.objectStoreNames[1] ? void 0 : n.objectStore(n.objectStoreNames[0]);
    }
    return d(t[e]);
  },
  set(t, e, n) {
    return t[e] = n, !0;
  },
  has(t, e) {
    return t instanceof IDBTransaction && (e === "done" || e === "store") ? !0 : e in t;
  }
};
function He(t) {
  M = t(M);
}
function ke(t) {
  return t === IDBDatabase.prototype.transaction && !("objectStoreNames" in IDBTransaction.prototype) ? function(e, ...n) {
    const r = t.call(O(this), e, ...n);
    return se.set(r, e.sort ? e.sort() : [e]), d(r);
  } : Le().includes(t) ? function(...e) {
    return t.apply(O(this), e), d(re.get(this));
  } : function(...e) {
    return d(t.apply(O(this), e));
  };
}
function Ve(t) {
  return typeof t == "function" ? ke(t) : (t instanceof IDBTransaction && Fe(t), Me(t, xe()) ? new Proxy(t, M) : t);
}
function d(t) {
  if (t instanceof IDBRequest)
    return Pe(t);
  if (B.has(t))
    return B.get(t);
  const e = Ve(t);
  return e !== t && (B.set(t, e), H.set(e, t)), e;
}
const O = (t) => H.get(t);
function ze(t, e, { blocked: n, upgrade: r, blocking: s, terminated: i } = {}) {
  const a = indexedDB.open(t, e), c = d(a);
  return r && a.addEventListener("upgradeneeded", (o) => {
    r(d(a.result), o.oldVersion, o.newVersion, d(a.transaction), o);
  }), n && a.addEventListener("blocked", (o) => n(
    // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
    o.oldVersion,
    o.newVersion,
    o
  )), c.then((o) => {
    i && o.addEventListener("close", () => i()), s && o.addEventListener("versionchange", (h) => s(h.oldVersion, h.newVersion, h));
  }).catch(() => {
  }), c;
}
function Ht(t, { blocked: e } = {}) {
  const n = indexedDB.deleteDatabase(t);
  return e && n.addEventListener("blocked", (r) => e(
    // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
    r.oldVersion,
    r
  )), d(n).then(() => {
  });
}
const Ue = ["get", "getKey", "getAll", "getAllKeys", "count"], We = ["put", "add", "delete", "clear"], T = /* @__PURE__ */ new Map();
function U(t, e) {
  if (!(t instanceof IDBDatabase && !(e in t) && typeof e == "string"))
    return;
  if (T.get(e))
    return T.get(e);
  const n = e.replace(/FromIndex$/, ""), r = e !== n, s = We.includes(n);
  if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(n in (r ? IDBIndex : IDBObjectStore).prototype) || !(s || Ue.includes(n))
  )
    return;
  const i = async function(a, ...c) {
    const o = this.transaction(a, s ? "readwrite" : "readonly");
    let h = o.store;
    return r && (h = h.index(c.shift())), (await Promise.all([
      h[n](...c),
      s && o.done
    ]))[0];
  };
  return T.set(e, i), i;
}
He((t) => ({
  ...t,
  get: (e, n, r) => U(e, n) || t.get(e, n, r),
  has: (e, n) => !!U(e, n) || t.has(e, n)
}));
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
class je {
  constructor(e) {
    this.container = e;
  }
  // In initial implementation, this will be called by installations on
  // auth token refresh, and installations will send this string.
  getPlatformInfoString() {
    return this.container.getProviders().map((n) => {
      if (Ge(n)) {
        const r = n.getImmediate();
        return `${r.library}/${r.version}`;
      } else
        return null;
    }).filter((n) => n).join(" ");
  }
}
function Ge(t) {
  const e = t.getComponent();
  return (e == null ? void 0 : e.type) === "VERSION";
}
const v = "@firebase/app", x = "0.16.2";
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const u = new Re("@firebase/app"), Je = "@firebase/app-compat", Ke = "@firebase/analytics-compat", Ye = "@firebase/analytics", Xe = "@firebase/app-check-compat", qe = "@firebase/app-check", Ze = "@firebase/auth", Qe = "@firebase/auth-compat", et = "@firebase/database", tt = "@firebase/data-connect", nt = "@firebase/database-compat", rt = "@firebase/functions", st = "@firebase/functions-compat", it = "@firebase/installations", at = "@firebase/installations-compat", ot = "@firebase/messaging", ct = "@firebase/messaging-compat", lt = "@firebase/performance", ht = "@firebase/performance-compat", ft = "@firebase/remote-config", dt = "@firebase/remote-config-compat", ut = "@firebase/storage", pt = "@firebase/storage-compat", mt = "@firebase/firestore", gt = "@firebase/ai", bt = "@firebase/firestore-compat", yt = "firebase", Et = "12.19.0";
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const A = "[DEFAULT]", _t = {
  [v]: "fire-core",
  [Je]: "fire-core-compat",
  [Ye]: "fire-analytics",
  [Ke]: "fire-analytics-compat",
  [qe]: "fire-app-check",
  [Xe]: "fire-app-check-compat",
  [Ze]: "fire-auth",
  [Qe]: "fire-auth-compat",
  [et]: "fire-rtdb",
  [tt]: "fire-data-connect",
  [nt]: "fire-rtdb-compat",
  [rt]: "fire-fn",
  [st]: "fire-fn-compat",
  [it]: "fire-iid",
  [at]: "fire-iid-compat",
  [ot]: "fire-fcm",
  [ct]: "fire-fcm-compat",
  [lt]: "fire-perf",
  [ht]: "fire-perf-compat",
  [ft]: "fire-rc",
  [dt]: "fire-rc-compat",
  [ut]: "fire-gcs",
  [pt]: "fire-gcs-compat",
  [mt]: "fire-fst",
  [bt]: "fire-fst-compat",
  [gt]: "fire-vertex",
  "fire-js": "fire-js",
  // Platform identifier for JS SDK.
  [yt]: "fire-js-all"
};
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const g = /* @__PURE__ */ new Map(), E = /* @__PURE__ */ new Map(), _ = /* @__PURE__ */ new Map();
function W(t, e) {
  try {
    t.container.addComponent(e);
  } catch (n) {
    u.debug(`Component ${e.name} failed to register with FirebaseApp ${t.name}`, n);
  }
}
function kt(t, e) {
  t.container.addOrOverwriteComponent(e);
}
function L(t) {
  const e = t.name;
  if (_.has(e))
    return u.debug(`There were multiple attempts to register component ${e}.`), !1;
  _.set(e, t);
  for (const n of g.values())
    W(n, t);
  for (const n of E.values())
    W(n, t);
  return !0;
}
function Dt(t, e) {
  const n = t.container.getProvider("heartbeat").getImmediate({ optional: !0 });
  return n && n.triggerHeartbeat(), t.container.getProvider(e);
}
function Vt(t, e, n = A) {
  Dt(t, e).clearInstance(n);
}
function ie(t) {
  return t.options !== void 0;
}
function Ct(t) {
  return ie(t) ? !1 : "authIdToken" in t || "appCheckToken" in t || "releaseOnDeref" in t || "automaticDataCollectionEnabled" in t;
}
function zt(t) {
  return t == null ? !1 : t.settings !== void 0;
}
function Ut() {
  _.clear();
}
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const St = {
  "no-app": "No Firebase App '{$appName}' has been created - call initializeApp() first",
  "bad-app-name": "Illegal App name: '{$appName}'",
  "duplicate-app": "Firebase App named '{$appName}' already exists with different {$mismatchedParam}. Existing: '{$oldValue}'. New: '{$newValue}'.",
  "app-deleted": "Firebase App named '{$appName}' already deleted",
  "server-app-deleted": "Firebase Server App has been deleted",
  "no-options": "Need to provide options, when not being deployed to hosting via source.",
  "invalid-app-argument": "firebase.{$appName}() takes either no argument or a Firebase App instance.",
  "invalid-log-argument": "First argument to `onLog` must be null or a function.",
  "idb-open": "Error thrown when opening IndexedDB. Original error: {$originalErrorMessage}.",
  "idb-get": "Error thrown when reading from IndexedDB. Original error: {$originalErrorMessage}.",
  "idb-set": "Error thrown when writing to IndexedDB. Original error: {$originalErrorMessage}.",
  "idb-delete": "Error thrown when deleting from IndexedDB. Original error: {$originalErrorMessage}.",
  "finalization-registry-not-supported": "FirebaseServerApp deleteOnDeref field defined but the JS runtime does not support FinalizationRegistry.",
  "invalid-server-app-environment": "FirebaseServerApp is not for use in browser environments."
}, f = new ee("app", "Firebase", St);
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
class ae {
  constructor(e, n, r) {
    this._isDeleted = !1, this._options = { ...e }, this._config = { ...n }, this._name = n.name, this._automaticDataCollectionEnabled = n.automaticDataCollectionEnabled, this._container = r, this.container.addComponent(new w(
      "app",
      () => this,
      "PUBLIC"
      /* ComponentType.PUBLIC */
    ));
  }
  get automaticDataCollectionEnabled() {
    return this.checkDestroyed(), this._automaticDataCollectionEnabled;
  }
  set automaticDataCollectionEnabled(e) {
    this.checkDestroyed(), this._automaticDataCollectionEnabled = e;
  }
  get name() {
    return this.checkDestroyed(), this._name;
  }
  get options() {
    return this.checkDestroyed(), this._options;
  }
  get config() {
    return this.checkDestroyed(), this._config;
  }
  get container() {
    return this._container;
  }
  get isDeleted() {
    return this._isDeleted;
  }
  set isDeleted(e) {
    this._isDeleted = e;
  }
  /**
   * This function will throw an Error if the App has already been deleted -
   * use before performing API actions on the App.
   */
  checkDestroyed() {
    if (this.isDeleted)
      throw f.create("app-deleted", { appName: this._name });
  }
}
/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function j(t, e) {
  const n = Z(t.split(".")[1]);
  if (n === null) {
    console.error(`FirebaseServerApp ${e} is invalid: second part could not be parsed.`);
    return;
  }
  if (JSON.parse(n).exp === void 0) {
    console.error(`FirebaseServerApp ${e} is invalid: expiration claim could not be parsed`);
    return;
  }
  const s = JSON.parse(n).exp * 1e3, i = (/* @__PURE__ */ new Date()).getTime();
  s - i <= 0 && console.error(`FirebaseServerApp ${e} is invalid: the token has expired.`);
}
class It extends ae {
  constructor(e, n, r, s) {
    const i = n.automaticDataCollectionEnabled !== void 0 ? n.automaticDataCollectionEnabled : !0, a = {
      name: r,
      automaticDataCollectionEnabled: i
    };
    if (e.apiKey !== void 0)
      super(e, a, s);
    else {
      const c = e;
      super(c.options, a, s);
    }
    this._serverConfig = {
      automaticDataCollectionEnabled: i,
      ...n
    }, this._serverConfig.authIdToken && j(this._serverConfig.authIdToken, "authIdToken"), this._serverConfig.appCheckToken && j(this._serverConfig.appCheckToken, "appCheckToken"), this._finalizationRegistry = null, typeof FinalizationRegistry < "u" && (this._finalizationRegistry = new FinalizationRegistry(() => {
      this.automaticCleanup();
    })), this._refCount = 0, this.incRefCount(this._serverConfig.releaseOnDeref), this._serverConfig.releaseOnDeref = void 0, n.releaseOnDeref = void 0, I(v, x, "serverapp");
  }
  toJSON() {
  }
  get refCount() {
    return this._refCount;
  }
  // Increment the reference count of this server app. If an object is provided, register it
  // with the finalization registry.
  incRefCount(e) {
    this.isDeleted || (this._refCount++, e !== void 0 && this._finalizationRegistry !== null && this._finalizationRegistry.register(e, this));
  }
  // Decrement the reference count.
  decRefCount() {
    return this.isDeleted ? 0 : --this._refCount;
  }
  // Invoked by the FinalizationRegistry callback to note that this app should go through its
  // reference counts and delete itself if no reference count remain. The coordinating logic that
  // handles this is in deleteApp(...).
  automaticCleanup() {
    vt(this);
  }
  get settings() {
    return this.checkDestroyed(), this._serverConfig;
  }
  /**
   * This function will throw an Error if the App has already been deleted -
   * use before performing API actions on the App.
   */
  checkDestroyed() {
    if (this.isDeleted)
      throw f.create(
        "server-app-deleted"
        /* AppError.SERVER_APP_DELETED */
      );
  }
}
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const Wt = Et;
function wt(t, e = {}) {
  let n = t;
  typeof e != "object" && (e = { name: e });
  const r = {
    name: A,
    automaticDataCollectionEnabled: !0,
    ...e
  }, s = r.name;
  if (typeof s != "string" || !s)
    throw f.create("bad-app-name", {
      appName: String(s)
    });
  if (n || (n = P()), !n)
    throw f.create(
      "no-options"
      /* AppError.NO_OPTIONS */
    );
  const i = g.get(s);
  if (i)
    if ($(n, i.options)) {
      if ($(r, i.config))
        return i;
      throw f.create("duplicate-app", {
        appName: s,
        mismatchedParam: "config",
        oldValue: JSON.stringify(i.config),
        newValue: JSON.stringify(r)
      });
    } else throw f.create("duplicate-app", {
      appName: s,
      mismatchedParam: "options",
      oldValue: JSON.stringify(i.options),
      newValue: JSON.stringify(n)
    });
  const a = new te(s);
  for (const o of _.values())
    a.addComponent(o);
  const c = new ae(n, r, a);
  return g.set(s, c), c;
}
function jt(t, e = {}) {
  if (_e() && !Q())
    throw f.create(
      "invalid-server-app-environment"
      /* AppError.INVALID_SERVER_APP_ENVIRONMENT */
    );
  let n, r = e || {};
  if (t && (ie(t) ? n = t.options : Ct(t) ? r = t : n = t), r.automaticDataCollectionEnabled === void 0 && (r.automaticDataCollectionEnabled = !0), n || (n = P()), !n)
    throw f.create(
      "no-options"
      /* AppError.NO_OPTIONS */
    );
  const s = {
    ...r,
    ...n
  };
  s.releaseOnDeref !== void 0 && delete s.releaseOnDeref;
  const i = (b) => [...b].reduce((p, y) => Math.imul(31, p) + y.charCodeAt(0) | 0, 0);
  if (r.releaseOnDeref !== void 0 && typeof FinalizationRegistry > "u")
    throw f.create("finalization-registry-not-supported", {});
  const a = "" + i(JSON.stringify(s)), c = E.get(a);
  if (c)
    return c.incRefCount(r.releaseOnDeref), c;
  const o = new te(a);
  for (const b of _.values())
    o.addComponent(b);
  const h = new It(n, r, a, o);
  return E.set(a, h), h;
}
function Gt(t = A) {
  const e = g.get(t);
  if (!e && t === A && P())
    return wt();
  if (!e)
    throw f.create("no-app", { appName: t });
  return e;
}
function Jt() {
  return Array.from(g.values());
}
async function vt(t) {
  let e = !1;
  const n = t.name;
  g.has(n) ? (e = !0, g.delete(n)) : E.has(n) && t.decRefCount() <= 0 && (E.delete(n), e = !0), e && (await Promise.all(t.container.getProviders().map((r) => r.delete())), t.isDeleted = !0);
}
function I(t, e, n) {
  let r = _t[t] ?? t;
  n && (r += `-${n}`);
  const s = r.match(/\s|\//), i = e.match(/\s|\//);
  if (s || i) {
    const a = [
      `Unable to register library "${r}" with version "${e}":`
    ];
    s && a.push(`library name "${r}" contains illegal characters (whitespace or "/")`), s && i && a.push("and"), i && a.push(`version name "${e}" contains illegal characters (whitespace or "/")`), u.warn(a.join(" "));
    return;
  }
  L(new w(
    `${r}-version`,
    () => ({ library: r, version: e }),
    "VERSION"
    /* ComponentType.VERSION */
  ));
}
function Kt(t, e) {
  if (t !== null && typeof t != "function")
    throw f.create(
      "invalid-log-argument"
      /* AppError.INVALID_LOG_ARGUMENT */
    );
  Ne(t, e);
}
function Yt(t) {
  $e(t);
}
/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const At = "firebase-heartbeat-database", Bt = 1, D = "firebase-heartbeat-store";
let R = null;
function oe() {
  return R || (R = ze(At, Bt, {
    upgrade: (t, e) => {
      switch (e) {
        case 0:
          try {
            t.createObjectStore(D);
          } catch (n) {
            console.warn(n);
          }
      }
    }
  }).catch((t) => {
    throw f.create("idb-open", {
      originalErrorMessage: t.message
    });
  })), R;
}
async function Ot(t) {
  try {
    const n = (await oe()).transaction(D), r = await n.objectStore(D).get(ce(t));
    return await n.done, r;
  } catch (e) {
    if (e instanceof C)
      u.warn(e.message);
    else {
      const n = f.create("idb-get", {
        originalErrorMessage: e == null ? void 0 : e.message
      });
      u.warn(n.message);
    }
  }
}
async function G(t, e) {
  try {
    const r = (await oe()).transaction(D, "readwrite");
    await r.objectStore(D).put(e, ce(t)), await r.done;
  } catch (n) {
    if (n instanceof C)
      u.warn(n.message);
    else {
      const r = f.create("idb-set", {
        originalErrorMessage: n == null ? void 0 : n.message
      });
      u.warn(r.message);
    }
  }
}
function ce(t) {
  return `${t.name}!${t.options.appId}`;
}
/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const Tt = 1024, Rt = 30;
class $t {
  constructor(e) {
    this.container = e, this._heartbeatsCache = null;
    const n = this.container.getProvider("app").getImmediate();
    this._storage = new Mt(n), this._heartbeatsCachePromise = this._storage.read().then((r) => (this._heartbeatsCache = r, r));
  }
  /**
   * Called to report a heartbeat. The function will generate
   * a HeartbeatsByUserAgent object, update heartbeatsCache, and persist it
   * to IndexedDB.
   * Note that we only store one heartbeat per day. So if a heartbeat for today is
   * already logged, subsequent calls to this function in the same day will be ignored.
   */
  async triggerHeartbeat() {
    var e, n;
    try {
      const s = this.container.getProvider("platform-logger").getImmediate().getPlatformInfoString(), i = J();
      if (((e = this._heartbeatsCache) == null ? void 0 : e.heartbeats) == null && (this._heartbeatsCache = await this._heartbeatsCachePromise, ((n = this._heartbeatsCache) == null ? void 0 : n.heartbeats) == null) || this._heartbeatsCache.lastSentHeartbeatDate === i || this._heartbeatsCache.heartbeats.some((a) => a.date === i))
        return;
      if (this._heartbeatsCache.heartbeats.push({ date: i, agent: s }), this._heartbeatsCache.heartbeats.length > Rt) {
        const a = xt(this._heartbeatsCache.heartbeats);
        this._heartbeatsCache.heartbeats.splice(a, 1);
      }
      return this._storage.overwrite(this._heartbeatsCache);
    } catch (r) {
      u.warn(r);
    }
  }
  /**
   * Returns a base64 encoded string which can be attached to the heartbeat-specific header directly.
   * It also clears all heartbeats from memory as well as in IndexedDB.
   *
   * NOTE: Consuming product SDKs should not send the header if this method
   * returns an empty string.
   */
  async getHeartbeatsHeader() {
    var e;
    try {
      if (this._heartbeatsCache === null && await this._heartbeatsCachePromise, ((e = this._heartbeatsCache) == null ? void 0 : e.heartbeats) == null || this._heartbeatsCache.heartbeats.length === 0)
        return "";
      const n = J(), { heartbeatsToSend: r, unsentEntries: s } = Nt(this._heartbeatsCache.heartbeats), i = q(JSON.stringify({ version: 2, heartbeats: r }));
      return this._heartbeatsCache.lastSentHeartbeatDate = n, s.length > 0 ? (this._heartbeatsCache.heartbeats = s, await this._storage.overwrite(this._heartbeatsCache)) : (this._heartbeatsCache.heartbeats = [], this._storage.overwrite(this._heartbeatsCache)), i;
    } catch (n) {
      return u.warn(n), "";
    }
  }
}
function J() {
  return (/* @__PURE__ */ new Date()).toISOString().substring(0, 10);
}
function Nt(t, e = Tt) {
  const n = [];
  let r = t.slice();
  for (const s of t) {
    const i = n.find((a) => a.agent === s.agent);
    if (i) {
      if (i.dates.push(s.date), K(n) > e) {
        i.dates.pop();
        break;
      }
    } else if (n.push({
      agent: s.agent,
      dates: [s.date]
    }), K(n) > e) {
      n.pop();
      break;
    }
    r = r.slice(1);
  }
  return {
    heartbeatsToSend: n,
    unsentEntries: r
  };
}
class Mt {
  constructor(e) {
    this.app = e, this._canUseIndexedDBPromise = this.runIndexedDBEnvironmentCheck();
  }
  async runIndexedDBEnvironmentCheck() {
    return De() ? Ce().then(() => !0).catch(() => !1) : !1;
  }
  /**
   * Read all heartbeats.
   */
  async read() {
    if (await this._canUseIndexedDBPromise) {
      const n = await Ot(this.app);
      return n != null && n.heartbeats ? n : { heartbeats: [] };
    } else
      return { heartbeats: [] };
  }
  // overwrite the storage with the provided heartbeats
  async overwrite(e) {
    if (await this._canUseIndexedDBPromise) {
      const r = await this.read();
      return G(this.app, {
        lastSentHeartbeatDate: e.lastSentHeartbeatDate ?? r.lastSentHeartbeatDate,
        heartbeats: e.heartbeats
      });
    } else
      return;
  }
  // add heartbeats
  async add(e) {
    if (await this._canUseIndexedDBPromise) {
      const r = await this.read();
      return G(this.app, {
        lastSentHeartbeatDate: e.lastSentHeartbeatDate ?? r.lastSentHeartbeatDate,
        heartbeats: [
          ...r.heartbeats,
          ...e.heartbeats
        ]
      });
    } else
      return;
  }
}
function K(t) {
  return q(
    // heartbeatsCache wrapper properties
    JSON.stringify({ version: 2, heartbeats: t })
  ).length;
}
function xt(t) {
  if (t.length === 0)
    return -1;
  let e = 0, n = t[0].date;
  for (let r = 1; r < t.length; r++)
    t[r].date < n && (n = t[r].date, e = r);
  return e;
}
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function Lt(t) {
  L(new w(
    "platform-logger",
    (e) => new je(e),
    "PRIVATE"
    /* ComponentType.PRIVATE */
  )), L(new w(
    "heartbeat",
    (e) => new $t(e),
    "PRIVATE"
    /* ComponentType.PRIVATE */
  )), I(v, x, t), I(v, x, "esm2020"), I("fire-js", "");
}
/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Lt("");
export {
  w as C,
  A as D,
  ee as E,
  C as F,
  Wt as S,
  W as _,
  kt as a,
  g as b,
  Ut as c,
  _ as d,
  Dt as e,
  ie as f,
  zt as g,
  Ct as h,
  L as i,
  Vt as j,
  E as k,
  vt as l,
  Gt as m,
  Jt as n,
  wt as o,
  jt as p,
  Kt as q,
  I as r,
  Yt as s,
  ze as t,
  Ft as u,
  Ce as v,
  De as w,
  Pt as x,
  Ht as y
};
