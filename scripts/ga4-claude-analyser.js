/**
 * EstimateAI — GA4 → Claude Analysis & Email Report
 * ===================================================
 * Pulls 28 days of Google Analytics 4 data, sends it to
 * Claude for analysis, then emails a rich HTML report.
 *
 * SETUP:
 *   npm install @google-analytics/data @anthropic-ai/sdk nodemailer dotenv
 *
 * ENV VARS (add to your .env or Render environment):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  base64-encoded service account key JSON
 *                                Same key as GSC script — enable GA4 Data API
 *                                in Google Cloud Console for the same project
 *   GA4_PROPERTY_ID              Numeric property ID (not G-XXXXXXXX)
 *                                Found in GA4 → Admin → Property Settings
 *   ANTHROPIC_API_KEY
 *   SMTP_HOST                    e.g. mail.privateemail.com (Namecheap)
 *   SMTP_PORT                    e.g. 587
 *   SMTP_USER                    your email
 *   SMTP_PASS                    your email password
 *   REPORT_RECIPIENT             who gets the report
 *
 * IMPORTANT — SERVICE ACCOUNT SETUP:
 *   The same service account used for GSC needs GA4 access too.
 *   In GA4 → Admin → Account Access Management, add the service account
 *   email as a Viewer. Also enable "Google Analytics Data API" in
 *   Google Cloud Console under APIs & Services.
 *
 * SCHEDULE: Add to Render as a cron job: 0 8 * * 1 (every Monday 8am)
 *           Offset from GSC report (7am) so emails arrive separately.
 *
 * NOTE ON SINGAPORE FILTER:
 *   All requests exclude Singapore (country = SG) to avoid traffic
 *   skewing analysis. This is applied as a dimensionFilter on every
 *   GA4 API call in this script.
 */

require('dotenv').config();
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PROPERTY_ID = process.env.GA4_PROPERTY_ID; // numeric only, e.g. "123456789"
const DAYS_BACK = 28;

// GA4 custom events fired by EstimateAI (from analytics.js)
const ESTIMATE_EVENTS = [
  'estimate_generated',
  'postcode_entered',
  'lead_captured',
  'estimate_popup_shown',
  'estimate_popup_dismissed',
  'pdf_downloaded',
  'contractor_unlock_clicked',
];

// Article/page path prefixes for segmentation
const PAGE_CATEGORIES = {
  article:  /^\/articles\//,
  regional: /^\/costs\//,
  home:     /^\/$/,
  tracker:  /renovation-cost-tracker/,
  other:    /.*/,
};

// Singapore exclusion filter — applied to every request
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

// ─── GA4 CLIENT ──────────────────────────────────────────────────────────────

function createGA4Client() {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!encoded) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  if (!PROPERTY_ID) throw new Error('GA4_PROPERTY_ID env var is not set');

  const credentials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  console.log('Service account loaded:', credentials.client_email || 'unknown');

  return new BetaAnalyticsDataClient({
    credentials,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
}

function getDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - DAYS_BACK);
  const fmt = (d) => d.toISOString().split('T')[0];
  return { startDate: fmt(start), endDate: fmt(end) };
}

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────

/**
 * Fetch sessions + engagement metrics by source/medium.
 * Singapore excluded via dimensionFilter.
 */
async function fetchSessionsBySource(client, dateRange) {
  const [response] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
    dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],
    dimensionFilter: {
      notExpression: EXCLUDE_SINGAPORE,
    },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 20,
  });

  return (response.rows || []).map((row) => ({
    sourceMedium: row.dimensionValues[0].value,
    sessions: parseInt(row.metricValues[0].value, 10),
    engagedSessions: parseInt(row.metricValues[1].value, 10),
    engagementRate: (parseFloat(row.metricValues[2].value) * 100).toFixed(1) + '%',
    avgDuration: parseFloat(row.metricValues[3].value).toFixed(0) + 's',
    bounceRate: (parseFloat(row.metricValues[4].value) * 100).toFixed(1) + '%',
  }));
}

/**
 * Fetch event counts for EstimateAI custom events.
 * Singapore excluded via dimensionFilter.
 */
async function fetchEventCounts(client, dateRange) {
  const [response] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
    dimensions: [{ name: 'eventName' }],
    metrics: [
      { name: 'eventCount' },
      { name: 'totalUsers' },
    ],
    dimensionFilter: {
      notExpression: EXCLUDE_SINGAPORE,
    },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 50,
  });

  return (response.rows || []).map((row) => ({
    event: row.dimensionValues[0].value,
    count: parseInt(row.metricValues[0].value, 10),
    uniqueUsers: parseInt(row.metricValues[1].value, 10),
  }));
}

