'use strict';

/**
 * The active extension's Reports page (json/reports.json, CRM 3.29.0). Generic: the extension declares filters
 * and sections, each section's data comes from one of its GET routes in a fixed shape the CRM draws and
 * checks here (kpis, funnel, groups, table, chart). The CRM:
 *  - shows a section only to users with its permission (and the extension route checks again)
 *  - fills generic filter options (users, lead sources, pipeline stages); the rest comes from the extension
 *  - passes the filters to the routes as query values (from / to ISO days + one value per filter key)
 *  - keeps only drill-down links to this extension's pages or core record pages
 *  - exports table sections as CSV (the rows the user was given, nothing more)
 *
 * GET  /extension-reports                → { available, title, subtitle, keepCoreTabs, filters, sections }
 * POST /extension-reports/data           { filters, params, sections? } → { sections: { <id>: data | { error } } }
 * POST /extension-reports/export         { sectionId, filters, params } → { fileName, csv }
 */

const { requestHasPermission } = require('../utils/extension-permission.util');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALUE_RE = /^[\w .,&()'/@+-]{0,120}$/u;
const MAX_ROWS = 500;
const MAX_ITEMS = 16;
const MAX_POINTS = 120;
const FORMATS = ['number', 'money', 'percent', 'days', 'text'];
const COLUMN_TYPES = ['text', 'number', 'money', 'percent', 'days', 'date', 'user', 'status', 'flags'];
const TONES = ['neutral', 'success', 'warning', 'danger', 'info'];

function appError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

const text = (v, max = 120) => (v === null || v === undefined ? '' : String(v)).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

/** which: 'reports' (json/reports.json) or 'dashboard' (json/dashboard.json, CRM 3.31.0). */
async function activeReports(req, which = 'reports') {
  const CrmExtensionService = require('./crm-extension.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  const reports = def && def.isInternal === false && def.declarations && def.declarations[which === 'dashboard' ? 'dashboard' : 'reports'];
  return reports && Array.isArray(reports.sections) && reports.sections.length ? { def, reports } : { def: null, reports: null };
}

function canSee(req, def, section) {
  return !section.permission || requestHasPermission(req, section.permission, def);
}

/** A drill-down link the page may open: this extension's pages or a core record list / page. */
function safeLink(def, link) {
  const value = text(link, 300);
  if (!value || value.includes('//') || !value.startsWith('/')) return '';
  if (value.startsWith(`/ext/${def.id}/`)) return value;
  if (/^\/reports\?tab=[a-z-]{2,40}(&[a-z]{1,20}=[\w%.-]{1,80}){0,3}$/i.test(value)) return value; // a core report tab, e.g. one rep's activities
  return /^\/(leads|opportunities|quotations|invoices|clients|contacts|payments)(\/[a-f0-9]{24})?(\?[\w=&%.,:+-]*)?$/i.test(value) ? value : '';
}

async function filterOptions(req, def, filter) {
  try {
    if (filter.options) return filter.options;
    if (filter.source === 'users') {
      const users = await require('./context.service').getAssignableUsers(req, '');
      return (users || []).slice(0, 200).map((u) => ({ value: text(u.id || u._id), label: text(u.name || u.username || u.email || u.id) })).filter((o) => o.value);
    }
    if (filter.source === 'leadSources') {
      const settings = await require('./setting.service').getAll(req);
      return (Array.isArray(settings.lead_sources) ? settings.lead_sources : []).map((s) => ({ value: text(s, 80), label: text(s, 80) })).filter((o) => o.value);
    }
    if (filter.source === 'pipelineStages') {
      const Pipeline = req.cms?.models?.get?.('OpportunityPipeline');
      const { resolveTenantId } = require('../utils/tenant.util');
      const or = [{ extensionId: `crm:${def.id}` }];
      if (def.pipelineKey) or.push({ pipelineKey: def.pipelineKey });
      const q = Pipeline ? Pipeline.findOne({ tenantId: resolveTenantId(req), isDeleted: false, $or: or }) : null;
      const pipeline = q && typeof q.lean === 'function' ? await q.lean() : await q;
      return ((pipeline && pipeline.stages) || []).map((s) => ({ value: text(s.label, 80), label: text(s.label, 80) })).filter((o) => o.value);
    }
  } catch {
    return [];
  }
  return [];
}

/** GET /extension-reports · GET /extension-dashboard */
async function definition(req, which = 'reports') {
  const { def, reports } = await activeReports(req, which);
  if (!def) return { available: false };
  const sections = reports.sections.filter((s) => canSee(req, def, s));
  const routed = new Map();
  const filters = [];
  for (const f of reports.filters || []) {
    let options = [];
    if (f.type === 'select') {
      if (f.optionsRoute) {
        if (!routed.has(f.optionsRoute)) {
          routed.set(f.optionsRoute, (async () => {
            try {
              const { callActiveRoute } = require('../extension-runtime/runtime');
              const res = await callActiveRoute(req, 'GET', f.optionsRoute);
              return res && res.data && typeof res.data === 'object' ? res.data : {};
            } catch {
              return {};
            }
          })());
        }
        const data = await routed.get(f.optionsRoute);
        const list = Array.isArray(data[f.optionsKey]) ? data[f.optionsKey] : [];
        options = list.slice(0, 200).map((o) => ({ value: text(o && typeof o === 'object' ? o.value : o, 80), label: text(o && typeof o === 'object' ? o.label || o.value : o, 80) })).filter((o) => o.value);
      } else {
        options = await filterOptions(req, def, f);
      }
    }
    filters.push({ key: f.key, label: f.label, type: f.type, ...(f.default ? { default: f.default } : {}), ...(f.type === 'select' ? { options } : {}) });
  }
  const actions = (reports.actions || []).filter((a) => !a.permission || requestHasPermission(req, a.permission, def));
  return {
    available: true,
    extensionId: def.id,
    title: reports.title,
    subtitle: reports.subtitle || '',
    actions,
    keepCoreTabs: reports.keepCoreTabs || [],
    filters,
    // Only tabs that still have a section this user may see.
    tabs: (reports.tabs || []).filter((t) => sections.some((s) => s.tab === t.id)),
    sections: sections.map((s) => ({ id: s.id, kind: s.kind, title: s.title, subtitle: s.subtitle, width: s.width, export: s.export, ...(s.periods ? { periods: s.periods } : {}), ...(s.tab ? { tab: s.tab } : {}) }))
  };
}

/** Filters → the route query: from / to ISO days, one string per declared filter key, p_<section> periods. */
function queryFor(reports, input = {}) {
  const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  const query = {};
  if (DAY_RE.test(String(filters.from || ''))) query.from = String(filters.from);
  if (DAY_RE.test(String(filters.to || ''))) query.to = String(filters.to);
  if (query.from && query.to && query.from > query.to) [query.from, query.to] = [query.to, query.from];
  for (const f of reports.filters || []) {
    if (f.type !== 'select') continue;
    const v = filters[f.key];
    if (typeof v === 'string' && v && VALUE_RE.test(v)) query[f.key] = v;
  }
  for (const s of reports.sections) {
    const v = params[s.id];
    if (s.periods && typeof v === 'string' && s.periods.some((p) => p.value === v)) query[`p_${s.id.replace(/-/g, '_')}`] = v;
  }
  return query;
}

function cleanItems(def, items) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS).map((i) => ({
    key: text(i && i.key, 40),
    label: text(i && i.label, 60),
    value: num(i && i.value),
    ...(i && i.count !== undefined ? { count: num(i.count) } : {}),
    format: pick(i && i.format, FORMATS, 'number'),
    ...(i && i.currency ? { currency: text(i.currency, 3).toUpperCase() } : {}),
    ...(i && i.hint ? { hint: text(i.hint, 120) } : {}),
    tone: pick(i && i.tone, TONES, 'neutral'),
    ...(i && i.link && safeLink(def, i.link) ? { link: safeLink(def, i.link) } : {})
  }));
}

