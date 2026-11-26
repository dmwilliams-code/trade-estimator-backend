// analytics/demandStats.js
// Pure functions behind the demand stats pipeline: windows, share tables,
// suppression, captions and validation. No database access here, so every
// rule is unit tested (analytics/demandStats.test.js).
//
// Figures describe what was priced on EstimateAI (job mix, sizes, quality
// tier, region), never what work costs. Estimate totals come from our own
// engine, so publishing them as market evidence would be circular.

const {
  RULES,
  JOB_LABELS,
  FAMILIES,
  AREA_SIZES,
  PROJECT_SIZE_LABELS,
  QUALITY_LABELS,
  CATEGORY_LABELS,
  QUOTE_LABELS
} = require('./demandStatsConfig');

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Dates and windows (all UTC) ─────────────────────────────────────────────

function utcMonthStart(year, month) {
  return new Date(Date.UTC(year, month, 1));
}

function monthLabel(date) {
  return date.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function dayLabel(date) {
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function isLocked(windowEnd, now, rules = RULES) {
  return now.getTime() >= windowEnd.getTime() + rules.lockAfterDays * DAY_MS;
}

// Completed calendar months and quarters that start on or after the floor,
// plus the rolling 6 month window ending now.
function windowsFor(now, rules = RULES) {
  const floor = new Date(`${rules.dateFloor}T00:00:00Z`);
  const windows = [];

  const sixAgo = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth() - 6);
  sixAgo.setUTCDate(Math.min(now.getUTCDate(), 28));
  const trailingStart = sixAgo < floor ? floor : sixAgo;
  windows.push({
    windowType: 'trailing-6m',
    windowStart: trailingStart,
    windowEnd: now,
    windowLabel: `${dayLabel(trailingStart)} to ${dayLabel(new Date(now.getTime() - 1))}`,
    complete: false
  });

  const currentMonth = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth());
  let cursor = utcMonthStart(floor.getUTCFullYear(), floor.getUTCMonth());
  if (cursor < floor) cursor = utcMonthStart(floor.getUTCFullYear(), floor.getUTCMonth() + 1);
  while (cursor < currentMonth) {
    const end = utcMonthStart(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
    windows.push({ windowType: 'month', windowStart: cursor, windowEnd: end, windowLabel: monthLabel(cursor), complete: true });
    cursor = end;
  }

  const currentQuarter = utcMonthStart(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3);
  let q = utcMonthStart(floor.getUTCFullYear(), Math.floor(floor.getUTCMonth() / 3) * 3);
  if (q < floor) q = utcMonthStart(q.getUTCFullYear(), q.getUTCMonth() + 3);
  while (q < currentQuarter) {
    const end = utcMonthStart(q.getUTCFullYear(), q.getUTCMonth() + 3);
    const quarter = Math.floor(q.getUTCMonth() / 3) + 1;
    windows.push({ windowType: 'quarter', windowStart: q, windowEnd: end, windowLabel: `Q${quarter} ${q.getUTCFullYear()}`, complete: true });
    q = end;
  }

  return windows;
}

// ─── Share tables ────────────────────────────────────────────────────────────

// Whole percentages that always add up to exactly 100 (largest remainder).
function wholeShares(counts, total) {
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rem: r - floors[i] }))
    .sort((a, b) => b.rem - a.rem || counts[b.i] - counts[a.i]);
  for (let k = 0; k < order.length && left > 0; k += 1, left -= 1) floors[order[k].i] += 1;
  return floors;
}

// counts: { key: number }. Keys below minCell, or beyond the top `limit`, are
// merged into "Other". Each row keeps its count for validation; the API strips
// counts before anything is served.
function shareTable(counts, labelFor, { minCell = RULES.minCell, limit = Infinity } = {}) {
  const entries = Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, c]) => sum + c, 0);
  if (!total) return [];

  const shown = [];
  let other = 0;
  for (const [key, count] of entries) {
    if (count >= minCell && shown.length < limit) shown.push({ key, label: labelFor(key), count });
    else other += count;
  }
  const rows = other > 0 ? [...shown, { key: 'other', label: 'Other', count: other }] : shown;
  const shares = wholeShares(rows.map((r) => r.count), total);
  return rows.map((r, i) => ({ ...r, share: shares[i] }));
}