/**
 * Fetch top pages by sessions + engagement.
 * Singapore excluded via dimensionFilter.
 */
async function fetchTopPages(client, dateRange) {
  const [response] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
      { name: 'screenPageViews' },
    ],
    dimensionFilter: {
      notExpression: EXCLUDE_SINGAPORE,
    },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 30,
  });

  return (response.rows || []).map((row) => ({
    page: row.dimensionValues[0].value,
    sessions: parseInt(row.metricValues[0].value, 10),
    engagedSessions: parseInt(row.metricValues[1].value, 10),
    engagementRate: (parseFloat(row.metricValues[2].value) * 100).toFixed(1) + '%',
    avgDuration: parseFloat(row.metricValues[3].value).toFixed(0) + 's',
    pageViews: parseInt(row.metricValues[4].value, 10),
    category: categorizePage(row.dimensionValues[0].value),
  }));
}

/**
 * Fetch events broken down by source/medium — shows which channels
 * drive estimate completions and lead captures.
 * Singapore excluded via dimensionFilter.
 */
async function fetchEventsBySource(client, dateRange) {
  const [response] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
    dimensions: [
      { name: 'eventName' },
      { name: 'sessionSourceMedium' },
    ],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          { notExpression: EXCLUDE_SINGAPORE },
          {
            filter: {
              fieldName: 'eventName',
              inListFilter: {
                values: ESTIMATE_EVENTS,
              },
            },
          },
        ],
      },
    },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 100,
  });

  return (response.rows || []).map((row) => ({
    event: row.dimensionValues[0].value,
    sourceMedium: row.dimensionValues[1].value,
    count: parseInt(row.metricValues[0].value, 10),
  }));
}

/**
 * Fetch week-over-week comparison for headline metrics.
 * Singapore excluded via dimensionFilter.
 */
async function fetchWeeklyTrend(client) {
  const [response] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [
      { startDate: '14daysAgo', endDate: '8daysAgo', name: 'prev_week' },
      { startDate: '7daysAgo',  endDate: 'yesterday', name: 'this_week' },
    ],
    dimensions: [{ name: 'dateRange' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'engagedSessions' },
    ],
    dimensionFilter: {
      notExpression: EXCLUDE_SINGAPORE,
    },
  });

  const result = {};
  for (const row of response.rows || []) {
    const label = row.dimensionValues[0].value; // 'this_week' or 'prev_week'
    result[label] = {
      sessions: parseInt(row.metricValues[0].value, 10),
      users: parseInt(row.metricValues[1].value, 10),
      engagedSessions: parseInt(row.metricValues[2].value, 10),
    };
  }
  return result;
}

// ─── DATA PROCESSING ─────────────────────────────────────────────────────────

function categorizePage(path) {
  for (const [cat, pattern] of Object.entries(PAGE_CATEGORIES)) {
    if (pattern.test(path)) return cat;
  }
  return 'other';
}

