// Weekly permanent record of site performance, written to the sitesnapshots
// collection. This is not the primary interface -- the mcp-analytics tools
// are queried live for that. This exists for two things live queries can't
// give you: a record that survives GA4's own data retention window, and a
// historical series that exists whether or not anyone remembers to ask for
// it that week (useful as contractor pitch collateral per
// ContractorMonetisationPlan.md).
//
// No Google Drive mirror. The original spec called that best-effort only,
// and it comes with a known service-account storage quota risk (writing
// into a folder shared from a personal Google account fails because the
// uploaded file is owned by the service account, which has no quota of its
// own) -- not worth the complexity now that the data is queryable live
// through the MCP tools anyway. MongoDB is the only store.
//
// Schedule: Mondays 09:30, after the existing GSC (07:00) and GA4 (08:00)
// analyser crons, and offset from cost-index-analyser.js's 09:00 slot.

require('dotenv').config();
const mongoose = require('mongoose');
const SiteSnapshot = require('../models/SiteSnapshot');
const { buildSnapshot } = require('../analytics/analyticsSnapshot');
const { createOpsAlerter } = require('../utils/opsAlert');
const { sendOpsEmail } = require('../services/emailService');

// One email to ALERT_EMAIL when the run fails, so this cron cannot stop
// silently again (it never ran between July and November 2026).
const alertOps = createOpsAlerter({ send: sendOpsEmail, recipient: () => process.env.ALERT_EMAIL });

const num = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toLocaleString('en-GB'));

function kpiLines(kpis) {
  const lines = ['## KPIs (latest complete week)'];
  if (!kpis) return [...lines, '_unavailable_', ''];
  const row = (label, s) => `| ${label} | ${num(s.current)} | ${num(s.previous)} | ${num(s.avg4)} | ${s.flag ? `${s.flag.direction} ${s.flag.changePct}%` : ''} |`;
  lines.push('| KPI | This week | Last week | 4-week avg | Flag |', '|---|---|---|---|---|');
  if (kpis.gsc) {
    lines.push(row(`Impressions (${kpis.gsc.weeks[0].from} to ${kpis.gsc.weeks[0].to})`, kpis.gsc.impressions));
    lines.push(row('Clicks', kpis.gsc.clicks));
  }
  if (kpis.ga4) {
    lines.push(row(`Organic sessions (${kpis.ga4.weeks[0].from} to ${kpis.ga4.weeks[0].to})`, kpis.ga4.sessionsOrganic));
    lines.push(row('All sessions', kpis.ga4.sessionsAll));
  }
  kpis.mongodb.estimatesByVariant.forEach((v) => lines.push(row(`Estimates, ${v.variant} (${kpis.mongodb.weeks[0].from} to ${kpis.mongodb.weeks[0].to})`, v)));
  lines.push('');
  if (kpis.ga4) {
    lines.push('| Organic landers | Sessions | Estimates | Rate | Last week | 4-week | Flag |', '|---|---|---|---|---|---|---|');
    kpis.ga4.organicEstimateRateByLanding.forEach((r) => lines.push(`| ${r.group} | ${r.sessions} | ${r.estimates} | ${num(r.ratePct)}% | ${num(r.previousRatePct)}% | ${num(r.avg4RatePct)}% | ${r.flag ? `${r.flag.direction} ${r.flag.changePct}%` : ''} |`));
    lines.push('');
  }
  if (kpis.partialFailure) lines.push(`**KPI partial failure:** ${kpis.partialFailure.map((f) => `${f.source} (${f.reason})`).join('; ')}`, '');
  return lines;
}

function fmtCurrency(value) {
  if (value === null || value === undefined) return 'n/a';
  return `£${Math.round(value).toLocaleString()}`;
}

function fmtDate(value) {
  return new Date(value).toISOString().split('T')[0];
}

function renderMarkdown(snapshot) {
  const { meta, data } = snapshot;
  const lines = [];

  lines.push('# EstimateAI Weekly Snapshot');
  lines.push(`Generated ${meta.generatedAt}`);
  lines.push('');

  if (meta.partialFailure && meta.partialFailure.length) {
    lines.push(`**Partial failure:** ${meta.partialFailure.map((f) => `${f.source} (${f.reason})`).join('; ')}`);
    lines.push('');
  }

  lines.push(...kpiLines(data.kpis));

  lines.push('## A/B test funnel');
  lines.push(`Verdict: **${data.abTestStatus.verdict.verdict}** -- ${data.abTestStatus.verdict.reason}`);
  lines.push('');
  lines.push('| Variant | Estimates | Leads | Avg value |');
  lines.push('|---|---|---|---|');
  Object.entries(data.abTestStatus.funnel).forEach(([variant, row]) => {
    lines.push(`| ${variant} | ${row.estimates} | ${row.leads} | ${fmtCurrency(row.avgValue)} |`);
  });
  lines.push('');

  lines.push('## Top job types by demand');
  lines.push('| Variant | Job type | Count | Avg value |');
  lines.push('|---|---|---|---|');
  data.estimateDemand.rows.slice(0, 15).forEach((row) => {
    lines.push(`| ${row.variant} | ${row.key} | ${row.count} | ${fmtCurrency(row.avgValue)} |`);
  });
  lines.push('');

  lines.push('## Contractor signal ladder');
  lines.push('| Variant | Action | Count |');
  lines.push('|---|---|---|');
  data.contractorSignals.forEach((row) => {
    lines.push(`| ${row.variant} | ${row.action} | ${row.count} |`);
  });
  lines.push('');

  lines.push('## GSC top pages');
  if (data.gscPerformance) {
    lines.push('| Page | Clicks | Impressions | Position |');
    lines.push('|---|---|---|---|');
    data.gscPerformance.slice(0, 10).forEach((row) => {
      lines.push(`| ${row.key} | ${row.clicks} | ${row.impressions} | ${row.position.toFixed(1)} |`);
    });
  } else {
    lines.push('_unavailable this run -- see partialFailure above_');
  }
  lines.push('');

  lines.push('## GA4 events');
  if (data.ga4Events) {
    lines.push('| Event | Count | Unique users |');
    lines.push('|---|---|---|');
    data.ga4Events.slice(0, 15).forEach((row) => {
      lines.push(`| ${row.event} | ${row.count} | ${row.uniqueUsers} |`);
    });
  } else {
    lines.push('_unavailable this run -- see partialFailure above_');
  }
  lines.push('');

  lines.push('## Recent changes');
  if (data.changeLog.length) {
    data.changeLog.forEach((entry) => {
      lines.push(`- **${fmtDate(entry.date)}** [${entry.type}] ${entry.description}`);
    });
  } else {
    lines.push('_none in this window_');
  }

  return lines.join('\n');
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI env var not set');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');

  const snapshot = await buildSnapshot({ period: 'week' });
  const markdown = renderMarkdown(snapshot);
  const weekEnding = new Date(snapshot.meta.windows.mongodb.to);

  await SiteSnapshot.create({ weekEnding, payload: snapshot, markdown });

  console.log(`Snapshot written for week ending ${fmtDate(weekEnding)}`);
  if (snapshot.meta.partialFailure) {
    console.warn('Partial failure this run:', JSON.stringify(snapshot.meta.partialFailure));
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('snapshot-cron failed:', err);
  await alertOps('snapshot-cron', 'EstimateAI weekly snapshot failed', `crons/snapshot-cron.js failed and wrote no snapshot.\n\n${err && err.message}`);
  process.exit(1);
});
