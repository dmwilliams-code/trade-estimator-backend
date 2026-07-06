const express = require('express');
const router = express.Router();
const ContractorRegistration = require('../models/ContractorRegistration');

// ============================================
// POST /api/contractor-registrations - Founding member interest form (/for-contractors)
// No auto-reply email - reviewed manually at v1, per project decision.
// ============================================
router.post('/', async (req, res) => {
  try {
    const {
      businessName,
      contactName,
      companiesHouseNumber,
      email,
      postcode,
      serviceDistricts,
      jobTypes
    } = req.body;

    if (!businessName || !contactName || !email || !postcode) {
      return res.status(400).json({
        success: false,
        error: 'businessName, contactName, email and postcode are required'
      });
    }

    const registration = new ContractorRegistration({
      businessName: businessName.trim(),
      contactName: contactName.trim(),
      companiesHouseNumber: companiesHouseNumber ? companiesHouseNumber.trim() : null,
      email: email.toLowerCase().trim(),
      postcode: postcode.trim(),
      serviceDistricts: Array.isArray(serviceDistricts) ? serviceDistricts.map(d => d.toUpperCase().trim()) : [],
      jobTypes: Array.isArray(jobTypes) ? jobTypes : []
    });

    const saved = await registration.save();

    console.log('✅ Contractor registration captured:', {
      registrationId: saved._id,
      businessName: saved.businessName,
      serviceDistricts: saved.serviceDistricts
    });

    res.status(201).json({
      success: true,
      registrationId: saved._id
    });

  } catch (error) {
    console.error('❌ Error creating contractor registration:', error);

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
      error: 'Failed to save registration',
      message: error.message
    });
  }
});

module.exports = router;
