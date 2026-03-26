const mongoose = require('mongoose');

const blogSubscriberSchema = new mongoose.Schema(
  {
    email:  { type: String, required: true, unique: true, trim: true, lowercase: true },
    name:   { type: String, trim: true, default: '' },
    source: { type: String, default: 'blog' },   // 'blog' always for now; extensible later
    post:   { type: String, default: null },      // Slug of the post where they subscribed
  },
  {
    timestamps: true,  // createdAt + updatedAt auto-managed
  }
);

blogSubscriberSchema.index({ email: 1 }, { unique: true });
blogSubscriberSchema.index({ source: 1 });
blogSubscriberSchema.index({ post: 1 });

module.exports = mongoose.model('BlogSubscriber', blogSubscriberSchema);
