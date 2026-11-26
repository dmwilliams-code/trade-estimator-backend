// analytics/demandStatsConfig.js
// Rules and labels for the demand stats pipeline (DemandStatsPipelineSpec.md in
// the frontend repo). Thresholds live here so they can be raised as volume grows.

const RULES = {
  minN: 20,            // a scope is published only with at least this many estimates
  minCell: 5,          // a subgroup (region, size band, tier) is shown only with at least this many
  dedupe: 'none',      // every saved estimate counts, so copy says "estimates", not "homeowners"
  dateFloor: '2026-06-13',
  quoteStatusFrom: '2026-11-26', // quote ownership question went live
  lockAfterDays: 7,    // a completed month or quarter is locked this long after it ends
  swingReviewPct: 60   // a volume change bigger than this holds the window for review
};

// Every jobType seen in estimates needs a label. An unknown jobType stops the
// run rather than publishing a raw slug.
const JOB_LABELS = {
  'single-storey-extension': 'Single-storey extension',
  'double-storey-extension': 'Double-storey extension',
  'kitchen-extension': 'Kitchen extension',
  'loft-conversion': 'Loft conversion',
  'loft-conversion-dormer': 'Dormer loft conversion',
  'plastering-room': 'Room plastering',
  'plastering-house': 'Whole-house re-skim',
  'bathroom-install': 'Bathroom installation',
  'kitchen-renovation': 'Kitchen renovation',
  rewire: 'Full rewire',
  'consumer-unit': 'Consumer unit replacement',
  'ev-charger': 'EV charger installation',
  'painting-room': 'Room painting',
  wallpapering: 'Wallpapering',
  'floor-sanding': 'Floor sanding',
  'air-conditioning': 'Air conditioning installation',
  'boiler-replacement': 'Boiler replacement',
  'radiator-install': 'Radiator installation',
  'radiator-repair': 'Radiator repair',
  'toilet-repair': 'Toilet repair',
  'tap-leaks': 'Tap leak repair',
  'garden-landscaping': 'Garden landscaping',
  'tree-surgery': 'Tree surgery'
};

// Fixed groups for the Demand Index mix-over-time chart (DemandMixOverTimeSpec.md).
// Separate from FAMILIES so changing the chart can never change article blocks.
// Order is the chart order; 'everything-else' catches every other job type.
const CHART_GROUPS = [
  { key: 'extensions', label: 'Extensions', jobTypes: ['single-storey-extension', 'double-storey-extension', 'kitchen-extension'] },
  { key: 'plastering', label: 'Plastering', jobTypes: ['plastering-room', 'plastering-house'] },
  { key: 'bathroom', label: 'Bathroom', jobTypes: ['bathroom-install'] },
  { key: 'loft', label: 'Loft conversions', jobTypes: ['loft-conversion', 'loft-conversion-dormer'] },
  { key: 'everything-else', label: 'Everything else', jobTypes: [] }
];

const FAMILIES = {
  extensions: { label: 'Extensions', noun: 'extension', jobTypes: ['single-storey-extension', 'double-storey-extension', 'kitchen-extension'] },
  loft: { label: 'Loft conversions', noun: 'loft', jobTypes: ['loft-conversion', 'loft-conversion-dormer'] },
  plastering: { label: 'Plastering', noun: 'plastering', jobTypes: ['plastering-room', 'plastering-house'] }
};

// Size bands for area jobs (m2). Bands are [from, to). Values outside the
// plausible range (for example the 1 m2 entries seen on extensions) are left
// out of the size figures only, not out of the job's other figures.
const AREA_SIZES = {
  'single-storey-extension': { plausible: [5, 150], bands: [0, 15, 20, 25, 30, 40] },
  'double-storey-extension': { plausible: [5, 250], bands: [0, 20, 30, 40, 60] },
  'kitchen-extension': { plausible: [4, 100], bands: [0, 10, 15, 20, 30] },
  'garden-landscaping': { plausible: [2, 500], bands: [0, 20, 30, 50, 100] }
};

// The estimator's size buttons are room sizes ("Single room", "Standard room"),
// so a size mix only means something for jobs priced by the room.
const PROJECT_SIZE_JOBS = ['plastering-room', 'painting-room', 'wallpapering', 'bathroom-install', 'kitchen-renovation'];

const PROJECT_SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large', 'extra-large': 'Extra large' };
const QUALITY_LABELS = { budget: 'Budget', standard: 'Standard', premium: 'Premium', luxury: 'Luxury' };
const CATEGORY_LABELS = { building: 'Building', plumbing: 'Plumbing', electrical: 'Electrical', decoration: 'Decoration', outdoor: 'Outdoor' };
const QUOTE_LABELS = { none: 'No quote yet', one: 'One quote', multiple: 'Several quotes' };

module.exports = {
  RULES,
  JOB_LABELS,
  FAMILIES,
  CHART_GROUPS,
  AREA_SIZES,
  PROJECT_SIZE_JOBS,
  PROJECT_SIZE_LABELS,
  QUALITY_LABELS,
  CATEGORY_LABELS,
  QUOTE_LABELS
};
