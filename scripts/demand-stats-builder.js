/**
 * scripts/demand-stats-builder.js
 * Builds demand stats snapshots from saved estimates and appends them to the
 * `demandstats` collection. Replaces scripts/cost-index-analyser.js. No
 * language model is called: captions are built from the figures in code.
 * Spec: DemandStatsPipelineSpec.md (frontend repo).
 *
 * Usage:
 *   node scripts/demand-stats-builder.js                  build and publish
 *   node scripts/demand-stats-builder.js --dry-run        print, write nothing
 *   node scripts/demand-stats-builder.js --dry-run --out=stats.json
 *   node scripts/demand-stats-builder.js --window=month   one window type only
 *   node scripts/demand-stats-builder.js --force          rebuild locked windows
 *   node scripts/demand-stats-builder.js --approve=month:2026-11
 *        publish the latest build of a window held for review
 *
 * Schedule (Render cron): Mondays 10:00 UTC, after the 09:30 snapshot cron.
 * ENV: MONGODB_URI, ALERT_EMAIL (optional, for alerts), TEST_EXCLUSION_DISTRICTS.
 */

require('dotenv').config();
const fs = require('fs');
const https = require('https');
const mongoose = require('mongoose');
const Estimate = require('../models/Estimate');
const DemandStat = require('../models/DemandStat');
const regionalCostData = require('../regionalCostData.json');
const { TEST_DISTRICTS, estimateTestExclusion } = require('../analytics/sources/mongoSource');
const { RULES } = require('../analytics/demandStatsConfig');
const { windowsFor, buildWindowSnapshots, validateWindow, unknownJobTypes } = require('../analytics/demandStats');
const { createOpsAlerter } = require('../utils/opsAlert');
const { sendOpsEmail } = require('../services/emailService');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY_RUN = flag('dry-run');
const FORCE = flag('force');
const ONLY_WINDOW = option('window');
const OUT = option('out');
const APPROVE = option('approve');

