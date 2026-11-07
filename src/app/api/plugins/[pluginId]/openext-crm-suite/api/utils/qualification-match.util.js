'use strict';

/**
 * Score Commercial Requirement against Settings → Qualification Match catalogs.
 * Equal weight per filled criterion; multi-select = matched/selected × 100.
 */

const DEFAULT_CATALOG = Object.freeze({
  projectSoftwareTypes: ['Web App', 'Mobile App', 'Embedded System', 'Desktop Software', 'Other'],
  projectTechnologies: ['React', 'Next.js', 'Node.js', 'Python', '.NET', 'Java', 'Flutter'],
  projectUserBands: ['1-10', '11-50', '51-200', '201-1000', '1000+'],
  projectIntegrations: ['CRM', 'ERP', 'Payment Gateway', 'Email / SMS', 'Accounting', 'Custom API'],
  productCategories: ['Hardware', 'Software License', 'SaaS Subscription', 'Accessory', 'Spare Part'],
  productSpecifications: ['Standard', 'Premium', 'Custom', 'Industrial Grade'],
  productCertifications: ['ISO', 'CE', 'BIS', 'RoHS', 'None']
});

function norm(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function inCatalog(value, catalog) {
  const n = norm(value);
  if (!n) return false;
  return (catalog || []).some((item) => norm(item) === n);
}

function scoreSingle(value, catalog, label, key) {
  if (!String(value || '').trim()) return null;
  if (!(catalog || []).length) {
    return { key, label, score: 0, detail: 'No admin catalog configured for this field' };
  }
  const matched = inCatalog(value, catalog);
  return {
    key,
    label,
    score: matched ? 100 : 0,
    detail: matched
      ? `"${value}" matches Qualification Match catalog`
      : `"${value}" is not in Qualification Match catalog`
  };
}

function scoreMulti(selected, catalog, label, key) {
  const items = (selected || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!items.length) return null;
  if (!(catalog || []).length) {
    return { key, label, score: 0, detail: 'No admin catalog configured for this field' };
  }
  const matched = items.filter((item) => inCatalog(item, catalog));
  const score = Math.round((matched.length / items.length) * 100);
  return {
    key,
    label,
    score,
    detail: `${matched.length} of ${items.length} selected value(s) match catalog`
  };
}

function normalizeCatalog(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (key) =>
    Array.isArray(source[key]) && source[key].length
      ? source[key].map((v) => String(v || '').trim()).filter(Boolean)
      : [...DEFAULT_CATALOG[key]];
  return {
    projectSoftwareTypes: pick('projectSoftwareTypes'),
    projectTechnologies: pick('projectTechnologies'),
    projectUserBands: pick('projectUserBands'),
    projectIntegrations: pick('projectIntegrations'),
    productCategories: pick('productCategories'),
    productSpecifications: pick('productSpecifications'),
    productCertifications: pick('productCertifications')
  };
}

function computeScore(commercial, catalogRaw) {
  const catalog = normalizeCatalog(catalogRaw);
  const kind = commercial?.kind || '';
  const breakdown = [];

  if (kind === 'project' && commercial.project) {
    const p = commercial.project;
    const parts = [
      scoreSingle(p.softwareType, catalog.projectSoftwareTypes, 'Software type', 'softwareType'),
      scoreMulti(p.technologies, catalog.projectTechnologies, 'Technologies', 'technologies'),
      scoreSingle(p.numberOfUsers, catalog.projectUserBands, 'Number of users', 'numberOfUsers'),
      scoreMulti(p.integrations, catalog.projectIntegrations, 'Integrations', 'integrations')
    ];
    parts.forEach((part) => part && breakdown.push(part));
  } else if (kind === 'product' && commercial.product) {
    const p = commercial.product;
    const parts = [
      scoreSingle(p.category, catalog.productCategories, 'Product category', 'category'),
      scoreSingle(p.specification, catalog.productSpecifications, 'Specification', 'specification'),
      scoreMulti(p.certifications, catalog.productCertifications, 'Certifications', 'certifications')
    ];
    parts.forEach((part) => part && breakdown.push(part));
  }

  if (!breakdown.length) return { score: null, breakdown: [] };
  const score = Math.round(breakdown.reduce((sum, item) => sum + item.score, 0) / breakdown.length);
  return { score, breakdown };
}

function cleanStringList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeCommercialInput(input = {}, requestType = '') {
  const rt = String(requestType || '').trim().toLowerCase();
  let kind = String(input.kind || '').trim().toLowerCase();
  if (kind !== 'project' && kind !== 'product') {
    if (rt.includes('project')) kind = 'project';
    else if (rt.includes('product')) kind = 'product';
    else kind = '';
  }

  const projectIn = input.project && typeof input.project === 'object' ? input.project : {};
  const productIn = input.product && typeof input.product === 'object' ? input.product : {};

  const budgetRaw = projectIn.budget;
  const budget =
    budgetRaw === '' || budgetRaw === undefined || budgetRaw === null
      ? null
      : Number(budgetRaw);
  const qtyRaw = productIn.quantity;
  const quantity =
    qtyRaw === '' || qtyRaw === undefined || qtyRaw === null ? null : Number(qtyRaw);

  return {
    kind,
    project: {
      softwareType: String(projectIn.softwareType || '').trim(),
      technologies: cleanStringList(projectIn.technologies),
      modulesFeatures: cleanStringList(projectIn.modulesFeatures),
      numberOfUsers: String(projectIn.numberOfUsers || '').trim(),
      integrations: cleanStringList(projectIn.integrations),
      budget: Number.isFinite(budget) ? budget : null,
      expectedDelivery: String(projectIn.expectedDelivery || '').trim()
    },
    product: {
      productName: String(productIn.productName || '').trim(),
      category: String(productIn.category || '').trim(),
      specification: String(productIn.specification || '').trim(),
      targetPrice: String(productIn.targetPrice || '').trim(),
      certifications: cleanStringList(productIn.certifications),
      quantity: Number.isFinite(quantity) ? quantity : null
    }
  };
}

/**
 * Normalize dynamic commercial values against a Request Type field schema.
 */
function normalizeDynamicValues(fields, rawValues) {
  const source = rawValues && typeof rawValues === 'object' ? rawValues : {};
  const values = {};
  for (const field of fields || []) {
    const key = String(field.key || '').trim();
    if (!key) continue;
    const raw = source[key];
    if (field.type === 'multiselect') {
      values[key] = cleanStringList(Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : []);
    } else if (field.type === 'number') {
      if (raw === '' || raw === undefined || raw === null) values[key] = null;
      else {
        const num = Number(raw);
        values[key] = Number.isFinite(num) ? num : null;
      }
    } else {
      values[key] = String(raw ?? '').trim();
    }
  }
  return values;
}

function scoreNumberField(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return {
      key: field.key,
      label: field.label,
      score: 0,
      status: 'unmatched',
      detail: 'Invalid number'
    };
  }
  const hasMin = field.matchNumberMin != null && Number.isFinite(Number(field.matchNumberMin));
  const hasMax = field.matchNumberMax != null && Number.isFinite(Number(field.matchNumberMax));
  if (!hasMin && !hasMax && !(field.matchValues || []).length) {
    return {
      key: field.key,
      label: field.label,
      score: 100,
      status: 'matched',
      detail: 'Value provided (no range configured)'
    };
  }
  if (hasMin || hasMax) {
    const min = hasMin ? Number(field.matchNumberMin) : -Infinity;
    const max = hasMax ? Number(field.matchNumberMax) : Infinity;
    const ok = num >= min && num <= max;
    return {
      key: field.key,
      label: field.label,
      score: ok ? 100 : 0,
      status: ok ? 'matched' : 'unmatched',
      detail: ok
        ? `${num} is within supported range ${hasMin ? min : '…'}–${hasMax ? max : '…'}`
        : `${num} is outside supported range ${hasMin ? min : '…'}–${hasMax ? max : '…'}`
    };
  }
  const asText = String(num);
  const matched = inCatalog(asText, field.matchValues || []);
  return {
    key: field.key,
    label: field.label,
    score: matched ? 100 : 0,
    status: matched ? 'matched' : 'unmatched',
    detail: matched
      ? `"${asText}" matches Qualification Match catalog`
      : `"${asText}" is not in Qualification Match catalog`
  };
}