function countBy(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = fn(row);
    if (key === null || key === undefined || key === '') continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function bandLabel(bands, i) {
  const from = bands[i];
  const to = bands[i + 1];
  if (i === 0) return `Under ${to} m²`;
  if (to === undefined) return `${from} m² or more`;
  return `${from} to ${to} m²`;
}

function areaSizeMetric(rows, jobType, rules) {
  const cfg = AREA_SIZES[jobType];
  if (!cfg) return null;
  const [lo, hi] = cfg.plausible;
  const values = rows
    .map((r) => r.areaQuantity)
    .filter((v) => typeof v === 'number' && v >= lo && v <= hi)
    .sort((a, b) => a - b);
  if (values.length < rules.minN) return null;

  const counts = {};
  for (const v of values) {
    let i = cfg.bands.length - 1;
    while (i > 0 && v < cfg.bands[i]) i -= 1;
    counts[i] = (counts[i] || 0) + 1;
  }
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  // Bands keep their natural order rather than being sorted by size of share.
  const table = shareTable(counts, (i) => bandLabel(cfg.bands, Number(i)), { minCell: rules.minCell });
  const ordered = [
    ...table.filter((r) => r.key !== 'other').sort((a, b) => Number(a.key) - Number(b.key)),
    ...table.filter((r) => r.key === 'other')
  ];
  return { kind: 'area', unit: 'm²', medianArea: Math.round(median), bands: ordered, sampleCount: values.length };
}

function projectSizeMetric(rows, rules) {
  const counts = countBy(rows, (r) => (PROJECT_SIZE_LABELS[r.projectSize] ? r.projectSize : null));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < rules.minN) return null;
  const table = shareTable(counts, (k) => PROJECT_SIZE_LABELS[k], { minCell: rules.minCell });
  const order = Object.keys(PROJECT_SIZE_LABELS);
  table.sort((a, b) => (a.key === 'other') - (b.key === 'other') || order.indexOf(a.key) - order.indexOf(b.key));
  return { kind: 'projectSize', bands: table, sampleCount: total };
}

function regionMetric(rows, regionNames, rules) {
  const resolved = rows.filter((r) => r.regionSlug && regionNames[r.regionSlug]);
  const resolvedShare = rows.length ? Math.round((resolved.length / rows.length) * 100) : 0;
  if (resolved.length < rules.minN) return { regionShare: null, regionResolvedShare: resolvedShare };
  const table = shareTable(countBy(resolved, (r) => r.regionSlug), (s) => regionNames[s], { minCell: rules.minCell, limit: 8 });
  return { regionShare: table, regionResolvedShare: resolvedShare };
}

function monthlyMetric(rows) {
  const counts = countBy(rows, (r) => r.createdAt.toISOString().slice(0, 7));
  const keys = Object.keys(counts).sort();
  // A month with very few estimates cannot be merged into "Other" sensibly,
  // so the whole series is left out instead.
  if (!keys.length || keys.some((k) => counts[k] < RULES.minCell)) return null;
  const shares = wholeShares(keys.map((k) => counts[k]), rows.length);
  return keys.map((k, i) => ({
    key: k,
    label: monthLabel(new Date(`${k}-01T00:00:00Z`)),
    count: counts[k],
    share: shares[i]
  }));
}

function quoteMetric(rows, rules) {
  const from = new Date(`${rules.quoteStatusFrom}T00:00:00Z`);
  const answered = rows.filter((r) => r.createdAt >= from && QUOTE_LABELS[r.quoteStatus]);
  if (answered.length < rules.minN) return null;
  return shareTable(countBy(answered, (r) => r.quoteStatus), (k) => QUOTE_LABELS[k], { minCell: rules.minCell });
}

