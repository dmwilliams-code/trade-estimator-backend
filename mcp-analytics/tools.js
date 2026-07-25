// Tool definitions. All read-only -- no tool here performs a write of any
// kind. Descriptions matter: they're what Claude reads to choose a tool, so
// the distinctions between tools are made explicit in each one.
//
// Phase 6: tools 1, 2 and 7 only (get_site_snapshot, get_ab_test_status,
// get_change_log). Tools 3-6 land in the next phase.

const { z } = require('zod/v4');
const analyticsSnapshot = require('../analytics/analyticsSnapshot');

function toToolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

// Structured error, never a stack trace or internal file path.
function toErrorResult(err) {
  return {
    content: [{ type: 'text', text: `Error: ${err.message}` }],
    isError: true,
  };
}

function registerTools(server) {
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
        return toErrorResult(err);
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
        return toErrorResult(err);
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
        return toErrorResult(err);
      }
    }
  );
}

module.exports = { registerTools };
