const express = require('express');
const router = express.Router();
const Lead = require('../models/LeadModel');
const Job = require('../models/Job');
const { sendWelcomeEmail } = require('../services/emailService');
const { bandForEstimateValue } = require('../utils/budgetBands');

const JOB_EXPIRY_DAYS = 30;

// ============================================
// POST /api/leads - Create new lead
// ============================================
router.post('/', async (req, res) => {
  try {
    const {
      email,
      category,
      jobType,
      jobName,
      quality,
      hasPhotos,
      source,
      userLocation,
      timestamp,
      estimateData,  // Optional estimate data to include in email
      contractors,   // Optional contractor list to include in email
      estimateValue, // Estimate total at point of lead capture
      abVariant,     // A/B test variant — 'blur' or 'control'
      propertyValue, // ROI tool: self-reported or postcode-estimated property value in GBP
      topRenovation, // ROI tool: highest-ranked renovation key (e.g. 'loft-conversion')
      estimateId,       // Job Feed: ref to the anonymous Estimate, for provenance only
      postcodeDistrict, // Job Feed: outward postcode district, e.g. 'LS6'
      region,           // Job Feed: region name, consistent with locationData.region elsewhere
      consent           // Job Feed: { namedAt, feedAt, copyVersion } — only sent by contact-request flow
    } = req.body;

    // Validation — only email is required
    // category/jobType are optional: PDF downloads and waitlist signups
    // don't have this context
    if (!email || !email.includes('@')) {
      return res.status(400).json({
        success: false,
        error: 'Valid email is required'
      });
    }

    // Create lead document
    const leadDocument = new Lead({
      email: email.toLowerCase().trim(),
      category: category ? category.toLowerCase() : undefined,
      jobType: jobType || undefined,
      jobName: jobName || undefined,
      quality: quality ? quality.toLowerCase() : 'standard',
      hasPhotos: hasPhotos || false,
      status: 'new',
      source: source || 'web-app',
      userLocation: userLocation || undefined,
      estimateValue: estimateValue || null,
      abVariant: abVariant || null,
      propertyValue: propertyValue || null,
      topRenovation: topRenovation || null,
      consent: consent ? {
        namedAt: consent.namedAt || null,
        feedAt: consent.feedAt || null,
        copyVersion: consent.copyVersion || null
      } : undefined,
      createdAt: timestamp ? new Date(timestamp) : new Date()
    });

    // Save to database
    const savedLead = await leadDocument.save();

    // Job Feed: a contact request with Layer 2 (feed) consent also becomes an
    // anonymised job posting. Best-effort — a Job creation failure must not
    // block the Lead response, since the Lead is the record of the homeowner's
    // request either way.
    if (consent?.feedAt && category && jobType && postcodeDistrict && region) {
      try {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + JOB_EXPIRY_DAYS);

        await Job.create({
          jobType,
          category: category.toLowerCase(),
          postcodeDistrict,
          region,
          budgetBand: bandForEstimateValue(estimateValue),
          qualityTier: quality ? quality.toLowerCase() : 'standard',
          leadId: savedLead._id,
          estimateId: estimateId || null,
          abVariant: abVariant || null,
          consent: {
            namedAt: consent.namedAt || new Date(),
            feedAt: consent.feedAt,
            copyVersion: consent.copyVersion || null
          },
          expiresAt
        });
        console.log('✅ Job posted to feed:', { leadId: savedLead._id, jobType, region });
      } catch (jobError) {
        console.error('❌ Job creation failed (Lead still saved):', jobError.message);
      }
    }

    console.log('✅ Lead captured:', {
      leadId: savedLead._id,
      email: savedLead.email,
      source: savedLead.source,
      jobName: savedLead.jobName,
      hasPhotos: savedLead.hasPhotos
    });

    // Send welcome email for all sources except explicitly excluded ones
    // Blocklist approach: add to noEmailSources to suppress, rather than maintaining a whitelist
    const noEmailSources = ['admin', 'test', 'dev'];
    if (!noEmailSources.includes(source)) {
      console.log('📤 Attempting to send welcome email to:', email);
      sendWelcomeEmail({ ...savedLead.toObject(), contractors: contractors || [] }, estimateData)
        .then((result) => {
          console.log('📧 Welcome email sent successfully!');
          console.log('   Email ID:', result.id);
          console.log('   Recipient:', email);
        })
        .catch(err => {
          console.error('❌ Email sending failed!');
          console.error('   Error:', err.message);
          console.error('   Full error:', err);
        });
    }

    // Return success immediately (don't wait for email)
    res.status(201).json({
      success: true,
      leadId: savedLead._id,
      message: 'Lead captured successfully'
    });

  } catch (error) {
    console.error('❌ Error creating lead:', error);
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: Object.keys(error.errors).map(key => ({
          field: key,
          message: error.errors[key].message
        }))
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to save lead',
      message: error.message
    });
  }
});

