// Offline tests for analytics/opportunities.js. No Google APIs.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const o = require('../analytics/opportunities');

const row = (query, page, position, impressions, clicks) => ({
  query, page: `https://getestimateai.co.uk${page}`, position, impressions, clicks, ctr: impressions ? clicks / impressions : 0,
});

test('CTR curve pools positions into bands and never rises with position', () => {
  const curve = o.buildCtrCurve([
    row('a', '/x', 1, 1000, 10), // band 1-3: (10 + 2) / 2000 = 0.6%
    row('b', '/x', 3, 1000, 2),
    row('c', '/x', 5, 1000, 20), // band 4-6: 2%, higher than band 1-3
    row('d', '/x', 8, 1000, 5), // band 7-10: 0.5%
    row('e', '/x', 12, 50, 25), // band 11-15 too thin, borrows a neighbour
  ], { minBucketImpressions: 200, maxPos: 15 });
  assert.strictEqual(curve[5], 0.02);
  assert.strictEqual(curve[1], 0.02); // raised to band 4-6, never rises with position
  assert.strictEqual(curve[2], curve[3]);
  assert.strictEqual(curve[9], 0.005);
  assert.strictEqual(curve[12], 0.005); // thin band takes the nearest filled band
  for (let p = 2; p <= 15; p += 1) assert.ok(curve[p] <= curve[p - 1]);
});

test('job matching flags a query served by the wrong article', () => {
  assert.strictEqual(o.jobMismatch('loft conversion cost uk', '/articles/house-extension-cost-uk-2026'), true);
  assert.strictEqual(o.jobMismatch('loft conversion cost uk', '/articles/loft-conversion-costs-uk-2026'), false);
  assert.strictEqual(o.jobMismatch('how much does it cost', '/articles/plastering-cost-uk-2026'), false);
  assert.deepStrictEqual(o.queryJobs('rewire and consumer unit cost'), ['rewire']);
  assert.strictEqual(o.isHubOrHome('https://getestimateai.co.uk/'), true);
  assert.strictEqual(o.isHubOrHome('/costs'), true);
  assert.strictEqual(o.isHubOrHome('/costs/leeds'), false);
});

test('group rates use organic landers only', () => {
  const rates = o.groupRates([
    { landingPage: '/articles/a', channel: 'Organic Search', sessions: 100, estimates: 20 },
    { landingPage: '/articles/b', channel: 'Direct', sessions: 100, estimates: 90 },
    { landingPage: '/', channel: 'Organic Search', sessions: 10, estimates: 5 },
  ]);
  assert.strictEqual(rates.articles, 0.2);
  assert.strictEqual(rates.homepage, 0.5);
});

const curve = [null, 0.1, 0.06, 0.04, 0.03, 0.02, 0.015, 0.01, 0.008, 0.006, 0.005, ...Array(30).fill(0.002)];
const rates = { articles: 0.2, homepage: 0.5, region: 0.3, trade: 0.02, other: 0 };

test('striking distance keeps positions 8 to 20 with enough impressions and sizes the gain', () => {
  const list = o.strikingDistance([
    row('loft cost', '/articles/loft-conversion-costs-uk-2026', 12, 1000, 2),
    row('too few', '/articles/x', 12, 50, 0),
    row('already high', '/articles/x', 4, 5000, 100),
  ], curve, rates);
  assert.strictEqual(list.length, 1);
  // 1000 * (0.02 at position 5 - 0.002) = 18 clicks, * 0.2 = 3.6 estimates
  assert.strictEqual(list[0].expectedExtraClicks, 18);
  assert.strictEqual(list[0].expectedExtraEstimates, 3.6);
  assert.strictEqual(list[0].page, '/articles/loft-conversion-costs-uk-2026');
});

test('CTR gap flags pages ranking on page one below the site CTR there', () => {
  const list = o.ctrGap([
    row('rewire cost', '/articles/house-rewire-cost-uk-2026', 5, 3000, 10), // 0.33% vs 2% at 5
    row('rewire price', '/articles/house-rewire-cost-uk-2026', 5, 1000, 3),
    row('plastering', '/articles/plastering-cost-uk-2026', 5, 3000, 70), // 2.3%, above the site CTR
  ], curve, rates);
  assert.deepStrictEqual(list.map((p) => p.page), ['/articles/house-rewire-cost-uk-2026']);
  assert.strictEqual(list[0].impressions, 4000);
  assert.strictEqual(list[0].siteCtrAtPositionPct, 2);
  assert.deepStrictEqual(list[0].topQueries, ['rewire cost', 'rewire price']);
});

