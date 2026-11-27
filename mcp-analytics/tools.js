// Tool definitions. All read-only -- no tool here performs a write of any
// kind. Descriptions matter: they're what Claude reads to choose a tool, so
// the distinctions between tools are made explicit in each one.

const { z } = require('zod/v4');
const analyticsSnapshot = require('../analytics/analyticsSnapshot');

function toToolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

// Structured error, never a stack trace or internal file path in what's
// returned to the client. The full message is also logged server-side so a
// real outage (e.g. GA4/GSC auth expiring) shows up in Render's logs
// directly, not only inside a tool response someone happens to inspect.
function toErrorResult(toolName, err) {
  console.error(`[${new Date().toISOString()}] tool error (${toolName}):`, err.message);
  return {
    content: [{ type: 'text', text: `Error: ${err.message}` }],
    isError: true,
  };
}

function registerTools(server) {
  server.registerTool(
    'get_kpi_summary',
    {
      description:
        'Weekly KPIs: GSC impressions, clicks, CTR and position (total and by page group), GA4 sessions and ' +
        'organic estimate rate per landing session by page group, and MongoDB estimates by variant and job group. ' +
        'Each is the latest complete week vs the previous week and the 4-week average, with anomaly flags ' +
        'computed in code. Use this first for any question about how traffic or estimates moved this week, and ' +
        'quote its numbers exactly. Each source block states its own week dates.',
      inputSchema: {},
    },
    async () => {
      try {
        return toToolResult(await analyticsSnapshot.buildKpis());
      } catch (err) {
        return toErrorResult('get_kpi_summary', err);
      }
    }
  );

  server.registerTool(
    'get_site_snapshot',
    {
      description:
        'Full composite snapshot for one period: AB test funnel + verdict, estimate demand by job type, ' +
        'contractor signal ladder, GSC page performance, GA4 event counts, and the recent change log. ' +
        'This is the default entry point for open questions like "how are things going" -- use it before ' +
        'reaching for a narrower tool. If GSC or GA4 fails, MongoDB-sourced sections are still returned, ' +
        'with the failure noted in meta.partialFailure.',
      inputSchema: {
        period: z
          .enum(['week', 'month', 'since_test_start'])
          .default('week')
          .describe('week = last 7 days, month = last 30 days, since_test_start = since the A/B test began (2026-06-13).'),
      },
    },
    async ({ period }) => {
      try {
        return toToolResult(await analyticsSnapshot.buildSnapshot({ period }));
      } catch (err) {
        return toErrorResult('get_site_snapshot', err);
      }
    }
  );

  server.registerTool(
    'get_ab_test_status',
    {
      description:
        'Per-variant (blur, control, open_jul2026, unassigned) estimate and lead funnel since the A/B test ' +
        'started (2026-06-13), plus a computed verdict (activate, do_not_activate, inconclusive, or ' +
        'insufficient_data) for the blur-vs-control comparison. open_jul2026 is reported separately and ' +
        'never enters the verdict calculation -- the verdict criteria are a two-arm comparison only.',
      inputSchema: {},
    },
    async () => {
      try {
        return toToolResult(await analyticsSnapshot.getAbTestStatus());
      } catch (err) {
        return toErrorResult('get_ab_test_status', err);
      }
    }
  );

  server.registerTool(
    'get_gsc_performance',
    {
      description:
        'Google Search Console clicks, impressions, CTR and average position, broken down by query, page, ' +
        'country or device, plus the delta vs the immediately preceding equivalent window. GSC data lags ' +
        '2-3 days behind GA4 and MongoDB -- do not compare absolute counts across sources without accounting ' +
        'for that (see meta.caveats).',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(28).describe('Number of days to look back, 1-90.'),
        dimension: z.enum(['query', 'page', 'country', 'device']).describe('What to break the results down by.'),
        limit: z.number().int().min(1).max(500).default(20).describe('Max rows to return.'),
      },
    },
    async ({ days, dimension, limit }) => {
      try {
        return toToolResult(await analyticsSnapshot.getGscPerformance({ days, dimension, limit }));
      } catch (err) {
        return toErrorResult('get_gsc_performance', err);
      }
    }
  );

  server.registerTool(
    'get_ga4_events',
    {
      description:
        'GA4 event counts and unique users, optionally filtered to specific event names and broken down by ' +
        'traffic source, medium, or not broken down at all. Singapore traffic is excluded, matching the ' +
        'existing weekly GA4 analyser. breakdown "variant" is NOT supported -- ab_variant is sent as a GA4 ' +
        'event parameter but is not a registered GA4 custom dimension, so it cannot be queried via the Data ' +
        'API. Use get_estimate_demand or get_contractor_signals for variant-segmented data instead.',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7).describe('Number of days to look back, 1-90.'),
        eventNames: z
          .array(z.string())
          .optional()
          .describe('Specific GA4 event names to filter to, e.g. ["estimate_generated"]. Omit for all events.'),
        breakdown: z
          .enum(['source', 'medium', 'variant', 'none'])
          .default('none')
          .describe('How to break down event counts. "variant" will return a clear unsupported-dimension error -- see description.'),
      },
    },
    async ({ days, eventNames, breakdown }) => {
      try {
        return toToolResult(await analyticsSnapshot.getGa4Events({ days, eventNames, breakdown }));
      } catch (err) {
        return toErrorResult('get_ga4_events', err);
      }
    }
  );

  server.registerTool(
    'get_estimate_demand',
    {
      description:
        'Estimate volume and average value by job type, district or region, split by A/B variant and by ' +
        'quality tier, with unresolved-region counts surfaced separately rather than dropped. "region" groups ' +
        'by the stable regionSlug key, not the display region name.',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7).describe('Number of days to look back, 1-90.'),
        groupBy: z.enum(['job_type', 'district', 'region']).describe('What to group demand by.'),
      },
    },
    async ({ days, groupBy }) => {
      try {
        return toToolResult(await analyticsSnapshot.getEstimateDemand({ days, groupBy }));
      } catch (err) {
        return toErrorResult('get_estimate_demand', err);
      }
    }
  );

  server.registerTool(
    'get_contractor_signals',
    {
      description:
        'Contractor engagement from ContractorClick events, split by A/B variant. groupBy "ladder" returns ' +
        'counts per action (shown, call, website, map, contact_requested) per variant -- note control-arm ' +
        '"shown" counts are known to be under-reported (see meta.caveats), other actions are unaffected. ' +
        'groupBy "contractor" returns per-contractor density (name, place ID, districts, job types, total ' +
        'estimate value) ranked by signal count, where a signal is call, website, map or contact_requested ' +
        '-- "shown" is excluded there as a passive impression, not an active signal. Use "contractor" for ' +
        'outreach targeting, "ladder" for funnel-shape questions.',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7).describe('Number of days to look back, 1-90.'),
        groupBy: z.enum(['ladder', 'contractor']).describe('"ladder" for the action-count funnel, "contractor" for per-contractor density.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max contractors to return. Only applies when groupBy is "contractor".'),
      },
    },
    async ({ days, groupBy, limit }) => {
      try {
        return toToolResult(await analyticsSnapshot.getContractorSignals({ days, groupBy, limit }));
      } catch (err) {
        return toErrorResult('get_contractor_signals', err);
      }
    }
  );

  server.registerTool(
    'get_change_log',
    {
      description:
        'Deliberate site changes logged as annotations (seo, cta, content, bug-fix, new-page, technical, ' +
        'estimator), each with a description, affected URLs and a hypothesis for what metric it should move. ' +
        'Use this to attribute a metric movement seen in another tool to a specific shipped change.',
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe('ISO date (YYYY-MM-DD). Defaults to 90 days ago if omitted.'),
      },
    },
    async ({ since }) => {
      try {
        return toToolResult(await analyticsSnapshot.getChangeLog({ since }));
      } catch (err) {
        return toErrorResult('get_change_log', err);
      }
    }
  );
}

module.exports = { registerTools };