/** Build a Set of normalized lead-specific option values for a field. */
function leadSpecificValueSet(customOptions, fieldKey) {
  const list = customOptions && typeof customOptions === 'object' ? customOptions[fieldKey] : null;
  const set = new Set();
  if (!Array.isArray(list)) return set;
  for (const item of list) {
    const value =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? item.value || item.label
          : '';
    const n = norm(value);
    if (n) set.add(n);
  }
  return set;
}

function isLeadSpecificValue(customOptions, fieldKey, value) {
  return leadSpecificValueSet(customOptions, fieldKey).has(norm(value));
}

/**
 * Score dynamic commercial values against Request Type field match config.
 * Lead-specific options not present in Qualification Match catalog → unmatched.
 * Returns score, breakdown, matched / unmatched / missing lists.
 */
function computeDynamicScore(requestType, valuesRaw, options = {}) {
  const fields = Array.isArray(requestType?.fields) ? requestType.fields : [];
  const values = normalizeDynamicValues(fields, valuesRaw);
  const customOptions =
    options.customOptions && typeof options.customOptions === 'object'
      ? options.customOptions
      : {};
  const breakdown = [];
  const matched = [];
  const unmatched = [];
  const missing = [];

  for (const field of fields) {
    if (field.matchEnabled === false) continue;
    const label = field.label || field.key;
    const raw = values[field.key];

    if (field.type === 'multiselect') {
      const items = Array.isArray(raw) ? raw : [];
      if (!items.length) {
        if (field.required) missing.push({ key: field.key, label, detail: 'Required value missing' });
        continue;
      }
      const catalog = field.matchValues || [];
      const leadOnly = items.filter((item) => isLeadSpecificValue(customOptions, field.key, item));
      const leadNotInCatalog = leadOnly.filter((item) => !inCatalog(item, catalog));

      if (!catalog.length) {
        // No match catalog: global options count as matched; lead-specific stay unmatched.
        if (leadNotInCatalog.length === items.length) {
          const part = {
            key: field.key,
            label,
            score: 0,
            status: 'unmatched',
            detail: `Lead-specific option(s) not configured in Qualification Match: ${leadNotInCatalog.join(', ')}`
          };
          breakdown.push(part);
          unmatched.push(part);
          continue;
        }
        if (leadNotInCatalog.length) {
          const globalCount = items.length - leadNotInCatalog.length;
          const score = Math.round((globalCount / items.length) * 100);
          const part = {
            key: field.key,
            label,
            score,
            status: score >= 100 ? 'matched' : score > 0 ? 'partial' : 'unmatched',
            detail: `${leadNotInCatalog.join(', ')} — Not Configured / Unmatched (lead-specific)`
          };
          breakdown.push(part);
          if (score >= 100) matched.push(part);
          else unmatched.push(part);
          continue;
        }
        const part = {
          key: field.key,
          label,
          score: 100,
          status: 'matched',
          detail: 'Value provided (no Qualification Match catalog configured)'
        };
        breakdown.push(part);
        matched.push(part);
        continue;
      }

      const hit = items.filter((item) => inCatalog(item, catalog));
      const score = Math.round((hit.length / items.length) * 100);
      const notConfigured = items.filter((item) => !inCatalog(item, catalog));
      const leadNote = notConfigured.filter((item) =>
        isLeadSpecificValue(customOptions, field.key, item)
      );
      let detail = `${hit.length} of ${items.length} selected value(s) match catalog`;
      if (leadNote.length) {
        detail += `. Lead-specific not configured: ${leadNote.join(', ')}`;
      } else if (notConfigured.length) {
        detail += `. Unmatched: ${notConfigured.join(', ')}`;
      }
      const part = {
        key: field.key,
        label,
        score,
        status: score >= 100 ? 'matched' : score > 0 ? 'partial' : 'unmatched',
        detail
      };
      breakdown.push(part);
      if (score >= 100) matched.push(part);
      else unmatched.push(part);
      continue;
    }

    if (field.type === 'number') {
      if (raw === null || raw === undefined || raw === '') {
        if (field.required) missing.push({ key: field.key, label, detail: 'Required value missing' });
        continue;
      }
      const part = scoreNumberField(raw, field);
      if (!part) continue;
      breakdown.push(part);
      if (part.status === 'matched') matched.push(part);
      else unmatched.push(part);
      continue;
    }

    const text = String(raw ?? '').trim();
    if (!text) {
      if (field.required) missing.push({ key: field.key, label, detail: 'Required value missing' });
      continue;
    }
    const catalog = field.matchValues || [];
    const leadSpecific = isLeadSpecificValue(customOptions, field.key, text);

    if (leadSpecific && !inCatalog(text, catalog)) {
      const part = {
        key: field.key,
        label,
        score: 0,
        status: 'unmatched',
        detail: `"${text}" — Not Configured / Unmatched (lead-specific option)`
      };
      breakdown.push(part);
      unmatched.push(part);
      continue;
    }

    if (!catalog.length) {
      const part = {
        key: field.key,
        label,
        score: 100,
        status: 'matched',
        detail: 'Value provided (no Qualification Match catalog configured)'
      };
      breakdown.push(part);
      matched.push(part);
      continue;
    }
    const ok = inCatalog(text, catalog);
    const part = {
      key: field.key,
      label,
      score: ok ? 100 : 0,
      status: ok ? 'matched' : 'unmatched',
      detail: ok
        ? `"${text}" matches Qualification Match catalog`
        : `"${text}" is not in Qualification Match catalog`
    };
    breakdown.push(part);
    if (ok) matched.push(part);
    else unmatched.push(part);
  }

  if (!breakdown.length) {
    return { score: null, breakdown: [], matched, unmatched, missing, values };
  }
  const score = Math.round(breakdown.reduce((sum, item) => sum + item.score, 0) / breakdown.length);
  return { score, breakdown, matched, unmatched, missing, values };
}

/**
 * Map legacy project/product commercial into dynamic values for seeded types.
 */
function legacyValuesFromCommercial(commercial) {
  const kind = commercial?.kind || '';
  if (kind === 'project' && commercial.project) {
    const p = commercial.project;
    return {
      software_type: p.softwareType || '',
      technologies: p.technologies || [],
      number_of_users: p.numberOfUsers || '',
      integrations: p.integrations || [],
      budget: p.budget,
      modules_features: Array.isArray(p.modulesFeatures)
        ? p.modulesFeatures.join(', ')
        : String(p.modulesFeatures || '')
    };
  }
  if (kind === 'product' && commercial.product) {
    const p = commercial.product;
    return {
      product_name: p.productName || '',
      category: p.category || '',
      specification: p.specification || '',
      certifications: p.certifications || [],
      target_price: p.targetPrice || '',
      quantity: p.quantity
    };
  }
  return {};
}

module.exports = {
  DEFAULT_CATALOG,
  normalizeCatalog,
  computeScore,
  normalizeCommercialInput,
  normalizeDynamicValues,
  computeDynamicScore,
  legacyValuesFromCommercial
};
