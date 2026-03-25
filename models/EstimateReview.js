const mongoose = require('mongoose');

const EstimateReviewSchema = new mongoose.Schema({
  reviewId:    { type: String, required: true, unique: true },
  estimateId:  { type: String, required: true },
  rating:      { type: String, enum: ['low', 'accurate', 'high'], required: true },
  actualCost:  { type: Number, default: null },
  variance:    { type: Number, default: null },
  variancePct: { type: Number, default: null },
  comment:     { type: String, default: null },
  submittedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('EstimateReview', EstimateReviewSchema);
