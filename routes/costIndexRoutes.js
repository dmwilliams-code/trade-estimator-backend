/**
 * costIndexRoutes.js
 * ==================
 * Serves Cost Index documents to the frontend /renovation-cost-index page.
 *
 * Mount in server.js:
 *   const costIndexRoutes = require('./routes/costIndexRoutes');
 *   app.use('/api/cost-index', costIndexRoutes);
 *
 * Endpoints:
 *   GET /api/cost-index/latest      — most recent published index
 *   GET /api/cost-index/history     — all published indexes, newest first (for chart data)
 */

const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
// Mirrors the schema in cost-index-analyser.js. Defined here so server.js can
// serve the data without importing the cron script.

const costIndexSchema = new mongoose.Schema({
  monthLabel:           String,
  monthStart:           Date,
  generatedAt:          Date,
  totalEstimates:       Number,
  topJobTypes:          Array,
  topRegions:           Array,
  labourMaterialsRatio: Object,
  commentary:           String,
  prevMonthLabel:       String,
  prevMonthTotals:      Object,
}, { collection: 'costindex' });

// Use existing model if already registered (handles hot-reload in dev)
const CostIndex = mongoose.models.CostIndex
  || mongoose.model('CostIndex', costIndexSchema);

// ─── GET /api/cost-index/latest ───────────────────────────────────────────────

router.get('/latest', async (req, res) => {
  try {
    const doc = await CostIndex
      .findOne()
      .sort({ monthStart: -1 })
      .lean();

    if (!doc) {
      return res.status(404).json({ error: 'No cost index published yet.' });
    }

    res.json(doc);
  } catch (err) {
    console.error('Cost index /latest error:', err.message);
    res.status(500).json({ error: 'Failed to fetch cost index.' });
  }
});

// ─── GET /api/cost-index/history ─────────────────────────────────────────────
// Returns all months, newest first, with a reduced payload (no commentary)
// so the frontend can render a volume trend chart without overfetching.

router.get('/history', async (req, res) => {
  try {
    const docs = await CostIndex
      .find({}, {
        monthLabel:     1,
        monthStart:     1,
        totalEstimates: 1,
        topJobTypes:    1,
        labourMaterialsRatio: 1,
      })
      .sort({ monthStart: -1 })
      .lean();

    res.json(docs);
  } catch (err) {
    console.error('Cost index /history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch cost index history.' });
  }
});

module.exports = router;
