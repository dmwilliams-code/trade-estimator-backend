// Offline tests for analytics/queryClass.js, using real queries from the
// 28 Nov 2026 opportunity scan and Search Console.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const { classifyQuery, PLACES } = require('../analytics/queryClass');

const CASES = [
  // local
  ['home renovation birmingham', 'local'],
  ['house renovation birmingham', 'local'],
  ['plastering cost per m2 london', 'local'],
  ['edinburgh roofing cost', 'local'],
  ['plasterer near me', 'local'],
  ['renovation cost milton keynes', 'local'],
  ['builders in bath', 'local'],
  ['plastering cost near reading', 'local'],
  ['extension cost stoke on trent', 'local'],
  // tool
  ['renovation cost calculator uk', 'tool'],
  ['home remodeling cost estimator tool', 'tool'],
  ['free estimates for home repairs', 'tool'],
  ['plastering cost calculator uk', 'tool'],
  ['how much to rewire my house', 'tool'],
  // own-data
  ['most popular home renovations 2026', 'own-data'],
  ['renovation trends uk', 'own-data'],
  // generic price
  ['plastering cost per m2', 'generic-price'],
  ['plastering rates per m2 uk', 'generic-price'],
  ['cost to rewire a house', 'generic-price'],
  ['how much does it cost to rewire a house', 'generic-price'],
  ['how much to plaster a 3 bed house', 'generic-price'],
  ['dry lining price per m2 uk', 'generic-price'],
  ['single storey extension cost', 'generic-price'],
  ['bath replacement cost', 'generic-price'], // bath the fixture, not the city
  ['reading lamp price', 'generic-price'],
  ['plasterer day rate', 'generic-price'],
  ['is skimming cheaper than plastering', 'generic-price'], // "cheaper" is a price word
  // other
  ['does a 30 year old house need rewiring', 'other'],
  ['order of work renovation', 'other'],
  ['how many m2 should a plasterer do in a day', 'other'],
];

test('classifies real queries', () => {
  CASES.forEach(([q, expected]) => assert.strictEqual(classifyQuery(q), expected, q));
});

test('place list covers every region and London', () => {
  assert.ok(PLACES.includes('london'));
  assert.ok(PLACES.includes('brighton'));
  assert.ok(PLACES.includes('hove'));
  assert.ok(PLACES.includes('milton keynes'));
  assert.ok(!PLACES.includes('london central'));
});