function processData(sessionsBySource, eventCounts, topPages, eventsBySource, weeklyTrend) {
  // ── Overall totals ──
  const totalSessions = sessionsBySource.reduce((s, r) => s + r.sessions, 0);
  const totalUsers = 0; // not fetched at aggregate level — derived from weekly trend
  const thisWeek = weeklyTrend['this_week'] || {};
  const prevWeek = weeklyTrend['prev_week'] || {};

  const wow = (curr, prev) => {
    if (!prev) return 'n/a';
    const pct = ((curr - prev) / prev) * 100;
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  };

  const weekComparison = {
    sessions:        { thisWeek: thisWeek.sessions,        prevWeek: prevWeek.sessions,        change: wow(thisWeek.sessions, prevWeek.sessions) },
    users:           { thisWeek: thisWeek.users,           prevWeek: prevWeek.users,           change: wow(thisWeek.users, prevWeek.users) },
    engagedSessions: { thisWeek: thisWeek.engagedSessions, prevWeek: prevWeek.engagedSessions, change: wow(thisWeek.engagedSessions, prevWeek.engagedSessions) },
  };

  // ── Funnel metrics ──
  const getCount = (name) => (eventCounts.find((e) => e.event === name) || {}).count || 0;

  const estimatesGenerated  = getCount('estimate_generated');
  const postcodesEntered    = getCount('postcode_entered');
  const leadsCapured        = getCount('lead_captured');
  const popupsShown         = getCount('estimate_popup_shown');
  const popupsDismissed     = getCount('estimate_popup_dismissed');
  const pdfsDownloaded      = getCount('pdf_downloaded');

  const funnelRates = {
    sessionsToEstimate: totalSessions > 0
      ? ((estimatesGenerated / totalSessions) * 100).toFixed(1) + '%' : 'n/a',
    estimateToLead: estimatesGenerated > 0
      ? ((leadsCapured / estimatesGenerated) * 100).toFixed(1) + '%' : 'n/a',
    popupDismissRate: popupsShown > 0
      ? ((popupsDismissed / popupsShown) * 100).toFixed(1) + '%' : 'n/a',
  };

  // ── Events by source — conversion breakdown ──
  const estimatesBySource = {};
  const leadsBySource = {};
  for (const row of eventsBySource) {
    if (row.event === 'estimate_generated') {
      estimatesBySource[row.sourceMedium] = (estimatesBySource[row.sourceMedium] || 0) + row.count;
    }
    if (row.event === 'lead_captured') {
      leadsBySource[row.sourceMedium] = (leadsBySource[row.sourceMedium] || 0) + row.count;
    }
  }

  // ── Page category breakdown ──
  const categoryBreakdown = {};
  for (const page of topPages) {
    const cat = page.category;
    if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { sessions: 0, pages: 0 };
    categoryBreakdown[cat].sessions += page.sessions;
    categoryBreakdown[cat].pages++;
  }

  // ── Low-engagement pages (high sessions, low engagement) ──
  const lowEngagement = topPages
    .filter((p) => p.sessions > 10 && parseFloat(p.engagementRate) < 40)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);

  return {
    totalSessions,
    weekComparison,
    sessionsBySource,
    funnelMetrics: {
      estimatesGenerated,
      postcodesEntered,
      leadsCapured,
      popupsShown,
      popupsDismissed,
      pdfsDownloaded,
    },
    funnelRates,
    estimatesBySource,
    leadsBySource,
    topPages: topPages.slice(0, 20),
    lowEngagement,
    categoryBreakdown,
    allEvents: eventCounts.slice(0, 30),
  };
}

// ─── CLAUDE ANALYSIS ─────────────────────────────────────────────────────────

async function runClaudeAnalysis(data) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are a senior product analytics consultant analysing data for EstimateAI (getestimateai.co.uk) — a free UK AI-powered home renovation cost estimation platform.

The platform's business goals in priority order:
1. Grow estimate completions (estimate_generated events) — the core engagement metric
2. Grow lead captures (lead_captured events) — the near-term revenue mechanism
3. Grow organic traffic — more UK homeowners finding the site
4. Build toward contractor lead-gen monetisation once 30 estimates/week is sustained

Key product context:
- The estimate funnel: user lands → enters postcode → selects project → gets estimate → (optional) submits email via popup or inline gate
- estimate_popup_shown / estimate_popup_dismissed track a scroll-triggered popup at 35% past the estimate result
- lead_captured covers multiple sources: contractor-unlock, pdf-download, estimate-popup, web-app
- Singapore traffic is excluded from all data — do not reference it
- The site has regional pages (/costs/), article guides (/articles/), and the home page estimator
- Organic Social converts to estimates at ~39%, Organic Search at ~12% — channel mix matters

Here is the last 28 days of GA4 data (Singapore excluded throughout):

## WEEK-ON-WEEK COMPARISON (last 7 days vs prior 7 days)
${JSON.stringify(data.weekComparison, null, 2)}

## TOTAL SESSIONS (28 days, ex-Singapore)
${data.totalSessions.toLocaleString()}

## SESSIONS BY SOURCE/MEDIUM (top 20)
${JSON.stringify(data.sessionsBySource, null, 2)}

## ESTIMATE FUNNEL METRICS (28 days)
${JSON.stringify(data.funnelMetrics, null, 2)}

## FUNNEL CONVERSION RATES
${JSON.stringify(data.funnelRates, null, 2)}

## ESTIMATES GENERATED BY SOURCE/MEDIUM
${JSON.stringify(data.estimatesBySource, null, 2)}

## LEADS CAPTURED BY SOURCE/MEDIUM
${JSON.stringify(data.leadsBySource, null, 2)}

## TOP PAGES BY SESSIONS
${JSON.stringify(data.topPages, null, 2)}

## LOW ENGAGEMENT PAGES (sessions > 10, engagement rate < 40%)
${JSON.stringify(data.lowEngagement, null, 2)}

## PAGE CATEGORY BREAKDOWN
${JSON.stringify(data.categoryBreakdown, null, 2)}

