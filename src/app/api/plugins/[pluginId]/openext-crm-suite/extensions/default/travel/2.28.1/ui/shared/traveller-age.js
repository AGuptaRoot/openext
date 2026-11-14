/**
 * Traveller calculation and formatting helpers:
 * - Age and category (Adult, Child, Infant) from DOB / Year of Birth
 * - Passport expiry warning
 * - Date display formatting (DD Mon YYYY)
 * - Name capitalization (Title Case)
 * - Passport / Aadhaar format cleaning and Verhoeff validation
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(value) {
  const m = DATE_RE.exec(String(value || ''));
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Today on this device's calendar (date-only; never the UTC day, which can be a day off). */
export function todayIso(now) {
  const d = now ? new Date(now) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addMonths(iso, months) {
  if (!isValidDate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return date.toISOString().slice(0, 10);
}

/** Full years from dob to ref (both YYYY-MM-DD). */
export function yearsBetween(dob, ref) {
  if (!isValidDate(dob) || !isValidDate(ref)) return null;
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ry, rm, rd] = ref.split('-').map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

export function categoryForAge(age) {
  if (age === null || age === undefined || !Number.isFinite(age) || age < 0) return '';
  if (age < 2) return 'Infant';
  if (age < 12) return 'Child';
  return 'Adult';
}

/**
 * Calculate age and category on the reference date.
 * @returns {{ age: number|null, ageApproximate: boolean, ageCategory: string }}
 */
export function calculateAgeInfo({ dob, yearOfBirth }, referenceDate) {
  const ref = isValidDate(referenceDate) ? referenceDate : todayIso();
  if (isValidDate(dob)) {
    const age = yearsBetween(dob, ref);
    return {
      age: age !== null && age >= 0 ? age : null,
      ageApproximate: false,
      ageCategory: categoryForAge(age)
    };
  }
  const yob = Number(yearOfBirth);
  if (Number.isInteger(yob) && yob > 1880) {
    const refYear = Number(ref.slice(0, 4));
    const age = refYear - yob;
    return {
      age: age >= 0 ? age : null,
      ageApproximate: true,
      ageCategory: categoryForAge(age)
    };
  }
  return { age: null, ageApproximate: false, ageCategory: '' };
}

/**
 * Passport expiry warning compared with referenceDate:
 * '' | 'expired' | 'before_travel' | 'within_6_months'
 */
export function calculateExpiryWarning(expiryDate, referenceDate, now) {
  if (!isValidDate(expiryDate)) return '';
  const today = todayIso(now);
  const ref = isValidDate(referenceDate) ? referenceDate : today;
  if (expiryDate < today) return 'expired';
  if (expiryDate < ref) return 'before_travel';
  if (expiryDate < addMonths(ref, 6)) return 'within_6_months';
  return '';
}

export function expiryWarningLabel(warning) {
  switch (warning) {
    case 'expired':
      return 'Passport has expired';
    case 'before_travel':
      return 'Passport expires before the trip';
    case 'within_6_months':
      return 'Many countries need 6 months of passport validity after the trip';
    default:
      return '';
  }
}

/** Format YYYY-MM-DD as '12 May 1990' */
export function formatDisplayDate(iso) {
  if (!isValidDate(iso)) return iso || '—';
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Format age for display: e.g. '36 yrs', 'about 36 yrs', or '—' */
export function formatAgeDisplay(age, approximate) {
  if (age === null || age === undefined || !Number.isFinite(age)) return '';
  const suffix = age === 1 ? 'yr' : 'yrs';
  return approximate ? `about ${age} ${suffix}` : `${age} ${suffix}`;
}

/** Convert string to Title Case (e.g. PRIYA SHARMA -> Priya Sharma) */
export function toTitleCase(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/(^|\s|[-'])\p{L}/gu, (m) => m.toUpperCase());
}

/** Passport number cleaning: uppercase alphanumeric */
export function cleanPassportNumber(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* ---------------------------------------------------------------- Aadhaar */

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

export function verhoeffValid(digits) {
  let c = 0;
  const list = String(digits).split('').reverse().map(Number);
  for (let i = 0; i < list.length; i += 1) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][list[i]]];
  return c === 0;
}

export function isValidAadhaar(value) {
  const digits = String(value || '').replace(/\s+/g, '');
  return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
}

/* ------------------------------------------------- passport ↔ Aadhaar check */

/** Name words, compared without case, accents, dots or hyphens ("D'Souza" = "DSOUZA"). */
function nameWords(person) {
  return `${(person && person.firstName) || ''} ${(person && person.lastName) || ''}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function birthYear(person) {
  if (person && isValidDate(person.dob)) return Number(person.dob.slice(0, 4));
  const y = Number(person && person.yearOfBirth);
  return Number.isInteger(y) && y > 1880 ? y : null;
}

function birthText(person, referenceDate) {
  const info = calculateAgeInfo({ dob: person.dob, yearOfBirth: person.yearOfBirth }, referenceDate);
  const when = isValidDate(person.dob) ? formatDisplayDate(person.dob) : `born ${birthYear(person)}`;
  return info.age === null ? when : `${when} (${formatAgeDisplay(info.age, info.ageApproximate)})`;
}

/**
 * Differences between the details read from the passport and from the Aadhaar card.
 * Only what both documents show is compared: name, date of birth (or year, when the card shows only the
 * year) and gender. [] when everything readable matches or one of them was not read.
 * @returns {{ field: 'name'|'age'|'gender', label: string, passport: string, aadhaar: string }[]}
 */
export function compareDocumentIdentity(passport, aadhaar, referenceDate) {
  if (!passport || !aadhaar) return [];
  const out = [];
  const a = nameWords(passport);
  const b = nameWords(aadhaar);
  if (a.length && b.length && a.join(' ') !== b.join(' ')) {
    const show = (p) => [p.firstName, p.lastName].filter(Boolean).join(' ');
    out.push({ field: 'name', label: 'Name', passport: show(passport), aadhaar: show(aadhaar) });
  }
  const bothDates = isValidDate(passport.dob) && isValidDate(aadhaar.dob);
  const ya = birthYear(passport);
  const yb = birthYear(aadhaar);
  if ((bothDates && passport.dob !== aadhaar.dob) || (!bothDates && ya && yb && ya !== yb)) {
    out.push({ field: 'age', label: 'Date of birth / age', passport: birthText(passport, referenceDate), aadhaar: birthText(aadhaar, referenceDate) });
  }
  const ga = String((passport && passport.gender) || '');
  const gb = String((aadhaar && aadhaar.gender) || '');
  if (ga && gb && ga !== gb) out.push({ field: 'gender', label: 'Gender', passport: ga, aadhaar: gb });
  return out;
}
