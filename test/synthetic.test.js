// Offline tests for the synthetic check cleanup route: no database.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createSyntheticRouter, MAX_AGE_MS } = require('../routes/syntheticRoutes');

const NOW = Date.parse('2026-11-28T06:31:00Z');
const ID = '6b09bfd01b551ba2ff068d76';

// Fake Estimate: holds records in memory and applies the same filter fields.
function fakeEstimate(records) {
  return {
    calls: 0,
    async deleteOne(filter) {
      this.calls += 1;
      const i = records.findIndex((r) => r._id === String(filter._id)
        && r.district === filter['locationData.district']
        && r.createdAt >= filter.createdAt.$gte);
      if (i === -1) return { deletedCount: 0 };
      records.splice(i, 1);
      return { deletedCount: 1 };
    },
  };
}

async function start(records, secret = 's3cret') {
  const Estimate = fakeEstimate(records);
  const app = express();
  app.use('/api/synthetic', createSyntheticRouter({ Estimate, secret: () => secret, now: () => NOW }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const del = async (id, headerSecret) => {
    const res = await fetch(`${base}/api/synthetic/estimate/${id}`, {
      method: 'DELETE',
      headers: headerSecret === undefined ? {} : { 'x-synthetic-secret': headerSecret },
    });
    return { status: res.status, body: await res.json() };
  };
  return { del, Estimate, close: () => server.close() };
}

const recent = () => ({ _id: ID, district: 'BA14', createdAt: new Date(NOW - 60 * 1000) });

test('deletes a recent BA14 record with the right secret', async () => {
  const records = [recent()];
  const app = await start(records);
  const r = await app.del(ID, 's3cret');
  app.close();
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { deleted: true });
  assert.strictEqual(records.length, 0);
});

test('wrong or missing secret deletes nothing and never queries', async () => {
  const records = [recent()];
  const app = await start(records);
  const wrong = await app.del(ID, 'nope');
  const missing = await app.del(ID);
  app.close();
  assert.strictEqual(wrong.status, 404);
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(app.Estimate.calls, 0);
  assert.strictEqual(records.length, 1);
});

test('no secret configured on the server refuses everything', async () => {
  const records = [recent()];
  const app = await start(records, undefined);
  const r = await app.del(ID, '');
  app.close();
  assert.strictEqual(r.status, 404);
  assert.strictEqual(records.length, 1);
});

test('a non-BA14 record is left alone', async () => {
  const records = [{ ...recent(), district: 'M1' }];
  const app = await start(records);
  const r = await app.del(ID, 's3cret');
  app.close();
  assert.strictEqual(r.status, 404);
  assert.strictEqual(records.length, 1);
});

test('a BA14 record older than 15 minutes is left alone', async () => {
  const records = [{ ...recent(), createdAt: new Date(NOW - MAX_AGE_MS - 1000) }];
  const app = await start(records);
  const r = await app.del(ID, 's3cret');
  app.close();
  assert.strictEqual(r.status, 404);
  assert.strictEqual(records.length, 1);
});

test('an invalid id returns 404 without a query', async () => {
  const app = await start([recent()]);
  const r = await app.del('not-an-id', 's3cret');
  app.close();
  assert.strictEqual(r.status, 404);
  assert.strictEqual(app.Estimate.calls, 0);
});
