'use strict';

/**
 * Location Wise Leads & Clients report (generic CRM core).
 *
 * Groups leads (by the lead's own state / district / city) and clients (by billing address) into a
 * State → District → City tree. All counting is done in MongoDB with $group on normalised keys
 * ($toLower + $trim + collapsed spaces); only the small grouped rows are merged here.
 *
 *  - Leads: not deleted, not merged; date range on the lead's createdAt; filters assignedTo + source.
 *  - Converted leads: leads with convertedClientId set, under the lead's location.
 *  - Clients: Company not deleted, not merged; date range on the client's createdAt. The sales person
 *    and lead source filters follow the lead the client came from (Company.leadId); the sales person
 *    filter also takes clients created by that user. With a lead source chosen, clients without a
 *    source lead are left out.
 *  - Sales reps see only their own leads / clients (sales-access scope helpers).
 */

const { resolveTenantId, resolveUserId, isClientUser } = require('../utils/tenant.util');
const {
  hasPermission,
  isSalesAgentScoped,
  applySalesAgentLeadListScope,
  applySalesAgentClientListScope
} = require('../utils/sales-access.util');
const {
  LOCATION_PARTS,
  cleanLocation,
  locationRegex,
  parseLocationQuery,
  keysMatchLocation,
  andInto
} = require('../utils/location-filter.util');

const NOT_SET_NAME = 'Location not set';
const BEST_CONVERSION_MIN_LEADS = 5;

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getModel(req, name) {
  return req.cms?.models.get(name) || null;
}

/* ------------------------------------------------------------------ filters */

function parseDay(value, endOfDay) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else if (m) d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Normalise report filters from a query object.
 * from / to (or dateFrom / dateTo), state, district, city (+ *NotSet flags), assignedTo (or salesPerson), source.
 */
function parseFilters(req, query = {}) {
  const q = query || {};
  let from = parseDay(q.from || q.dateFrom, false);
  let to = parseDay(q.to || q.dateTo, true);
  if (from && to && from > to) {
    const swap = from;
    from = parseDay(q.to || q.dateTo, false);
    to = new Date(swap.getTime());
    to.setHours(23, 59, 59, 999);
  }
  let assignedTo = String(q.assignedTo || q.salesPerson || '').trim();
  // A sales rep cannot pick another user; their own scope applies anyway.
  if (assignedTo && isSalesAgentScoped(req) && assignedTo !== String(resolveUserId(req) || '')) {
    assignedTo = '';
  }
  return {
    from,
    to,
    assignedTo,
    source: cleanLocation(q.source),
    location: parseLocationQuery(q)
  };
}

function dateClause(field, from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return { [field]: range };
}

function sourceRegex(source) {
  return locationRegex(source);
}

/** Lead $match for the report (before the sales-rep scope is applied). */
function buildLeadMatch(req, filters) {
  const filter = { tenantId: resolveTenantId(req), isDeleted: false, mergedIntoId: null };
  const clauses = [];
  const dates = dateClause('createdAt', filters.from, filters.to);
  if (dates) clauses.push(dates);
  if (filters.source) clauses.push({ source: sourceRegex(filters.source) });
  if (filters.assignedTo) clauses.push({ assignedTo: filters.assignedTo });
  return andInto(filter, clauses);
}

/**
 * Clauses that tie a client to the lead it came from (generic; reused by the Clients list).
 *  - source: client.leadId is a lead with that source (clients without a source lead are left out)
 *  - assignedTo: client.leadId is a lead assigned to that user, or the client was created by that user
 */
async function buildClientOriginClauses(req, { source, assignedTo } = {}) {
  const clauses = [];
  const cleanSource = cleanLocation(source);
  const owner = String(assignedTo || '').trim();
  if (!cleanSource && !owner) return clauses;

  const Lead = getModel(req, 'Lead');
  const tenantId = resolveTenantId(req);
  const leadIds = async (extra) => {
    if (!Lead) return [];
    const rows = await Lead.find({ tenantId, ...extra }).select('_id').lean();
    return rows.map((row) => String(row._id));
  };

  if (cleanSource) {
    clauses.push({ leadId: { $in: await leadIds({ source: sourceRegex(cleanSource) }) } });
  }
  if (owner) {
    const ownedIds = await leadIds({ assignedTo: owner });
    clauses.push({ $or: [{ createdBy: owner }, { leadId: { $in: ownedIds } }] });
  }
  return clauses;
}

