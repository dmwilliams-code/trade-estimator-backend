const mongoose = require('mongoose');

// Weekly snapshot written by crons/snapshot-cron.js. This is the source of
// truth for historical site performance -- retained indefinitely, reused as
// contractor pitch collateral. The Drive mirror is best-effort only.
const siteSnapshotSchema = new mongoose.Schema({
  weekEnding: { type: Date, required: true, index: true },
  payload:    { type: mongoose.Schema.Types.Mixed, required: true },
  markdown:   { type: String, required: true },
  createdAt:  { type: Date, default: Date.now }
});

module.exports = mongoose.model('SiteSnapshot', siteSnapshotSchema);
