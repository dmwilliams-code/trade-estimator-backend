// Output whitelists. Each shape below declares the exact keys it may emit;
// pick() strips everything else immediately before a response leaves this
// module. This is what makes rule 4.1.2 (no personal data) structural: a
// future schema change that adds a field to a collection cannot leak through
// a response here, because the field is not on the list. leadId is never on
// any list below.

const WHITELISTS = {
  estimate_variant_summary: ['variant', 'count', 'avgValue', 'regionUnresolved'],
  lead_variant_summary: ['variant', 'count', 'sourceBreakdown'],
  contractor_signal_ladder: ['variant', 'action', 'count'],
  estimate_demand: ['variant', 'key', 'count', 'avgValue', 'qualityBreakdown'],
  contractor_density: ['placeId', 'contractorName', 'variant', 'signals', 'districts', 'jobTypes', 'totalEstimateValue'],
  change_log: ['date', 'type', 'description', 'affectedUrls', 'hypothesis', 'outcome', 'filesChanged'],
  gsc_performance: ['key', 'clicks', 'impressions', 'ctr', 'position', 'delta'],
  ga4_events: ['event', 'count', 'uniqueUsers', 'breakdown'],
};

function pick(obj, keys) {
  const out = {};
  keys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  });
  return out;
}

// serialise(shapeName, rows) -> rows with only whitelisted keys
function serialise(shapeName, rows) {
  const keys = WHITELISTS[shapeName];
  if (!keys) {
    throw new Error(`serialise: no whitelist defined for shape "${shapeName}"`);
  }
  return rows.map((row) => pick(row, keys));
}

module.exports = { serialise, WHITELISTS };