async function buildClientMatch(req, filters) {
  const filter = { tenantId: resolveTenantId(req), isDeleted: false, mergedIntoId: null };
  const clauses = [];
  const dates = dateClause('createdAt', filters.from, filters.to);
  if (dates) clauses.push(dates);
  clauses.push(...(await buildClientOriginClauses(req, filters)));
  return andInto(filter, clauses);
}

/* ------------------------------------------------------------------ aggregation */

/** Aggregation expression: the field as a string, trimmed, inner spaces collapsed. */
function cleanExpr(path) {
  return {
    $reduce: {
      input: {
        $filter: {
          input: { $split: [{ $trim: { input: { $toString: { $ifNull: [path, ''] } } } }, ' '] },
          as: 'w',
          cond: { $ne: ['$$w', ''] }
        }
      },
      initialValue: '',
      in: {
        $cond: [{ $eq: ['$$value', ''] }, '$$this', { $concat: ['$$value', ' ', '$$this'] }]
      }
    }
  };
}

/**
 * Pipeline: clean each location part, group by (normalised key + spelling) to count spellings,
 * then group by the normalised key alone. `withConverted` adds the converted-lead count.
 */
function buildLocationPipeline(match, paths, withConverted) {
  const project = {
    s: cleanExpr(`$${paths.state}`),
    d: cleanExpr(`$${paths.district}`),
    c: cleanExpr(`$${paths.city}`)
  };
  if (withConverted) {
    project.conv = {
      $cond: [{ $ne: [{ $ifNull: ['$convertedClientId', ''] }, ''] }, 1, 0]
    };
  }
  const firstGroup = {
    _id: {
      sk: { $toLower: '$s' },
      dk: { $toLower: '$d' },
      ck: { $toLower: '$c' },
      s: '$s',
      d: '$d',
      c: '$c'
    },
    n: { $sum: 1 }
  };
  if (withConverted) firstGroup.conv = { $sum: '$conv' };
  const secondGroup = {
    _id: { sk: '$_id.sk', dk: '$_id.dk', ck: '$_id.ck' },
    count: { $sum: '$n' },
    spellings: { $push: { s: '$_id.s', d: '$_id.d', c: '$_id.c', n: '$n' } }
  };
  if (withConverted) secondGroup.converted = { $sum: '$conv' };
  return [{ $match: match }, { $project: project }, { $group: firstGroup }, { $group: secondGroup }];
}

const LEAD_PATHS = { state: 'state', district: 'district', city: 'city' };
const CLIENT_PATHS = {
  state: 'billingAddress.state',
  district: 'billingAddress.district',
  city: 'billingAddress.city'
};

/* ------------------------------------------------------------------ tree */

function rateOf(converted, leads) {
  if (!leads) return null;
  return Math.round((converted / leads) * 1000) / 10;
}

/** Picks the most common spelling per key (first seen wins a tie). */
function createSpellingBook() {
  const book = new Map();
  return {
    add(key, spelling, n) {
      if (!key || !spelling) return;
      if (!book.has(key)) book.set(key, new Map());
      const counts = book.get(key);
      counts.set(spelling, (counts.get(spelling) || 0) + (Number(n) || 0));
    },
    name(key) {
      const counts = book.get(key);
      if (!counts) return key;
      let best = '';
      let bestN = -1;
      for (const [spelling, n] of counts) {
        if (n > bestN) {
          best = spelling;
          bestN = n;
        }
      }
      return best || key;
    }
  };
}

function newNode(level, key, name, filter) {
  return { level, key, name, leads: 0, clients: 0, converted: 0, rate: null, filter, children: [] };
}

function addCounts(node, counts) {
  node.leads += counts.leads;
  node.clients += counts.clients;
  node.converted += counts.converted;
}

function sortNodes(nodes) {
  nodes.sort((a, b) => b.leads - a.leads || b.clients - a.clients || String(a.name).localeCompare(String(b.name)));
  for (const node of nodes) {
    node.rate = rateOf(node.converted, node.leads);
    // A parent whose only child is its own "City not set" remainder shows no children.
    if (node.children.length === 1 && node.children[0].remainder) node.children = [];
    sortNodes(node.children);
    for (const child of node.children) delete child.remainder;
  }
  return nodes;
}

/**
 * Build the State → District → City tree from merged group rows.
 * @param {Array<{ keys: {state,district,city}, leads, clients, converted }>} groups
 */
