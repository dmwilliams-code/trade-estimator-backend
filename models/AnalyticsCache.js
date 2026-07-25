const mongoose = require('mongoose');

// Read-through cache for GSC/GA4 responses. MongoDB queries are never cached
// (see analytics/cache.js) -- only external API calls that lag or rate-limit.
const analyticsCacheSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, index: true },
  payload:   { type: mongoose.Schema.Types.Mixed },
  cachedAt:  { type: Date, default: Date.now },
  // TTL index: document is removed once the current time passes this value.
  expiresAt: { type: Date, required: true, expires: 0 }
});

module.exports = mongoose.model('AnalyticsCache', analyticsCacheSchema);
