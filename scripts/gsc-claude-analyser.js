/**
 * EstimateAI — GSC → Claude Analysis & Email Report
 * ===================================================
 * Pulls 28 days of Google Search Console data, sends it to
 * Claude for analysis, then emails a rich HTML report.
 *
 * SETUP:
 *   npm install googleapis @anthropic-ai/sdk nodemailer dotenv
 *
 * ENV VARS (add to your .env or Render environment):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *   GSC_SITE_URL              e.g. https://getestimateai.co.uk/
 *   ANTHROPIC_API_KEY
 *   SMTP_HOST                 e.g. mail.privateemail.com (Namecheap)
 *   SMTP_PORT                 e.g. 587
 *   SMTP_USER                 your email
 *   SMTP_PASS                 your email password
 *   REPORT_RECIPIENT          who gets the report
 *
 * SCHEDULE: Add to Render as a cron job: 0 7 * * 1 (every Monday 7am)
 */

require('dotenv').config();
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SITE_URL = process.env.GSC_SITE_URL || 'https://getestimateai.co.uk/';
const DAYS_BACK = 28;
const ROW_LIMIT = 500; // max rows per GSC request

// Pages that are part of the estimate completion funnel
const FUNNEL_PATTERNS = [
  '/estimate', '/get-estimate', '/quote', '/start',
  '/step', '/results', '/your-estimate'
];

// Page categories for segmentation
const PAGE_CATEGORIES = {
  regional: /\/(london|manchester|birmingham|leeds|liverpool|bristol|sheffield|edinburgh|glasgow|cardiff|newcastle|nottingham|leicester|coventry|bradford|hull|stoke|wolverhampton|sunderland|reading|belfast|derby|plymouth|southampton|oxford|cambridge|brighton|portsmouth|norwich|exeter|york|milton-keynes|luton|peterborough|swansea|aberdeen|dundee|inverness|bath|chester|worcester|hereford|shrewsbury|gloucester|exeter)\//i,
  trade: /\/(plumbing|electrical|building|roofing|painting|landscaping|kitchen|bathroom|extension|loft|boiler|heating|flooring|plastering|carpentry|tiling|damp|insulation|windows|doors|garage|conservatory|garden|patio|driveway|fence)\//i,
  article: /\/(blog|articles?|guide|how-to|advice|tips|cost-guide|resources?)\//i,
  comparison: /compare|vs\.|versus/i,
};

// ─── GSC CLIENT ──────────────────────────────────────────────────────────────

function createGSCClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  console.log('OAuth credentials loaded:', {
    clientId: process.env.GOOGLE_CLIENT_ID ? 'SET' : 'MISSING',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN ? process.env.GOOGLE_REFRESH_TOKEN.substring(0, 10) + '...' : 'MISSING',
  });
  return google.searchconsole({ version: 'v1', auth });
}

function getDateRange() {
  const end = new Date();
  end.setDate(end.getDate() - 3); // GSC has ~3 day delay
  const start = new Date(end);
  start.setDate(start.getDate() - DAYS_BACK);
  const fmt = (d) => d.toISOString().split('T')[0];
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function fetchGSCData(gsc, dimensions, rowLimit = ROW_LIMIT) {
  const { startDate, endDate } = getDateRange();
  const response = await gsc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate,
      endDate,
      dimensions,
      rowLimit,
      dataState: 'final',
    },
  });
  return response.data.rows || [];
}

// ─── DATA PROCESSING ─────────────────────────────────────────────────────────

function categorisePage(url) {
  for (const [cat, pattern] of Object.entries(PAGE_CATEGORIES)) {
    if (pattern.test(url)) return cat;
  }
  return 'other';
}

function isFunnelPage(url) {
  return FUNNEL_PATTERNS.some((p) => url.toLowerCase().includes(p));
}

