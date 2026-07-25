// Canonical analytics module. Owns every query and every data rule. Both
// mcp-analytics/server.js and crons/snapshot-cron.js import this and only
// this -- neither contains a database query of its own.
//
// Every public function returns { meta, data }. Never a bare array.

const mongoSource = require('./sources/mongoSource');
const gscSource = require('./sources/gscSource');
const ga4Source = require('./sources/ga4Source');
const { resolveWindow, TEST_START_DATE } = require('./resolveWindow');
const { computeVerdict } = require('./verdict');
const caveats = require('./caveats');
const { serialise } = require('./serialise');

const VARIANT_ARMS = ['blur', 'control', 'open_jul2026', 'unassigned'];

// ─── meta helpers ─────────────────────────────────────────────────────────

function activeCaveats(sourcesTouched, windowsBySource) {
  return caveats
    .filter((c) => {
      if (!c.sources.some((s) => sourcesTouched.includes(s))) return false;
      if (c.from === null && c.to === null) return true;
      return c.sources.some((s) => {
        const w = windowsBySource[s];
        if (!w) return false;
        const caveatFrom = c.from || '0000-01-01';
        const caveatTo = c.to || '9999-12-31';
        return w.from <= caveatTo && w.to >= caveatFrom;
      });
    })
    .map((c) => c.text);
}

function buildMeta({ windows, sampleSizes, cachedAt, sourcesTouched, windowsBySource, partialFailure }) {
  const meta = {
    generatedAt: new Date().toISOString(),
    windows: windows || {},
    caveats: activeCaveats(sourcesTouched, windowsBySource),
  };
  if (sampleSizes) meta.sampleSizes = sampleSizes;
  if (cachedAt) meta.cachedAt = cachedAt;
  if (partialFailure && partialFailure.length) meta.partialFailure = partialFailure;
  return meta;
}

function sumCountByVariant(rows, variantPath) {
  const sizes = {};
  rows.forEach((row) => {
    const variant = variantPath(row);
    sizes[variant] = (sizes[variant] || 0) + (row.count || 0);
  });
  return sizes;
}

// ─── core implementations (period|days accepted directly) ────────────────

async function coreEstimateDemand(periodOrDays, groupBy) {
  const window = resolveWindow(periodOrDays, 'mongodb');
  const [demandRows, varianceRows] = await Promise.all([
    mongoSource.getDemandByGroup({ from: window.from, to: window.to, groupBy }),
    mongoSource.getEstimatesByVariant({ from: window.from, to: window.to }),
  ]);

  const regionUnresolved = {};
  varianceRows.forEach((r) => { regionUnresolved[r._id] = r.regionUnresolved; });

  const data = {
    rows: serialise('estimate_demand', demandRows.map((r) => ({
      variant: r._id.variant,
      key: r._id.key,
      count: r.count,
      avgValue: r.avgValue,
      qualityBreakdown: r.qualityBreakdown,
    }))),
    regionUnresolved,
  };

  const sampleSizes = { estimates: sumCountByVariant(demandRows.map((r) => ({ count: r.count, variant: r._id.variant })), (r) => r.variant) };

  return {
    meta: buildMeta({
      windows: { mongodb: window },
      sampleSizes,
      sourcesTouched: ['mongodb'],
      windowsBySource: { mongodb: window },
    }),
    data,
  };
}

async function coreContractorSignals(periodOrDays, groupBy, limit) {
  const window = resolveWindow(periodOrDays, 'mongodb');

  if (groupBy === 'ladder') {
    const rows = await mongoSource.getContractorSignalLadder({ from: window.from, to: window.to });
    const shaped = rows.map((r) => ({ variant: r._id.variant, action: r._id.action, count: r.count }));
    const sampleSizes = { contractorClicks: sumCountByVariant(shaped, (r) => r.variant) };
    return {
      meta: buildMeta({
        windows: { mongodb: window },
        sampleSizes,
        sourcesTouched: ['mongodb'],
        windowsBySource: { mongodb: window },
      }),
      data: serialise('contractor_signal_ladder', shaped),
    };
  }

  if (groupBy === 'contractor') {
    const rows = await mongoSource.getContractorDensity({ from: window.from, to: window.to, limit });
    const shaped = rows.map((r) => ({
      placeId: r._id.placeId,
      variant: r._id.variant,
      contractorName: r.contractorName,
      signals: r.signals,
      districts: r.districts,
      jobTypes: r.jobTypes,
      totalEstimateValue: r.totalEstimateValue,
    }));
    return {
      meta: buildMeta({
        windows: { mongodb: window },
        sourcesTouched: ['mongodb'],
        windowsBySource: { mongodb: window },
      }),
      data: serialise('contractor_density', shaped),
    };
  }

  throw new Error(`getContractorSignals: unknown groupBy "${groupBy}", expected "ladder" or "contractor"`);
}

async function coreGscPerformance(periodOrDays, dimension, limit) {
  const window = resolveWindow(periodOrDays, 'gsc');
  const { rows, cachedAt } = await gscSource.getGscPerformance({ from: window.from, to: window.to, dimension, limit });
  return {
    meta: buildMeta({
      windows: { gsc: window },
      cachedAt: { gsc: cachedAt },
      sourcesTouched: ['gsc'],
      windowsBySource: { gsc: window },
    }),
    data: serialise('gsc_performance', rows),
  };
}

async function coreGa4Events(periodOrDays, eventNames, breakdown) {
  const window = resolveWindow(periodOrDays, 'ga4');
  const { rows, cachedAt } = await ga4Source.getGa4Events({ from: window.from, to: window.to, eventNames, breakdown });
  return {
    meta: buildMeta({
      windows: { ga4: window },
      cachedAt: { ga4: cachedAt },
      sourcesTouched: ['ga4'],
      windowsBySource: { ga4: window },
    }),
    data: serialise('ga4_events', rows),
  };
}

