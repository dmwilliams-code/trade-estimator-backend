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

main().catch((err) => {
  console.error('snapshot-cron failed:', err);
  process.exit(1);
});
