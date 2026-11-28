// Monthly search opportunity scan (frontend repo, OpportunityScanSpec.md).
// Four ranked lists from UK Search Console data, sized by expected extra
// clicks and estimates. Every figure is computed here; the digest only
// formats them and drops pages that are under a running test.
//
// Expected gains use EstimateAI's own CTR-by-position curve (90 days), not an
// industry curve: site CTR is unusually low, so a generic curve would
// overstate every gain. They are sizes for ordering the list, not forecasts.

const gscSource = require('./sources/gscSource');
const ga4Source = require('./sources/ga4Source');
const { pageGroup } = require('./kpis');

const COUNTRY = 'gbr';
const WINDOW_DAYS = 28;
const CURVE_DAYS = 90;
const GSC_LAG = 3;
const GA4_LAG = 1;
const TOP_N = 15; // the digest shows 5 after dropping held pages

// Signed off in OpportunityScanSpec.md (28 Nov 2026).
const RULES = {
  striking: { minImpressions: 100, minPos: 8, maxPos: 20, targetPos: 5 },
  // Below the site's own CTR at that position (changed from "below half" on
  // 28 Nov 2026: site CTR is uniformly low, so "below half" never fired).
  ctrGap: { minImpressions: 500, maxPos: 10, belowShare: 1 },
  unserved: { minImpressions: 200, minPos: 15, maxPos: 40, targetPos: 5 },
  cannibal: { minImpressions: 100, minShare: 0.2 },
  curve: { minBucketImpressions: 200, maxPos: 40 },
};

const BRANDED = /estimate\s*ai|getestimateai/i;

// Job keywords in a query and the path fragments of pages that serve them.
const JOBS = [
  { key: 'extension', query: /extension/i, path: /extension/ },
  { key: 'loft', query: /\bloft|dormer/i, path: /loft/ },
  { key: 'rewire', query: /rewir|electric|consumer unit|fuse ?board/i, path: /rewir|electric/ },
  { key: 'plastering', query: /plaster|skim/i, path: /plaster/ },
  { key: 'bathroom', query: /bathroom|shower room|en.?suite/i, path: /bathroom/ },
  { key: 'kitchen', query: /kitchen/i, path: /kitchen/ },
  { key: 'boiler', query: /boiler|combi/i, path: /boiler|plumbing|future-homes/ },
  { key: 'garage', query: /garage/i, path: /garage/ },
  { key: 'roofing', query: /roof/i, path: /roof/ },
  { key: 'painting', query: /paint|decorat/i, path: /paint|decorat/ },
  { key: 'heat-pump', query: /heat pump/i, path: /heat-pump|future-homes|energy/ },
  { key: 'solar', query: /solar/i, path: /solar|future-homes|energy/ },
  { key: 'ev-charger', query: /\bev\b|charger|charging point/i, path: /ev-charger|energy/ },
  { key: 'air-con', query: /air con|air-con|aircon|air conditioning/i, path: /air-conditioning/ },
  { key: 'tree', query: /tree surg|tree removal|tree felling/i, path: /tree/ },
  { key: 'landscaping', query: /landscap|garden|patio|driveway/i, path: /landscap|garden/ },
  { key: 'renovation', query: /renovat|refurb/i, path: /renovat|roadmap|order-of-work|roi/ },
];

// ─── pure helpers (tested offline) ───────────────────────────────────────

const pathOf = (url) => String(url || '').replace(/^https?:\/\/[^/]+/i, '').split('?')[0] || '/';

function queryJobs(query) {
  return JOBS.filter((j) => j.query.test(query)).map((j) => j.key);
}

// True when the query names a job and the page path serves none of them.
function jobMismatch(query, page) {
  const jobs = JOBS.filter((j) => j.query.test(query));
  if (!jobs.length) return false;
  const path = pathOf(page);
  return !jobs.some((j) => j.path.test(path));
}

const isHubOrHome = (page) => ['/', '/costs', '/articles'].includes(pathOf(page).replace(/\/+$/, '') || '/');

// Site CTR by position, pooled into bands because single positions are noisy
// at this site's click volume (27 Nov 2026: positions 1 to 5 each had under
// 20 clicks in 90 days). A band with too few impressions takes the nearest
// filled band; the curve never rises with position (enforced from the deep
// end, so one noisy top band cannot drag the rest down).
const BANDS = [[1, 3], [4, 6], [7, 10], [11, 15], [16, 20], [21, 30], [31, 40]];

