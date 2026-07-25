// MongoDB aggregations for the analytics channel. Field paths here are the
// ones confirmed against the real models during preflight, not the ones
// assumed in the original spec draft -- see the corrections noted inline.
//
// Rule 4.1.1 (no blended aggregates): every aggregation below groups by
// abVariant (or the two-level {variant, ...} shape) as its first/outer key.
// Records with no abVariant group under the literal 'unassigned'. There is
// no parameter anywhere in this file that collapses variants into one number.

const Estimate = require('../../models/Estimate');
const Lead = require('../../models/LeadModel');
const ContractorClick = require('../../models/ContractorClick');
const Annotation = require('../../models/Annotation');

// Postcode districts used for the developer's own manual testing. Estimates
// are cleaned manually by hand already; ContractorClick and Lead are not, so
// this exclusion is what actually keeps test noise out of those two.
const TEST_DISTRICTS = (process.env.TEST_EXCLUSION_DISTRICTS || 'BA14,TA6')
  .split(',')
  .map((d) => d.trim().toUpperCase())
  .filter(Boolean);

// Estimate.locationData.district and ContractorClick.postcodeDistrict are
// both clean outward-code-only strings, so an exact $nin excludes test
// traffic. Lead.userLocation is free text (may be a full postcode, an
// outward code, or something else depending on source), so it needs a
// prefix match instead.
const testDistrictPrefixRegex = new RegExp(`^(${TEST_DISTRICTS.join('|')})(\\s|$)`, 'i');

function estimateTestExclusion() {
  return { 'locationData.district': { $nin: TEST_DISTRICTS } };
}

function contractorClickTestExclusion() {
  return { postcodeDistrict: { $nin: TEST_DISTRICTS } };
}

function leadTestExclusion() {
  return {
    $or: [
      { userLocation: null },
      { userLocation: { $not: testDistrictPrefixRegex } }
    ]
  };
}

// Whitelisted groupBy -> field path mapping. Never interpolate a
// caller-supplied string into a field path directly.
//
// 'region' maps to locationData.regionSlug, not locationData.region: the
// slug is the stable key the schema comments identify as the one to group
// regional reporting by; .region is a display name, not confirmed stable.
const GROUP_FIELD_MAP = {
  job_type: 'jobType',
  district: 'locationData.district',
  region: 'locationData.regionSlug'
};

function dateRangeMatch(field, from, to) {
  return { [field]: { $gte: new Date(from), $lt: new Date(to) } };
}

// Estimates by variant. total -> estimate.total (nested, not a top-level
// field); regionUnresolved -> locationData.regionResolved (nested).
async function getEstimatesByVariant({ from, to }) {
  return Estimate.aggregate([
    { $match: { ...dateRangeMatch('createdAt', from, to), ...estimateTestExclusion() } },
    { $group: {
        _id: { $ifNull: ['$abVariant', 'unassigned'] },
        count: { $sum: 1 },
        avgValue: { $avg: '$estimate.total' },
        regionUnresolved: { $sum: { $cond: [{ $eq: ['$locationData.regionResolved', false] }, 1, 0] } }
    } },
    { $sort: { _id: 1 } }
  ]);
}

// Leads by variant, with a per-variant source breakdown (two-stage group
// rather than a push + client-side tally, so counting stays inside Mongo).
async function getLeadsByVariant({ from, to }) {
  return Lead.aggregate([
    { $match: { ...dateRangeMatch('createdAt', from, to), ...leadTestExclusion() } },
    { $group: {
        _id: { variant: { $ifNull: ['$abVariant', 'unassigned'] }, source: '$source' },
        count: { $sum: 1 }
    } },
    { $group: {
        _id: '$_id.variant',
        count: { $sum: '$count' },
        sourceBreakdown: { $push: { source: '$_id.source', count: '$count' } }
    } },
    { $sort: { _id: 1 } }
  ]);
}

// Contractor signal ladder: shown/call/website/map/contact_requested counts
// per variant. Matches on `timestamp`, not `createdAt` -- ContractorClick
// has no createdAt field.
async function getContractorSignalLadder({ from, to }) {
  return ContractorClick.aggregate([
    { $match: { ...dateRangeMatch('timestamp', from, to), ...contractorClickTestExclusion() } },
    { $group: {
        _id: { variant: { $ifNull: ['$abVariant', 'unassigned'] }, action: '$actionType' },
        count: { $sum: 1 }
    } },
    { $sort: { '_id.variant': 1, '_id.action': 1 } }
  ]);
}

// Demand by job type, district or region. Weighted avgValue is computed via
// sum/count across two group stages rather than averaging pre-grouped
// averages, which would under/overweight quality tiers with different
// volumes.
async function getDemandByGroup({ from, to, groupBy }) {
  const groupField = GROUP_FIELD_MAP[groupBy];
  if (!groupField) {
    throw new Error(`getDemandByGroup: unknown groupBy "${groupBy}", expected one of ${Object.keys(GROUP_FIELD_MAP).join(', ')}`);
  }

  return Estimate.aggregate([
    { $match: { ...dateRangeMatch('createdAt', from, to), ...estimateTestExclusion() } },
    { $group: {
        _id: { variant: { $ifNull: ['$abVariant', 'unassigned'] }, key: `$${groupField}`, quality: '$quality' },
        count: { $sum: 1 },
        sumValue: { $sum: '$estimate.total' }
    } },
    { $group: {
        _id: { variant: '$_id.variant', key: '$_id.key' },
        count: { $sum: '$count' },
        sumValue: { $sum: '$sumValue' },
        qualityBreakdown: { $push: { quality: '$_id.quality', count: '$count' } }
    } },
    { $addFields: {
        avgValue: { $cond: [{ $gt: ['$count', 0] }, { $divide: ['$sumValue', '$count'] }, null] }
    } },
    { $project: { sumValue: 0 } },
    { $sort: { count: -1 } }
  ]);
}

// Contractor density (outreach targeting). "Signal" = call, website, map or
// contact_requested -- 'shown' is a passive impression, excluded. There is
// no 'clicked' actionType value; the spec draft's filter assumed one that
// doesn't exist in the schema.
async function getContractorDensity({ from, to, limit }) {
  return ContractorClick.aggregate([
    { $match: {
        ...dateRangeMatch('timestamp', from, to),
        actionType: { $in: ['call', 'website', 'map', 'contact_requested'] },
        ...contractorClickTestExclusion()
    } },
    { $group: {
        _id: { placeId: '$placeId', variant: { $ifNull: ['$abVariant', 'unassigned'] } },
        contractorName: { $first: '$contractorName' },
        signals: { $sum: 1 },
        districts: { $addToSet: '$postcodeDistrict' },
        jobTypes: { $addToSet: '$jobType' },
        totalEstimateValue: { $sum: '$estimateValue' }
    } },
    { $sort: { signals: -1 } },
    { $limit: limit }
  ]);
}

// Change log. Projects only the confirmed Annotation fields, no _id.
async function getChangeLog({ since }) {
  return Annotation.aggregate([
    { $match: { date: { $gte: new Date(since) } } },
    { $sort: { date: -1 } },
    { $project: {
        _id: 0,
        date: 1,
        type: 1,
        description: 1,
        affectedUrls: 1,
        hypothesis: 1,
        outcome: 1,
        filesChanged: 1
    } }
  ]);
}

module.exports = {
  TEST_DISTRICTS,
  getEstimatesByVariant,
  getLeadsByVariant,
  getContractorSignalLadder,
  getDemandByGroup,
  getContractorDensity,
  getChangeLog
};
