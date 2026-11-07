'use strict';

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

const DEFAULT_LEAD_WEIGHTS = {
  name: 10,
  email: 15,
  phone: 15,
  company: 15,
  pan: 15,
  address: 10,
  owner: 10,
  duplicates: 10
};

const DEFAULT_CLIENT_WEIGHTS = {
  name: 15,
  email: 15,
  phone: 15,
  website: 10,
  address: 15,
  taxId: 10,
  contact: 10,
  duplicates: 10
};

function qualityLabel(score, thresholds = {}) {
  const excellent = Number(thresholds.excellent) || 85;
  const good = Number(thresholds.good) || 70;
  const needsAttention = Number(thresholds.needsAttention) || 50;

  if (score >= excellent) return 'Excellent';
  if (score >= good) return 'Good';
  if (score >= needsAttention) return 'Needs attention';
  return 'Incomplete';
}

function buildScore(checks, thresholds = {}) {
  const score = checks.reduce((total, check) => total + (check.complete ? check.weight : 0), 0);
  return {
    score,
    label: qualityLabel(score, thresholds),
    missing: checks.filter((check) => !check.complete).map((check) => check.label),
    checks
  };
}

function getWeight(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function scoreLead(lead, options = {}, customWeights = null, thresholds = {}) {
  const weights = { ...DEFAULT_LEAD_WEIGHTS, ...(customWeights || {}) };
  return buildScore(
    [
      { key: 'name', label: 'Full name', weight: getWeight(weights.name, 10), complete: present(lead?.name) },
      { key: 'email', label: 'Valid email', weight: getWeight(weights.email, 15), complete: present(lead?.email) },
      { key: 'phone', label: 'Valid mobile number', weight: getWeight(weights.phone, 15), complete: present(lead?.phone) },
      { key: 'company', label: 'Company name', weight: getWeight(weights.company, 15), complete: present(lead?.company) },
      { key: 'pan', label: 'PAN number', weight: getWeight(weights.pan, 15), complete: present(lead?.pan) },
      { key: 'address', label: 'Address', weight: getWeight(weights.address, 10), complete: present(lead?.address) },
      { key: 'owner', label: 'Assigned owner', weight: getWeight(weights.owner, 10), complete: present(lead?.assignedTo) },
      {
        key: 'duplicates',
        label: 'No possible duplicate',
        weight: getWeight(weights.duplicates, 10),
        complete: options.hasDuplicate === false
      }
    ],
    thresholds
  );
}

function scoreClient(client, options = {}, customWeights = null, thresholds = {}) {
  const weights = { ...DEFAULT_CLIENT_WEIGHTS, ...(customWeights || {}) };
  const address = client?.billingAddress || {};
  const addressComplete = ['street', 'city', 'state', 'country', 'zip'].every((key) => present(address[key]));
  return buildScore(
    [
      { key: 'name', label: 'Company name', weight: getWeight(weights.name, 15), complete: present(client?.name) },
      { key: 'email', label: 'Company email', weight: getWeight(weights.email, 15), complete: present(client?.email) },
      { key: 'phone', label: 'Company mobile number', weight: getWeight(weights.phone, 15), complete: present(client?.phone) },
      { key: 'website', label: 'Website', weight: getWeight(weights.website, 10), complete: present(client?.website) },
      { key: 'address', label: 'Complete billing address', weight: getWeight(weights.address, 15), complete: addressComplete },
      { key: 'taxId', label: 'Tax ID', weight: getWeight(weights.taxId, 10), complete: present(client?.taxId) },
      { key: 'contact', label: 'At least one contact', weight: getWeight(weights.contact, 10), complete: Number(options.contactCount) > 0 },
      {
        key: 'duplicates',
        label: 'No possible duplicate',
        weight: getWeight(weights.duplicates, 10),
        complete: options.hasDuplicate === false
      }
    ],
    thresholds
  );
}

module.exports = {
  qualityLabel,
  scoreLead,
  scoreClient,
  DEFAULT_LEAD_WEIGHTS,
  DEFAULT_CLIENT_WEIGHTS
};
