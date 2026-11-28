// Query classes for the opportunity scan and the weekly KPIs (frontend repo,
// AIQueryStrategySpec.md). Generic "cost of X" queries are answered in full by
// Google's AI Overviews and get almost no clicks (checked 28 Nov 2026), so
// effort goes to queries an overview cannot answer: local, tool and own-data.
//
// Classes, first match wins: local, tool, own-data, generic-price, other.

const regionalCostData = require('../regionalCostData.json');

// Region names that are also everyday words only count with "in" or "near".
const AMBIGUOUS = new Set(['bath', 'reading']);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function placeTerms() {
  const terms = new Set(['london']);
  regionalCostData.regions.forEach((r) => {
    r.name.toLowerCase().split(/\s*&\s*/).forEach((t) => terms.add(t.trim()));
    terms.add(r.slug.replace(/-/g, ' '));
  });
  ['london central', 'london greater'].forEach((t) => terms.delete(t));
  return [...terms];
}

const PLACES = placeTerms();
const PLAIN_PLACES = PLACES.filter((p) => !AMBIGUOUS.has(p));
const LOCAL_RE = new RegExp(`\\b(${PLAIN_PLACES.map(escape).join('|')})\\b|\\bnear me\\b`, 'i');
const AMBIGUOUS_RE = new RegExp(`\\b(in|near)\\s+(${[...AMBIGUOUS].join('|')})\\b`, 'i');
const TOOL_RE = /\b(calculator|calculate|estimator|estimate|estimates|quote|quotes|for my|my house|my home)\b/i;
const OWN_DATA_RE = /\b(most popular|popularity|how many people|trend|trends|trending|demand|most common)\b/i;
const PRICE_RE = /\b(cost|costs|costing|price|prices|pricing|rate|rates|how much|per m2|per m²|per sq|per square|cheap|cheaper|cheapest|expensive|charge|charges)\b/i;

const CLASSES = ['local', 'tool', 'own-data', 'generic-price', 'other'];

function classifyQuery(query) {
  const q = String(query || '');
  if (LOCAL_RE.test(q) || AMBIGUOUS_RE.test(q)) return 'local';
  if (TOOL_RE.test(q)) return 'tool';
  if (OWN_DATA_RE.test(q)) return 'own-data';
  if (PRICE_RE.test(q)) return 'generic-price';
  return 'other';
}

module.exports = { classifyQuery, CLASSES, PLACES };
