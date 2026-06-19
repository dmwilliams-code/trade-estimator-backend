const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  // User Contact Information
  email: {
    type: String,
    required: [true, 'Email is required'],
    lowercase: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: props => `${props.value} is not a valid email address`
    }
  },
  
  // Project Details — all optional, not every lead source has these
  category: {
    type: String,
    required: false,
    enum: ['decoration', 'plumbing', 'electrical', 'outdoor', 'building', null],
    lowercase: true,
    default: null
  },
  
  jobType: {
    type: String,
    required: false,
    trim: true,
    default: null
  },
  
  jobName: {
    type: String,
    required: false,
    trim: true,
    default: null
  },
  
  quality: {
    type: String,
    enum: ['budget', 'standard', 'premium', 'luxury'],
    default: 'standard',
    lowercase: true
  },
  
  hasPhotos: {
    type: Boolean,
    default: false
  },

  userLocation: {
    type: String,
    default: null
  },
  
  // Lead Status Management
  status: {
    type: String,
    enum: ['new', 'contacted', 'converted', 'lost'],
    default: 'new',
    lowercase: true
  },
  
  // Source identifies where the lead came from:
  // 'web-app'            — original estimate email capture
  // 'pdf_download'       — EstimatePDF email gate
  // 'timeline_preview'   — Timeline free preview (removed, kept for legacy)
  // 'timeline_waitlist'  — Timeline Pro waitlist
  source: {
    type: String,
    default: 'web-app'
  },
  
  // Optional fields
  notes: {
    type: String,
    default: null
  },
  
  estimateValue: {
    type: Number,
    default: null
  },

  // A/B test variant assigned at session start — 'blur' or 'control'
  // Populated during blur gate experiment (Jun 2026). Null on pre-experiment leads.
  abVariant: {
    type: String,
    default: null
  },

  // ROI tool fields — populated when source is 'roi-tool'
  // propertyValue: self-reported or postcode-estimated property value in GBP
  // topRenovation: the highest-ranked renovation key at point of lead capture (e.g. 'loft-conversion')
  propertyValue: {
    type: Number,
    default: null
  },

  topRenovation: {
    type: String,
    default: null
  },
  
  contractorAssigned: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contractor',
    default: null
  },
  
  followUpDate: {
    type: Date,
    default: null
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt timestamp before saving
leadSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes for query performance
leadSchema.index({ email: 1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ status: 1 });
leadSchema.index({ source: 1 });
leadSchema.index({ category: 1, status: 1 });
leadSchema.index({ abVariant: 1 });

// Text index for searching
leadSchema.index({ email: 'text', jobName: 'text' });

const Lead = mongoose.model('Lead', leadSchema);

module.exports = Lead;
