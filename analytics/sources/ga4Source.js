// GA4 Data API queries. Auth pattern reused verbatim from
// scripts/ga4-claude-analyser.js -- same service account, same scope,
// same Singapore exclusion filter.

const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { withCache } = require('../cache');

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const CACHE_TTL_SECONDS = 3 * 60 * 60; // some events settle within 24-48h, but 3h keeps this useful intraday

const EXCLUDE_SINGAPORE = {
  filter: {
    fieldName: 'country',
    stringFilter: {
      matchType: 'EXACT',
      value: 'Singapore',
      caseSensitive: false,
    },
  },
};

// 'variant' is intentionally absent: ab_variant is sent as a GA4 event
// parameter (see src/analytics.js trackEstimateGenerated), but it is not
// registered as a GA4 custom dimension, so it isn't queryable via the Data
// API. Confirmed directly, not assumed.
const BREAKDOWN_DIMENSION_MAP = {
  source: 'sessionSourceMedium',
  medium: 'sessionMedium',
  none: null,
};

function createGA4Client() {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!encoded) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  if (!PROPERTY_ID) throw new Error('GA4_PROPERTY_ID env var is not set');
  const credentials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  return new BetaAnalyticsDataClient({
    credentials,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
}

async function queryGa4Events({ from, to, eventNames, breakdown }) {
  if (breakdown === 'variant') {
    throw new Error("ga4Source: breakdown 'variant' is not supported -- ab_variant is not a registered GA4 custom dimension. Use a MongoDB-sourced tool (get_estimate_demand, get_contractor_signals) for variant segmentation.");
  }
  if (!(breakdown in BREAKDOWN_DIMENSION_MAP)) {
    throw new Error(`ga4Source: unknown breakdown "${breakdown}", expected one of ${Object.keys(BREAKDOWN_DIMENSION_MAP).join(', ')}, variant`);
  }

  const client = createGA4Client();
  const breakdownDimension = BREAKDOWN_DIMENSION_MAP[breakdown];

  const dimensions = [{ name: 'eventName' }];
  if (breakdownDimension) dimensions.push({ name: breakdownDimension });

  const dimensionFilter = eventNames && eventNames.length
    ? {
        andGroup: {
          expressions: [
            { notExpression: EXCLUDE_SINGAPORE },
            { filter: { fieldName: 'eventName', inListFilter: { values: eventNames.map((e) => e.toLowerCase()) } } },
          ],
        },
      }
    : { notExpression: EXCLUDE_SINGAPORE };

  const [response] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions,
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter,
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 100,
  });

  return (response.rows || []).map((row) => {
    const out = {
      event: row.dimensionValues[0].value,
      count: parseInt(row.metricValues[0].value, 10),
      uniqueUsers: parseInt(row.metricValues[1].value, 10),
    };
    if (breakdownDimension) out.breakdown = row.dimensionValues[1].value;
    return out;
  });
}

// getGa4Events({ from, to, eventNames, breakdown }) -> { rows, cachedAt }
async function getGa4Events({ from, to, eventNames, breakdown }) {
  const { data: rows, cachedAt } = await withCache(
    'ga4_events',
    { from, to, eventNames: eventNames || null, breakdown },
    CACHE_TTL_SECONDS,
    () => queryGa4Events({ from, to, eventNames, breakdown })
  );

  return { rows, cachedAt };
}

// getGa4LandingRows({ from, to }) -> { rows, cachedAt }
// Weekly KPI section (analytics/kpis.js): sessions and estimate_generated
// events per date, landing page and channel group, Singapore excluded.
// rows: [{ date: 'YYYY-MM-DD', landingPage, channel, sessions, estimates }]
async function queryGa4LandingRows({ from, to }) {
  const client = createGA4Client();
  const dimensions = [{ name: 'date' }, { name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }];
  const run = (metric, extraFilter) => client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions,
    metrics: [{ name: metric }],
    dimensionFilter: extraFilter
      ? { andGroup: { expressions: [{ notExpression: EXCLUDE_SINGAPORE }, extraFilter] } }
      : { notExpression: EXCLUDE_SINGAPORE },
    limit: 100000,
  });
  const [[sessionsRes], [eventsRes]] = await Promise.all([
    run('sessions'),
    run('eventCount', { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'estimate_generated' } } }),
  ]);

  const byKey = new Map();
  const entry = (r) => {
    const values = r.dimensionValues.map((v) => v.value);
    const k = values.join('|');
    if (!byKey.has(k)) {
      const [d, landingPage, channel] = values;
      byKey.set(k, { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, landingPage, channel, sessions: 0, estimates: 0 });
    }
    return byKey.get(k);
  };
  (sessionsRes.rows || []).forEach((r) => { entry(r).sessions += parseInt(r.metricValues[0].value, 10); });
  (eventsRes.rows || []).forEach((r) => { entry(r).estimates += parseInt(r.metricValues[0].value, 10); });
  return [...byKey.values()];
}

async function getGa4LandingRows({ from, to }) {
  const { data: rows, cachedAt } = await withCache(
    'ga4_landing_rows',
    { from, to },
    CACHE_TTL_SECONDS,
    () => queryGa4LandingRows({ from, to })
  );
  return { rows, cachedAt };
}

module.exports = { getGa4Events, getGa4LandingRows };
