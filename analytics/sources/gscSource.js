// GSC Search Analytics queries. Auth pattern reused verbatim from
// scripts/gsc-claude-analyser.js -- same service account, same scope.

const { google } = require('googleapis');
const { withCache } = require('../cache');

const SITE_URL = process.env.GSC_SITE_URL || 'sc-domain:getestimateai.co.uk';
const CACHE_TTL_SECONDS = 12 * 60 * 60; // GSC lags 2-3 days; more frequent refresh returns identical data

const DIMENSION_MAP = {
  query: 'query',
  page: 'page',
  country: 'country',
  device: 'device',
  date: 'date'
};

function createGSCClient() {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!encoded) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  const keyFile = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: keyFile,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return google.searchconsole({ version: 'v1', auth });
}

async function queryGscRows({ dimension, from, to, limit }) {
  const dimensionName = DIMENSION_MAP[dimension];
  if (!dimensionName) {
    throw new Error(`gscSource: unknown dimension "${dimension}", expected one of ${Object.keys(DIMENSION_MAP).join(', ')}`);
  }

  const gsc = createGSCClient();
  const response = await gsc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: from,
      endDate: to,
      dimensions: [dimensionName],
      rowLimit: limit,
      dataState: 'final',
    },
  });

  return (response.data.rows || []).map((row) => ({
    key: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
}

function shiftWindow(from, to) {
  const windowMs = new Date(to).getTime() - new Date(from).getTime();
  const prevTo = from;
  const prevFrom = new Date(new Date(from).getTime() - windowMs).toISOString().split('T')[0];
  return { from: prevFrom, to: prevTo };
}

// getGscPerformance({ from, to, dimension, limit }) -> rows with clicks,
// impressions, ctr, position, plus delta vs the immediately preceding
// equivalent window (same length, ending where this one starts).
async function getGscPerformance({ from, to, dimension, limit }) {
  const { data: current, cachedAt } = await withCache(
    'gsc_performance',
    { from, to, dimension, limit },
    CACHE_TTL_SECONDS,
    () => queryGscRows({ dimension, from, to, limit })
  );

  const prevWindow = shiftWindow(from, to);
  const { data: previous } = await withCache(
    'gsc_performance',
    { from: prevWindow.from, to: prevWindow.to, dimension, limit },
    CACHE_TTL_SECONDS,
    () => queryGscRows({ dimension, from: prevWindow.from, to: prevWindow.to, limit })
  );

  const previousByKey = new Map(previous.map((row) => [row.key, row]));

  const rows = current.map((row) => {
    const prevRow = previousByKey.get(row.key);
    return {
      ...row,
      delta: prevRow
        ? {
            clicks: row.clicks - prevRow.clicks,
            impressions: row.impressions - prevRow.impressions,
            ctr: row.ctr - prevRow.ctr,
            position: row.position - prevRow.position,
          }
        : null,
    };
  });

  return { rows, cachedAt };
}

// getGscKpiRows({ from, to, dimension }) -> { rows, cachedAt }
// Weekly KPI section (analytics/kpis.js): one row per date or per page, no
// delta, high row limit so page groups are summed from every page with data.
async function getGscKpiRows({ from, to, dimension }) {
  if (!['date', 'page'].includes(dimension)) {
    throw new Error(`gscSource: getGscKpiRows dimension must be date or page, got "${dimension}"`);
  }
  const { data: rows, cachedAt } = await withCache(
    'gsc_kpi_rows',
    { from, to, dimension },
    CACHE_TTL_SECONDS,
    () => queryGscRows({ dimension, from, to, limit: 5000 })
  );
  return { rows, cachedAt };
}

module.exports = { getGscPerformance, getGscKpiRows };
