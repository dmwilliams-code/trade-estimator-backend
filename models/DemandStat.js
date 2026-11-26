// models/DemandStat.js
// One document per demand stats snapshot (scope x window x build). Snapshots
// are appended, never overwritten, so any published figure can be traced to
// the exact build it came from. Written by scripts/demand-stats-builder.js,
// served by routes/demandStatsRoutes.js. Aggregates only: no locationHash,
// no postcode district.

const mongoose = require('mongoose');

const demandStatSchema = new mongoose.Schema({
  windowType: { type: String, enum: ['cumulative', 'trailing-6m', 'month', 'quarter'] /* trailing-6m: retired 26 Nov 2026, kept for old records */, required: true },
  windowStart: { type: Date, required: true },
  windowEnd: { type: Date, required: true },
  windowLabel: { type: String, required: true },
  scope: { type: String, enum: ['national', 'job', 'family'], required: true },
  key: { type: String, required: true },
  label: { type: String, required: true },
  noun: { type: String, default: null },
  builtAt: { type: Date, required: true },
  locked: { type: Boolean, default: false },
  status: { type: String, enum: ['published', 'needs_review'], required: true },
  reviewReason: { type: String, default: null },
  rules: { type: mongoose.Schema.Types.Mixed },
  n: { type: Number, required: true },          // internal only, never served
  suppressed: { type: Boolean, default: false },
  metrics: { type: mongoose.Schema.Types.Mixed },
  caption: { type: String, default: null }
}, { collection: 'demandstats', minimize: false });

demandStatSchema.index({ windowType: 1, scope: 1, key: 1, windowStart: -1, builtAt: -1 });
demandStatSchema.index({ status: 1, windowType: 1 });

module.exports = mongoose.models.DemandStat || mongoose.model('DemandStat', demandStatSchema);
