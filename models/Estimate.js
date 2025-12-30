// models/Estimate.js
const mongoose = require('mongoose');

/**
 * Estimate Schema
 * Stores all user inputs and calculation results for each estimate
 */
const estimateSchema = new mongoose.Schema({
  // Job Details
  category: {
    type: String,
    required: true,
    enum: ['decoration', 'plumbing', 'electrical', 'outdoor']
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
    enum: ['room', 'sqm', 'unit']
  },
  
  // For room-based jobs
  roomCounts: {
    small: { type: Number, default: 0 },
    medium: { type: Number, default: 0 },
    large: { type: Number, default: 0 },
    extraLarge: { type: Number, default: 0 }
  },
  
  // For area/unit-based jobs
  areaQuantity: {
    type: Number,
    default: null
  },
  
  // Location
  userLocation: {
    type: String,
    required: true
  },
  locationData: {
    city: String,
    region: String,
    district: String,
    costMultiplier: Number,
    costReason: String
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
    detectedIssues: Boolean,
    materials: [{
      item: String,
      quantity: Number,
      unit: String,
      estimatedCost: Number
    }]
  },
  
  // Calculation Results
  estimate: {
    total: {
      type: Number,
      required: true
    },
    labour: {
      type: Number,
      required: true
    },
    materials: {
      type: Number,
      required: true
    },
    baseRate: Number,
    quantity: Number,
    unit: String,
    photoEnhanced: {
      type: Boolean,
      default: false
    },
    confidence: {
      type: Number,
      default: 60
    }
  },
  
  // Breakdown of multipliers applied
  multipliers: {
    quality: Number,
    location: Number,
    photo: Number
  },
  
  // Contractors recommended (optional - store just basic info)
  contractorsShown: [{
    name: String,
    rating: Number,
    totalReviews: Number,
    matchScore: Number
  }],
  
  // Metadata
  createdAt: {
    type: Date,
    default: Date.now
  },
  ipAddress: String,
  userAgent: String
  
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

// Indexes for common queries
estimateSchema.index({ createdAt: -1 }); // Sort by date
estimateSchema.index({ category: 1, jobType: 1 }); // Filter by job type
estimateSchema.index({ userLocation: 1 }); // Filter by location

// Virtual for total number of rooms (calculated field)
estimateSchema.virtual('totalRooms').get(function() {
  if (this.inputType === 'room') {
    return this.roomCounts.small + this.roomCounts.medium + 
           this.roomCounts.large + this.roomCounts.extraLarge;
  }
  return null;
});

// Method to get a summary
estimateSchema.methods.getSummary = function() {
  return {
    id: this._id,
    job: this.jobName,
    location: this.userLocation,
    total: `£${this.estimate.total.toFixed(2)}`,
    date: this.createdAt.toLocaleDateString()
  };
};

module.exports = mongoose.model('Estimate', estimateSchema);