async function coreAbTestStatus(fromOverride, toOverride) {
  const window = (fromOverride && toOverride)
    ? { from: fromOverride, to: toOverride, lagDays: 0 }
    : resolveWindow('since_test_start', 'mongodb');

  const [estimateRows, leadRows] = await Promise.all([
    mongoSource.getEstimatesByVariant({ from: window.from, to: window.to }),
    mongoSource.getLeadsByVariant({ from: window.from, to: window.to }),
  ]);

  const estimatesByVariant = {};
  estimateRows.forEach((r) => { estimatesByVariant[r._id] = r; });
  const leadsByVariant = {};
  leadRows.forEach((r) => { leadsByVariant[r._id] = r; });

  const funnel = {};
  VARIANT_ARMS.forEach((variant) => {
    const est = estimatesByVariant[variant] || { count: 0, avgValue: null, regionUnresolved: 0 };
    const lead = leadsByVariant[variant] || { count: 0, sourceBreakdown: [] };
    funnel[variant] = {
      estimates: est.count,
      leads: lead.count,
      avgValue: est.avgValue,
      regionUnresolved: est.regionUnresolved,
      leadSourceBreakdown: lead.sourceBreakdown,
    };
  });

  // Verdict engine is two-arm only (spec section 8, "third arm handling").
  // open_jul2026 and unassigned are reported in `funnel` but never enter
  // this calculation.
  const verdict = computeVerdict({
    blur: { estimates: funnel.blur.estimates, leads: funnel.blur.leads },
    control: { estimates: funnel.control.estimates, leads: funnel.control.leads },
  });

  const sampleSizes = { estimates: {} };
  VARIANT_ARMS.forEach((v) => { sampleSizes.estimates[v] = funnel[v].estimates; });

  return {
    meta: buildMeta({
      windows: { mongodb: window },
      sampleSizes,
      sourcesTouched: ['mongodb'],
      windowsBySource: { mongodb: window },
    }),
    data: { funnel, verdict },
  };
}

async function coreChangeLog(since) {
  const rows = await mongoSource.getChangeLog({ since });
  return {
    meta: buildMeta({ windows: {}, sourcesTouched: [], windowsBySource: {} }),
    data: serialise('change_log', rows),
  };
}

// ─── public surface ────────────────────────────────────────────────────────

async function getEstimateDemand({ days, groupBy }) {
  return coreEstimateDemand(days, groupBy);
}

async function getContractorSignals({ days, groupBy, limit }) {
  return coreContractorSignals(days, groupBy, limit);
}

async function getGscPerformance({ days, dimension, limit }) {
  return coreGscPerformance(days, dimension, limit);
}

async function getGa4Events({ days, eventNames, breakdown }) {
  return coreGa4Events(days, eventNames, breakdown);
}

async function getAbTestStatus({ from, to } = {}) {
  return coreAbTestStatus(from, to);
}

async function getChangeLog({ since } = {}) {
  const sinceDate = since || (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 90);
    return d.toISOString().split('T')[0];
  })();
  return coreChangeLog(sinceDate);
}

// buildSnapshot({ period }) -> full composite object. The default entry
// point for open questions like "how are things going". GSC/GA4 failures
// degrade to a partialFailure entry rather than failing the whole snapshot
// (rule: section 10.4) -- MongoDB failures are not caught, since the
// snapshot has no meaningful content without it.
async function buildSnapshot({ period }) {
  const partialFailure = [];

  const [abStatus, demand, signals, changeLog] = await Promise.all([
    coreAbTestStatus(),
    coreEstimateDemand(period, 'job_type'),
    coreContractorSignals(period, 'ladder'),
    coreChangeLog(resolveWindow(period, 'mongodb').from),
  ]);

  let gsc = null;
  try {
    gsc = await coreGscPerformance(period, 'page', 20);
  } catch (err) {
    partialFailure.push({ source: 'gsc', reason: err.message });
  }

  let ga4 = null;
  try {
    ga4 = await coreGa4Events(period, null, 'none');
  } catch (err) {
    partialFailure.push({ source: 'ga4', reason: err.message });
  }

  const windows = { mongodb: abStatus.meta.windows.mongodb };
  const cachedAt = {};
  const caveatSet = new Set([
    ...abStatus.meta.caveats,
    ...demand.meta.caveats,
    ...signals.meta.caveats,
    ...changeLog.meta.caveats,
  ]);

  if (gsc) {
    windows.gsc = gsc.meta.windows.gsc;
    cachedAt.gsc = gsc.meta.cachedAt.gsc;
    gsc.meta.caveats.forEach((c) => caveatSet.add(c));
  }
  if (ga4) {
    windows.ga4 = ga4.meta.windows.ga4;
    cachedAt.ga4 = ga4.meta.cachedAt.ga4;
    ga4.meta.caveats.forEach((c) => caveatSet.add(c));
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      windows,
      sampleSizes: abStatus.meta.sampleSizes,
      cachedAt,
      caveats: [...caveatSet],
      ...(partialFailure.length ? { partialFailure } : {}),
    },
    data: {
      abTestStatus: abStatus.data,
      estimateDemand: demand.data,
      contractorSignals: signals.data,
      gscPerformance: gsc ? gsc.data : null,
      ga4Events: ga4 ? ga4.data : null,
      changeLog: changeLog.data,
    },
  };
}

module.exports = {
  buildSnapshot,
  getAbTestStatus,
  getGscPerformance,
  getGa4Events,
  getEstimateDemand,
  getContractorSignals,
  getChangeLog,
  resolveWindow,
  TEST_START_DATE,
};
