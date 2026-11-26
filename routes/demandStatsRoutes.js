/**
 * routes/demandStatsRoutes.js
 * Serves published demand stats snapshots (models/DemandStat.js).
 *
 * Mounted in server.js at /api/demand-stats:
 *   GET /latest?window=month&scope=national
 *   GET /latest?window=cumulative&scope=job&key=single-storey-extension
 *   GET /bundle?window=cumulative    every scope from the latest build, in one response
 *   GET /history?window=month        locked months, newest first (labels, captions, top jobs)
 *
 * Sample sizes and cell counts stay internal: n, count and sampleCount are
 * stripped from every response. Only status 'published' snapshots are served.
 */

const express = require('express');
const DemandStat = require('../models/DemandStat');

const router = express.Router();

const WINDOWS = ['cumulative', 'month', 'quarter'];
const SCOPES = ['national', 'job', 'family'];
const INTERNAL_KEYS = new Set(['n', 'count', 'sampleCount', '_id', '__v', 'status', 'reviewReason']);

function toPublic(value) {
  if (Array.isArray(value)) return value.map(toPublic);
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!INTERNAL_KEYS.has(k)) out[k] = toPublic(v);
    }
    return out;
  }
  return value;
}

function cache(res) {
  res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

router.get('/latest', async (req, res) => {
  const windowType = pick(req.query.window, WINDOWS, null);
  const scope = pick(req.query.scope, SCOPES, null);
  const key = scope === 'national' ? 'all' : String(req.query.key || '');
  if (!windowType || !scope || !/^[a-z0-9-]{1,60}$/.test(key)) {
    return res.status(400).json({ error: 'window, scope and (for job or family) key are required' });
  }
  try {
    const doc = await DemandStat.findOne({ windowType, scope, key, status: 'published' })
      .sort({ windowStart: -1, builtAt: -1 })
      .lean();
    if (!doc) return res.status(404).json({ error: 'No published figures for this scope yet.' });
    cache(res);
    return res.json(toPublic(doc));
  } catch (err) {
    console.error('demand-stats /latest error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch demand stats.' });
  }
});

router.get('/bundle', async (req, res) => {
  const windowType = pick(req.query.window, WINDOWS, 'cumulative');
  try {
    const anchor = await DemandStat.findOne({ windowType, scope: 'national', status: 'published' })
      .sort({ windowStart: -1, builtAt: -1 })
      .lean();
    if (!anchor) return res.status(404).json({ error: 'No published figures yet.' });
    const docs = await DemandStat.find({
      windowType,
      windowStart: anchor.windowStart,
      builtAt: anchor.builtAt,
      status: 'published'
    }).lean();
    cache(res);
    return res.json({
      windowType,
      windowLabel: anchor.windowLabel,
      builtAt: anchor.builtAt,
      snapshots: docs.map(toPublic)
    });
  } catch (err) {
    console.error('demand-stats /bundle error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch demand stats.' });
  }
});

router.get('/history', async (req, res) => {
  const windowType = pick(req.query.window, ['month', 'quarter'], 'month');
  try {
    const docs = await DemandStat.aggregate([
      { $match: { windowType, scope: 'national', status: 'published', locked: true } },
      { $sort: { windowStart: -1, builtAt: -1 } },
      { $group: { _id: '$windowStart', doc: { $first: '$$ROOT' } } },
      { $sort: { _id: -1 } },
      { $project: {
        _id: 0,
        windowStart: '$doc.windowStart',
        windowLabel: '$doc.windowLabel',
        caption: '$doc.caption',
        suppressed: '$doc.suppressed',
        jobShare: { $slice: [{ $ifNull: ['$doc.metrics.jobShare', []] }, 5] }
      } }
    ]);
    cache(res);
    return res.json(docs.map(toPublic));
  } catch (err) {
    console.error('demand-stats /history error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch demand stats history.' });
  }
});

module.exports = router;
module.exports.toPublic = toPublic;
