// Offline tests for the reliability modules: no database, no external APIs.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createRateLimiters, applyRateLimits } = require('../middleware/rateLimits');
const { coalesce, searchKey } = require('../middleware/coalesce');
const { classifyPhotoError } = require('../utils/photoErrors');
const { createOpsAlerter } = require('../utils/opsAlert');

function recorder() {
  const lines = [];
  const push = (...args) => lines.push(args.join(' '));
  return { lines, log: push, warn: push, error: push };
}

// An app wired like server.js: same proxy setting, same limiter mounting.
async function startApp(overrides) {
  const log = recorder();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const limiters = createRateLimiters(overrides, log);
  applyRateLimits(app, limiters);
  app.post('/api/analyze-photos', limiters.photoAnalysis, (req, res) => res.json({ ok: true }));
  app.use((req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let hop = 0;
  // Each request arrives from a different proxy hop, as it does behind Cloudflare.
  const call = async (path, ip = '203.0.113.10', method = 'POST') => {
    hop += 1;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': `${ip}, 10.0.${hop % 250}.${hop % 200}` }
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { call, log, close: () => server.close() };
}

const ONE_ESTIMATE = ['/api/location-cost', '/api/save-estimate', '/api/search-contractors',
  ...Array(5).fill('/api/contractor-click')];

test('several estimates in a minute all succeed', async () => {
  const app = await startApp();
  for (let i = 0; i < 4; i += 1) {
    for (const path of ONE_ESTIMATE) assert.strictEqual((await app.call(path)).status, 200, `${path} estimate ${i + 1}`);
  }
  assert.strictEqual(app.log.lines.length, 0);
  app.close();
});

test('a visitor is counted once even when the proxy address changes', async () => {
  const app = await startApp({ searchPerMinute: 3 });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await app.call('/api/search-contractors')).status);
  assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
  assert.strictEqual((await app.call('/api/search-contractors', '198.51.100.7')).status, 200, 'another visitor');
  app.close();
});

test('rejections are logged by route without any IP address', async () => {
  const app = await startApp();
  let last;
  for (let i = 0; i < 11; i += 1) last = await app.call('/api/search-contractors');
  assert.strictEqual(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.deepStrictEqual(app.log.lines, ['RATE_LIMIT route=/api/search-contractors limiter=search-minute method=POST']);
  assert.ok(!app.log.lines.join(' ').includes('203.0.113.10'));
  app.close();
});

test('contractor search has a daily cap', async () => {
  const app = await startApp({ searchPerMinute: 1000 });
  let allowed = 0;
  for (let i = 0; i < 52; i += 1) if ((await app.call('/api/search-contractors')).status === 200) allowed += 1;
  assert.strictEqual(allowed, 50);
  assert.ok(app.log.lines[0].includes('limiter=search-day'));
  app.close();
});

test('general, location and photo limits are as agreed, with ids masked in logs', async () => {
  const app = await startApp();
  const count = async (path, n, ip) => {
    let ok = 0;
    for (let i = 0; i < n; i += 1) if ((await app.call(path, ip)).status === 200) ok += 1;
    return ok;
  };
  assert.strictEqual(await count('/api/location-cost', 125), 120);
  assert.strictEqual(await count('/api/estimate/6b06c19dec36e8e0ba1b4d7a', 62), 60);
  // A fresh visitor: the calls above used up the first one's general allowance
  assert.strictEqual(await count('/api/analyze-photos', 4, '198.51.100.20'), 3);
  assert.ok(app.log.lines.some((l) => l.includes('route=/api/estimate/:id limiter=general')));
  app.close();
});

test('identical searches in flight run the handler once and nothing is cached', async () => {
  let runs = 0;
  const app = express();
  app.use(express.json());
  app.post('/s', coalesce(searchKey), (req, res) => {
    runs += 1;
    setTimeout(() => res.json({ run: runs }), 80);
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const search = (userLocation) => fetch(`http://127.0.0.1:${server.address().port}/s`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobType: 'Full Rewire', userLocation })
  }).then((r) => r.json());

  const together = await Promise.all([search('BA14 8AA'), search('ba148aa'), search('BA14 8AA')]);
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(together, [{ run: 1 }, { run: 1 }, { run: 1 }]);
  await search('BA14 8AA');
  assert.strictEqual(runs, 2, 'a later request runs again');
  await Promise.all([search('BA14 8AA'), search('TA6 3AA')]);
  assert.strictEqual(runs, 4, 'different searches are not merged');
  server.close();
});

test('photo failures are classified', () => {
  const quota = classifyPhotoError({ status: 429, message: '429 You have no credits remaining. Add credits to continue using the API' });
  assert.deepStrictEqual([quota.reason, quota.httpStatus, quota.errorCode, quota.alert], ['quota', 503, 'photo_analysis_unavailable', true]);
  assert.strictEqual(classifyPhotoError({ status: 429, code: 'insufficient_quota', message: 'x' }).reason, 'quota');
  assert.strictEqual(classifyPhotoError({ status: 429, message: 'Rate limit reached for requests' }).reason, 'rate_limit');
  assert.strictEqual(classifyPhotoError({ status: 401, message: 'Incorrect API key' }).alert, true);
  assert.strictEqual(classifyPhotoError(Object.assign(new Error('Request timed out.'), {})).httpStatus, 504);
  assert.strictEqual(classifyPhotoError({ status: 400, message: 'Invalid image' }).reason, 'invalid_image');
  assert.strictEqual(classifyPhotoError(new SyntaxError('Unexpected token')).reason, 'other');
});

test('alert emails are throttled, skipped without a recipient, and retried after a failed send', async () => {
  let clock = 1000;
  const sent = [];
  let failNext = false;
  const alert = createOpsAlerter({
    send: async (m) => { if (failNext) { failNext = false; throw new Error('smtp down'); } sent.push(m); },
    recipient: () => 'ops@example.test',
    now: () => clock,
    log: recorder()
  });
  assert.strictEqual(await alert('photo-quota', 's', 't'), true);
  assert.strictEqual(await alert('photo-quota', 's', 't'), false);
  clock += 6 * 60 * 60 * 1000 + 1;
  failNext = true;
  assert.strictEqual(await alert('photo-quota', 's', 't'), false);
  assert.strictEqual(await alert('photo-quota', 's', 't'), true);
  assert.strictEqual(sent.length, 2);

  const log = recorder();
  const unset = createOpsAlerter({ send: async () => sent.push('x'), recipient: () => undefined, log });
  assert.strictEqual(await unset('photo-quota', 's', 't'), false);
  assert.ok(log.lines[0].includes('ALERT_EMAIL'));
});