function processData(queryRows, pageRows) {
  // ── Quick wins: ranking 5–20, CTR below average ──
  const avgCTR = pageRows.reduce((s, r) => s + r.ctr, 0) / (pageRows.length || 1);
  const quickWins = pageRows
    .filter((r) => r.position >= 5 && r.position <= 20 && r.ctr < avgCTR && r.impressions > 50)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map((r) => ({
      page: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1) + '%',
      position: r.position.toFixed(1),
      category: categorisePage(r.keys[0]),
    }));

  // ── Underperforming: high impressions, very low CTR ──
  const underperforming = pageRows
    .filter((r) => r.impressions > 100 && r.ctr < 0.01 && r.clicks < 5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map((r) => ({
      page: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(2) + '%',
      position: r.position.toFixed(1),
    }));

  // ── Funnel pages ──
  const funnelPages = pageRows
    .filter((r) => isFunnelPage(r.keys[0]))
    .map((r) => ({
      page: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1) + '%',
      position: r.position.toFixed(1),
    }));

  // ── Keyword gaps: queries with impressions but no dedicated page ──
  const topQueries = queryRows
    .filter((r) => r.impressions > 30 && r.position > 10)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 40)
    .map((r) => ({
      query: r.keys[0],
      impressions: r.impressions,
      clicks: r.clicks,
      position: r.position.toFixed(1),
    }));

  // ── Top performers (context for Claude) ──
  const topPages = pageRows
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 20)
    .map((r) => ({
      page: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1) + '%',
      position: r.position.toFixed(1),
      category: categorisePage(r.keys[0]),
    }));

  // ── Overview stats ──
  const totals = pageRows.reduce(
    (acc, r) => {
      acc.clicks += r.clicks;
      acc.impressions += r.impressions;
      return acc;
    },
    { clicks: 0, impressions: 0 }
  );
  totals.avgCTR = ((totals.clicks / totals.impressions) * 100).toFixed(2) + '%';
  totals.avgPosition = (
    pageRows.reduce((s, r) => s + r.position, 0) / (pageRows.length || 1)
  ).toFixed(1);

  const categoryBreakdown = {};
  for (const row of pageRows) {
    const cat = categorisePage(row.keys[0]);
    if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { clicks: 0, impressions: 0, pages: 0 };
    categoryBreakdown[cat].clicks += row.clicks;
    categoryBreakdown[cat].impressions += row.impressions;
    categoryBreakdown[cat].pages++;
  }

  return { quickWins, underperforming, funnelPages, topQueries, topPages, totals, categoryBreakdown };
}

// ─── CLAUDE ANALYSIS ─────────────────────────────────────────────────────────

async function runClaudeAnalysis(data) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are a senior SEO and conversion optimisation consultant analysing data for EstimateAI (getestimateai.co.uk) — a UK-focused AI-powered home renovation cost estimation platform.

The platform's goals are:
1. Increase organic clicks from Google (more UK homeowners finding the site)
2. Improve CTR on pages that already rank well
3. Fill content gaps where there's search demand but no dedicated page
4. Most importantly: increase the number of estimates completed by users

The site has these page types:
- Regional pages: cost guides for specific UK cities/regions (e.g. /london/boiler-installation)
- Trade pages: cost guides by trade type (e.g. /plumbing/boiler-replacement-cost)
- Articles/guides: informational renovation content
- The estimation tool itself: where users input their project details and get an AI estimate

Here is the last 28 days of Google Search Console data:

## OVERVIEW
Total clicks: ${data.totals.clicks.toLocaleString()}
Total impressions: ${data.totals.impressions.toLocaleString()}
Average CTR: ${data.totals.avgCTR}
Average position: ${data.totals.avgPosition}

## CATEGORY BREAKDOWN
${JSON.stringify(data.categoryBreakdown, null, 2)}

## TOP PERFORMING PAGES (by clicks)
${JSON.stringify(data.topPages, null, 2)}

## QUICK WIN OPPORTUNITIES (ranking 5-20, below-average CTR)
These pages rank well but aren't getting the clicks they should be.
${JSON.stringify(data.quickWins, null, 2)}

## UNDERPERFORMING PAGES (high impressions, very low CTR)
${JSON.stringify(data.underperforming, null, 2)}

## ESTIMATION FUNNEL PAGES
These are pages directly involved in getting users to complete an estimate:
${JSON.stringify(data.funnelPages, null, 2)}

## KEYWORD/QUERY GAPS (queries ranking 10+ with impressions but no clear dedicated page)
These represent potential new pages or content improvements:
${JSON.stringify(data.topQueries, null, 2)}

---

Please provide a detailed analysis structured as follows. Be specific, actionable, and UK-renovation focused throughout. Reference actual page URLs and queries from the data where possible.

**1. EXECUTIVE SUMMARY** (3-4 sentences on the overall health and biggest opportunities)

**2. QUICK WINS — CTR IMPROVEMENTS** (top 5-7 pages where a better title tag and meta description would immediately improve clicks. For each, suggest a specific new title and description.)

**3. UNDERPERFORMING PAGES — ROOT CAUSE & FIX** (for the worst offenders, diagnose why CTR is so low and give a specific fix)