function buildTree(groups, names) {
  const states = new Map();
  let notSet = null;

  for (const g of groups) {
    const { state: sk, district: dk, city: ck } = g.keys;
    if (!sk && !dk && !ck) {
      if (!notSet) notSet = newNode('state', 'not-set', NOT_SET_NAME, { locationNotSet: '1' });
      addCounts(notSet, g);
      continue;
    }

    const stateName = sk ? names.state.name(sk) : 'State not set';
    const stateFilter = sk ? { state: stateName } : { stateNotSet: '1' };
    const stateKey = `s:${sk}`;
    if (!states.has(stateKey)) states.set(stateKey, { node: newNode('state', stateKey, stateName, stateFilter), kids: new Map() });
    const stateEntry = states.get(stateKey);
    addCounts(stateEntry.node, g);

    let parentEntry = stateEntry;
    let parentFilter = stateFilter;
    let parentKey = stateKey;
    if (dk) {
      const districtName = names.district.name(dk);
      const districtKey = `${stateKey}|d:${dk}`;
      const districtFilter = { ...stateFilter, district: districtName };
      if (!stateEntry.kids.has(districtKey)) {
        stateEntry.kids.set(districtKey, { node: newNode('district', districtKey, districtName, districtFilter), kids: new Map() });
      }
      parentEntry = stateEntry.kids.get(districtKey);
      addCounts(parentEntry.node, g);
      parentFilter = districtFilter;
      parentKey = districtKey;
    } else {
      parentFilter = { ...stateFilter, districtNotSet: '1' };
    }

    const cityKey = `${parentKey}|c:${ck}`;
    if (!parentEntry.kids.has(cityKey)) {
      const cityName = ck ? names.city.name(ck) : 'City not set';
      const cityFilter = ck ? { ...parentFilter, city: cityName } : { ...parentFilter, cityNotSet: '1' };
      const cityNode = newNode('city', cityKey, cityName, cityFilter);
      if (!ck) cityNode.remainder = true;
      parentEntry.kids.set(cityKey, { node: cityNode, kids: new Map() });
    }
    addCounts(parentEntry.kids.get(cityKey).node, g);
  }

  const toNodes = (entries) =>
    [...entries.values()].map((entry) => {
      entry.node.children = toNodes(entry.kids);
      return entry.node;
    });
  const rows = toNodes(states);
  if (notSet) rows.push(notSet);
  return sortNodes(rows);
}

/** Leaf locations (excluding the not-set rows) with a readable path name. */
function collectLeaves(nodes, trail = [], out = []) {
  for (const node of nodes) {
    if (node.key === 'not-set') continue;
    const isStateNotSet = node.level === 'state' && node.filter.stateNotSet;
    const path = isStateNotSet ? trail : [node.name, ...trail];
    if (node.children.length) {
      collectLeaves(node.children, path, out);
    } else if (!(node.level === 'city' && node.filter.cityNotSet) && !isStateNotSet) {
      out.push({ name: path.join(', '), leads: node.leads, converted: node.converted, rate: node.rate });
    }
  }
  return out;
}

function buildSummary(rows, totals) {
  const leaves = collectLeaves(rows);
  let topLocation = null;
  let bestConversion = null;
  for (const leaf of leaves) {
    if (leaf.leads > 0 && (!topLocation || leaf.leads > topLocation.leads)) {
      topLocation = { name: leaf.name, leads: leaf.leads };
    }
    if (leaf.leads >= BEST_CONVERSION_MIN_LEADS) {
      if (
        !bestConversion ||
        leaf.rate > bestConversion.rate ||
        (leaf.rate === bestConversion.rate && leaf.leads > bestConversion.leads)
      ) {
        bestConversion = { name: leaf.name, rate: leaf.rate, leads: leaf.leads };
      }
    }
  }
  return { ...totals, topLocation, bestConversion };
}

/* ------------------------------------------------------------------ options */

