'use strict';

/**
 * GST core (CRM 3.53.0): the tested pure helpers of the GST app, copied UNCHANGED
 * (see SOURCE.md). They are ES modules and the CRM is CommonJS, so they are loaded through
 * dynamic import() and cached. Never edit the copied files: fix the GST app first, then copy again.
 *
 *   const { loadGstModule, loadGstCore } = require('../lib/gst-core');
 *   const utils = await loadGstModule('utils');          // only what a service needs
 *   const { utils, cashBook } = await loadGstCore();     // all of them
 *
 * Each module loads on its own: only bankMatch needs the npm package fflate, so a missing fflate
 * cannot stop the tax engine or the cash book.
 */

const path = require('path');
const { pathToFileURL } = require('url');

const MODULES = Object.freeze({
  utils: 'utils.js',
  gstr1: 'utils/gstr1Json.js',
  cashBook: 'utils/cashBook.js',
  bankMatch: 'utils/bankMatch.js',
  tdsTcs: 'utils/tdsTcs.js',
  lut: 'utils/lut.js',
  periodLock: 'utils/periodLock.js',
  period: 'utils/period.js',
  hsnRates: 'utils/hsnRates.js'
});

const cache = new Map();

function loadGstModule(name) {
  const file = MODULES[name];
  if (!file) return Promise.reject(new Error(`Unknown gst-core module "${name}"`));
  if (!cache.has(name)) {
    const promise = import(pathToFileURL(path.join(__dirname, file)).href).catch((error) => {
      // Let a later call try again (for example after `npm install` added fflate).
      cache.delete(name);
      throw error;
    });
    cache.set(name, promise);
  }
  return cache.get(name);
}

async function loadGstCore() {
  const names = Object.keys(MODULES);
  const mods = await Promise.all(names.map(loadGstModule));
  return Object.freeze(Object.fromEntries(names.map((name, i) => [name, mods[i]])));
}

module.exports = { loadGstModule, loadGstCore, GST_CORE_MODULES: MODULES };