/** The section data in the shape its kind needs; anything else is dropped. */
function cleanSection(def, section, raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const out = { kind: section.kind };
  if (data.note) out.note = text(data.note, 200);
  if (data.currency) out.currency = text(data.currency, 3).toUpperCase();
  if (data.items && section.kind !== 'list') out.items = cleanItems(def, data.items);
  // "View all" under a section.
  if (data.more && typeof data.more === 'object' && safeLink(def, data.more.link)) {
    out.more = { label: text(data.more.label, 40) || 'View all', link: safeLink(def, data.more.link) };
  }
  if (data.empty) out.empty = text(data.empty, 120);
  if (section.kind === 'list') {
    out.items = (Array.isArray(data.items) ? data.items : []).slice(0, 20).map((i) => ({
      key: text(i && i.key, 60),
      title: text(i && i.title, 80),
      detail: text(i && i.detail, 120),
      ...(i && i.meta ? { meta: text(i.meta, 120) } : {}),
      ...(i && i.badge ? { badge: text(i.badge, 30) } : {}),
      tone: pick(i && i.tone, TONES, 'neutral'),
      ...(i && i.actionLabel ? { actionLabel: text(i.actionLabel, 20) } : {}),
      ...(i && i.link && safeLink(def, i.link) ? { link: safeLink(def, i.link) } : {})
    }));
  }
  if (section.kind === 'steps') {
    out.stages = (Array.isArray(data.stages) ? data.stages : []).slice(0, 8).map((s) => ({
      key: text(s && s.key, 40),
      label: text(s && s.label, 40),
      count: Math.max(0, Math.round(num(s && s.count))),
      ...(s && s.link && safeLink(def, s.link) ? { link: safeLink(def, s.link) } : {})
    }));
  }
  if (section.kind === 'progress') {
    out.current = Math.max(0, num(data.current));
    out.total = Math.max(out.current, num(data.total));
    out.format = pick(data.format, FORMATS, 'money');
    if (data.label) out.label = text(data.label, 80);
  }
  if (section.kind === 'funnel') {
    const stages = (Array.isArray(data.stages) ? data.stages : []).slice(0, 12).map((s) => ({
      key: text(s && s.key, 40),
      label: text(s && s.label, 60),
      count: Math.max(0, Math.round(num(s && s.count))),
      ...(s && s.link && safeLink(def, s.link) ? { link: safeLink(def, s.link) } : {})
    }));
    // Conversion from the stage before and the drop-off, worked out here the same way for every extension.
    out.stages = stages.map((s, i) => {
      const prev = i ? stages[i - 1].count : 0;
      const conversion = i && prev > 0 ? Math.round((s.count / prev) * 1000) / 10 : null;
      return { ...s, conversion, dropOff: conversion === null ? null : Math.round((100 - conversion) * 10) / 10 };
    });
  }
  if (section.kind === 'table') {
    const columns = (Array.isArray(data.columns) ? data.columns : []).slice(0, 14).map((c) => ({
      key: text(c && c.key, 40),
      label: text(c && c.label, 40),
      type: pick(c && c.type, COLUMN_TYPES, 'text')
    })).filter((c) => /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(c.key));
    const keys = new Set(columns.map((c) => c.key));
    out.columns = columns;
    out.rows = (Array.isArray(data.rows) ? data.rows : []).slice(0, MAX_ROWS).map((r) => {
      const row = {};
      for (const c of columns) {
        const v = r ? r[c.key] : undefined;
        if (c.type === 'flags') row[c.key] = (Array.isArray(v) ? v : []).slice(0, 6).map((f) => text(f, 60));
        else if (['number', 'money', 'percent', 'days'].includes(c.type)) row[c.key] = v === null || v === undefined || v === '' ? null : num(v);
        else row[c.key] = text(v, 200);
      }
      if (r && r._link && safeLink(def, r._link)) row._link = safeLink(def, r._link);
      if (r && TONES.includes(r._tone)) row._tone = r._tone;
      for (const k of Object.keys(row)) if (!keys.has(k) && !k.startsWith('_')) delete row[k];
      return row;
    });
    out.total = Math.max(out.rows.length, Math.round(num(data.total)));
    // A graph of the table (CRM 3.30.0): one row = one point, labelled by a text column, series = number columns.
    const c = data.chart && typeof data.chart === 'object' ? data.chart : null;
    if (c && keys.has(text(c.labelKey, 40))) {
      const series = (Array.isArray(c.series) ? c.series : [])
        .slice(0, 4)
        .map((s) => ({ key: text(s && s.key, 40), label: text(s && s.label, 40), format: pick(s && s.format, FORMATS, 'number') }))
        .filter((s) => columns.some((col) => col.key === s.key && ['number', 'money', 'percent', 'days'].includes(col.type)));
      if (series.length) out.chart = { type: pick(c.type, ['bar', 'line', 'pie'], 'bar'), labelKey: text(c.labelKey, 40), series };
    }
  }
  if (section.kind === 'chart') {
    out.type = pick(data.type, ['bar', 'line'], 'bar');
    out.series = (Array.isArray(data.series) ? data.series : []).slice(0, 4).map((s) => ({ key: text(s && s.key, 40), label: text(s && s.label, 40), format: pick(s && s.format, FORMATS, 'number') }));
    out.points = (Array.isArray(data.points) ? data.points : []).slice(0, MAX_POINTS).map((p) => {
      const values = {};
      for (const s of out.series) values[s.key] = num(p && p.values && p.values[s.key]);
      return { label: text(p && p.label, 40), values };
    });
  }
  return out;
}

