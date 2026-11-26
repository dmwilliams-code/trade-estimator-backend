// Plain-assert unit tests for the demand stats pipeline, same style as
// verdict.test.js. Run with: node analytics/demandStats.test.js

const assert = require('assert');
const {
  windowsFor,
  wholeShares,
  shareTable,
  buildWindowSnapshots,
  validateWindow,
  unknownJobTypes
} = require('./demandStats');
const { RULES } = require('./demandStatsConfig');

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const REGIONS = { 'london-greater': 'Greater London', manchester: 'Manchester' };
const NOW = new Date('2026-11-30T10:00:00Z');

function rows(count, overrides = {}, start = '2026-10-05T12:00:00Z') {
  return Array.from({ length: count }, (_, i) => ({
    jobType: 'single-storey-extension',
    category: 'building',
    quality: 'standard',
    areaQuantity: 20,
    projectSize: null,
    regionSlug: 'london-greater',
    quoteStatus: null,
    createdAt: new Date(new Date(start).getTime() + i * 60000),
    ...overrides
  }));
}

const OCTOBER = { windowType: 'month', windowStart: new Date('2026-10-01T00:00:00Z'), windowEnd: new Date('2026-11-01T00:00:00Z'), windowLabel: 'October 2026', complete: true };

run('wholeShares always sums to 100', () => {
  for (const counts of [[1, 1, 1], [7, 2, 1], [33, 33, 34], [1, 0, 0], [5, 5, 5, 5, 5, 5, 3]]) {
    const total = counts.reduce((a, b) => a + b, 0);
    assert.strictEqual(wholeShares(counts, total).reduce((a, b) => a + b, 0), 100, JSON.stringify(counts));
  }
});

run('shareTable merges cells below minCell (4) into Other, keeps 5', () => {
  const table = shareTable({ a: 15, b: 5, c: 4 }, (k) => k.toUpperCase(), { minCell: 5 });
  assert.deepStrictEqual(table.map((r) => r.key), ['a', 'b', 'other']);
  assert.strictEqual(table.find((r) => r.key === 'other').count, 4);
});

run('shareTable limit sends the tail to Other', () => {
  const table = shareTable({ a: 10, b: 9, c: 8 }, (k) => k, { minCell: 5, limit: 2 });
  assert.deepStrictEqual(table.map((r) => r.key), ['a', 'b', 'other']);
});

run('scope with 19 estimates is suppressed, 20 is published', () => {
  const at19 = buildWindowSnapshots(rows(19), OCTOBER, { now: NOW, regionNames: REGIONS });
  const at20 = buildWindowSnapshots(rows(20), OCTOBER, { now: NOW, regionNames: REGIONS });
  assert.strictEqual(at19.find((s) => s.scope === 'national').suppressed, true);
  assert.strictEqual(at19.find((s) => s.scope === 'national').caption, null);
  assert.strictEqual(at20.find((s) => s.scope === 'national').suppressed, false);
});

run('extension sizes ignore implausible 1 m2 entries and report the median', () => {
  const data = [...rows(20, { areaQuantity: 22 }), ...rows(10, { areaQuantity: 1 })];
  const job = buildWindowSnapshots(data, OCTOBER, { now: NOW, regionNames: REGIONS }).find((s) => s.key === 'single-storey-extension');
  assert.strictEqual(job.metrics.size.medianArea, 22);
  assert.strictEqual(job.metrics.size.sampleCount, 20);
});

run('region share needs 20 resolved estimates and reports resolved share', () => {
  const data = [...rows(15), ...rows(15, { regionSlug: null })];
  const national = buildWindowSnapshots(data, OCTOBER, { now: NOW, regionNames: REGIONS }).find((s) => s.scope === 'national');
  assert.strictEqual(national.metrics.regionShare, null);
  assert.strictEqual(national.metrics.regionResolvedShare, 50);
});

run('quote mix only counts answers from 26 Nov 2026 and needs 20', () => {
  const before = rows(25, { quoteStatus: 'one' }, '2026-11-20T00:00:00Z');
  const after = rows(20, { quoteStatus: 'none' }, '2026-11-26T09:00:00Z');
  const win = { ...OCTOBER, windowStart: new Date('2026-11-01T00:00:00Z'), windowEnd: new Date('2026-12-01T00:00:00Z') };
  const national = buildWindowSnapshots([...before, ...after], win, { now: NOW, regionNames: REGIONS }).find((s) => s.scope === 'national');
  assert.deepStrictEqual(national.metrics.quoteStatusMix.map((r) => [r.key, r.share]), [['none', 100]]);
});

run('captions never state a count and use no em dash', () => {
  const data = [...rows(30), ...rows(20, { jobType: 'plastering-room', areaQuantity: null, projectSize: 'medium', quality: 'premium' })];
  for (const s of buildWindowSnapshots(data, OCTOBER, { now: NOW, regionNames: REGIONS })) {
    if (!s.caption) continue;
    assert.ok(!s.caption.includes(String.fromCharCode(0x2014)), s.caption);
    assert.ok(!/\d+ estimates?\b/.test(s.caption.replace(/% of estimates/g, '')), s.caption);
  }
});