function scopeMetrics(rows, { scope, key, windowType, regionNames, rules }) {
  const metrics = {
    qualityMix: shareTable(countBy(rows, (r) => (QUALITY_LABELS[r.quality] ? r.quality : null)), (k) => QUALITY_LABELS[k], { minCell: rules.minCell }),
    ...regionMetric(rows, regionNames, rules),
    monthlyShare: windowType === 'trailing-6m' ? monthlyMetric(rows) : null,
    quoteStatusMix: quoteMetric(rows, rules)
  };
  if (scope === 'national') {
    metrics.jobShare = shareTable(countBy(rows, (r) => r.jobType), (k) => JOB_LABELS[k], { minCell: rules.minCell, limit: 10 });
    metrics.familyShare = shareTable(
      // Jobs outside a family count as 'Other jobs', so shares are of all estimates.
      countBy(rows, (r) => Object.keys(FAMILIES).find((f) => FAMILIES[f].jobTypes.includes(r.jobType)) || 'other-jobs'),
      (k) => (FAMILIES[k] ? FAMILIES[k].label : 'Other jobs'),
      { minCell: rules.minCell }
    );
    metrics.categoryShare = shareTable(countBy(rows, (r) => (CATEGORY_LABELS[r.category] ? r.category : null)), (k) => CATEGORY_LABELS[k], { minCell: rules.minCell });
  } else if (scope === 'job') {
    metrics.size = AREA_SIZES[key] ? areaSizeMetric(rows, key, rules) : projectSizeMetric(rows, rules);
  } else if (scope === 'family') {
    metrics.jobShare = shareTable(countBy(rows, (r) => r.jobType), (k) => JOB_LABELS[k], { minCell: rules.minCell });
  }
  return metrics;
}

// ─── Captions (built from the figures, never by a language model) ───────────

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// Largest share, ignoring Other. Size tables are kept in size order, so the
// first row is not necessarily the biggest.
function topRow(table) {
  return (table || []).filter((r) => r.key !== 'other').reduce((best, r) => (!best || r.share > best.share ? r : best), null);
}

