'use strict';

const LEGAL_SUFFIXES = new Set([
  'co', 'company', 'corp', 'corporation', 'inc', 'incorporated',
  'limited', 'llc', 'llp', 'ltd', 'plc', 'private', 'pvt'
]);
const COMPANY_SIMILARITY_THRESHOLD = 0.82;

function normalizeCompanyName(value) {
  const words = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/([a-z0-9])\.([a-z0-9])/g, '$1$2')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function buildCompanyTokens(value) {
  const words = normalizeCompanyName(value).split(' ').filter(Boolean);
  const tokens = new Set();
  for (const word of words) {
    tokens.add(word);
    if (word.length > 4) tokens.add(word.slice(0, 4));
  }
  return [...tokens].slice(0, 20);
}

function diceCoefficient(left, right) {
  if (left === right) return left ? 1 : 0;
  if (left.length < 2 || right.length < 2) return 0;
  const leftPairs = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    leftPairs.set(pair, (leftPairs.get(pair) || 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = leftPairs.get(pair) || 0;
    if (count > 0) {
      intersection += 1;
      leftPairs.set(pair, count - 1);
    }
  }
  return (2 * intersection) / (left.length + right.length - 2);
}

function tokenSimilarity(left, right) {
  const leftTokens = left.split(' ').filter(Boolean);
  const rightTokens = right.split(' ').filter(Boolean);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const used = new Set();
  let matches = 0;
  for (const leftToken of leftTokens) {
    const index = rightTokens.findIndex((rightToken, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      if (leftToken === rightToken) return true;
      const shorter = leftToken.length <= rightToken.length ? leftToken : rightToken;
      const longer = leftToken.length > rightToken.length ? leftToken : rightToken;
      return shorter.length >= 4 && longer.startsWith(shorter);
    });
    if (index >= 0) {
      used.add(index);
      matches += 1;
    }
  }
  return matches / Math.max(leftTokens.length, rightTokens.length);
}

function companySimilarity(leftValue, rightValue) {
  const left = normalizeCompanyName(leftValue);
  const right = normalizeCompanyName(rightValue);
  if (!left || !right) return 0;
  return Math.max(diceCoefficient(left, right), tokenSimilarity(left, right));
}

function duplicateReasons(input, candidate) {
  const reasons = [];
  if (input.email && String(candidate.email || '').toLowerCase() === input.email) reasons.push('email');
  if (input.phone && String(candidate.phone || '') === input.phone) reasons.push('mobile');
  if (input.pan && String(candidate.pan || '').toUpperCase() === input.pan) reasons.push('PAN');

  const similarity = companySimilarity(input.company, candidate.company);
  if (similarity >= COMPANY_SIMILARITY_THRESHOLD) reasons.push('company');
  return { reasons, companySimilarity: similarity };
}

module.exports = {
  COMPANY_SIMILARITY_THRESHOLD,
  normalizeCompanyName,
  buildCompanyTokens,
  diceCoefficient,
  tokenSimilarity,
  companySimilarity,
  duplicateReasons
};
