require('dotenv').config();
const crypto = require('crypto'); // Built into Node.js
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { Client } = require('@googlemaps/google-maps-services-js');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const mongoSanitize = require('express-mongo-sanitize');
const helmet = require('helmet');

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    // Don't exit process - app can still run without database
    console.log('⚠️  App running without database functionality');
  }
};

// Connect to database
connectDB();

// Daily Usage Schema for tracking global estimates
const dailyUsageSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true }, // Format: YYYY-MM-DD
  totalEstimates: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const DailyUsage = mongoose.model('DailyUsage', dailyUsageSchema);


const app = express();
const port = process.env.PORT || 3001;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Google Places client
const googlePlacesClient = new Client({});
let searchResults;

function hashPostcode(postcode) {
     if (!postcode || typeof postcode !== 'string') {
       return null;
     }
     const normalized = postcode.toUpperCase().replace(/\s+/g, '');
     return crypto.createHash('sha256')
       .update(normalized)
       .digest('hex')
       .substring(0, 16);
   }

// Get or create today's usage record
async function getTodayUsage() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  try {
    let usage = await DailyUsage.findOne({ date: today });
    
    if (!usage) {
      usage = await DailyUsage.create({ date: today, totalEstimates: 0 });
      console.log(`📊 Created new usage record for ${today}`);
    }
    
    return usage;
  } catch (error) {
    console.error('Error getting today usage:', error);
    // Return a default object if DB is unavailable
    return { date: today, totalEstimates: 0 };
  }
}

// Check if global daily limit is reached
async function checkGlobalLimit() {
  const DAILY_LIMIT = 100;
  
  try {
    const usage = await getTodayUsage();
    
    return {
      limitReached: usage.totalEstimates >= DAILY_LIMIT,
      current: usage.totalEstimates,
      limit: DAILY_LIMIT,
      remaining: Math.max(0, DAILY_LIMIT - usage.totalEstimates)
    };
  } catch (error) {
    console.error('Error checking global limit:', error);
    // If DB fails, allow request (fail open)
    return { limitReached: false, current: 0, limit: DAILY_LIMIT, remaining: DAILY_LIMIT };
  }
}

// Increment global usage counter
async function incrementGlobalUsage() {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const usage = await DailyUsage.findOneAndUpdate(
      { date: today },
      { $inc: { totalEstimates: 1 } },
      { new: true, upsert: true }
    );
    
    console.log(`📈 Global usage: ${usage.totalEstimates}/100 estimates used today`);
    return usage.totalEstimates;
  } catch (error) {
    console.error('Error incrementing global usage:', error);
    return 0;
  }
}

// Middleware
app.use(cors({
  origin: [
    'https://getestimateai.co.uk',
    'https://www.getestimateai.co.uk',
    'http://localhost:3000',  // For local development
    'http://localhost:3001'   // For local development
  ],
  methods: ['GET', 'POST'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '10mb' }));
app.use(mongoSanitize());

app.use(helmet({
  contentSecurityPolicy: false, // Disable if causing CORS issues
  crossOriginEmbedderPolicy: false
}));

// Rate limiter: Prevents abuse by limiting requests per IP
// GDPR compliant: Legitimate interest (Article 6(1)(f))
// Stores IP + count for 60 seconds only
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 5, // Maximum 5 requests per minute per IP
  message: {
    error: 'Too many requests',
    message: 'Please wait a moment before trying again. Maximum 5 requests per minute.'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Skip rate limiting for health check
  skip: (req) => req.path === '/',
  // Custom key generator (uses IP address)
  keyGenerator: (req) => {
    // Get IP from various possible headers (for proxies/load balancers)
    return req.ip || 
           req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress;
  }
});

const photoAnalysisLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // Only 3 photo analysis requests per minute
  message: {
    error: 'Too many photo analysis requests',
    message: 'Please wait before analyzing more photos. Maximum 3 analyses per minute.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || 
           req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress;
  }
});

// Apply rate limiter to all API routes
app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Trade Estimator API is running' });
});

// Photo analysis endpoint
// Single GPT-4o call with 3 high-detail images
// No batching, no mini model, no complexity - just clean and fast
// ====================================================================