/** POST /extension-reports/data · POST /extension-dashboard/data */
async function data(req, input = {}, which = 'reports') {
  const { def, reports } = await activeReports(req, which);
  if (!def) throw appError('No extension reports are available', 404, 'NOT_FOUND');
  const wanted = Array.isArray(input.sections) && input.sections.length ? new Set(input.sections.map(String)) : null;
  const sections = reports.sections.filter((s) => canSee(req, def, s) && (!wanted || wanted.has(s.id)));
  const query = queryFor(reports, input);
  const { callActiveRoute } = require('../extension-runtime/runtime');
  // One call per route: sections sharing a route read their part of the answer (dataKey).
  const calls = new Map();
  for (const s of sections) {
    if (!calls.has(s.route)) {
      calls.set(s.route, callActiveRoute(req, 'GET', s.route, undefined, { query }).then(
        (res) => ({ ok: true, data: res && res.data && typeof res.data === 'object' ? res.data : {} }),
        (error) => ({ ok: false, status: Number(error && error.status) || 500, message: String((error && error.message) || '') })
      ));
    }
  }
  const out = {};
  for (const s of sections) {
    const res = await calls.get(s.route);
    if (!res.ok) {
      out[s.id] = { kind: s.kind, error: res.status === 403 ? 'You do not have permission for this report' : res.status < 500 ? text(res.message, 200) : 'This report could not be loaded' };
      continue;
    }
    out[s.id] = cleanSection(def, s, res.data[s.dataKey]);
  }
  return { sections: out };
}