## ALL EVENTS (top 30 by count)
${JSON.stringify(data.allEvents, null, 2)}

---

Please provide a detailed analysis structured as follows. Be specific, actionable, and EstimateAI-focused throughout. Reference actual numbers from the data.

**1. EXECUTIVE SUMMARY** (3-4 sentences on overall health, week-on-week trend, and the single most important thing to address)

**2. FUNNEL HEALTH** (how is the estimate funnel performing? sessions → postcode → estimate → lead. Where is the biggest drop-off? Is the scroll popup working — what does the shown/dismissed ratio tell us?)

**3. CHANNEL PERFORMANCE** (which sources are sending quality traffic that converts to estimates vs sources sending browsers who leave? What should change about channel investment or content targeting?)

**4. PAGE PERFORMANCE** (which pages are punching above their weight? Which are wasting sessions? For low-engagement pages specifically, diagnose why and suggest a fix.)

**5. ESTIMATE VOLUME TREND** (are we on track toward 30 estimates/week sustained? What's the current weekly run rate based on the 28-day figure? What would move the needle fastest?)

**6. LEAD CAPTURE ANALYSIS** (how are leads distributed across sources — popup vs contractor-unlock vs pdf-download? Which source should be optimised next?)

**7. PRIORITY ACTION LIST** (numbered 1-8, ordered by impact on estimate volume and lead capture, with a one-line description and the specific metric expected to move)`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ─── EMAIL REPORT ─────────────────────────────────────────────────────────────

function markdownToHTML(md) {
  return md
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#0d9488;margin-top:28px;margin-bottom:8px;font-size:18px;">$1</h2>')
    .replace(/^\*\*(\d+\..+?)\*\*$/gm, '<h3 style="color:#1e293b;margin-top:20px;margin-bottom:6px;">$1</h3>')
    .replace(/^(\d+\. .+)$/gm, '<p style="margin:4px 0 4px 16px;">$1</p>')
    .replace(/^- (.+)$/gm, '<li style="margin:3px 0;">$1</li>')
    .replace(/(<li.*<\/li>\n?)+/g, '<ul style="margin:8px 0 8px 20px;padding:0;">$&</ul>')
    .replace(/\n\n/g, '</p><p style="margin:8px 0;">')
    .replace(/^(?!<[h|u|p|l])(.+)$/gm, '<p style="margin:6px 0;">$1</p>')
    .replace(/<p style="margin:6px 0;"><\/p>/g, '');
}

function buildEmailHTML(analysis, data, dateRange) {
  const { startDate, endDate } = dateRange;
  const { funnelMetrics, funnelRates, weekComparison } = data;

  const statsRow = (label, value, sub = '') => `
    <td style="padding:16px 20px;background:#f8fafc;border-radius:8px;text-align:center;margin:4px;">
      <div style="font-size:26px;font-weight:700;color:#0d9488;">${value}</div>
      <div style="font-size:12px;color:#64748b;margin-top:4px;">${label}</div>
      ${sub ? `<div style="font-size:11px;color:#94a3b8;">${sub}</div>` : ''}
    </td>`;

  const wowBadge = (change) => {
    if (!change || change === 'n/a') return '';
    const positive = change.startsWith('+');
    const color = positive ? '#16a34a' : '#dc2626';
    return `<span style="font-size:11px;color:${color};font-weight:600;">${change}</span>`;
  };

  const sourceRows = data.sessionsBySource.slice(0, 8).map((s) => `
    <tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:8px 12px;font-size:12px;color:#334155;">${s.sourceMedium}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;">${s.sessions.toLocaleString()}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;">${s.engagementRate}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;">${s.avgDuration}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;">${data.estimatesBySource[s.sourceMedium] || 0}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EstimateAI — GA4 Weekly Report</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;margin:0;padding:24px;">
<div style="max-width:700px;margin:0 auto;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#075F58,#0A9F94);border-radius:16px 16px 0 0;padding:32px 36px;color:white;">
    <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;">📈 EstimateAI GA4 Report</div>
    <div style="font-size:14px;opacity:0.85;margin-top:6px;">${startDate} → ${endDate} &nbsp;·&nbsp; Singapore excluded &nbsp;·&nbsp; Powered by Claude AI</div>
  </div>

  <!-- Funnel stats bar -->
  <div style="background:white;padding:20px 24px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
    <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">28-Day Funnel</div>
    <table width="100%" cellpadding="4" cellspacing="8"><tr>
      ${statsRow('Sessions', data.totalSessions.toLocaleString(), wowBadge(weekComparison.sessions?.change))}
      ${statsRow('Estimates', funnelMetrics.estimatesGenerated.toLocaleString(), funnelRates.sessionsToEstimate + ' conv.')}
      ${statsRow('Leads', funnelMetrics.leadsCapured.toLocaleString(), funnelRates.estimateToLead + ' of estimates')}
      ${statsRow('PDFs', funnelMetrics.pdfsDownloaded.toLocaleString(), 'downloaded')}
    </tr></table>
  </div>

  <!-- Popup funnel -->
  <div style="background:white;padding:16px 24px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-top:1px solid #f1f5f9;">
    <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Scroll Popup Performance</div>
    <table width="100%" cellpadding="4" cellspacing="8"><tr>
      ${statsRow('Popups Shown', funnelMetrics.popupsShown.toLocaleString())}
      ${statsRow('Dismissed', funnelMetrics.popupsDismissed.toLocaleString(), funnelRates.popupDismissRate + ' dismiss rate')}
    </tr></table>
  </div>

  <!-- Sessions by source table -->
  <div style="background:white;padding:24px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-top:1px solid #f1f5f9;">
    <h2 style="color:#0d9488;font-size:16px;margin:0 0 12px;">🔀 Sessions by Source (top 8)</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:600;">Source / Medium</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">Sessions</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">Eng. Rate</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">Avg Duration</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">Estimates</th>
        </tr>
      </thead>
      <tbody>${sourceRows}</tbody>
    </table>
  </div>

  <!-- Claude Analysis -->
  <div style="background:white;padding:28px 32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
      <div style="width:36px;height:36px;background:linear-gradient(135deg,#075F58,#0A9F94);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;">🤖</div>
      <div>
        <div style="font-weight:700;color:#1e293b;font-size:16px;">Claude AI Analysis & Recommendations</div>
        <div style="font-size:12px;color:#94a3b8;">Generated ${new Date().toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</div>
      </div>
    </div>
    <div style="color:#334155;line-height:1.7;font-size:14px;">
      ${markdownToHTML(analysis)}
    </div>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px;">
    EstimateAI Automated GA4 Report &nbsp;·&nbsp; Singapore excluded from all data &nbsp;·&nbsp;
    <a href="https://getestimateai.co.uk" style="color:#0d9488;">getestimateai.co.uk</a>
  </div>

</div>
</body>
</html>`;
}

// ─── EMAIL SENDER ─────────────────────────────────────────────────────────────

async function sendEmail(htmlContent, dateRange) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const { startDate, endDate } = dateRange;
  await transporter.sendMail({
    from: `"EstimateAI Reports" <${process.env.SMTP_USER}>`,
    to: process.env.REPORT_RECIPIENT,
    subject: `📈 EstimateAI GA4 Report — ${startDate} to ${endDate}`,
    html: htmlContent,
  });

  console.log('✅ GA4 report email sent to', process.env.REPORT_RECIPIENT);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 EstimateAI GA4 Analyser starting...');
  console.log('ℹ️  Singapore excluded from all data');

  const client = createGA4Client();
  const dateRange = getDateRange();

  console.log(`📅 Fetching data: ${dateRange.startDate} → ${dateRange.endDate}`);

  // Fetch all data in parallel
  const [sessionsBySource, eventCounts, topPages, eventsBySource, weeklyTrend] = await Promise.all([
    fetchSessionsBySource(client, dateRange),
    fetchEventCounts(client, dateRange),
    fetchTopPages(client, dateRange),
    fetchEventsBySource(client, dateRange),
    fetchWeeklyTrend(client),
  ]);

  console.log(`✅ Fetched: ${sessionsBySource.length} sources, ${eventCounts.length} events, ${topPages.length} pages`);

  // Process
  const data = processData(sessionsBySource, eventCounts, topPages, eventsBySource, weeklyTrend);

  console.log(`📊 Funnel: ${data.funnelMetrics.estimatesGenerated} estimates → ${data.funnelMetrics.leadsCapured} leads`);
  console.log(`📊 Conversion: sessions→estimate ${data.funnelRates.sessionsToEstimate}, estimate→lead ${data.funnelRates.estimateToLead}`);

  // Claude analysis
  console.log('🤖 Running Claude analysis...');
  const analysis = await runClaudeAnalysis(data);
  console.log('✅ Analysis complete');

  // Build and send email
  const html = buildEmailHTML(analysis, data, dateRange);
  await sendEmail(html, dateRange);

  console.log('🎉 Done!');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
