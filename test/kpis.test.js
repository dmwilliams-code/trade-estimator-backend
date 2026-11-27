// Offline tests for analytics/kpis.js: week blocks, page groups, the anomaly
// rule and the builders. No database, no Google APIs.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const k = require('../analytics/kpis');

test('weekBlocks: five 7-day blocks, newest first, inclusive', () => {
  const b = k.weekBlocks('2026-11-24', 5);
  assert.strictEqual(b.length, 5);
  assert.deepStrictEqual(b[0], { from: '2026-11-18', to: '2026-11-24' });
  assert.deepStrictEqual(b[1], { from: '2026-11-11', to: '2026-11-17' });
  assert.deepStrictEqual(b[4], { from: '2026-10-21', to: '2026-10-27' });
});

test('pageGroup maps GSC URLs and GA4 paths the same way', () => {
  assert.strictEqual(k.pageGroup('https://getestimateai.co.uk/'), 'homepage');
  assert.strictEqual(k.pageGroup('/'), 'homepage');
  assert.strictEqual(k.pageGroup('/?project=plastering'), 'homepage');
  assert.strictEqual(k.pageGroup('https://getestimateai.co.uk/articles/plastering-cost-uk-2026'), 'articles');
  assert.strictEqual(k.pageGroup('/articles'), 'other');
  assert.strictEqual(k.pageGroup('/costs/manchester'), 'region');
  assert.strictEqual(k.pageGroup('/costs/manchester/plumbing/'), 'trade');
  assert.strictEqual(k.pageGroup('/costs'), 'other');
  assert.strictEqual(k.pageGroup('/renovation-roi/leeds'), 'other');
  assert.strictEqual(k.pageGroup('(not set)'), 'other');
});

test('jobGroup uses the Demand Index groups', () => {
  assert.strictEqual(k.jobGroup('kitchen-extension'), 'extensions');
  assert.strictEqual(k.jobGroup('plastering-room'), 'plastering');
  assert.strictEqual(k.jobGroup('rewire'), 'everything-else');
});

test('compare flags only when both the 30% and the minimum are met', () => {
  // estimates: avg 20, now 12: -40% and 8 below, under the minimum of 10
  assert.strictEqual(k.compare([12, 20, 20, 20, 20], 'estimates').flag, null);
  // avg 30, now 12: -60% and 18 below
  assert.deepStrictEqual(k.compare([12, 30, 30, 30, 30], 'estimates').flag, { direction: 'down', changePct: -60 });
  // impressions: +25% is under 30%
  assert.strictEqual(k.compare([50000, 40000, 40000, 40000, 40000], 'impressions').flag, null);
  // impressions: +40% and 16,000 above
  assert.deepStrictEqual(k.compare([56000, 40000, 40000, 40000, 40000], 'impressions').flag, { direction: 'up', changePct: 40 });
  const s = k.compare([10, 8, 12, 16, 20], 'clicks');
  assert.strictEqual(s.previous, 8);
  assert.strictEqual(s.avg4, 14);
});

test('compareRate catches the November article drop and ignores thin weeks', () => {
  const w = (sessions, estimates) => ({ sessions, estimates });
  // 23.7% before, 8.8% now, on about 45 sessions a week
  const nov = k.compareRate([w(45, 4), w(73, 17), w(73, 17), w(73, 18), w(72, 17)]);
  assert.strictEqual(nov.ratePct, 8.9);
  assert.strictEqual(nov.flag.direction, 'down');
  // same rates but only 12 sessions this week: not flagged
  assert.strictEqual(k.compareRate([w(12, 1), w(73, 17), w(73, 17), w(73, 18), w(72, 17)]).flag, null);
  assert.strictEqual(k.compareRate([w(0, 0), w(10, 1), w(0, 0), w(0, 0), w(0, 0)]).ratePct, null);
});

