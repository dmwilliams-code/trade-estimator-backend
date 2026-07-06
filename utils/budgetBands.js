// utils/budgetBands.js
// Maps an estimate total (GBP) to a job feed budget band. Bands are fixed labels,
// never the exact figure - protects the homeowner's negotiating position.

const BUDGET_BANDS = ['under £5k', '£5k-15k', '£15k-40k', '£40k-80k', '£80k+'];

function bandForEstimateValue(estimateValue) {
  const value = Number(estimateValue) || 0;
  if (value < 5000) return BUDGET_BANDS[0];
  if (value < 15000) return BUDGET_BANDS[1];
  if (value < 40000) return BUDGET_BANDS[2];
  if (value < 80000) return BUDGET_BANDS[3];
  return BUDGET_BANDS[4];
}

module.exports = { BUDGET_BANDS, bandForEstimateValue };
