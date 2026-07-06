// models/Job.js
// Anonymised job posting, created when a contact request carries Layer 2 (feed) consent.
// Identity lives on the referenced Lead record only - never duplicated here.

const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  jobType: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['decoration', 'plumbing', 'electrical', 'outdoor', 'building']
  },
  postcodeDistrict: {
    type: String,
    required: true,
    uppercase: true,
    trim: true
  },
  region: {
    type: String,
    required: true
  },
  budgetBand: {
    type: String,
    required: true,
    enum: ['under £5k', '£5k-15k', '£15k-40k', '£40k-80k', '£80k+']
  },
  qualityTier: {
    type: String,
    required: true,
    enum: ['budget', 'standard', 'premium', 'luxury']
  },
  leadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    required: true,
    index: true
  },
  estimateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Estimate',
    default: null
  },
  abVariant: {
    type: String,
    default: null
  },
  consent: {
    namedAt: { type: Date, required: true },
    feedAt: { type: Date, required: true },
    copyVersion: { type: String, required: true }
  },
  claims: [{
    registrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ContractorRegistration',
      required: true
    },
    claimedAt: {
      type: Date,
      default: Date.now
    }
  }],
  status: {
    type: String,
    enum: ['open', 'full', 'expired', 'withdrawn'],
    default: 'open'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true
  }
});

jobSchema.index({ status: 1, postcodeDistrict: 1, jobType: 1 });
jobSchema.index({ status: 1, region: 1, jobType: 1 });
jobSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Job', jobSchema);
