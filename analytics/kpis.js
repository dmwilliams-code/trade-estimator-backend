// Weekly KPI section for the snapshot and the Monday digest (frontend repo,
// WeeklyDigestSpec.md part 2). Impressions, clicks and estimates, each for
// the latest complete week against the previous week and the average of the
// four weeks before it. Every number and every flag is computed here, in
// code; the digest only copies them.
//
// Weeks are seven complete days ending at each source's latest complete day
// (GSC lags 3 days, GA4 1 day, MongoDB 1 day so today's partial count is
// never read as a drop), so the three sources cover slightly different dates.
// Each block states its own dates.

const gscSource = require('./sources/gscSource');
const ga4Source = require('./sources/ga4Source');
const mongoSource = require('./sources/mongoSource');
const { CHART_GROUPS } = require('./demandStatsConfig');
const { classifyQuery, CLASSES } = require('./queryClass');

const WEEKS = 5; // latest week + 4 prior weeks for the average
const LAG_DAYS = { gsc: 3, ga4: 1, mongodb: 1 };

// Anomaly rule, signed off in WeeklyDigestSpec.md: a count is flagged when it
// moves 30% or more against the 4-week average and by at least the minimum.
// Rates (estimates per landing session) use the same 30%, and only when the
// week had enough sessions for the rate to mean something.
const ANOMALY = {
  pct: 0.30,
  minAbs: { impressions: 2000, clicks: 10, sessions: 10, estimates: 10 },
  minSessionsForRate: 30,
};

const PAGE_GROUPS = ['articles', 'region', 'trade', 'homepage', 'other'];

// ─── pure helpers (tested offline) ───────────────────────────────────────

function toIso(d) {
  return d.toISOString().split('T')[0];
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

// weekBlocks('2026-11-24', 5) -> [{ from, to }] newest first, inclusive dates
function weekBlocks(lastDay, count = WEEKS) {
  const blocks = [];
  for (let i = 0; i < count; i += 1) {
    const to = addDays(lastDay, -7 * i);
    blocks.push({ from: addDays(to, -6), to });
  }
  return blocks;
}

function blockIndex(date, blocks) {
  return blocks.findIndex((b) => date >= b.from && date <= b.to);
}

// Accepts a full URL (GSC) or a path (GA4).
function pageGroup(urlOrPath) {
  let path = String(urlOrPath || '');
  path = path.replace(/^https?:\/\/[^/]+/i, '').split('?')[0].split('#')[0];
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '' || path === '/') return 'homepage';
  if (/^\/articles\/[^/]+$/.test(path)) return 'articles';
  if (/^\/costs\/[^/]+\/[^/]+$/.test(path)) return 'trade';
  if (/^\/costs\/[^/]+$/.test(path)) return 'region';
  return 'other';
}

function jobGroup(jobType) {
  const g = CHART_GROUPS.find((c) => c.jobTypes.includes(jobType));
  return g ? g.key : 'everything-else';
}

const round1 = (n) => Math.round(n * 10) / 10;

// compare(series) where series[0] is the latest week -> summary with flag
function compare(series, metric) {
  const current = series[0];
  const previous = series[1];
  const prior = series.slice(1, WEEKS);
  const avg4 = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
  const out = { current, previous, avg4: avg4 === null ? null : round1(avg4), flag: null };
  if (avg4 && ANOMALY.minAbs[metric] !== undefined) {
    const diff = current - avg4;
    if (Math.abs(diff) / avg4 >= ANOMALY.pct && Math.abs(diff) >= ANOMALY.minAbs[metric]) {
      out.flag = { direction: diff > 0 ? 'up' : 'down', changePct: Math.round((diff / avg4) * 100) };
    }
  }
  return out;
}

// Rate per landing session: series of { sessions, estimates } newest first.
function compareRate(series) {
  const rate = (w) => (w.sessions ? w.estimates / w.sessions : null);
  const current = rate(series[0]);
  const previous = rate(series[1]);
  const priorS = series.slice(1, WEEKS).reduce((a, w) => a + w.sessions, 0);
  const priorE = series.slice(1, WEEKS).reduce((a, w) => a + w.estimates, 0);
  const avg4 = priorS ? priorE / priorS : null;
  const pct = (r) => (r === null ? null : round1(r * 100));
  const out = {
    sessions: series[0].sessions,
    estimates: series[0].estimates,
    ratePct: pct(current),
    previousRatePct: pct(previous),
    avg4RatePct: pct(avg4),
    flag: null,
  };
  if (current !== null && avg4 && series[0].sessions >= ANOMALY.minSessionsForRate) {
    const change = (current - avg4) / avg4;
    if (Math.abs(change) >= ANOMALY.pct) {
      out.flag = { direction: change > 0 ? 'up' : 'down', changePct: Math.round(change * 100) };
    }
  }
  return out;
}

