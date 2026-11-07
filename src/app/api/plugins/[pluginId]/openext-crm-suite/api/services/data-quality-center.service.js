'use strict';

const { resolveTenantId } = require('../utils/tenant.util');
const { scoreLead, scoreClient } = require('../utils/data-quality.util');
const {
  buildCompanyTokens,
  companySimilarity,
  COMPANY_SIMILARITY_THRESHOLD
} = require('../utils/lead-duplicate.util');

const MAX_SCAN_RECORDS = 1000;
const MAX_COMPANY_COMPARISONS = 20000;
const VALID_VIEWS = new Set(['duplicates', 'low-quality']);
const VALID_RECORD_TYPES = new Set(['lead', 'client']);
const VALID_MATCH_TYPES = new Set(['all', 'exact', 'similar']);

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getModel(req, name) {
  const Model = req.cms?.models.get(name);
  if (!Model) throw appError(`${name} model is not registered`, 500);
  return Model;
}

function recordId(record) {
  return String(record?._id || record?.id || '');
}

function normalizeExact(value, upper = false) {
  const normalized = String(value || '').trim();
  return upper ? normalized.toUpperCase() : normalized.toLowerCase();
}

function addPair(pairMap, left, right, reason, similarity = 0) {
  const leftId = recordId(left);
  const rightId = recordId(right);
  if (!leftId || !rightId || leftId === rightId) return;
  const ordered = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
  const key = ordered.join(':');
  const pair = pairMap.get(key) || { leftId: ordered[0], rightId: ordered[1], reasons: [], companySimilarity: 0 };
  if (!pair.reasons.includes(reason)) pair.reasons.push(reason);
  pair.companySimilarity = Math.max(pair.companySimilarity, similarity);
  pairMap.set(key, pair);
}

function addExactPairs(records, pairMap, field, reason, upper = false) {
  const groups = new Map();
  for (const record of records) {
    const value = normalizeExact(record?.[field], upper);
    if (!value) continue;
    const group = groups.get(value) || [];
    group.push(record);
    groups.set(value, group);
  }
  for (const group of groups.values()) {
    // A chain marks every member of a large exact-match group without creating O(n²) pairs.
    for (let index = 1; index < group.length; index += 1) {
      addPair(pairMap, group[index - 1], group[index], reason);
    }
  }
}

function analyzeRecords(recordType, sourceRecords, contactCounts = {}, rules = {}) {
  const records = (sourceRecords || []).map((record) => ({ ...record, _id: recordId(record) }));
  const recordsById = new Map(records.map((record) => [recordId(record), record]));
  const pairMap = new Map();
  addExactPairs(records, pairMap, 'email', 'email');
  addExactPairs(records, pairMap, 'phone', 'mobile');
  if (recordType === 'lead') addExactPairs(records, pairMap, 'pan', 'pan', true);

  const tokenGroups = new Map();
  for (const record of records) {
    const companyName = recordType === 'lead' ? record.company : record.name;
    const tokens = Array.isArray(record.companyTokens) && record.companyTokens.length
      ? record.companyTokens
      : buildCompanyTokens(companyName);
    for (const token of tokens) {
      const group = tokenGroups.get(token) || [];
      group.push(record);
      tokenGroups.set(token, group);
    }
  }

  const compared = new Set();
  let comparisons = 0;
  let comparisonLimited = false;
  outer: for (const group of tokenGroups.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const ids = [recordId(group[left]), recordId(group[right])].sort();
        const key = ids.join(':');
        if (compared.has(key)) continue;
        compared.add(key);
        comparisons += 1;
        if (comparisons > MAX_COMPANY_COMPARISONS) {
          comparisonLimited = true;
          break outer;
        }
        const leftName = recordType === 'lead' ? group[left].company : group[left].name;
        const rightName = recordType === 'lead' ? group[right].company : group[right].name;
        const similarity = companySimilarity(leftName, rightName);
        if (similarity >= COMPANY_SIMILARITY_THRESHOLD) {
          addPair(pairMap, group[left], group[right], 'company', similarity);
        }
      }
    }
  }

  const matchesById = new Map();
  for (const pair of pairMap.values()) {
    for (const [id, otherId] of [[pair.leftId, pair.rightId], [pair.rightId, pair.leftId]]) {
      const matches = matchesById.get(id) || [];
      matches.push({
        ...recordsById.get(otherId),
        id: otherId,
        reasons: [...pair.reasons],
        companySimilarity: Number(pair.companySimilarity.toFixed(3))
      });
      matchesById.set(id, matches);
    }
  }

  const items = records.map((record) => {
    const id = recordId(record);
    const matches = matchesById.get(id) || [];
    const quality = recordType === 'lead'
      ? scoreLead(record, { hasDuplicate: matches.length > 0 }, rules?.leadWeights, rules?.thresholds)
      : scoreClient(record, { contactCount: Number(contactCounts[id] || 0), hasDuplicate: matches.length > 0 }, rules?.clientWeights, rules?.thresholds);
    return { ...record, id, matches, dataQuality: quality };
  });

  return { items, comparisonLimited };
}

