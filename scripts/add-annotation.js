#!/usr/bin/env node
// scripts/add-annotation.js
// Shorthand for logging an annotation via the live /api/admin/annotations endpoint.
// Auto-truncates description to the schema's 300-char limit instead of round-tripping
// on a validation error.
//
// Usage:
//   node scripts/add-annotation.js path/to/entry.json
//   node scripts/add-annotation.js '{"type":"estimator","description":"..."}'
//
// entry.json shape (type and description required, the rest default to []):
// {
//   "type": "seo|cta|content|bug-fix|new-page|technical|estimator",
//   "description": "...",
//   "affectedUrls": ["/"],
//   "hypothesis": ["..."],
//   "filesChanged": ["..."]
// }

require('dotenv').config();
const fs = require('fs');

const DESCRIPTION_MAX = 300;

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/add-annotation.js <path-to-json | inline-json>');
    process.exit(1);
  }

  const raw = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg;
  const entry = JSON.parse(raw);

  if (!entry.type || !entry.description) {
    console.error('type and description are required');
    process.exit(1);
  }

  if (entry.description.length > DESCRIPTION_MAX) {
    const original = entry.description.length;
    entry.description = entry.description.slice(0, DESCRIPTION_MAX - 1) + '…';
    console.warn(`⚠️  Description truncated from ${original} to ${DESCRIPTION_MAX} chars`);
  }

  if (!process.env.REINDEX_SECRET) throw new Error('REINDEX_SECRET env var not set');
  const apiBase = process.env.ANNOTATIONS_API_BASE || 'https://api.getestimateai.co.uk';

  const response = await fetch(`${apiBase}/api/admin/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-reindex-secret': process.env.REINDEX_SECRET },
    body: JSON.stringify(entry)
  });

  const body = await response.json();
  if (!response.ok) {
    console.error('❌ Failed:', JSON.stringify(body));
    process.exit(1);
  }

  console.log('✅ Annotation saved:', body.annotationId);
  console.log(JSON.stringify(body.annotation, null, 2));
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