test('buildGsc sums days into weeks and pages into groups', () => {
  const blocks = k.weekBlocks('2026-11-24', 5);
  const dateRows = [
    { key: '2026-11-24', clicks: 10, impressions: 1000, position: 10 },
    { key: '2026-11-18', clicks: 5, impressions: 1000, position: 20 },
    { key: '2026-11-17', clicks: 7, impressions: 700, position: 12 },
    { key: '2026-10-01', clicks: 99, impressions: 9999, position: 1 }, // outside every block
  ];
  const g = k.buildGsc({
    dateRows,
    pageRowsCurrent: [{ key: 'https://getestimateai.co.uk/articles/a', clicks: 3, impressions: 300 }, { key: 'https://getestimateai.co.uk/costs/leeds', clicks: 1, impressions: 50 }],
    pageRowsPrevious: [{ key: 'https://getestimateai.co.uk/articles/a', clicks: 2, impressions: 200 }],
    blocks,
  });
  assert.strictEqual(g.clicks.current, 15);
  assert.strictEqual(g.impressions.current, 2000);
  assert.strictEqual(g.clicks.previous, 7);
  assert.strictEqual(g.ctrPct.current, 0.75);
  assert.strictEqual(g.position.current, 15);
  const art = g.byPageGroup.find((r) => r.group === 'articles');
  assert.deepStrictEqual(art, { group: 'articles', clicks: 3, previousClicks: 2, impressions: 300, previousImpressions: 200 });
});

test('buildGa4 counts organic landers only for the rate', () => {
  const blocks = k.weekBlocks('2026-11-26', 5);
  const rows = [
    { date: '2026-11-25', landingPage: '/articles/a', channel: 'Organic Search', sessions: 40, estimates: 4 },
    { date: '2026-11-25', landingPage: '/articles/a', channel: 'Direct', sessions: 20, estimates: 5 },
    { date: '2026-11-25', landingPage: '/', channel: 'Organic Search', sessions: 10, estimates: 5 },
  ];
  const g = k.buildGa4({ rows, blocks });
  assert.strictEqual(g.sessionsAll.current, 70);
  assert.strictEqual(g.sessionsOrganic.current, 50);
  const art = g.organicEstimateRateByLanding.find((r) => r.group === 'articles');
  assert.strictEqual(art.sessions, 40);
  assert.strictEqual(art.estimates, 4);
  assert.strictEqual(art.ratePct, 10);
});

test('buildMongo keeps variants separate and groups jobs', () => {
  const blocks = k.weekBlocks('2026-11-26', 5);
  const rows = [
    { variant: 'open_jul2026', date: '2026-11-26', jobType: 'kitchen-extension', count: 3 },
    { variant: 'open_jul2026', date: '2026-11-20', jobType: 'rewire', count: 2 },
    { variant: 'open_jul2026', date: '2026-11-19', jobType: 'plastering-room', count: 4 },
    { variant: 'unassigned', date: '2026-11-25', jobType: 'rewire', count: 1 },
  ];
  const m = k.buildMongo({ rows, blocks });
  assert.deepStrictEqual(m.estimatesByVariant.map((v) => v.variant), ['open_jul2026', 'unassigned']);
  const open = m.estimatesByVariant[0];
  assert.strictEqual(open.current, 5);
  assert.strictEqual(open.previous, 4);
  assert.strictEqual(open.byJobGroup.find((g) => g.group === 'extensions').current, 3);
  assert.strictEqual(open.byJobGroup.find((g) => g.group === 'plastering').previous, 4);
});

test('collectFlags lists every flagged KPI', () => {
  const flagged = { current: 12, avg4: 30, flag: { direction: 'down', changePct: -60 } };
  const quiet = { current: 30, avg4: 30, flag: null };
  const flags = k.collectFlags({
    gsc: { impressions: quiet, clicks: flagged },
    ga4: { sessionsOrganic: quiet, sessionsAll: quiet, organicEstimateRateByLanding: [{ group: 'articles', ratePct: 8.8, avg4RatePct: 23.7, sessions: 45, flag: { direction: 'down', changePct: -63 } }] },
    mongo: { estimatesByVariant: [{ variant: 'open_jul2026', ...flagged }] },
  });
  assert.deepStrictEqual(flags.map((f) => f.kpi), ['clicks', 'estimate rate, articles landers', 'estimates (open_jul2026)']);
});
