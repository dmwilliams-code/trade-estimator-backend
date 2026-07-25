// Per-source window resolution. GSC, GA4 and MongoDB never share a window --
// each source has its own reporting lag, and a naive shared "last N days"
// window reads incomplete GSC/GA4 data as a traffic collapse.

const LAG_DAYS = { gsc: 3, ga4: 1, mongodb: 0 };

const PERIOD_DAYS = { week: 7, month: 30 };

const TEST_START_DATE = '2026-06-13';

function toIsoDate(date) {
  return date.toISOString().split('T')[0];
}

function subtractDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

// resolveWindow(period|days, source) -> { from, to, lagDays }
// `to` is always today minus the source's lag. `from` is `to` minus the
// period, except for 'since_test_start' which anchors `from` to the fixed
// A/B test start date.
function resolveWindow(periodOrDays, source) {
  if (!(source in LAG_DAYS)) {
    throw new Error(`resolveWindow: unknown source "${source}", expected one of ${Object.keys(LAG_DAYS).join(', ')}`);
  }

  const lagDays = LAG_DAYS[source];
  const to = subtractDays(new Date(), lagDays);

  if (periodOrDays === 'since_test_start') {
    return { from: TEST_START_DATE, to: toIsoDate(to), lagDays };
  }

  const days = typeof periodOrDays === 'number' ? periodOrDays : PERIOD_DAYS[periodOrDays];
  if (!days) {
    throw new Error(`resolveWindow: unknown period "${periodOrDays}"`);
  }

  const from = subtractDays(to, days);
  return { from: toIsoDate(from), to: toIsoDate(to), lagDays };
}

module.exports = { resolveWindow, LAG_DAYS, TEST_START_DATE };