function buildCtrCurve(rows, { minBucketImpressions = RULES.curve.minBucketImpressions, maxPos = RULES.curve.maxPos } = {}) {
  const bands = BANDS.filter(([lo]) => lo <= maxPos).map(([lo, hi]) => ({ lo, hi: Math.min(hi, maxPos), clicks: 0, impressions: 0 }));
  rows.forEach((r) => {
    const p = Math.max(1, Math.min(maxPos, Math.round(r.position)));
    const b = bands.find((x) => p >= x.lo && p <= x.hi);
    b.clicks += r.clicks;
    b.impressions += r.impressions;
  });
  let rates = bands.map((b) => (b.impressions >= minBucketImpressions ? b.clicks / b.impressions : null));
  rates = rates.map((v, i) => {
    if (v !== null) return v;
    for (let d = 1; d < rates.length; d += 1) {
      if (i - d >= 0 && rates[i - d] !== null) return rates[i - d];
      if (i + d < rates.length && rates[i + d] !== null) return rates[i + d];
    }
    return 0;
  });
  for (let i = rates.length - 2; i >= 0; i -= 1) rates[i] = Math.max(rates[i], rates[i + 1]);
  const curve = [null];
  for (let p = 1; p <= maxPos; p += 1) curve.push(rates[bands.findIndex((b) => p >= b.lo && p <= b.hi)]);
  return curve;
}

const ctrAt = (curve, position) => curve[Math.max(1, Math.min(curve.length - 1, Math.round(position)))];

// Organic estimate rate per landing page group from GA4 landing rows.
function groupRates(ga4Rows) {
  const t = {};
  ga4Rows.forEach((r) => {
    if (r.channel !== 'Organic Search') return;
    const g = pageGroup(r.landingPage);
    if (!t[g]) t[g] = { sessions: 0, estimates: 0 };
    t[g].sessions += r.sessions;
    t[g].estimates += r.estimates;
  });
  const out = {};
  Object.entries(t).forEach(([g, v]) => { out[g] = v.sessions ? v.estimates / v.sessions : 0; });
  return out;
}

const r1 = (n) => Math.round(n * 10) / 10;
const pct = (n) => Math.round(n * 10000) / 100;

function sized(clicksGain, rate) {
  return { expectedExtraClicks: r1(clicksGain), expectedExtraEstimates: r1(clicksGain * (rate || 0)) };
}

function strikingDistance(rows, curve, rates) {
  const { minImpressions, minPos, maxPos, targetPos } = RULES.striking;
  return rows
    .filter((r) => r.impressions >= minImpressions && r.position >= minPos && r.position <= maxPos)
    .map((r) => {
      const gain = r.impressions * Math.max(0, ctrAt(curve, targetPos) - r.ctr);
      return {
        query: r.query,
        page: pathOf(r.page),
        position: r1(r.position),
        impressions: r.impressions,
        clicks: r.clicks,
        ctrPct: pct(r.ctr),
        ...sized(gain, rates[pageGroup(r.page)]),
        action: 'strengthen this page for the query: a section, FAQ answer or internal links',
      };
    });
}

function ctrGap(rows, curve, rates) {
  const { minImpressions, maxPos, belowShare } = RULES.ctrGap;
  const pages = new Map();
  rows.forEach((r) => {
    const k = pathOf(r.page);
    if (!pages.has(k)) pages.set(k, { page: k, clicks: 0, impressions: 0, posWeighted: 0, topQueries: [] });
    const p = pages.get(k);
    p.clicks += r.clicks;
    p.impressions += r.impressions;
    p.posWeighted += r.position * r.impressions;
    p.topQueries.push({ query: r.query, impressions: r.impressions });
  });
  return [...pages.values()]
    .map((p) => ({ ...p, position: p.posWeighted / p.impressions, ctr: p.clicks / p.impressions }))
    .filter((p) => p.impressions >= minImpressions && p.position <= maxPos && p.ctr < belowShare * ctrAt(curve, p.position))
    .map((p) => {
      const expected = ctrAt(curve, p.position);
      return {
        page: p.page,
        position: r1(p.position),
        impressions: p.impressions,
        clicks: p.clicks,
        ctrPct: pct(p.ctr),
        siteCtrAtPositionPct: pct(expected),
        topQueries: p.topQueries.sort((a, b) => b.impressions - a.impressions).slice(0, 3).map((q) => q.query),
        ...sized(p.impressions * (expected - p.ctr), rates[pageGroup(p.page)]),
        action: 'rewrite the title and description',
      };
    });
}

function byQuery(rows) {
  const q = new Map();
  rows.forEach((r) => {
    if (!q.has(r.query)) q.set(r.query, []);
    q.get(r.query).push(r);
  });
  return q;
}