function sortedNames(set) {
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function buildOptions(groups, names, location, leadSources) {
  const states = new Set();
  const districts = new Set();
  const cities = new Set();
  const stateKey = location.state ? location.state.toLowerCase() : '';
  const districtKey = location.district ? location.district.toLowerCase() : '';
  for (const g of groups) {
    const { state: sk, district: dk, city: ck } = g.keys;
    if (sk) states.add(names.state.name(sk));
    const inState = !stateKey || sk === stateKey;
    if (dk && inState) districts.add(names.district.name(dk));
    if (ck && inState && (!districtKey || dk === districtKey)) cities.add(names.city.name(ck));
  }
  return {
    states: sortedNames(states),
    districts: sortedNames(districts),
    cities: sortedNames(cities),
    leadSources
  };
}

async function loadLeadSources(req, Lead, scopedBase) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const clean = cleanLocation(value);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
  try {
    const SettingService = require('./setting.service');
    (await SettingService.getLeadSources(req)).forEach(add);
  } catch {
    /* settings unavailable — fall back to the sources in use */
  }
  if (Lead && typeof Lead.distinct === 'function') {
    try {
      (await Lead.distinct('source', scopedBase)).forEach(add);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ report */

/**
 * @param {object} req
 * @param {object} query — from/to, state, district, city, *NotSet flags, assignedTo, source
 */
async function locationReport(req, query = {}) {
  if (isClientUser(req)) throw appError('Reports are not available for client logins', 403);

  const filters = parseFilters(req, query);
  const Lead = getModel(req, 'Lead');
  const Company = getModel(req, 'Company');
  const canLeads = Boolean(Lead) && hasPermission(req, 'crm.leads.read');
  const canClients = Boolean(Company) && hasPermission(req, 'crm.clients.read');
  const getLeadModel = () => Lead;

  const [leadGroups, clientGroups, leadSources] = await Promise.all([
    canLeads
      ? Lead.aggregate(
          buildLocationPipeline(applySalesAgentLeadListScope(req, buildLeadMatch(req, filters)), LEAD_PATHS, true)
        )
      : [],
    canClients
      ? (async () => {
          const match = await applySalesAgentClientListScope(req, await buildClientMatch(req, filters), getLeadModel);
          return Company.aggregate(buildLocationPipeline(match, CLIENT_PATHS, false));
        })()
      : [],
    canLeads
      ? loadLeadSources(
          req,
          Lead,
          applySalesAgentLeadListScope(req, { tenantId: resolveTenantId(req), isDeleted: false, mergedIntoId: null })
        )
      : []
  ]);

  // Merge leads and clients on the normalised keys; remember every spelling.
  const names = { state: createSpellingBook(), district: createSpellingBook(), city: createSpellingBook() };
  const merged = new Map();
  const take = (rows, kind) => {
    for (const row of rows || []) {
      const id = row._id || {};
      const keys = { state: id.sk || '', district: id.dk || '', city: id.ck || '' };
      for (const sp of row.spellings || []) {
        names.state.add(keys.state, sp.s, sp.n);
        names.district.add(keys.district, sp.d, sp.n);
        names.city.add(keys.city, sp.c, sp.n);
      }
      const mapKey = LOCATION_PARTS.map((p) => keys[p]).join('\u0001');
      if (!merged.has(mapKey)) merged.set(mapKey, { keys, leads: 0, clients: 0, converted: 0 });
      const entry = merged.get(mapKey);
      if (kind === 'lead') {
        entry.leads += Number(row.count) || 0;
        entry.converted += Number(row.converted) || 0;
      } else {
        entry.clients += Number(row.count) || 0;
      }
    }
  };
  take(leadGroups, 'lead');
  take(clientGroups, 'client');

  const allGroups = [...merged.values()];
  const groups = allGroups.filter((g) => keysMatchLocation(g.keys, filters.location));

  const totals = groups.reduce(
    (acc, g) => {
      acc.totalLeads += g.leads;
      acc.totalClients += g.clients;
      acc.convertedLeads += g.converted;
      return acc;
    },
    { totalLeads: 0, totalClients: 0, convertedLeads: 0 }
  );

  const rows = buildTree(groups, names);

  return {
    summary: buildSummary(rows, totals),
    rows,
    options: buildOptions(allGroups, names, filters.location, leadSources),
    filters: {
      from: filters.from ? filters.from.toISOString() : null,
      to: filters.to ? filters.to.toISOString() : null,
      assignedTo: filters.assignedTo,
      source: filters.source,
      state: filters.location.state,
      district: filters.location.district,
      city: filters.location.city
    },
    meta: {
      canFilterSalesPerson: !isSalesAgentScoped(req),
      bestConversionMinLeads: BEST_CONVERSION_MIN_LEADS
    }
  };
}

module.exports = {
  locationReport,
  buildClientOriginClauses,
  buildLocationPipeline,
  parseFilters,
  rateOf,
  NOT_SET_NAME,
  BEST_CONVERSION_MIN_LEADS
};