const zeros = () => Array(WEEKS).fill(0);

// ─── builders over source rows (tested offline) ──────────────────────────

function buildGsc({ dateRows, pageRowsCurrent, pageRowsPrevious, blocks }) {
  const impressions = zeros();
  const clicks = zeros();
  const posWeighted = zeros();
  dateRows.forEach((r) => {
    const i = blockIndex(r.key, blocks);
    if (i === -1) return;
    impressions[i] += r.impressions;
    clicks[i] += r.clicks;
    posWeighted[i] += r.position * r.impressions;
  });
  const ctr = (i) => (impressions[i] ? Math.round((clicks[i] / impressions[i]) * 10000) / 100 : null);
  const pos = (i) => (impressions[i] ? round1(posWeighted[i] / impressions[i]) : null);

  const sumByGroup = (rows) => {
    const g = Object.fromEntries(PAGE_GROUPS.map((k) => [k, { clicks: 0, impressions: 0 }]));
    rows.forEach((r) => {
      const k = pageGroup(r.key);
      g[k].clicks += r.clicks;
      g[k].impressions += r.impressions;
    });
    return g;
  };
  const cur = sumByGroup(pageRowsCurrent);
  const prev = sumByGroup(pageRowsPrevious);

  return {
    weeks: blocks,
    impressions: compare(impressions, 'impressions'),
    clicks: compare(clicks, 'clicks'),
    ctrPct: { current: ctr(0), previous: ctr(1) },
    position: { current: pos(0), previous: pos(1) },
    byPageGroup: PAGE_GROUPS.map((k) => ({
      group: k,
      clicks: cur[k].clicks,
      previousClicks: prev[k].clicks,
      impressions: cur[k].impressions,
      previousImpressions: prev[k].impressions,
    })),
  };
}

function buildGa4({ rows, blocks }) {
  const all = zeros();
  const organic = zeros();
  const landing = Object.fromEntries(PAGE_GROUPS.map((k) => [k, Array.from({ length: WEEKS }, () => ({ sessions: 0, estimates: 0 }))]));
  rows.forEach((r) => {
    const i = blockIndex(r.date, blocks);
    if (i === -1) return;
    all[i] += r.sessions;
    if (r.channel === 'Organic Search') {
      organic[i] += r.sessions;
      const w = landing[pageGroup(r.landingPage)][i];
      w.sessions += r.sessions;
      w.estimates += r.estimates;
    }
  });
  return {
    weeks: blocks,
    sessionsAll: compare(all, 'sessions'),
    sessionsOrganic: compare(organic, 'sessions'),
    organicEstimateRateByLanding: PAGE_GROUPS.map((k) => ({ group: k, ...compareRate(landing[k]) })),
  };
}

function buildMongo({ rows, blocks }) {
  const byVariant = {};
  const byJobGroupCurrent = {};
  const byJobGroupPrevious = {};
  rows.forEach((r) => {
    const i = blockIndex(r.date, blocks);
    if (i === -1) return;
    if (!byVariant[r.variant]) byVariant[r.variant] = zeros();
    byVariant[r.variant][i] += r.count;
    const target = i === 0 ? byJobGroupCurrent : i === 1 ? byJobGroupPrevious : null;
    if (target) {
      if (!target[r.variant]) target[r.variant] = {};
      const g = jobGroup(r.jobType);
      target[r.variant][g] = (target[r.variant][g] || 0) + r.count;
    }
  });
  return {
    weeks: blocks,
    estimatesByVariant: Object.keys(byVariant).sort().map((v) => ({
      variant: v,
      ...compare(byVariant[v], 'estimates'),
      byJobGroup: CHART_GROUPS.map((g) => ({
        group: g.key,
        current: (byJobGroupCurrent[v] || {})[g.key] || 0,
        previous: (byJobGroupPrevious[v] || {})[g.key] || 0,
      })),
    })),
  };
}

function collectFlags({ gsc, ga4, mongo }) {
  const flags = [];
  const push = (kpi, source, s, extra = {}) => { if (s && s.flag) flags.push({ kpi, source, current: s.current, avg4: s.avg4, ...s.flag, ...extra }); };
  if (gsc) { push('impressions', 'gsc', gsc.impressions); push('clicks', 'gsc', gsc.clicks); }
  if (ga4) {
    push('organic sessions', 'ga4', ga4.sessionsOrganic);
    push('all sessions', 'ga4', ga4.sessionsAll);
    ga4.organicEstimateRateByLanding.forEach((r) => {
      if (r.flag) flags.push({ kpi: `estimate rate, ${r.group} landers`, source: 'ga4', current: r.ratePct, avg4: r.avg4RatePct, sessions: r.sessions, ...r.flag });
    });
  }
  if (mongo) mongo.estimatesByVariant.forEach((v) => push(`estimates (${v.variant})`, 'mongodb', v));
  return flags;
}

