const crypto = require('crypto');
const AnalyticsCache = require('../models/AnalyticsCache');

function buildKey(toolName, params) {
  const sorted = {};
  Object.keys(params || {}).sort().forEach((k) => { sorted[k] = params[k]; });
  const hash = crypto.createHash('sha1').update(JSON.stringify(sorted)).digest('hex');
  return `${toolName}:${hash}`;
}

// Read-through cache over the analyticscache collection. MongoDB-sourced
// queries never call this -- freshness matters more than cost there (see the
// TTL table in the spec). GSC and GA4 sources wrap their fetches with this,
// passing their own fixed TTL in seconds.
//
// Returns { data, cachedAt }. cachedAt is the stored timestamp on a hit, and
// the fresh fetch timestamp on a miss -- callers use this to populate
// meta.cachedAt so staleness is visible rather than inferred.
async function withCache(toolName, params, ttlSeconds, fetchFn) {
  const key = buildKey(toolName, params);
  const existing = await AnalyticsCache.findOne({ key }).lean();
  if (existing) {
    return { data: existing.payload, cachedAt: existing.cachedAt };
  }

  const data = await fetchFn();
  const cachedAt = new Date();
  const expiresAt = new Date(cachedAt.getTime() + ttlSeconds * 1000);

  await AnalyticsCache.findOneAndUpdate(
    { key },
    { key, payload: data, cachedAt, expiresAt },
    { upsert: true }
  );

  return { data, cachedAt };
}

module.exports = { withCache, buildKey };
