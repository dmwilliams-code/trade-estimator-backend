// models/Annotation.js
// Tracks deliberate changes made to the site so future GSC/GA4 analysis
// has context to distinguish organic ranking movements from intervention effects.

const mongoose = require('mongoose');

const annotationSchema = new mongoose.Schema({

  // When the change was made (defaults to now, but can be backdated)
  date: {
    type: Date,
    required: true,
    default: Date.now
  },

  // Broad category of change
  type: {
    type: String,
    required: true,
    enum: [
      'seo',          // Title, meta description, schema, canonical changes
      'cta',          // CTA copy, placement, links, widget changes
      'content',      // Article edits, new sections, data updates
      'bug-fix',      // Fixes that may have suppressed metrics (e.g. save pipeline)
      'new-page',     // New article, regional page, tool page
      'technical',    // Performance, redirect, sitemap, indexing changes
      'estimator',    // Estimator UI, job types, pricing, flow changes
    ]
  },

  // Short description — used as the headline in analysis context
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: 300
  },

  // Which URLs are directly affected (optional but useful for GSC correlation)
  affectedUrls: {
    type: [String],
    default: []
  },

  // What metric(s) this change is expected to move
  // e.g. ['CTR', 'estimate completions', 'impressions']
  hypothesis: {
    type: [String],
    default: []
  },

  // Retrospective outcome — filled in during a later analysis session
  outcome: {
    type: String,
    default: null,
    trim: true,
    maxlength: 500
  },

  // Optional: which file(s) were changed — helpful for cross-referencing deploys
  filesChanged: {
    type: [String],
    default: []
  }

}, {
  timestamps: true // createdAt, updatedAt
});

// Indexes for the queries the analysis script will run
annotationSchema.index({ date: -1 });
annotationSchema.index({ type: 1 });
annotationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Annotation', annotationSchema);