function parseQuery(query = {}) {
  const view = String(query.view || 'duplicates');
  const recordType = String(query.recordType || 'lead');
  const matchType = String(query.matchType || 'all');
  if (!VALID_VIEWS.has(view)) throw appError('Invalid data-quality view');
  if (!VALID_RECORD_TYPES.has(recordType)) throw appError('Invalid record type');
  if (!VALID_MATCH_TYPES.has(matchType)) throw appError('Invalid duplicate match type');
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 10));
  const maxScoreValue = query.maxScore === undefined ? 69 : Number(query.maxScore);
  if (!Number.isFinite(maxScoreValue) || maxScoreValue < 0 || maxScoreValue > 100) {
    throw appError('Maximum quality score must be between 0 and 100');
  }
  return { view, recordType, matchType, page, limit, maxScore: Math.round(maxScoreValue), search: String(query.search || '').trim().toLowerCase().slice(0, 120) };
}

function matchesSearch(item, search, recordType) {
  if (!search) return true;
  const values = recordType === 'lead'
    ? [item.name, item.company, item.email, item.phone, item.stage]
    : [item.name, item.email, item.phone, item.website, item.taxId];
  return values.some((value) => String(value || '').toLowerCase().includes(search));
}

function hasMatchType(item, matchType) {
  if (matchType === 'all') return item.matches.length > 0;
  if (matchType === 'exact') return item.matches.some((match) => match.reasons.some((reason) => reason !== 'company'));
  return item.matches.some((match) => match.reasons.includes('company'));
}

function summarize(leadAnalysis, clientAnalysis) {
  const summaryFor = (analysis) => {
    const scores = analysis.items.map((item) => item.dataQuality.score);
    return {
      duplicates: analysis.items.filter((item) => item.matches.length).length,
      lowQuality: analysis.items.filter((item) => item.dataQuality.score < 70).length,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0
    };
  };
  return { leads: summaryFor(leadAnalysis), clients: summaryFor(clientAnalysis) };
}

async function loadRecords(req, modelName, projection) {
  const Model = getModel(req, modelName);
  const tenantId = resolveTenantId(req);
  const filter = { tenantId, isDeleted: false, mergedIntoId: null };
  const [records, total] = await Promise.all([
    Model.find(filter).select(projection).sort({ createdAt: -1, _id: -1 }).limit(MAX_SCAN_RECORDS).lean(),
    Model.countDocuments(filter)
  ]);
  return { records, total };
}

async function loadContactCounts(req, clientIds) {
  if (!clientIds.length) return {};
  const Contact = getModel(req, 'Contact');
  const rows = await Contact.aggregate([
    { $match: { tenantId: resolveTenantId(req), isDeleted: false, companyId: { $in: clientIds } } },
    { $group: { _id: '$companyId', count: { $sum: 1 } } }
  ]);
  return Object.fromEntries(rows.map((row) => [String(row._id), Number(row.count || 0)]));
}