**4. CONTENT GAP OPPORTUNITIES** (identify the 5-7 most valuable new pages or sections to create based on the query data. Include suggested URL structure, target keywords, and estimated search intent)

**5. ESTIMATE FUNNEL ANALYSIS** (specific recommendations to drive more users from landing pages through to completing an estimate — include any messaging, CTA, or UX ideas relevant to renovation homeowners)

**6. REGIONAL & TRADE PAGE STRATEGY** (are there obvious geographic or trade gaps? Which combinations should be prioritised next?)

**7. PRIORITY ACTION LIST** (numbered 1-10, ordered by impact×effort, with a one-line description of each action and the expected benefit)`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ─── EMAIL REPORT ─────────────────────────────────────────────────────────────

function markdownToHTML(md) {
  // Basic markdown → HTML conversion for the report
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

  const statsRow = (label, value, sub = '') => `
    <td style="padding:16px 20px;background:#f8fafc;border-radius:8px;text-align:center;margin:4px;">
      <div style="font-size:26px;font-weight:700;color:#0d9488;">${value}</div>
      <div style="font-size:12px;color:#64748b;margin-top:4px;">${label}</div>
      ${sub ? `<div style="font-size:11px;color:#94a3b8;">${sub}</div>` : ''}
    </td>`;

  const quickWinsTable = data.quickWins.slice(0, 8).map(w => `
    <tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:8px 12px;font-size:12px;color:#334155;max-width:240px;word-break:break-all;">${w.page.replace(SITE_URL, '/')}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;">${w.impressions.toLocaleString()}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;">${w.clicks}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;color:#ef4444;font-weight:600;">${w.ctr}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;">${w.position}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EstimateAI — GSC Weekly Report</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;margin:0;padding:24px;">
<div style="max-width:700px;margin:0 auto;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0d9488,#0891b2);border-radius:16px 16px 0 0;padding:32px 36px;color:white;">
    <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;">📊 EstimateAI SEO Report</div>
    <div style="font-size:14px;opacity:0.85;margin-top:6px;">${startDate} → ${endDate} &nbsp;·&nbsp; Powered by Claude AI</div>
  </div>

  <!-- Stats bar -->
  <div style="background:white;padding:20px 24px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
    <table width="100%" cellpadding="4" cellspacing="8"><tr>
      ${statsRow('Total Clicks', data.totals.clicks.toLocaleString())}
      ${statsRow('Impressions', data.totals.impressions.toLocaleString())}
      ${statsRow('Avg CTR', data.totals.avgCTR)}
      ${statsRow('Avg Position', data.totals.avgPosition)}
    </tr></table>
  </div>

  <!-- Quick wins table -->
  <div style="background:white;padding:24px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-top:1px solid #f1f5f9;">
    <h2 style="color:#0d9488;font-size:16px;margin:0 0 12px;">⚡ Quick Win Pages (Ranking 5–20, Low CTR)</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:600;">Page</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">Impr.</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">Clicks</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">CTR</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-weight:600;">Pos.</th>
        </tr>
      </thead>
      <tbody>${quickWinsTable}</tbody>
    </table>
  </div>

  <!-- Claude Analysis -->
  <div style="background:white;padding:28px 32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
      <div style="width:36px;height:36px;background:linear-gradient(135deg,#0d9488,#0891b2);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;">🤖</div>
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
    EstimateAI Automated SEO Report &nbsp;·&nbsp; <a href="https://getestimateai.co.uk" style="color:#0d9488;">getestimateai.co.uk</a>
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
    subject: `📊 EstimateAI SEO Report — ${startDate} to ${endDate}`,
    html: htmlContent,
  });

  console.log('✅ Report email sent to', process.env.REPORT_RECIPIENT);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 EstimateAI GSC Analyser starting...');

  const gsc = createGSCClient();
  const dateRange = getDateRange();

  console.log(`📅 Fetching data: ${dateRange.startDate} → ${dateRange.endDate}`);

  // Fetch data in parallel
  const [queryRows, pageRows] = await Promise.all([
    fetchGSCData(gsc, ['query']),
    fetchGSCData(gsc, ['page']),
  ]);

  console.log(`✅ Fetched ${queryRows.length} queries, ${pageRows.length} pages`);

  // Process
  const data = processData(queryRows, pageRows);
  console.log(`📊 Quick wins: ${data.quickWins.length}, Underperforming: ${data.underperforming.length}, Gaps: ${data.topQueries.length}`);

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