// Clicks and impressions by query class (AIQueryStrategySpec.md part 2).
// Query-level rows leave out anonymised queries, so totals here are lower
// than the site totals; compare classes and weeks, not against the site total.
function buildQueryClasses(rowsCurrent, rowsPrevious) {
  const sum = (rows) => {
    const t = Object.fromEntries(CLASSES.map((c) => [c, { clicks: 0, impressions: 0 }]));
    rows.forEach((r) => {
      const c = classifyQuery(r.key);
      t[c].clicks += r.clicks;
      t[c].impressions += r.impressions;
    });
    return t;
  };
  const cur = sum(rowsCurrent);
  const prev = sum(rowsPrevious);
  const ctr = (x) => (x.impressions ? Math.round((x.clicks / x.impressions) * 10000) / 100 : null);
  return CLASSES.map((c) => ({
    queryClass: c,
    clicks: cur[c].clicks,
    previousClicks: prev[c].clicks,
    impressions: cur[c].impressions,
    previousImpressions: prev[c].impressions,
    ctrPct: ctr(cur[c]),
    previousCtrPct: ctr(prev[c]),
  }));
}

// ─── live entry point ────────────────────────────────────────────────────

function lastCompleteDay(source, now = new Date()) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - LAG_DAYS[source]);
  return toIso(d);
}

async function buildKpis({ now = new Date() } = {}) {
  const partialFailure = [];
  const blocks = {
    gsc: weekBlocks(lastCompleteDay('gsc', now)),
    ga4: weekBlocks(lastCompleteDay('ga4', now)),
    mongodb: weekBlocks(lastCompleteDay('mongodb', now)),
  };
  const span = (b) => ({ from: b[WEEKS - 1].from, to: b[0].to });

  let gsc = null;
  try {
    const [dates, pagesCur, pagesPrev, queriesCur, queriesPrev] = await Promise.all([
      gscSource.getGscKpiRows({ ...span(blocks.gsc), dimension: 'date' }),
      gscSource.getGscKpiRows({ ...blocks.gsc[0], dimension: 'page' }),
      gscSource.getGscKpiRows({ ...blocks.gsc[1], dimension: 'page' }),
      gscSource.getGscKpiRows({ ...blocks.gsc[0], dimension: 'query' }),
      gscSource.getGscKpiRows({ ...blocks.gsc[1], dimension: 'query' }),
    ]);
    gsc = buildGsc({ dateRows: dates.rows, pageRowsCurrent: pagesCur.rows, pageRowsPrevious: pagesPrev.rows, blocks: blocks.gsc });
    gsc.byQueryClass = buildQueryClasses(queriesCur.rows, queriesPrev.rows);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] buildKpis: gsc failed:`, err.message);
    partialFailure.push({ source: 'gsc', reason: err.message });
  }

  let ga4 = null;
  try {
    const { rows } = await ga4Source.getGa4LandingRows(span(blocks.ga4));
    ga4 = buildGa4({ rows, blocks: blocks.ga4 });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] buildKpis: ga4 failed:`, err.message);
    partialFailure.push({ source: 'ga4', reason: err.message });
  }

  // Mongo range is [from, day after to) so the last day is complete.
  const m = span(blocks.mongodb);
  const mongoRows = await mongoSource.getEstimateDailyCounts({ from: m.from, to: addDays(m.to, 1) });
  const mongo = buildMongo({ rows: mongoRows, blocks: blocks.mongodb });

  return {
    generatedAt: new Date().toISOString(),
    rule: 'Flag: 30% or more against the 4-week average and at least 2,000 impressions, or 10 clicks, sessions or estimates. Rates: 30% or more with at least 30 landing sessions in the week.',
    excluded: { testDistricts: mongoSource.TEST_DISTRICTS, ga4Countries: ['Singapore'] },
    gsc,
    ga4,
    mongodb: mongo,
    flags: collectFlags({ gsc, ga4, mongo }),
    ...(partialFailure.length ? { partialFailure } : {}),
  };
}

module.exports = {
  buildKpis,
  // exported for tests
  weekBlocks,
  pageGroup,
  jobGroup,
  compare,
  compareRate,
  buildGsc,
  buildGa4,
  buildMongo,
  collectFlags,
  buildQueryClasses,
  ANOMALY,
};
