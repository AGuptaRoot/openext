'use strict';

/**
 * Tiny semver range matcher for extension `compatibility.crm` checks.
 *
 * Supports what package authors actually write: `>=3.5.0`, `^3.5.0`, `~3.5.0`,
 * `3.x`, `3.5.*`, `*`, exact versions, space-separated AND (`>=3.5.0 <4.0.0`)
 * and `||` OR. Pre-release tags are ignored. No dependency on the semver package.
 */

const VERSION_RE = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/;

function parseVersion(input) {
  const match = VERSION_RE.exec(String(input || '').trim());
  if (!match) return null;
  const part = (value) => (value === undefined || value === 'x' || value === '*' ? null : Number(value));
  return { major: Number(match[1]), minor: part(match[2]), patch: part(match[3]) };
}

function compare(a, b) {
  const pa = [a.major, a.minor || 0, a.patch || 0];
  const pb = [b.major, b.minor || 0, b.patch || 0];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** Turn one comparator (`>=1.2.0`, `^1.2`, `1.x`, `*`) into a predicate. */
function comparator(token) {
  const raw = String(token || '').trim();
  if (!raw || raw === '*' || raw === 'x') return () => true;

  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(raw);
  if (!match) return null;
  const op = match[1] || '';
  const target = parseVersion(match[2]);
  if (!target) return null;

  const lower = { major: target.major, minor: target.minor || 0, patch: target.patch || 0 };

  if (op === '>=') return (v) => compare(v, lower) >= 0;
  if (op === '>') return (v) => compare(v, lower) > 0;
  if (op === '<=') return (v) => compare(v, lower) <= 0;
  if (op === '<') return (v) => compare(v, lower) < 0;

  // Upper bound for ^, ~, wildcards and exact versions.
  let upper;
  if (op === '^') {
    upper =
      lower.major > 0
        ? { major: lower.major + 1, minor: 0, patch: 0 }
        : lower.minor > 0
          ? { major: 0, minor: lower.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: lower.patch + 1 };
  } else if (op === '~' || (target.minor !== null && target.patch === null)) {
    upper = { major: lower.major, minor: lower.minor + 1, patch: 0 };
  } else if (target.minor === null) {
    upper = { major: lower.major + 1, minor: 0, patch: 0 };
  } else {
    return (v) => compare(v, lower) === 0;
  }
  return (v) => compare(v, lower) >= 0 && compare(v, upper) < 0;
}

/**
 * @param {string} version  e.g. "3.5.1"
 * @param {string} range    e.g. ">=3.5.0 <4.0.0 || ^5.0.0"
 * @returns {boolean|null}  null when the range cannot be parsed
 */
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || v.minor === null || v.patch === null) return null;
  const alternatives = String(range || '')
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!alternatives.length) return null;

  for (const alternative of alternatives) {
    const predicates = alternative.split(/\s+/).filter(Boolean).map(comparator);
    if (predicates.some((p) => p === null)) return null;
    if (predicates.every((p) => p(v))) return true;
  }
  return false;
}

function isValidRange(range) {
  return satisfies('1.0.0', range) !== null;
}

module.exports = { satisfies, isValidRange, parseVersion, compareVersions: compare };