test('unserved queries catch homepage and wrong-job rankings only', () => {
  const list = o.unservedQueries([
    row('renovation cost calculator uk', '/', 22, 400, 0),
    row('loft conversion cost', '/articles/house-extension-cost-uk-2026', 25, 300, 0),
    row('extension cost', '/articles/house-extension-cost-uk-2026', 25, 300, 0), // served
    row('loft dormer price', '/articles/loft-conversion-costs-uk-2026', 25, 300, 0), // served
    row('kitchen extension', '/', 9, 500, 3), // already ranking well
  ], curve, rates);
  assert.deepStrictEqual(list.map((q) => q.query).sort(), ['loft conversion cost', 'renovation cost calculator uk']);
  const hub = list.find((q) => q.bestPage === '/');
  assert.strictEqual(hub.reason, 'best page is the homepage or a hub');
});

test('cannibalisation needs two pages with 20%+ of a query', () => {
  const list = o.cannibalisation([
    row('extension cost', '/articles/house-extension-cost-uk-2026', 9, 600, 2),
    row('extension cost', '/articles/single-vs-double-storey-extension-cost-uk-2026', 14, 400, 0),
    row('plaster', '/articles/plastering-cost-uk-2026', 7, 900, 5),
    row('plaster', '/articles/plasterer-day-rate-uk-2026', 30, 100, 0), // 10%, below 20%
  ]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].query, 'extension cost');
  assert.deepStrictEqual(list[0].pages.map((p) => p.sharePct), [60, 40]);
});

test('buildLists drops branded queries and sorts by expected estimates', () => {
  const rows = [
    row('estimateai calculator', '/', 12, 5000, 0),
    row('trade cost', '/costs/leeds/plumbing', 12, 2000, 0),
    row('article cost', '/articles/a', 12, 1000, 0),
  ];
  const curveRows = [...rows, row('curve', '/articles/c', 5, 1000, 20)];
  const out = o.buildLists({ rows, curveRows, ga4Rows: [
    { landingPage: '/articles/a', channel: 'Organic Search', sessions: 10, estimates: 2 },
    { landingPage: '/costs/leeds/plumbing', channel: 'Organic Search', sessions: 100, estimates: 1 },
  ] });
  assert.ok(!out.strikingDistance.some((r) => /estimateai/.test(r.query)));
  assert.deepStrictEqual(out.strikingDistance.map((r) => r.query), ['article cost', 'trade cost']);
});

test('query items carry their class and generic price ranks at 0.2x', () => {
  const local = o.withClass({ query: 'home renovation birmingham', expectedExtraEstimates: 1 });
  const generic = o.withClass({ query: 'plastering cost per m2', expectedExtraEstimates: 3 });
  assert.strictEqual(local.queryClass, 'local');
  assert.strictEqual(local.rankScore, 1);
  assert.strictEqual(generic.queryClass, 'generic-price');
  assert.strictEqual(generic.label, 'likely AI Overview');
  assert.strictEqual(generic.rankScore, 0.6);
});

test('hidden citations group by page, compare windows and catch graduated queries', () => {
  const prev = [
    row('plastering cost per m2', '/articles/plastering-cost-uk-2026', 4.4, 300, 0),
    row('plastering rates per m2 uk', '/articles/plastering-cost-uk-2026', 4.1, 200, 0),
    row('cost to rewire a house', '/articles/house-rewire-cost-uk-2026', 5, 150, 0),
  ];
  const now = [
    row('plastering cost per m2', '/articles/plastering-cost-uk-2026', 4.2, 400, 0), // still hidden
    row('plastering rates per m2 uk', '/articles/plastering-cost-uk-2026', 3.5, 200, 4), // 2% CTR: graduated
    row('cost to rewire a house', '/articles/house-rewire-cost-uk-2026', 9, 150, 3), // moved 4 places: not graduated
    row('too few', '/articles/x', 3, 50, 0),
  ];
  const list = o.hiddenCitations(now, prev);
  const pl = list.find((p) => p.page === '/articles/plastering-cost-uk-2026');
  assert.strictEqual(pl.hiddenQueries, 1);
  assert.strictEqual(pl.impressions, 400);
  assert.strictEqual(pl.previousHiddenQueries, 2);
  assert.strictEqual(pl.previousImpressions, 500);
  assert.deepStrictEqual(pl.graduated.map((g) => g.query), ['plastering rates per m2 uk']);
  const rw = list.find((p) => p.page === '/articles/house-rewire-cost-uk-2026');
  assert.strictEqual(rw.hiddenQueries, 0);
  assert.deepStrictEqual(rw.graduated, []);
  assert.ok(!list.some((p) => p.page === '/articles/x'));
});
