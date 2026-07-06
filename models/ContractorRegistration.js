// models/ContractorRegistration.js
// Interest registrations from /for-contractors. Reviewed manually at v1 - no dashboard, no auto-approval.
// Google Places data plays no role here - inbound registration only.

const mongoose = require('mongoose');

const contractorRegistrationSchema = new mongoose.Schema({
  businessName: {
    type: String,
    required: true,
    trim: true
  },
  contactName: {
    type: String,
    required: true,
    trim: true
  },
  companiesHouseNumber: {
    type: String,
    default: null,
    trim: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: props => `${props.value} is not a valid email address`
    }
  },
  postcode: {
    type: String,
    required: true,
    trim: true
  },
  serviceDistricts: {
    type: [String],
    default: []
  },
  jobTypes: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

contractorRegistrationSchema.index({ status: 1 });
contractorRegistrationSchema.index({ serviceDistricts: 1, jobTypes: 1 });
contractorRegistrationSchema.index({ email: 1 });

module.exports = mongoose.model('ContractorRegistration', contractorRegistrationSchema);