run('validateWindow passes clean data and flags a count mismatch', () => {
  const snaps = buildWindowSnapshots(rows(40), OCTOBER, { now: NOW, regionNames: REGIONS });
  assert.strictEqual(validateWindow(snaps, { independentCount: 40, previousN: 38 }).ok, true);
  assert.strictEqual(validateWindow(snaps, { independentCount: 41, previousN: 38 }).ok, false);
});

run('validateWindow holds a volume swing over 60% for review', () => {
  const snaps = buildWindowSnapshots(rows(40), OCTOBER, { now: NOW, regionNames: REGIONS });
  assert.strictEqual(validateWindow(snaps, { independentCount: 40, previousN: 141 }).needsReview, true);
  assert.strictEqual(validateWindow(snaps, { independentCount: 40, previousN: 60 }).needsReview, false);
});

run('unknown jobType is reported', () => {
  assert.deepStrictEqual(unknownJobTypes(rows(2, { jobType: 'hot-tub' })), ['hot-tub']);
});

run('windows: months from July, quarters from Q3, months lock 7 days after end', () => {
  const wins = windowsFor(NOW);
  const months = wins.filter((w) => w.windowType === 'month').map((w) => w.windowLabel);
  assert.deepStrictEqual(months, ['July 2026', 'August 2026', 'September 2026', 'October 2026']);
  assert.deepStrictEqual(wins.filter((w) => w.windowType === 'quarter').map((w) => w.windowLabel), ['Q3 2026']);
  const cumulative = wins.find((w) => w.windowType === 'cumulative');
  assert.strictEqual(cumulative.windowStart.toISOString().slice(0, 10), RULES.dateFloor);
  assert.strictEqual(wins.filter((w) => w.windowType === 'cumulative').length, 1);
  const later = windowsFor(new Date('2027-05-01T10:00:00Z')).find((w) => w.windowType === 'cumulative');
  assert.strictEqual(later.windowStart.toISOString().slice(0, 10), RULES.dateFloor, 'cumulative never drops early months');
  const snaps = buildWindowSnapshots(rows(25), OCTOBER, { now: NOW, regionNames: REGIONS });
  assert.strictEqual(snaps[0].locked, true);
  const early = buildWindowSnapshots(rows(25), OCTOBER, { now: new Date('2026-11-03T10:00:00Z'), regionNames: REGIONS });
  assert.strictEqual(early[0].locked, false);
});

run('caption picks the biggest size band, not the first in size order', () => {
  const data = [...rows(8, { jobType: 'plastering-room', areaQuantity: null, projectSize: 'small' }),
    ...rows(14, { jobType: 'plastering-room', areaQuantity: null, projectSize: 'medium' })];
  const job = buildWindowSnapshots(data, OCTOBER, { now: NOW, regionNames: REGIONS }).find((s) => s.key === 'plastering-room');
  assert.ok(job.caption.startsWith('64% of room plastering estimates'), job.caption);
  assert.ok(job.caption.includes('for a medium job'), job.caption);
});

run('family share is a share of all estimates, not just family jobs', () => {
  const data = [...rows(20), ...rows(20, { jobType: 'rewire', category: 'electrical', areaQuantity: null, projectSize: 'medium' })];
  const national = buildWindowSnapshots(data, OCTOBER, { now: NOW, regionNames: REGIONS }).find((s) => s.scope === 'national');
  assert.deepStrictEqual(national.metrics.familyShare.map((r) => [r.label, r.share]), [['Extensions', 50], ['Other jobs', 50]]);
});

run('room size mix only for jobs priced by the room, not rewires', () => {
  const data = [...rows(25, { jobType: 'rewire', category: 'electrical', areaQuantity: null, projectSize: 'medium' }),
    ...rows(25, { jobType: 'bathroom-install', category: 'plumbing', areaQuantity: null, projectSize: 'small' })];
  const snaps = buildWindowSnapshots(data, OCTOBER, { now: NOW, regionNames: REGIONS });
  assert.strictEqual(snaps.find((s) => s.key === 'rewire').metrics.size, null);
  assert.strictEqual(snaps.find((s) => s.key === 'bathroom-install').metrics.size.kind, 'projectSize');
});

run('group share: five rows in fixed order, small group shown as null, shown shares never over 100', () => {
  const data = [...rows(30), ...rows(12, { jobType: 'plastering-room', areaQuantity: null, projectSize: 'medium' }),
    ...rows(4, { jobType: 'bathroom-install', category: 'plumbing', areaQuantity: null, projectSize: 'small' }),
    ...rows(9, { jobType: 'rewire', category: 'electrical', areaQuantity: null, projectSize: 'medium' })];
  const snaps = buildWindowSnapshots(data, OCTOBER, { now: NOW, regionNames: REGIONS });
  const g = snaps.find((s) => s.scope === 'national').metrics.groupShare;
  assert.deepStrictEqual(g.map((r) => r.key), ['extensions', 'plastering', 'bathroom', 'loft', 'everything-else']);
  assert.strictEqual(g.find((r) => r.key === 'bathroom').share, null);
  assert.strictEqual(g.find((r) => r.key === 'loft').share, null);
  assert.strictEqual(g.find((r) => r.key === 'extensions').share, 55);
  assert.ok(g.reduce((a, r) => a + (r.share || 0), 0) <= 100);
  assert.strictEqual(validateWindow(snaps, { independentCount: 55, previousN: null }).ok, true);
});
