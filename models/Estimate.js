// models/Estimate.js
// ANONYMOUS VERSION - No Personal Data Collected
// UPDATED: roomCounts → projectSize migration

const mongoose = require('mongoose');

const estimateSchema = new mongoose.Schema({
  // Job Details
  category: {
    type: String,
    required: true,
    enum: ['decoration', 'plumbing', 'electrical', 'outdoor', 'building']
  },
  jobType: {
    type: String,
    required: true
  },
  jobName: {
    type: String,
    required: true
  },
  
  // Input Details - Room-based or Area-based
  inputType: {
    type: String,
    required: true,
    enum: ['room', 'sqm', 'area', 'unit']  // 'sqm' is what the frontend sends for area-based jobs
  },
  
  // UPDATED: Single project size field (replaces roomCounts)
  projectSize: {
    type: String,
    enum: ['small', 'medium', 'large', 'extra-large'],
    default: null
  },
  
  // For area/unit-based jobs
  areaQuantity: {
    type: Number,
    default: null
  },
  
  // Location (ANONYMIZED - hashed postcode)
  locationHash: {
    type: String,
    default: null,
    index: true
  },
  locationData: {
    region: String,          // Just "London", "Manchester", etc.
    costMultiplier: Number,
    costReason: String
    // NO: city, district, postcode, or specific location
  },
  
  // Quality Selection
  quality: {
    type: String,
    required: true,
    enum: ['budget', 'standard', 'premium', 'luxury'],
    default: 'standard'
  },
  
  // Photo Analysis (if photos were uploaded)
  photoAnalysis: {
    adjustment: Number,
    confidence: Number,
    insights: [String],
    detectedIssues: [String],  // Changed from Boolean to match frontend
    materials: [String]        // Simplified to match frontend
  },
  
  // Calculation Results — matches what App.js sends from computeEstimate()
  estimate: {
    total: Number,            // Final cost after all multipliers
    labour: Number,           // Labour portion
    materials: Number,        // Materials portion
    baseRate: Number,         // Base rate for the job
    quantity: Number,         // Rooms, sqm, or 1 for unit jobs
    unit: String,             // 'room', 'sqm', or 'unit'
    confidence: Number,       // Confidence score 0-100
    photoEnhanced: {
      type: Boolean,
      default: false
    }
  },
  
  // Breakdown of multipliers applied - UPDATED to match frontend
  multipliers: mongoose.Schema.Types.Mixed,  // Allow flexible structure from frontend
  
  // Contractors recommended (public business data - not personal)
  contractorsShown: [{
    name: String,
    rating: Number,
    totalReviews: Number,
    matchScore: Number
  }],
  
  // Source — which article/page the estimate originated from (via ?ref= param)
  source: {
    type: String,
    default: null,
    trim: true
  }

  // REMOVED FIELDS (were personal data):
  // ipAddress: REMOVED
  // userAgent: REMOVED
  // userLocation (actual postcode): REMOVED (using locationHash instead)
  // roomCounts: REMOVED (replaced with projectSize)
  
}, {
  timestamps: true // createdAt and updatedAt are fine (not personal by themselves)
});

// Indexes for common queries
estimateSchema.index({ createdAt: -1 }); // Sort by date
estimateSchema.index({ category: 1, jobType: 1 }); // Filter by job type
estimateSchema.index({ 'locationData.region': 1 }); // Filter by region
estimateSchema.index({ projectSize: 1 }); // Filter by project size
estimateSchema.index({ source: 1 });       // Filter by source article

// Virtual for easy display of project size
estimateSchema.virtual('projectSizeDisplay').get(function() {
  if (!this.projectSize) return null;
  
  const sizeMap = {
    'small': 'Small',
    'medium': 'Medium',
    'large': 'Large',
    'extra-large': 'Extra Large'
  };
  
  return sizeMap[this.projectSize] || this.projectSize;
});

// Method to get a summary
estimateSchema.methods.getSummary = function() {
  return {
    id: this._id,
    job: this.jobName,
    projectSize: this.projectSizeDisplay,
    region: this.locationData?.region || 'Unknown',
    estimateTotal: this.estimate?.total
      ? `£${this.estimate.total.toLocaleString()}`
      : 'N/A',
    date: this.createdAt.toLocaleDateString()
  };
};

module.exports = mongoose.model('Estimate', estimateSchema);