app.post('/api/analyze-photos', photoAnalysisLimiter, async (req, res) => {
  try {
    const { images, jobType } = req.body;

    if (!images || images.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    if (images.length > 3) {
      return res.status(400).json({ error: 'Maximum 3 images allowed' });
    }

        // VALIDATION
    if (!images || !Array.isArray(images)) {
      return res.status(400).json({ error: 'Invalid images data' });
    }

    if (!jobType || typeof jobType !== 'string' || jobType.length > 200) {
      return res.status(400).json({ error: 'Invalid job type' });
    }

    if (images.length === 0 || images.length > 3) {
      return res.status(400).json({ error: 'Invalid number of images (1-3)' });
    }

    // Validate each image is a valid data URL
    for (const img of images) {
      if (!img.data || !img.data.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Invalid image format' });
      }
      
      // Check image size (prevent huge uploads)
      if (img.data.length > 10 * 1024 * 1024) { // 10MB limit
        return res.status(400).json({ error: 'Image too large' });
      }
    }

    console.log(`Analyzing ${images.length} photos for ${jobType}`);
    const startTime = Date.now();

    // Process 3 images with HIGH detail for 100% accuracy
    const imageMessages = images.slice(0, 3).map(img => ({
      type: "image_url",
      image_url: {
        url: img.data,
        detail: "high"
      }
    }));

    const prompt = `You are an expert construction, decoration, repair and renovation estimator. Analyse these photos of a ${jobType} project.

Please evaluate and provide your assessment as JSON with this exact structure:
{
  "complexity": 1.05,
  "condition": 0.95,
  "access": 1.0,
  "materialQuality": 1.0,
  "insights": ["insight 1", "insight 2", "insight 3"],
  "detectedIssues": ["issue1", "issue2"],
  "materials": ["material1", "material2"]
}

Each multiplier should be between 0.7 (much easier/cheaper) and 1.5 (much harder/expensive):
- complexity: Job difficulty (prep work, special skills needed)
- condition: Current state (good = lower, poor = higher)
- access: How difficult to reach/work on
- materialQuality: What's currently there or needed

Insights should be specific, helpful observations about the space.
DetectedIssues should note any visible problems that will affect cost.
Materials should list what appears to be needed or present.

Return ONLY valid JSON, no other text.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imageMessages
          ]
        }
      ],
      max_tokens: 1000,
      temperature: 0.3
    });

    const responseText = completion.choices[0].message.content.trim();
    
    let analysis;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      console.error('Raw response:', responseText);
      
      return res.status(500).json({
        error: 'Failed to parse AI response',
        fallback: true,
        adjustment: 1.0,
        confidence: 0,
        insights: ['AI analysis encountered an error. Using standard estimate.']
      });
    }

    const avgMultiplier = (
      (analysis.complexity || 1) +
      (analysis.condition || 1) +
      (analysis.access || 1) +
      (analysis.materialQuality || 1)
    ) / 4;

    const confidence = Math.round((1 - Math.abs(1 - avgMultiplier)) * 100);

    const result = {
      adjustment: Math.round(avgMultiplier * 100) / 100,
      confidence: Math.min(95, Math.max(60, confidence)),
      insights: analysis.insights || [],
      detectedIssues: analysis.detectedIssues || [],
      materials: analysis.materials || []
    };

    const duration = Date.now() - startTime;
    console.log(`✅ Analysis complete in ${duration}ms`);
    console.log(`   Adjustment: ${result.adjustment}x`);
    console.log(`   Confidence: ${result.confidence}%`);

    res.json(result);

  } catch (error) {
    console.error('Photo analysis error:', error);
    res.status(500).json({
      error: 'Analysis failed',
      fallback: true,
      adjustment: 1.0,
      confidence: 0,
      insights: ['Unable to analyze photos. Using standard estimate.']
    });
  }
});

// Location cost lookup endpoint
app.post('/api/location-cost', async (req, res) => {
  try {
    const { postcode } = req.body;

    if (!postcode || typeof postcode !== 'string') {
      return res.status(400).json({ error: 'Invalid postcode' });
    }

    // Validate postcode format (basic UK postcode pattern)
    const postcodePattern = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}$/i;
    if (!postcodePattern.test(postcode.trim())) {
      return res.status(400).json({ error: 'Invalid UK postcode format' });
    }

    console.log('🔍 Looking up location cost for:', postcode);

    // Use Geocoding API
    const geocodeResponse = await googlePlacesClient.geocode({
      params: {
        address: postcode,
        key: process.env.GOOGLE_PLACES_API_KEY,
        region: 'uk'
      }
    });

    if (!geocodeResponse.data.results || geocodeResponse.data.results.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const location = geocodeResponse.data.results[0];
    const addressComponents = location.address_components;

    // Extract location details
    let city = '';
    let region = '';
    let country = '';

    addressComponents.forEach(component => {
      if (component.types.includes('postal_town')) {
        city = component.long_name;
      }
      if (component.types.includes('administrative_area_level_2')) {
        region = component.long_name;
      }
      if (component.types.includes('country')) {
        country = component.long_name;
      }
    });

    // Determine cost multiplier based on location
    let costMultiplier = 1.0;
    let costReason = 'Average UK location';

    const locationLower = `${city} ${region}`.toLowerCase();

    if (locationLower.includes('london') || locationLower.includes('greater london')) {
      costMultiplier = 1.45;
      costReason = 'London premium - higher labour and material costs';
      region = 'London';
    } else if (
      locationLower.includes('cambridge') ||
      locationLower.includes('oxford') ||
      locationLower.includes('brighton') ||
      locationLower.includes('bath')
    ) {
      costMultiplier = 1.25;
      costReason = 'High-cost area - above average pricing';
    } else if (
      locationLower.includes('manchester') ||
      locationLower.includes('birmingham') ||
      locationLower.includes('edinburgh') ||
      locationLower.includes('bristol') ||
      locationLower.includes('glasgow')
    ) {
      costMultiplier = 1.1;
      costReason = 'Major city - slightly higher costs';
    } else if (
      locationLower.includes('newcastle') ||
      locationLower.includes('liverpool') ||
      locationLower.includes('sheffield') ||
      locationLower.includes('leeds')
    ) {
      costMultiplier = 0.95;
      costReason = 'Regional city - competitive pricing';
    } else {
      costMultiplier = 1.0;
      costReason = 'Standard UK pricing';
    }

    const result = {
      costMultiplier: Math.round(costMultiplier * 100) / 100,
      costReason,
      city,
      region: region || city,
      country
    };

    console.log('📍 Location cost result:', result);

    res.json(result);

  } catch (error) {
    console.error('Location cost lookup error:', error);
    res.status(500).json({
      error: 'Failed to lookup location cost',
      fallback: true,
      costMultiplier: 1.0,
      costReason: 'Unable to determine location - using standard UK pricing'
    });
  }
});

// Search contractors endpoint
app.post('/api/search-contractors', async (req, res) => {
  try {
    const { jobType, userLocation } = req.body;

    if (!jobType || !userLocation) {
      return res.status(400).json({ error: 'Job type and location are required' });
    }

    console.log(`🔍 Searching for ${jobType} contractors near ${userLocation}`);

    // First, geocode the location to get coordinates
    const geocodeResponse = await googlePlacesClient.geocode({
      params: {
        address: userLocation,
        key: process.env.GOOGLE_PLACES_API_KEY,
        region: 'uk'
      }
    });

    if (!geocodeResponse.data.results || geocodeResponse.data.results.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const location = geocodeResponse.data.results[0].geometry.location;
    
    // Also get location cost data for this location
    const addressComponents = geocodeResponse.data.results[0].address_components;
    let city = '';
    let region = '';

    addressComponents.forEach(component => {
      if (component.types.includes('postal_town')) {
        city = component.long_name;
      }
      if (component.types.includes('administrative_area_level_2')) {
        region = component.long_name;
      }
    });

    // Determine cost multiplier
    let costMultiplier = 1.0;
    let costReason = 'Average UK location';
    const locationLower = `${city} ${region}`.toLowerCase();

    if (locationLower.includes('london') || locationLower.includes('greater london')) {
      costMultiplier = 1.45;
      costReason = 'London premium - higher labour and material costs';
      region = 'London';
    } else if (
      locationLower.includes('cambridge') ||
      locationLower.includes('oxford') ||
      locationLower.includes('brighton') ||
      locationLower.includes('bath')
    ) {
      costMultiplier = 1.25;
      costReason = 'High-cost area - above average pricing';
    } else if (
      locationLower.includes('manchester') ||
      locationLower.includes('birmingham') ||
      locationLower.includes('edinburgh') ||
      locationLower.includes('bristol') ||
      locationLower.includes('glasgow')
    ) {
      costMultiplier = 1.1;
      costReason = 'Major city - slightly higher costs';
    } else if (
      locationLower.includes('newcastle') ||
      locationLower.includes('liverpool') ||
      locationLower.includes('sheffield') ||
      locationLower.includes('leeds')
    ) {
      costMultiplier = 0.95;
      costReason = 'Regional city - competitive pricing';
    }

    const locationDetails = {
      costMultiplier: Math.round(costMultiplier * 100) / 100,
      costReason,
      region: region || city
    };

    console.log('📍 Location details:', locationDetails);

    // Build search query
    const fullQuery = `${jobType} contractor`;
    
    console.log(`Searching: "${fullQuery}" near ${location.lat}, ${location.lng}`);

    // Search for contractors
    const response = await googlePlacesClient.placesNearby({
      params: {
        location: `${location.lat},${location.lng}`,
        radius: 16000, // 16km radius (10 miles)
        keyword: fullQuery,
        key: process.env.GOOGLE_PLACES_API_KEY
      }
    });

    console.log(`Found ${response.data.results.length} initial results`);

    if (response.data.results.length === 0) {
      return res.json({
        contractors: [],
        searchQuery: fullQuery,
        totalFound: 0,
        filters: { relaxed: false },
        locationData: locationDetails
      });
    }

    // Filter and process results
    let contractors = response.data.results
      .filter(place => {
        const hasRating = place.rating && place.rating >= 3.5;
        const hasReviews = place.user_ratings_total && place.user_ratings_total >= 5;
        return hasRating && hasReviews;
      })
      .map(place => ({
        name: place.name,
        address: place.vicinity || place.formatted_address || 'Address not available',
        rating: place.rating || 0,
        totalReviews: place.user_ratings_total || 0,
        types: place.types || [],
        location: place.geometry?.location,
        placeId: place.place_id,
        phoneNumber: place.formatted_phone_number || null,
        website: place.website || null,
        openNow: place.opening_hours?.open_now || false
      }));

    console.log(`After filtering: ${contractors.length} contractors`);

    let filtersUsed = { relaxed: false };

    if (contractors.length < 3) {
      console.log('Not enough results, relaxing filters...');
      contractors = response.data.results
        .filter(place => place.rating && place.rating >= 3.0)
        .map(place => ({
          name: place.name,
          address: place.vicinity || place.formatted_address || 'Address not available',
          rating: place.rating || 0,
          totalReviews: place.user_ratings_total || 0,
          types: place.types || [],
          location: place.geometry?.location,
          placeId: place.place_id,
          phoneNumber: place.formatted_phone_number || null,
          website: place.website || null,
          openNow: place.opening_hours?.open_now || false
        }));
      filtersUsed.relaxed = true;
      console.log(`After relaxing: ${contractors.length} contractors`);
    }

    // Score and rank contractors
    const searchQuery = jobType.toLowerCase();
    const scoredContractors = contractors.map(contractor => {
  let score = 0;
  const breakdown = {};
  
  // 1. Rating weight (35%) - High ratings matter
  const ratingScore = (contractor.rating / 5) * 35;
  score += ratingScore;
  breakdown.rating = ratingScore.toFixed(1);
  
  // 2. Review count weight (25%) - More reviews = more reliable
  // Logarithmic scale - diminishing returns after 100 reviews
  const reviewScore = Math.min(Math.log10(contractor.totalReviews + 1) / 2, 1) * 25;
  score += reviewScore;
  breakdown.reviews = reviewScore.toFixed(1);
  
  // 3. Relevance weight (20%) - Does name/types match job?
  let relevanceScore = 0;
  const nameAndTypes = `${contractor.name} ${contractor.types.join(' ')}`.toLowerCase();
  const jobKeywords = searchQuery.toLowerCase().split(' ');
  
  jobKeywords.forEach(keyword => {
    if (nameAndTypes.includes(keyword)) {
      relevanceScore += 5;
    }
  });
  relevanceScore = Math.min(relevanceScore, 20);
  score += relevanceScore;
  breakdown.relevance = relevanceScore.toFixed(1);
  
  // 4. Active/Open weight (10%)
  const activeScore = contractor.openNow ? 10 : 0;
  score += activeScore;
  breakdown.active = activeScore.toFixed(1);
  
  // 5. Professional presence (10%) - Website + multiple contact methods
  let professionalScore = 0;
  if (contractor.website) professionalScore += 5;
  if (contractor.phoneNumber) professionalScore += 5;
  score += professionalScore;
  breakdown.professional = professionalScore.toFixed(1);
  
  return {
    ...contractor,
    matchScore: Math.round(score),
    scoreBreakdown: breakdown
  };
});

    // Sort by match score
    scoredContractors.sort((a, b) => b.matchScore - a.matchScore);

// Return top 5 contractors
res.json({
  contractors: scoredContractors.slice(0, 5),
  searchQuery: fullQuery,
  totalFound: response.data.results.length,
  filters: filtersUsed,
  locationData: locationDetails
});

  } catch (error) {
    console.error('Contractor search error:', error);
    res.status(500).json({ 
      error: 'Failed to search contractors',
      message: 'Unable to fetch contractors. Please try again.' 
    });
  }
});

const Estimate = require('./models/Estimate');

// UPDATED: Save estimate endpoint - handles both projectSize and quantity
app.post('/api/save-estimate', async (req, res) => {
  try {
    const {
      category,
      jobType,
      jobName,
      inputType,
      projectSize,      // For room-based jobs
      areaQuantity,     // For area/unit/quantity-based jobs
      userLocation,
      locationData,
      quality,
      photoAnalysis,
      estimate,
      multipliers,
      contractors
    } = req.body;

    // Validation
    if (!category || !jobType || !estimate) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['category', 'jobType', 'estimate']
      });
    }

    // Validate projectSize for room-based jobs
    if (inputType === 'room' && !projectSize) {
      return res.status(400).json({
        error: 'Project size is required for room-based jobs',
        required: ['projectSize']
      });
    }

    // Validate projectSize enum
    const validSizes = ['small', 'medium', 'large', 'extra-large'];
    if (projectSize && !validSizes.includes(projectSize)) {
      return res.status(400).json({
        error: 'Invalid project size',
        validSizes: validSizes
      });
    }

    // UPDATED: Validate areaQuantity for area/unit/quantity-based jobs
    if ((inputType === 'area' || inputType === 'unit' || inputType === 'sqm' || inputType === 'quantity') && (!areaQuantity || areaQuantity <= 0)) {
      return res.status(400).json({
        error: 'Area/quantity is required for non-room-based jobs',
        required: ['areaQuantity']
      });
    }

    // Hash the postcode (ANONYMIZATION)
    const locationHash = hashPostcode(userLocation);
    
    console.log('🔒 Anonymizing postcode:');
    console.log('  Original:', userLocation);
    console.log('  Hashed:', locationHash);

    // Create new estimate document with ANONYMOUS data
    const newEstimate = new Estimate({
      // Job details
      category,
      jobType,
      jobName,
      inputType,
      
      // Input details - UPDATED to handle quantity
      projectSize: projectSize || null,
      areaQuantity: areaQuantity || null,
      
      // Location (ANONYMIZED)
      locationHash: locationHash,
      locationData: {
        region: locationData?.region,
        costMultiplier: locationData?.costMultiplier,
        costReason: locationData?.costReason
      },
      
      // Quality
      quality,
      
      // Photo analysis
      photoAnalysis: photoAnalysis ? {
        adjustment: photoAnalysis.adjustment,
        confidence: photoAnalysis.confidence,
        insights: photoAnalysis.insights,
        detectedIssues: photoAnalysis.detectedIssues,
        materials: photoAnalysis.materials
      } : null,
      
      // Estimate results
      estimate,
      
      // Multipliers
      multipliers,
      
      // Contractors (top 5 only - public business data)
      contractorsShown: contractors ? contractors.slice(0, 5).map(c => ({
        name: c.name,
        rating: c.rating,
        totalReviews: c.totalReviews,
        matchScore: c.matchScore
      })) : []
    });

    // Save to database
    const savedEstimate = await newEstimate.save();
    
    console.log('💾 Estimate saved (anonymous):', savedEstimate._id);
    console.log('   Category:', savedEstimate.category);
    console.log('   Job Type:', savedEstimate.jobType);
    console.log('   Input Type:', savedEstimate.inputType);
    console.log('   Project Size:', savedEstimate.projectSize);
    console.log('   Area/Quantity:', savedEstimate.areaQuantity);
    console.log('   Region:', savedEstimate.locationData?.region);
    console.log('   Location hash:', savedEstimate.locationHash);

    res.json({
      success: true,
      estimateId: savedEstimate._id,
      message: 'Estimate saved successfully',
      anonymous: true
    });

  } catch (error) {
    console.error('❌ Error saving estimate:', error);
    
    // Provide detailed error for validation failures
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation failed',
        details: Object.keys(error.errors).map(key => ({
          field: key,
          message: error.errors[key].message
        }))
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to save estimate',
      message: 'Unable to save your estimate. Please try again.'
    });
  }
});

// Get recent estimates (for analytics)
app.get('/api/estimates', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const estimates = await Estimate.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    res.json({ estimates, count: estimates.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch estimates' });
  }
});

// Get current usage stats
app.get('/api/usage-stats', async (req, res) => {
  try {
    const globalLimit = await checkGlobalLimit();
    const today = new Date().toISOString().split('T')[0];
    
    res.json({
      date: today,
      current: globalLimit.current,
      limit: globalLimit.limit,
      remaining: globalLimit.remaining,
      limitReached: globalLimit.limitReached,
      percentageUsed: ((globalLimit.current / globalLimit.limit) * 100).toFixed(1)
    });
  } catch (error) {
    console.error('Error fetching usage stats:', error);
    res.status(500).json({ error: 'Failed to fetch usage stats' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
