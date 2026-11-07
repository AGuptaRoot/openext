'use strict';

/**
 * Dynamic State & Weight Shipping Rate Calculation Engine.
 */
const STATE_SHIPPING_RATES = {
  'Maharashtra': { rate: 100, label: 'Intra-State (Local Zone)' },
  'Gujarat': { rate: 150, label: 'Inter-State (Commercial Zone A)' },
  'Karnataka': { rate: 150, label: 'Inter-State (Commercial Zone A)' },
  'Delhi': { rate: 250, label: 'Inter-State (Commercial Zone B)' },
  'Tamil Nadu': { rate: 250, label: 'Inter-State (Commercial Zone B)' },
  'Uttar Pradesh': { rate: 250, label: 'Inter-State (Commercial Zone B)' },
  'West Bengal': { rate: 250, label: 'Inter-State (Commercial Zone B)' },
  'Rajasthan': { rate: 200, label: 'Inter-State (Commercial Zone B)' },
  'Assam': { rate: 350, label: 'Outstation (Special Zone C)' },
  'Other': { rate: 300, label: 'Outstation (Standard Zone C)' }
};

/**
 * Calculates dynamic shipping charges according to Destination State, Weight, Subtotal, and tenant Settings.
 * 
 * Usecase: Calculates shipping fee dynamically for Sales Orders and Quotations.
 * 
 * @param {Object} params Calculation parameters ({ state, totalWeightKg, subtotal, customRates, freeThreshold })
 * @returns {Object} Shipping calculation result
 */
function calculateShippingCharge({ state = 'Maharashtra', totalWeightKg = 1, subtotal = 0, customRates = null, freeThreshold = 5000 }) {
  const threshold = Number(freeThreshold) || 5000;
  if (subtotal >= threshold && subtotal > 0) {
    return {
      shippingCharge: 0,
      ruleApplied: `Free Shipping (Order ≥ ₹${threshold.toLocaleString()})`
    };
  }

  const normalizedState = String(state || 'Maharashtra').trim();
  let baseRate = 300;

  if (customRates && typeof customRates === 'object' && customRates[normalizedState] !== undefined) {
    baseRate = Number(customRates[normalizedState]) || 0;
  } else if (STATE_SHIPPING_RATES[normalizedState]) {
    baseRate = STATE_SHIPPING_RATES[normalizedState].rate;
  }

  const weight = Math.max(1, Number(totalWeightKg) || 1);
  const extraWeight = Math.max(0, weight - 2);
  const weightSurcharge = extraWeight * 40;

  const totalCharge = Math.round((baseRate + weightSurcharge) * 100) / 100;

  return {
    shippingCharge: totalCharge,
    ruleApplied: `${normalizedState} Shipping Rate (Base ₹${baseRate}${weightSurcharge > 0 ? ` + ₹${weightSurcharge} weight surcharge` : ''})`
  };
}

module.exports = {
  calculateShippingCharge,
  STATE_SHIPPING_RATES
};
