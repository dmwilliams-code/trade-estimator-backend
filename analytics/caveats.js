// Caveat config, filtered by whether the requested window overlaps the
// caveat's active range (`from`/`to`, both inclusive; null = open-ended).
// Adding a caveat is a one-line change that applies to every future
// conversation. Set `to` when the underlying issue is fixed to retire it.

module.exports = [
  {
    id: 'gsc-lag',
    from: null, to: null,
    sources: ['gsc'],
    text: 'GSC data lags 2 to 3 days and its window differs from GA4 and MongoDB. Do not compare absolute counts across sources without accounting for this.'
  },
  {
    id: 'control-shown-undercount',
    from: '2026-06-13', to: null,
    sources: ['mongodb'],
    text: 'Control arm contractor shown events are under-reported. Known bug: shown events were gated behind emailSent === true in the control arm. Do not compare shown counts across variants. call, website, map and contact_requested are unaffected.'
  },
  {
    id: 'zero-organic-contact-requests',
    from: '2026-06-13', to: null,
    sources: ['mongodb'],
    text: 'Organic contact_requested has been zero since 13 June 2026. This is a confirmed behavioural finding, not an instrumentation fault. Test traffic from postcode districts BA14 and TA6 is excluded from this figure at the query level; any testing done from a different location before that exclusion was in place may still be present as unfiltered noise.'
  },
  {
    id: 'ui-redesign-12jul',
    from: '2026-07-12', to: '2026-08-12',
    sources: ['mongodb', 'ga4'],
    text: 'Estimator results page was reordered on 12 July 2026 (hero, contractors, email capture; Request contact promoted to primary CTA). Any window spanning that date contains two different page designs.'
  },
  {
    id: 'ga4-gsc-test-traffic-not-excluded',
    from: null, to: null,
    sources: ['ga4', 'gsc'],
    text: 'GA4 and GSC have no postcode dimension, so the developer\'s own test traffic (postcodes BA14 8UZ / TA6 6UN) cannot be excluded from these sources the way it is from MongoDB. MongoDB-sourced figures in this response are test-excluded; GA4/GSC figures are not.'
  }
];