function buildCaption(snapshot) {
  if (snapshot.suppressed) return null;
  const m = snapshot.metrics;
  const when = snapshot.windowType === 'trailing-6m' ? 'over the last six months' : `in ${snapshot.windowLabel}`;

  if (snapshot.scope === 'national') {
    const job = topRow(m.jobShare);
    if (!job) return null;
    return `${job.label} was the most priced job on EstimateAI ${when}, at ${job.share}% of estimates.`;
  }

  const parts = [];
  const quality = topRow(m.qualityMix);
  if (m.size && m.size.kind === 'area') {
    parts.push(`The typical ${lowerFirst(snapshot.label)} priced on EstimateAI ${when} was ${m.size.medianArea} m²`);
  } else if (m.size && m.size.kind === 'projectSize') {
    const size = topRow(m.size.bands);
    if (size) parts.push(`${size.share}% of ${lowerFirst(snapshot.label)} estimates on EstimateAI ${when} were for a ${size.label.toLowerCase()} job`);
  } else if (snapshot.scope === 'family') {
    const job = topRow(m.jobShare);
    if (job) parts.push(`${job.label} made up ${job.share}% of ${snapshot.noun || lowerFirst(snapshot.label)} estimates on EstimateAI ${when}`);
  }
  if (quality) {
    const qualityText = `${quality.share}% chose ${quality.label} quality`;
    if (parts.length) return `${parts[0]}, and ${qualityText}.`;
    return `For ${lowerFirst(snapshot.label)} estimates on EstimateAI ${when}, ${qualityText}.`;
  }
  return parts.length ? `${parts[0]}.` : null;
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

function unknownJobTypes(rows) {
  return [...new Set(rows.map((r) => r.jobType).filter((j) => !JOB_LABELS[j]))];
}

// rows: plain estimate rows already filtered by the population rules, shaped
// { jobType, category, quality, areaQuantity, projectSize, regionSlug, quoteStatus, createdAt }.
function buildWindowSnapshots(rows, win, { now, regionNames, rules = RULES }) {
  const inWindow = rows.filter((r) => r.createdAt >= win.windowStart && r.createdAt < win.windowEnd);
  const base = {
    windowType: win.windowType,
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    windowLabel: win.windowLabel,
    builtAt: now,
    locked: win.complete && isLocked(win.windowEnd, now, rules),
    rules: { minN: rules.minN, minCell: rules.minCell, dedupe: rules.dedupe, dateFloor: rules.dateFloor, excluded: rules.excluded || [] }
  };

  const scopes = [{ scope: 'national', key: 'all', label: 'All jobs', rows: inWindow }];
  for (const jobType of Object.keys(JOB_LABELS)) {
    scopes.push({ scope: 'job', key: jobType, label: JOB_LABELS[jobType], rows: inWindow.filter((r) => r.jobType === jobType) });
  }
  for (const [family, def] of Object.entries(FAMILIES)) {
    scopes.push({ scope: 'family', key: family, label: def.label, noun: def.noun, rows: inWindow.filter((r) => def.jobTypes.includes(r.jobType)) });
  }

  return scopes
    .filter((s) => s.rows.length > 0)
    .map((s) => {
      const suppressed = s.rows.length < rules.minN;
      const snapshot = {
        ...base,
        scope: s.scope,
        key: s.key,
        label: s.label,
        ...(s.noun ? { noun: s.noun } : {}),
        n: s.rows.length,
        suppressed,
        metrics: suppressed ? {} : scopeMetrics(s.rows, { scope: s.scope, key: s.key, windowType: win.windowType, regionNames, rules })
      };
      snapshot.caption = buildCaption(snapshot);
      return snapshot;
    });
}

// ─── Validation ──────────────────────────────────────────────────────────────

function shareTables(metrics) {
  const tables = [];
  for (const value of Object.values(metrics || {})) {
    if (Array.isArray(value)) tables.push(value);
    else if (value && Array.isArray(value.bands)) tables.push(value.bands);
  }
  return tables;
}

// Checks one window's snapshots before they are marked published.
// independentCount: a separate countDocuments() run with the same filters.
// previousN: national n of the previous comparable snapshot, or null.
function validateWindow(snapshots, { independentCount, previousN, rules = RULES }) {
  const problems = [];
  const national = snapshots.find((s) => s.scope === 'national');
  const n = national ? national.n : 0;

  if (n !== independentCount) problems.push(`national n ${n} does not match independent count ${independentCount}`);

  for (const s of snapshots) {
    for (const table of shareTables(s.metrics)) {
      const sum = table.reduce((a, r) => a + r.share, 0);
      if (table.length && sum !== 100) problems.push(`${s.scope}/${s.key}: shares sum to ${sum}`);
      for (const row of table) {
        if (row.key !== 'other' && row.count < rules.minCell) {
          problems.push(`${s.scope}/${s.key}: cell ${row.key} has ${row.count}, below ${rules.minCell}`);
        }
      }
    }
    if (s.caption && /\d+ estimates?\b/.test(s.caption.replace(/% of estimates/g, ''))) {
      problems.push(`${s.scope}/${s.key}: caption states a count`);
    }
  }

  let swingPct = null;
  if (previousN && previousN > 0) swingPct = Math.round(((n - previousN) / previousN) * 100);
  const needsReview = swingPct !== null && Math.abs(swingPct) > rules.swingReviewPct;

  return { ok: problems.length === 0, problems, swingPct, needsReview };
}

module.exports = {
  windowsFor,
  wholeShares,
  shareTable,
  buildWindowSnapshots,
  buildCaption,
  validateWindow,
  unknownJobTypes,
  isLocked
};
