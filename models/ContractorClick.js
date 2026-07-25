const mongoose = require('mongoose');

// Contractor click schema -- one document per Call/Website/Map action
const contractorClickSchema = new mongoose.Schema({
  estimateId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Estimate', index: true },
  placeId:          { type: String, required: true, index: true },
  contractorName:   { type: String, required: true },
  actionType:       { type: String, enum: ['call', 'website', 'map', 'shown', 'contact_requested'], required: true },
  jobType:          { type: String },
  category:         { type: String },
  region:           { type: String },
  matchScore:       { type: Number },
  estimateValue:    { type: Number },        // estimate total at point of interaction
  postcodeDistrict: { type: String },        // outward code only, e.g. "SW1A"
  abVariant:        { type: String },        // blur/control from A/B test session
  leadId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null, index: true }, // joins to Leads collection, contact_requested only
  timestamp:        { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('ContractorClick', contractorClickSchema);