// ============================================
// GET /api/leads - Get all leads (admin only)
// ============================================
router.get('/', async (req, res) => {
  try {
    const { 
      status, 
      category,
      source,
      limit = 100, 
      skip = 0,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const filter = {};
    if (status) filter.status = status.toLowerCase();
    if (category) filter.category = category.toLowerCase();
    if (source) filter.source = source;

    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDirection };

    const leads = await Lead
      .find(filter)
      .sort(sortObj)
      .skip(parseInt(skip))
      .limit(parseInt(limit));

    const total = await Lead.countDocuments(filter);

    res.json({
      success: true,
      leads,
      total,
      limit: parseInt(limit),
      skip: parseInt(skip)
    });

  } catch (error) {
    console.error('❌ Error fetching leads:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch leads',
      message: error.message
    });
  }
});

// ============================================
// GET /api/leads/stats - Get lead statistics
// ============================================
router.get('/stats', async (req, res) => {
  try {
    const stats = await Lead.aggregate([
      {
        $facet: {
          total: [{ $count: 'count' }],
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } }
          ],
          byCategory: [
            { $group: { _id: '$category', count: { $sum: 1 } } }
          ],
          bySource: [
            { $group: { _id: '$source', count: { $sum: 1 } } }
          ],
          byQuality: [
            { $group: { _id: '$quality', count: { $sum: 1 } } }
          ],
          withPhotos: [
            { $match: { hasPhotos: true } },
            { $count: 'count' }
          ],
          recentLeads: [
            { $sort: { createdAt: -1 } },
            { $limit: 10 },
            { 
              $project: { 
                email: 1, 
                jobName: 1, 
                category: 1,
                source: 1,
                hasPhotos: 1,
                status: 1,
                createdAt: 1 
              } 
            }
          ],
          todayLeads: [
            {
              $match: {
                createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
              }
            },
            { $count: 'count' }
          ]
        }
      }
    ]);

    res.json({
      success: true,
      stats: stats[0]
    });

  } catch (error) {
    console.error('❌ Error fetching lead stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
      message: error.message
    });
  }
});

// ============================================
// GET /api/leads/:id - Get single lead
// ============================================
router.get('/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    res.json({ success: true, lead });

  } catch (error) {
    console.error('❌ Error fetching lead:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lead', message: error.message });
  }
});

// ============================================
// PATCH /api/leads/:id - Update lead
// ============================================
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, estimateValue, followUpDate } = req.body;

    const updateFields = { updatedAt: new Date() };

    if (status) {
      const validStatuses = ['new', 'contacted', 'converted', 'lost'];
      if (!validStatuses.includes(status.toLowerCase())) {
        return res.status(400).json({ success: false, error: 'Invalid status', validStatuses });
      }
      updateFields.status = status.toLowerCase();
    }
    
    if (notes !== undefined) updateFields.notes = notes;
    if (estimateValue !== undefined) updateFields.estimateValue = estimateValue;
    if (followUpDate !== undefined) updateFields.followUpDate = followUpDate;

    const lead = await Lead.findByIdAndUpdate(id, { $set: updateFields }, { new: true, runValidators: true });

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    console.log('✅ Lead updated:', { leadId: lead._id, status: lead.status, email: lead.email });
    res.json({ success: true, message: 'Lead updated successfully', lead });

  } catch (error) {
    console.error('❌ Error updating lead:', error);
    res.status(500).json({ success: false, error: 'Failed to update lead', message: error.message });
  }
});

// ============================================
// DELETE /api/leads/:id - Delete lead (GDPR)
// ============================================
router.delete('/:id', async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);

    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    console.log('🗑️ Lead deleted:', { leadId: lead._id, email: lead.email });
    res.json({ success: true, message: 'Lead deleted successfully' });

  } catch (error) {
    console.error('❌ Error deleting lead:', error);
    res.status(500).json({ success: false, error: 'Failed to delete lead', message: error.message });
  }
});

module.exports = router;
