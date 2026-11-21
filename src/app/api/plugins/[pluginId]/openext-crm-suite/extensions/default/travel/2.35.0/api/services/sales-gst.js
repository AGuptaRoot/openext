'use strict';

/**
 * Travel GST on quotation lines (crm-travel 2.29.0, CRM 3.53.0 GST suite; documentation/gst-planning/01 §2, §3, §8).
 *
 * Travel knowledge lives here, not in the CRM: which travel line is which GST service, the hotel rate and
 * place-of-supply notes, and the overseas tour package TCS rule. The CRM is reached only through
 * sdk.finance.gstSettings() (the agency's own SAC codes and rates from Settings → GST).
 */

/** Quotation line group (salesFlow.quotationLineGroups) → GST service key (salesFlow.gst.serviceTaxes). */
const SERVICE_OF_GROUP = Object.freeze({
  flights: 'flight',
  hotel: 'hotel',
  transfers: 'transfer',
  activities: 'activity',
  visa: 'visa',
  insurance: 'insurance',
  other: 'package'
});

const OVERSEAS_TCS_RULE = 'overseas_tour_package';

function serviceTypeOf(line) {
  return SERVICE_OF_GROUP[String((line && line.group) || '')] || 'package';
}

/**
 * The agency's GST settings, or null when this CRM has no GST suite or the user may not read finance
 * (the quotation then keeps the service tax rates, as before).
 */
async function gstSettingsOf(sdk) {
  if (!sdk || !sdk.finance || typeof sdk.finance.gstSettings !== 'function') return null;
  try {
    return await sdk.finance.gstSettings();
  } catch {
    return null;
  }
}

/**
 * Put SAC, service key and GST rate on the quotation lines. Pure.
 * @param lines  the prefill lines (with group, tax)
 * @param settings  sdk.finance.gstSettings() result, or null
 * @param {{ international: boolean }} trip
 * @returns {{ lines, tcsRuleKey, warnings }}
 */
function applyGst(lines, settings, { international = false } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  if (!settings) return { lines: list, tcsRuleKey: '', warnings: [] };
  if (!settings.ready) {
    return {
      lines: list.map((l) => ({ ...l, serviceType: serviceTypeOf(l) })),
      tcsRuleKey: '',
      warnings: ['GST is not set up yet: set the agency GSTIN in Settings → GST. Lines keep their service tax rates.']
    };
  }
  const byType = new Map((settings.serviceTaxes || []).map((s) => [s.serviceType, s]));
  const out = list.map((l) => {
    const serviceType = serviceTypeOf(l);
    const rate = byType.get(serviceType);
    return rate ? { ...l, serviceType, sac: rate.sac, tax: rate.taxPercent } : { ...l, serviceType };
  });

  const warnings = [];
  const missing = [...new Set(out.filter((l) => !byType.has(l.serviceType)).map((l) => l.serviceType))];
  if (missing.length) {
    warnings.push(`No SAC code or GST rate in Settings → GST for: ${missing.join(', ')}. Those lines keep their own tax rate (use "Load defaults" there).`);
  }
  if (out.some((l) => l.serviceType === 'hotel')) {
    warnings.push('Hotel GST depends on the room tariff: 5% up to ₹7,500 a night, 18% above. Check each hotel line. If you sell the stay as the supplier, the place of supply is the hotel\'s state: hotels in different states need separate invoices.');
  }
  const tcsOn = (settings.tcsRules || []).some((r) => r.key === OVERSEAS_TCS_RULE);
  const tcsRuleKey = international && tcsOn ? OVERSEAS_TCS_RULE : '';
  if (international && !tcsOn) {
    warnings.push('International trip: TCS on overseas tour packages is not switched on in Settings → GST. Ask your CA.');
  }
  return { lines: out, tcsRuleKey, warnings };
}

module.exports = { SERVICE_OF_GROUP, OVERSEAS_TCS_RULE, serviceTypeOf, gstSettingsOf, applyGst };
