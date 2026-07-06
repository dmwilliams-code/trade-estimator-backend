/**
 * EstimateAI — Job Feed Weekly Digest (Phase A / Concierge)
 * ==========================================================
 * Runs weekly. Emails Dan a plain digest of open jobs (type, district, band, age)
 * and current contractor registrations with matching districts/job types, so
 * jobs can be forwarded and claims recorded manually at this volume (Phase A,
 * per Job_Feed_Build_Spec.md section 6). No automated matching or claim logic
 * here yet — that is Phase B.
 *
 * SETUP:
 *   Uses mongoose, nodemailer (both already in the backend package.json)
 *
 * ENV VARS (all already present in Render environment):
 *   MONGODB_URI, SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT (optional, default 587)
 *
 * SCHEDULE (Render cron): suggested weekly, e.g. "0 7 * * 1" (Monday 7am, ahead
 * of the existing gsc-claude-analyser 8am Monday slot). Not yet registered in
 * render.yaml — cost-index-analyser.js and ga4-claude-analyser.js follow the
 * same pattern of being configured directly as separate cron services in the
 * Render dashboard rather than declared in render.yaml.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

// ─── MONGOOSE SCHEMAS (self-contained, mirrors the collections without pulling
//     in the full model files — same pattern as cost-index-analyser.js) ───────

const jobSchema = new mongoose.Schema({
  jobType:          String,
  category:         String,
  postcodeDistrict: String,
  region:           String,
  budgetBand:       String,
  qualityTier:      String,
  status:           String,
  createdAt:        Date,
}, { collection: 'jobs', strict: false });

const contractorRegistrationSchema = new mongoose.Schema({
  businessName:     String,
  contactName:      String,
  email:            String,
  postcode:         String,
  serviceDistricts: [String],
  jobTypes:         [String],
  status:           String,
  createdAt:        Date,
}, { collection: 'contractorregistrations', strict: false });

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function ageInDays(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function matchingRegistrations(job, registrations) {
  return registrations.filter(r =>
    r.jobTypes.includes(job.jobType) &&
    r.serviceDistricts.includes(job.postcodeDistrict)
  );
}

function buildDigestText(openJobs, registrations) {
  const lines = [];

  lines.push(`EstimateAI Job Feed — Weekly Digest`);
  lines.push(`Open jobs: ${openJobs.length} | Registered contractors: ${registrations.length}`);
  lines.push('');
  lines.push('--- OPEN JOBS ---');

  if (openJobs.length === 0) {
    lines.push('No open jobs this week.');
  } else {
    openJobs.forEach(job => {
      const matches = matchingRegistrations(job, registrations);
      const matchNames = matches.length > 0
        ? matches.map(m => `${m.businessName} <${m.email}>`).join(', ')
        : 'none yet';
      lines.push(
        `- ${job.jobType} | ${job.postcodeDistrict} (${job.region}) | ${job.budgetBand} | ` +
        `${ageInDays(job.createdAt)}d old | matching contractors: ${matchNames}`
      );
    });
  }

  lines.push('');
  lines.push('--- CONTRACTOR REGISTRATIONS ---');

  if (registrations.length === 0) {
    lines.push('No registrations yet.');
  } else {
    registrations.forEach(r => {
      lines.push(
        `- ${r.businessName} (${r.contactName}) <${r.email}> | ` +
        `districts: ${r.serviceDistricts.join(', ') || 'none set'} | ` +
        `job types: ${r.jobTypes.join(', ') || 'none set'} | status: ${r.status}`
      );
    });
  }

  return lines.join('\n');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('📋 Job Feed Digest starting...');

  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI env var not set');
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP_HOST, SMTP_USER and SMTP_PASS env vars must be set');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');

  const Job = mongoose.model('Job', jobSchema);
  const ContractorRegistration = mongoose.model('ContractorRegistration', contractorRegistrationSchema);

  const [openJobs, registrations] = await Promise.all([
    Job.find({ status: 'open' }).sort({ createdAt: -1 }).lean(),
    ContractorRegistration.find({}).sort({ createdAt: -1 }).lean(),
  ]);

  console.log(`✅ ${openJobs.length} open jobs, ${registrations.length} registrations`);

  const digestText = buildDigestText(openJobs, registrations);
  console.log('--- DIGEST PREVIEW ---');
  console.log(digestText);
  console.log('----------------------');

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: false
    }
  });

  await transporter.sendMail({
    from: `"EstimateAI" <${process.env.SMTP_USER}>`,
    to: process.env.SMTP_USER,
    subject: `Job Feed Digest — ${openJobs.length} open jobs, ${registrations.length} contractors`,
    text: digestText
  });

  console.log('✅ Digest email sent');

  await mongoose.disconnect();
  console.log('🎉 Done!');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