function csvCell(value) {
  const v = Array.isArray(value) ? value.join('; ') : value === null || value === undefined ? '' : String(value);
  // Spreadsheet formula injection: a leading = + - @ is made plain text.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** POST /extension-reports/export — a table section (or a section's items) as CSV. */
async function exportCsv(req, input = {}) {
  const { def, reports } = await activeReports(req);
  if (!def) throw appError('No extension reports are available', 404, 'NOT_FOUND');
  const section = reports.sections.find((s) => s.id === String(input.sectionId || ''));
  if (!section || !section.export) throw appError('This report cannot be exported', 404, 'NOT_FOUND');
  if (!canSee(req, def, section)) throw appError('You do not have permission for this report', 403, 'FORBIDDEN');
  const result = await data(req, { ...input, sections: [section.id] });
  const d = result.sections[section.id] || {};
  if (d.error) throw appError(d.error, 409, 'REPORT_FAILED');
  let lines = [];
  if (d.kind === 'table') {
    lines = [d.columns.map((c) => csvCell(c.label)).join(','), ...d.rows.map((r) => d.columns.map((c) => csvCell(r[c.key])).join(','))];
  } else if (d.kind === 'funnel') {
    lines = ['Stage,Count,Conversion %,Drop-off %', ...d.stages.map((s) => [s.label, s.count, s.conversion ?? '', s.dropOff ?? ''].map(csvCell).join(','))];
  } else if (d.kind === 'chart') {
    lines = [['Period', ...d.series.map((s) => s.label)].map(csvCell).join(','), ...d.points.map((p) => [p.label, ...d.series.map((s) => p.values[s.key])].map(csvCell).join(','))];
  } else {
    lines = ['Item,Count,Value', ...(d.items || []).map((i) => [i.label, i.count ?? '', i.value].map(csvCell).join(','))];
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return { fileName: `${def.id}-${section.id}-${stamp}.csv`, csv: `${lines.join('\n')}\n` };
}

module.exports = { definition, data, exportCsv, cleanSection, queryFor, safeLink };
