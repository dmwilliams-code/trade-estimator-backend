/**
 * routes/syntheticRoutes.js
 * Cleanup for the daily synthetic estimate check (frontend repo,
 * SyntheticEstimateCheckSpec.md). The check makes one real estimate a day with
 * postcode BA14 8UZ and deletes it here straight after.
 *
 * Mounted in server.js at /api/synthetic:
 *   DELETE /estimate/:id   header x-synthetic-secret: <SYNTHETIC_CHECK_SECRET>
 *
 * Deletes only a record in district BA14 created in the last 15 minutes. Every
 * other case, including a wrong or missing secret, returns 404 and deletes
 * nothing, so a leaked secret cannot remove real estimates.
 */

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const SYNTHETIC_DISTRICT = 'BA14';
const MAX_AGE_MS = 15 * 60 * 1000;

function secretMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Estimate and clock are injectable so the route can be tested without a database.
function createSyntheticRouter({ Estimate, secret = () => process.env.SYNTHETIC_CHECK_SECRET, now = () => Date.now() }) {
  const router = express.Router();

  router.delete('/estimate/:id', async (req, res) => {
    const notFound = () => res.status(404).json({ deleted: false });
    if (!secretMatches(req.get('x-synthetic-secret'), secret())) return notFound();
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return notFound();

    try {
      const result = await Estimate.deleteOne({
        _id: req.params.id,
        'locationData.district': SYNTHETIC_DISTRICT,
        createdAt: { $gte: new Date(now() - MAX_AGE_MS) },
      });
      if (result.deletedCount !== 1) return notFound();
      return res.json({ deleted: true });
    } catch (e) {
      console.error('synthetic cleanup failed:', e.message);
      return res.status(500).json({ deleted: false });
    }
  });

  return router;
}

module.exports = { createSyntheticRouter, SYNTHETIC_DISTRICT, MAX_AGE_MS };
