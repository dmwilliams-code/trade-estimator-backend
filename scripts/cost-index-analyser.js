/**
 * EstimateAI — Monthly Cost Index Generator
 * ==========================================
 * Runs every Monday but exits early unless it is the first Monday of the month.
 * Queries MongoDB for the previous calendar month's estimates, computes the index,
 * calls Claude for a plain-English commentary paragraph, then writes the result
 * to the `costindex` collection. The frontend /renovation-cost-index page reads
 * from that collection via the /api/cost-index endpoint.
 *
 * No email approval step — output goes straight to the database and live page.
 * Prompt constraints ensure commentary is always publish-ready.
 *
 * SETUP:
 *   npm install mongoose @anthropic-ai/sdk dotenv
 *   (mongoose and @anthropic-ai/sdk are already in the backend package.json)
 *
 * ENV VARS (all already present in Render environment):
 *   MONGODB_URI          MongoDB Atlas connection string
 *   ANTHROPIC_API_KEY    Anthropic API key
 *
 * SCHEDULE (Render cron):
 *   0 9 * * 1   —   every Monday at 9am
 *   First-Monday guard runs inside the script.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Anthropic = require('@anthropic-ai/sdk');

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function getPreviousMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end   = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive upper bound
  return { start, end };
}

function getMonthLabel(date) {
  return date.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

// ─── MONGOOSE SCHEMAS ─────────────────────────────────────────────────────────

const estimateSchema = new mongoose.Schema({
  jobType:        String,
  category:       String,
  postcodeDistrict: String,
  total:          Number,
  labour:         Number,
  materials:      Number,
  quality:        String,
  createdAt:      Date,
}, { collection: 'estimates', strict: false });

const costIndexSchema = new mongoose.Schema({
  monthLabel:     { type: String, required: true }, // e.g. "May 2026"
  monthStart:     { type: Date,   required: true },
  generatedAt:    { type: Date,   default: Date.now },
  totalEstimates: Number,
  topJobTypes:    Array,   // [{ jobType, count, avgTotal, avgLow, avgHigh, avgLabourPct }]
  topRegions:     Array,   // [{ district, count, avgTotal }]
  labourMaterialsRatio: {
    avgLabourPct:    Number, // e.g. 0.68
    avgMaterialsPct: Number,
  },
  commentary:     String,  // Claude-generated paragraph, publish-ready
  prevMonthLabel: String,
  prevMonthTotals: Object, // { totalEstimates, topJobType, avgLabourPct } for MoM comparison
}, { collection: 'costindex' });

// ─── MONGODB QUERIES ──────────────────────────────────────────────────────────

async function fetchIndexData(Estimate, start, end) {

  // Run all aggregations in parallel
  const [topJobTypes, topRegions, ratioResult, totalResult] = await Promise.all([

    // Top job types by volume with cost and ratio breakdown
    Estimate.aggregate([
      { $match: { createdAt: { $gte: start, $lt: end }, 'estimate.total': { $gt: 0 } } },
      { $group: {
        _id:          '$jobType',
        count:        { $sum: 1 },
        avgTotal:     { $avg: '$estimate.total' },
        avgLow:       { $avg: '$estimate.low' },
        avgHigh:      { $avg: '$estimate.high' },
        avgLabour:    { $avg: '$estimate.labour' },
        avgMaterials: { $avg: '$estimate.materials' },
      }},
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),

    // Top regions by estimate volume
    Estimate.aggregate([
      { $match: {
        createdAt: { $gte: start, $lt: end },
        'estimate.total': { $gt: 0 },
        postcodeDistrict: { $exists: true, $ne: null, $ne: '' },
      }},
      { $group: {
        _id:      '$postcodeDistrict',
        count:    { $sum: 1 },
        avgTotal: { $avg: '$estimate.total' },
      }},
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),

    // Overall labour/materials ratio
    Estimate.aggregate([
      { $match: {
        createdAt:         { $gte: start, $lt: end },
        'estimate.total':  { $gt: 0 },
        'estimate.labour': { $gt: 0 },
      }},
      { $group: {
        _id:          null,
        avgLabourPct: { $avg: { $divide: ['$estimate.labour', '$estimate.total'] } },
      }},
    ]),

    // Total estimate count
    Estimate.countDocuments({ createdAt: { $gte: start, $lt: end }, 'estimate.total': { $gt: 0 } }),
  ]);

  // Shape job types — add labour % and share of total estimates per job type
  const shapedJobTypes = topJobTypes.map(j => ({
    jobType:      j._id,
    count:        j.count,
    pct:          Math.round((j.count / totalResult) * 100),
    avgTotal:     Math.round(j.avgTotal),
    avgLow:       Math.round(j.avgLow || 0),
    avgHigh:      Math.round(j.avgHigh || 0),
    avgLabourPct: j.avgLabour && j.avgTotal
      ? Math.round((j.avgLabour / j.avgTotal) * 100)
      : null,
  }));

  const shapedRegions = topRegions.map(r => ({
    district: r._id,
    count:    r.count,
    avgTotal: Math.round(r.avgTotal),
  }));

  const avgLabourPct    = ratioResult[0]?.avgLabourPct    ?? null;
  const avgMaterialsPct = avgLabourPct !== null ? 1 - avgLabourPct : null;

  return {
    totalEstimates: totalResult,
    topJobTypes:    shapedJobTypes,
    topRegions:     shapedRegions,
    labourMaterialsRatio: {
      avgLabourPct:    avgLabourPct    !== null ? Math.round(avgLabourPct    * 100) / 100 : null,
      avgMaterialsPct: avgMaterialsPct !== null ? Math.round(avgMaterialsPct * 100) / 100 : null,
    },
  };
}

// ─── CLAUDE COMMENTARY ────────────────────────────────────────────────────────

async function generateCommentary(indexData, monthLabel, prevMonthData) {
  const client = new Anthropic();

  // Build a concise MoM comparison string if previous month data exists
  let momContext = 'No previous month data available for comparison.';
  if (prevMonthData) {
    const volChange = indexData.totalEstimates - prevMonthData.totalEstimates;
    const volPct    = prevMonthData.totalEstimates > 0
      ? Math.round((volChange / prevMonthData.totalEstimates) * 100)
      : null;
    momContext = `Previous month (${prevMonthData.monthLabel}): ${prevMonthData.totalEstimates} estimates, top job type: ${prevMonthData.topJobTypes?.[0]?.jobType ?? 'n/a'}, avg labour share: ${prevMonthData.labourMaterialsRatio?.avgLabourPct ? Math.round(prevMonthData.labourMaterialsRatio.avgLabourPct * 100) + '%' : 'n/a'}. Volume change: ${volChange >= 0 ? '+' : ''}${volChange} estimates (${volPct !== null ? (volPct >= 0 ? '+' : '') + volPct + '%' : 'n/a'}).`;
  }

  const prompt = `You are writing the commentary paragraph for the EstimateAI UK Renovation Cost Index for ${monthLabel}.

This paragraph appears on a public-facing web page read by UK homeowners and journalists. It must be publish-ready with no editing.

DATA:
- Top job types by share of demand: ${indexData.topJobTypes.map(j => `${j.jobType} (${Math.round((j.count / indexData.totalEstimates) * 100)}%)`).join(', ')}
- Top regions by demand: ${indexData.topRegions.slice(0, 5).map(r => r.district).join(', ')}
- ${momContext}

RULES — follow every one without exception:
1. Output exactly two short paragraphs separated by a blank line. No title, no preamble, no sign-off.
2. Paragraph 1 (40 to 50 words): summarise the job type demand mix for the month. Lead with a percentage share from the data.
3. Paragraph 2 (40 to 50 words): cover regional demand and any month-on-month trend if previous data is available. End with one sentence relevant to homeowners planning a project.
4. Make definitive claims. No hedging. No "may suggest" or "could indicate".
5. No em dashes. Use commas or full stops instead.
6. No "it is worth noting", "importantly", "it is interesting", or similar filler phrases.
7. Plain British English. No jargon.
8. Do NOT mention specific cost or price figures, pound signs, monetary amounts, or raw estimate counts. Focus on demand patterns, job type mix, and regional trends only.`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 200,
    messages:   [{ role: 'user', content: prompt }],
  });

  return message.content[0].text.trim();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🗓  Cost Index Analyser starting...');

  console.log('✅ Running Cost Index build.');

  if (!process.env.MONGODB_URI)      throw new Error('MONGODB_URI env var not set');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY env var not set');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');

  const Estimate  = mongoose.model('Estimate',  estimateSchema);
  const CostIndex = mongoose.model('CostIndex', costIndexSchema);

  const { start, end } = getPreviousMonthRange();
  const monthLabel     = getMonthLabel(start);
  console.log(`📅 Building index for: ${monthLabel}`);

  // Overwrite any existing index for this month on each run
  const existing = await CostIndex.findOne({ monthStart: start });
  if (existing) {
    console.log(`♻️  Overwriting existing index for ${monthLabel}.`);
    await CostIndex.deleteOne({ monthStart: start });
  }

  // Fetch index data
  console.log('📊 Querying estimates...');
  const indexData = await fetchIndexData(Estimate, start, end);
  console.log(`✅ ${indexData.totalEstimates} estimates found for ${monthLabel}`);

  if (indexData.totalEstimates === 0) {
    console.warn('⚠️  Zero estimates found for this period — aborting to avoid publishing an empty index.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // Fetch previous month's index for MoM comparison
  const prevMonthStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
  const prevMonthData  = await CostIndex.findOne({ monthStart: prevMonthStart }).lean();
  if (prevMonthData) {
    console.log(`📊 Previous month data found: ${prevMonthData.monthLabel}`);
  } else {
    console.log('ℹ️  No previous month index found — commentary will not include MoM comparison.');
  }

  // Generate Claude commentary
  console.log('🤖 Generating commentary...');
  const commentary = await generateCommentary(indexData, monthLabel, prevMonthData);
  console.log('✅ Commentary generated');
  console.log('--- COMMENTARY PREVIEW ---');
  console.log(commentary);
  console.log('--------------------------');

  // Write to costindex collection
  const doc = new CostIndex({
    monthLabel,
    monthStart:           start,
    generatedAt:          new Date(),
    totalEstimates:       indexData.totalEstimates,
    topJobTypes:          indexData.topJobTypes,
    topRegions:           indexData.topRegions,
    labourMaterialsRatio: indexData.labourMaterialsRatio,
    commentary,
    prevMonthLabel:       prevMonthData?.monthLabel   ?? null,
    prevMonthTotals:      prevMonthData
      ? {
          totalEstimates: prevMonthData.totalEstimates,
          topJobType:     prevMonthData.topJobTypes?.[0]?.jobType ?? null,
          avgLabourPct:   prevMonthData.labourMaterialsRatio?.avgLabourPct ?? null,
        }
      : null,
  });

  await doc.save();
  console.log(`✅ Cost Index for ${monthLabel} saved to MongoDB`);

  await mongoose.disconnect();
  console.log('🎉 Done!');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
