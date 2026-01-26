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
  
  // Project Details
  category: {
    type: String,
    required: [true, 'Category is required'],
    enum: ['decoration', 'plumbing', 'electrical', 'outdoor'],
    lowercase: true
  },
  
  jobType: {
    type: String,
    required: [true, 'Job type is required'],
    trim: true
  },
  
  jobName: {
    type: String,
    required: [true, 'Job name is required'],
    trim: true
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
  
  // Lead Status Management
  status: {
    type: String,
    enum: ['new', 'contacted', 'converted', 'lost'],
    default: 'new',
    lowercase: true
  },
  
  // Tracking Information
  source: {
    type: String,
    default: 'web-app'
  },
  
  // Optional fields for future use
  notes: {
    type: String,
    default: null
  },
  
  estimateValue: {
    type: Number,
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

// Indexes for better query performance
leadSchema.index({ email: 1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ status: 1 });
leadSchema.index({ category: 1, status: 1 });

// Text index for searching
leadSchema.index({ 
  email: 'text', 
  jobName: 'text'
});

const Lead = mongoose.model('Lead', leadSchema);

module.exports = Lead;