// Vercel deploy hook (ArticleDataBlocksSpec.md 3.2): article data blocks are
// built into the frontend, so a new cumulative build triggers a redeploy.
function triggerFrontendDeploy(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', timeout: 15000 }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
      else reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const alertOps = createOpsAlerter({ send: sendOpsEmail, recipient: () => process.env.ALERT_EMAIL });
const regionNames = Object.fromEntries(regionalCostData.regions.map((r) => [r.slug, r.name]));
const rules = { ...RULES, excluded: TEST_DISTRICTS };

function populationMatch(from, to) {
  return {
    createdAt: { $gte: from, ...(to ? { $lt: to } : {}) },
    'estimate.total': { $gt: 0 },
    ...estimateTestExclusion()
  };
}

async function previousNationalN(win) {
  const query = { scope: 'national', status: 'published', windowType: win.windowType };
  if (win.windowType !== 'cumulative') query.windowStart = { $lt: win.windowStart };
  const prev = await DemandStat.findOne(query).sort({ windowStart: -1, builtAt: -1 }).lean();
  return prev ? prev.n : null;
}

async function approve(spec) {
  const [windowType, ym] = spec.split(':');
  // ym is the window's first month, e.g. 2026-11 (a quarter uses its first month, e.g. 2026-10).
  if (!/^(month|quarter)$/.test(windowType || '') || !/^\d{4}-\d{2}$/.test(ym || '')) {
    throw new Error('Use --approve=<month|quarter>:<YYYY-MM>');
  }
  const windowStart = new Date(`${ym}-01T00:00:00Z`);
  const latest = await DemandStat.findOne({ windowType, windowStart, status: 'needs_review' }).sort({ builtAt: -1 }).lean();
  if (!latest) {
    console.log(`No build held for review for ${windowType} starting ${windowStart.toISOString().slice(0, 10)}.`);
    return;
  }
  const result = await DemandStat.updateMany(
    { windowType, windowStart, builtAt: latest.builtAt, status: 'needs_review' },
    { $set: { status: 'published', reviewReason: `approved ${new Date().toISOString()}: ${latest.reviewReason}` } }
  );
  console.log(`Published ${result.modifiedCount} snapshots for ${latest.windowLabel} (built ${latest.builtAt.toISOString()}).`);
}

function summarise(win, snaps, check, status) {
  const national = snaps.find((s) => s.scope === 'national');
  console.log(`\n=== ${win.windowType} ${win.windowLabel} | status=${status} locked=${snaps[0]?.locked} n=${national?.n ?? 0} swing=${check.swingPct ?? 'n/a'}%`);
  if (!check.ok) check.problems.forEach((p) => console.log(`  PROBLEM ${p}`));
  for (const s of snaps) {
    const tag = s.suppressed ? 'suppressed' : 'published';
    console.log(`  ${s.scope}/${s.key} n=${s.n} ${tag}${s.caption ? ` | ${s.caption}` : ''}`);
  }
  if (national && !national.suppressed) {
    const fmt = (t) => (t || []).map((r) => `${r.label} ${r.share}%`).join(', ');
    console.log(`  jobs: ${fmt(national.metrics.jobShare)}`);
    console.log(`  quality: ${fmt(national.metrics.qualityMix)}`);
    console.log(`  regions (${national.metrics.regionResolvedShare}% resolved): ${fmt(national.metrics.regionShare) || 'below threshold'}`);
  }
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI env var not set');
  await mongoose.connect(process.env.MONGODB_URI);

  if (APPROVE) {
    await approve(APPROVE);
    return;
  }

  const now = new Date();
  const floor = new Date(`${RULES.dateFloor}T00:00:00Z`);
  const docs = await Estimate.find(populationMatch(floor), {
    jobType: 1, category: 1, quality: 1, areaQuantity: 1, projectSize: 1, quoteStatus: 1, createdAt: 1, 'locationData.regionSlug': 1
  }).lean();
  const rows = docs.map((d) => ({
    jobType: d.jobType,
    category: d.category,
    quality: d.quality,
    areaQuantity: d.areaQuantity,
    projectSize: d.projectSize,
    regionSlug: d.locationData?.regionSlug || null,
    quoteStatus: d.quoteStatus || null,
    createdAt: d.createdAt
  }));
  console.log(`Loaded ${rows.length} estimates since ${RULES.dateFloor} (excluding ${TEST_DISTRICTS.join(', ')}).${DRY_RUN ? ' DRY RUN, nothing will be written.' : ''}`);

  const unknown = unknownJobTypes(rows);
  if (unknown.length) {
    const msg = `Demand stats stopped: job types with no label: ${unknown.join(', ')}. Add them to analytics/demandStatsConfig.js.`;
    console.error(msg);
    if (!DRY_RUN) await alertOps('demand-stats-unknown-job', 'Demand stats build stopped', msg);
    process.exitCode = 1;
    return;
  }

  const output = [];
  let failures = 0;
  const windows = windowsFor(now, rules).filter((w) => !ONLY_WINDOW || w.windowType === ONLY_WINDOW);

  for (const win of windows) {
    if (win.complete && !FORCE) {
      const locked = await DemandStat.exists({ windowType: win.windowType, windowStart: win.windowStart, locked: true });
      if (locked) {
        console.log(`\n=== ${win.windowType} ${win.windowLabel} is locked, skipped (use --force to rebuild).`);
        continue;
      }
    }

    const snaps = buildWindowSnapshots(rows, win, { now, regionNames, rules });
    const from = win.windowStart < floor ? floor : win.windowStart;
    const independentCount = await Estimate.countDocuments(populationMatch(from, win.windowEnd));
    const check = validateWindow(snaps, { independentCount, previousN: await previousNationalN(win), rules });

    // A forced rebuild of a finished period must reproduce its earlier count.
    // If it doesn't, estimates in that period changed, and the earlier
    // published figures would silently shift, so the period is not written.
    if (FORCE && win.complete) {
      const earlier = await DemandStat.findOne({ windowType: win.windowType, windowStart: win.windowStart, scope: 'national' })
        .sort({ builtAt: -1 })
        .lean();
      const nowN = (snaps.find((s) => s.scope === 'national') || {}).n;
      if (earlier && earlier.n !== nowN) {
        check.ok = false;
        check.problems.push(`forced rebuild count ${nowN} differs from the earlier build's ${earlier.n}`);
      }
    }
    const status = check.needsReview ? 'needs_review' : 'published';
    summarise(win, snaps, check, status);

    if (!check.ok) {
      failures += 1;
      if (!DRY_RUN) {
        await alertOps(`demand-stats-invalid-${win.windowType}`, 'Demand stats window failed validation',
          `${win.windowType} ${win.windowLabel} was not written:\n${check.problems.join('\n')}`);
      }
      continue;
    }

    const reviewReason = check.needsReview ? `volume changed ${check.swingPct}% against the previous ${win.windowType} snapshot` : null;
    const finalSnaps = snaps.map((s) => ({ ...s, status, reviewReason }));
    output.push(...finalSnaps);

    if (!DRY_RUN) {
      await DemandStat.insertMany(finalSnaps);
      if (check.needsReview) {
        await alertOps(`demand-stats-review-${win.windowType}`, 'Demand stats held for review',
          `${win.windowType} ${win.windowLabel}: ${reviewReason}. Not served until approved with\n` +
          `node scripts/demand-stats-builder.js --approve=${win.windowType}:${win.windowStart.toISOString().slice(0, 7)}`);
      }
    }
  }

  const cumulativePublished = output.some((s) => s.windowType === 'cumulative' && s.status === 'published');
  if (!DRY_RUN && cumulativePublished) {
    const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
    if (!hook) {
      console.log('\nVERCEL_DEPLOY_HOOK_URL not set, frontend not redeployed.');
    } else {
      try {
        const code = await triggerFrontendDeploy(hook);
        console.log(`\nFrontend redeploy triggered (HTTP ${code}).`);
      } catch (err) {
        console.error(`\nFrontend redeploy failed: ${err.message}`);
        await alertOps('demand-stats-deploy-hook', 'Demand stats: frontend redeploy failed',
          `The Vercel deploy hook returned an error (${err.message}). Article data blocks keep last week's figures until the next deploy.`);
      }
    }
  }

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
    console.log(`\nWrote ${output.length} snapshots to ${OUT}`);
  }
  console.log(`\nDone: ${output.length} snapshots ${DRY_RUN ? 'built (dry run)' : 'written'}, ${failures} window(s) failed validation.`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Demand stats build failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