function unservedQueries(rows, curve, rates) {
  const { minImpressions, minPos, maxPos, targetPos } = RULES.unserved;
  const out = [];
  byQuery(rows).forEach((pages, query) => {
    const impressions = pages.reduce((a, r) => a + r.impressions, 0);
    if (impressions < minImpressions) return;
    const best = [...pages].sort((a, b) => b.impressions - a.impressions)[0];
    if (best.position < minPos || best.position > maxPos) return;
    const hub = isHubOrHome(best.page);
    const mismatch = jobMismatch(query, best.page);
    if (!hub && !mismatch) return;
    const clicks = pages.reduce((a, r) => a + r.clicks, 0);
    out.push({
      query,
      bestPage: pathOf(best.page),
      position: r1(best.position),
      impressions,
      clicks,
      jobs: queryJobs(query),
      reason: hub ? 'best page is the homepage or a hub' : 'best page is about a different job',
      // A new article would land as an article, so size it with the article rate.
      ...sized(impressions * Math.max(0, ctrAt(curve, targetPos) - clicks / impressions), rates.articles),
      action: 'new article, or a new section on the matching page',
    });
  });
  return out;
}

function cannibalisation(rows) {
  const { minImpressions, minShare } = RULES.cannibal;
  const out = [];
  byQuery(rows).forEach((pages, query) => {
    const impressions = pages.reduce((a, r) => a + r.impressions, 0);
    if (impressions < minImpressions) return;
    const split = pages
      .map((r) => ({ page: pathOf(r.page), sharePct: Math.round((r.impressions / impressions) * 100), position: r1(r.position) }))
      .filter((p) => p.sharePct >= minShare * 100)
      .sort((a, b) => b.sharePct - a.sharePct);
    if (split.length < 2) return;
    out.push({ query, impressions, pages: split, action: 'merge, re-target one page, or link the weaker page to the stronger' });
  });
  return out;
}

function buildLists({ rows, curveRows, ga4Rows }) {
  const clean = rows.filter((r) => !BRANDED.test(r.query));
  const curve = buildCtrCurve(curveRows.filter((r) => !BRANDED.test(r.query)));
  const rates = groupRates(ga4Rows);
  const top = (list, key) => list.sort((a, b) => b[key] - a[key] || b.impressions - a.impressions).slice(0, TOP_N);
  return {
    ctrCurvePct: Object.fromEntries([1, 2, 3, 5, 8, 10, 15, 20, 30].map((p) => [p, pct(curve[p])])),
    organicEstimateRatePct: Object.fromEntries(Object.entries(rates).map(([g, v]) => [g, pct(v)])),
    strikingDistance: top(strikingDistance(clean, curve, rates), 'expectedExtraEstimates'),
    ctrGap: top(ctrGap(clean, curve, rates), 'expectedExtraEstimates'),
    unservedQueries: top(unservedQueries(clean, curve, rates), 'expectedExtraEstimates'),
    cannibalisation: top(cannibalisation(clean), 'impressions'),
  };
}

// ─── live entry point ────────────────────────────────────────────────────

function isoDaysAgo(days, now) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

async function buildOpportunities({ now = new Date() } = {}) {
  const gscTo = isoDaysAgo(GSC_LAG, now);
  const window = { from: isoDaysAgo(GSC_LAG + WINDOW_DAYS - 1, now), to: gscTo };
  const curveWindow = { from: isoDaysAgo(GSC_LAG + CURVE_DAYS - 1, now), to: gscTo };
  const ga4Window = { from: isoDaysAgo(GA4_LAG + WINDOW_DAYS - 1, now), to: isoDaysAgo(GA4_LAG, now) };

  const [current, curve, ga4] = await Promise.all([
    gscSource.getGscQueryPageRows({ ...window, country: COUNTRY }),
    gscSource.getGscQueryPageRows({ ...curveWindow, country: COUNTRY }),
    ga4Source.getGa4LandingRows(ga4Window),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    windows: { gsc: window, ctrCurve: curveWindow, ga4: ga4Window },
    country: 'United Kingdom',
    note: 'Expected extra clicks and estimates are 28-day sizes for ordering the lists, using EstimateAI\'s own CTR curve and organic estimate rates. They are not forecasts. Branded queries are excluded. Drop pages under a running test or changed in the last 28 days before presenting.',
    rules: RULES,
    gscRows: current.rows.length,
    ...buildLists({ rows: current.rows, curveRows: curve.rows, ga4Rows: ga4.rows }),
  };
}

module.exports = {
  buildOpportunities,
  // exported for tests
  buildCtrCurve,
  ctrAt,
  groupRates,
  jobMismatch,
  queryJobs,
  isHubOrHome,
  strikingDistance,
  ctrGap,
  unservedQueries,
  cannibalisation,
  buildLists,
  RULES,
};
