'use strict';

/**
 * The budget range a lead's Request Type puts on a deal.
 *
 * One definition on purpose: the convert-to-opportunity modal, opportunity
 * create and the quotation guard must all agree on what "within budget" means,
 * and must word the refusal the same way.
 *
 * The range is read from the Request Type's `budget` field (Settings →
 * Qualification Match), falling back to the Request Type's own
 * `minBudget`/`maxBudget`. A lead with no request type, or a request type with
 * no limits, has no range — that is not an error, it simply means only the
 * "amount must not be zero" rule applies.
 */

/** First candidate that is a real number, else null. */
function pickNumber(...candidates) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && Number.isFinite(Number(candidate))) {
      return Number(candidate);
    }
  }
  return null;
}

function findBudgetField(requestType) {
  return (requestType?.fields || []).find(
    (field) =>
      String(field?.key || '').trim().toLowerCase() === 'budget' ||
      String(field?.label || '').trim().toLowerCase() === 'budget'
  );
}

/**
 * Budget range for one lead, or null when it has none.
 *
 * Never throws: a missing or unreadable request type means "no limits", which
 * keeps a settings problem from blocking the whole sales flow.
 */
async function resolveLeadBudgetRange(req, leadDoc) {
  if (!leadDoc) return null;

  const commercial = leadDoc.commercialRequirement || {};
  const requestTypeRef =
    String(commercial.requestTypeId || leadDoc.requestTypeId || '').trim() ||
    String(leadDoc.requestType || '').trim();
  if (!requestTypeRef) return null;

  let requestType = null;
  try {
    const RequestTypeService = require('../services/request-type.service');
    requestType = await RequestTypeService.getByKeyOrId(req, requestTypeRef);
  } catch {
    return null;
  }
  if (!requestType) return null;

  const budgetField = findBudgetField(requestType);
  const min = pickNumber(budgetField?.minAmount, budgetField?.matchNumberMin, requestType.minBudget);
  const max = pickNumber(budgetField?.maxAmount, budgetField?.matchNumberMax, requestType.maxBudget);
  if (min == null && max == null) return null;

  return { min, max, requestTypeName: requestType.name || '' };
}

/**
 * Why `amount` falls outside `range`, or '' when it fits (or there is no range).
 *
 * The wording is shared with opportunity create, so a rep who was refused on
 * the convert modal reads the same sentence on the quotation button.
 */
function describeOutOfRange(range, amount, label = 'Estimated deal value') {
  if (!range) return '';
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  const forType = range.requestTypeName ? ` for ${range.requestTypeName}` : '';

  if (range.min != null && value < range.min) {
    return `${label} must be at least ₹${range.min.toLocaleString()}${forType}`;
  }
  if (range.max != null && value > range.max) {
    return `${label} cannot exceed ₹${range.max.toLocaleString()}${forType}`;
  }
  return '';
}

module.exports = {
  resolveLeadBudgetRange,
  describeOutOfRange
};