async function getCenter(req, rawQuery = {}) {
  const SettingService = require('./setting.service');
  const query = parseQuery(rawQuery);
  const [leadLoad, clientLoad, rules] = await Promise.all([
    loadRecords(req, 'Lead', '_id name company email phone pan stage assignedTo address companyTokens createdAt'),
    loadRecords(req, 'Company', '_id name email phone website taxId billingAddress leadId companyTokens createdAt'),
    SettingService.getDataQualityRules(req).catch(() => ({}))
  ]);
  const contactCounts = await loadContactCounts(req, clientLoad.records.map(recordId));
  const leadAnalysis = analyzeRecords('lead', leadLoad.records, {}, rules);
  const clientAnalysis = analyzeRecords('client', clientLoad.records, contactCounts, rules);
  const selected = query.recordType === 'lead' ? leadAnalysis : clientAnalysis;
  let items = selected.items.filter((item) => matchesSearch(item, query.search, query.recordType));
  items = query.view === 'duplicates'
    ? items.filter((item) => hasMatchType(item, query.matchType))
    : items.filter((item) => item.dataQuality.score <= query.maxScore);
  items.sort((left, right) => left.dataQuality.score - right.dataQuality.score || String(left.name).localeCompare(String(right.name)));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.min(query.page, totalPages);
  const start = (page - 1) * query.limit;

  return {
    items: items.slice(start, start + query.limit),
    summary: summarize(leadAnalysis, clientAnalysis),
    pagination: { page, limit: query.limit, total, totalPages },
    meta: {
      maxScanRecords: MAX_SCAN_RECORDS,
      leadsScanned: leadLoad.records.length,
      clientsScanned: clientLoad.records.length,
      truncated: leadLoad.total > MAX_SCAN_RECORDS || clientLoad.total > MAX_SCAN_RECORDS,
      comparisonLimited: leadAnalysis.comparisonLimited || clientAnalysis.comparisonLimited
    }
  };
}

async function exportDataQuality(req, rawQuery = {}) {
  const SettingService = require('./setting.service');
  const AuditService = require('./audit.service');
  const query = parseQuery(rawQuery);
  const [leadLoad, clientLoad, rules] = await Promise.all([
    loadRecords(req, 'Lead', '_id name company email phone pan stage assignedTo address companyTokens createdAt'),
    loadRecords(req, 'Company', '_id name email phone website taxId billingAddress leadId companyTokens createdAt'),
    SettingService.getDataQualityRules(req).catch(() => ({}))
  ]);
  const contactCounts = await loadContactCounts(req, clientLoad.records.map(recordId));
  const leadAnalysis = analyzeRecords('lead', leadLoad.records, {}, rules);
  const clientAnalysis = analyzeRecords('client', clientLoad.records, contactCounts, rules);
  const selected = query.recordType === 'lead' ? leadAnalysis : clientAnalysis;
  let items = selected.items.filter((item) => matchesSearch(item, query.search, query.recordType));
  items = query.view === 'duplicates'
    ? items.filter((item) => hasMatchType(item, query.matchType))
    : items.filter((item) => item.dataQuality.score <= query.maxScore);
  items.sort((left, right) => left.dataQuality.score - right.dataQuality.score || String(left.name).localeCompare(String(right.name)));

  const format = String(rawQuery.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'settings',
    recordId: 'data_quality_export',
    description: `Exported ${items.length} ${query.recordType} data quality hygiene records in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `data_quality_${query.recordType}_export_${nowStr}.json`,
      content: JSON.stringify(items, null, 2),
      data: items,
      count: items.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'ID',
    'Record Type',
    'Name',
    'Company / Organization',
    'Email',
    'Phone / Mobile',
    'Quality Score (0-100)',
    'Quality Status',
    'Duplicates Detected',
    'Duplicate Match Reasons',
    'Missing Fields'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const item of items) {
    const dupCount = item.duplicates ? item.duplicates.length : 0;
    const reasons = item.duplicates ? item.duplicates.map((d) => d.reasons?.join('+')).join('; ') : '';
    const missing = Array.isArray(item.dataQuality?.missingFields) ? item.dataQuality.missingFields.join('; ') : '';
    rows.push(
      [
        item._id,
        query.recordType.toUpperCase(),
        item.name || '',
        item.company || item.name || '',
        item.email || '',
        item.phone || item.mobile || '',
        item.dataQuality?.score || 0,
        item.dataQuality?.label || 'Fair',
        dupCount,
        reasons,
        missing
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `data_quality_${query.recordType}_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: items.length
  };
}

module.exports = {
  MAX_SCAN_RECORDS,
  analyzeRecords,
  parseQuery,
  getCenter,
  exportDataQuality
};
