// scripts/checkRegionSync.js
// Fails (exit 1) when the backend copy of regionalCostData.json has different
// region slugs or multipliers from the frontend copy. The frontend copy is the
// source of truth. Run locally before deploying either repo:
//   node scripts/checkRegionSync.js [path/to/frontend/src/regionalCostData.json]

const path = require('path');

const frontendPath = path.resolve(
  process.argv[2] || path.join(__dirname, '..', '..', 'trade-estimator', 'src', 'regionalCostData.json')
);
const backendPath = path.join(__dirname, '..', 'regionalCostData.json');

let frontend;
try {
  frontend = require(frontendPath);
} catch (err) {
  console.error(`Could not read the frontend copy at ${frontendPath}: ${err.message}`);
  process.exit(1);
}
const backend = require(backendPath);

const problems = [];
const backendBySlug = new Map(backend.regions.map((r) => [r.slug, r]));
const frontendSlugs = new Set(frontend.regions.map((r) => r.slug));

for (const region of frontend.regions) {
  const other = backendBySlug.get(region.slug);
  if (!other) problems.push(`missing on backend: ${region.slug}`);
  else if (other.multiplier !== region.multiplier) {
    problems.push(`multiplier differs for ${region.slug}: frontend ${region.multiplier}, backend ${other.multiplier}`);
  } else if (other.name !== region.name) {
    problems.push(`name differs for ${region.slug}: frontend "${region.name}", backend "${other.name}"`);
  }
}
for (const slug of backendBySlug.keys()) {
  if (!frontendSlugs.has(slug)) problems.push(`backend only: ${slug}`);
}
if (JSON.stringify(frontend.baseRates) !== JSON.stringify(backend.baseRates)) {
  problems.push('baseRates differ');
}

if (problems.length) {
  console.error(`Region data out of sync (${problems.length}):`);
  problems.forEach((p) => console.error(`  ${p}`));
  console.error('Fix: copy trade-estimator/src/regionalCostData.json over the backend copy.');
  process.exit(1);
}
console.log(`Region data in sync: ${frontend.regions.length} regions.`);
