require('dotenv').config();
const crypto = require('crypto'); // Built into Node.js
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { Client } = require('@googlemaps/google-maps-services-js');

const mongoose = require('mongoose');

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

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Trade Estimator API is running' });
});

// Photo analysis endpoint
app.post('/api/analyze-photos', async (req, res) => {
  try {
    const { images, jobType } = req.body;

    if (!images || images.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    if (images.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 images allowed' });
    }

    console.log(`Analyzing ${images.length} photos for ${jobType}`);

    // Prepare prompt for AI
const prompt = `You are an expert construction, decoration and renovation estimator. Analyse these photos of a ${jobType} project.

Please evaluate and provide your assessment as JSON with this exact structure:
{
  "complexity": 1.05,
  "condition": 0.95,
  "access": 1.0,
  "materialQuality": 1.0,
  "insights": ["insight 1", "insight 2", "insight 3"],
  "detectedIssues": false,
  "confidence": 85,
  "materials": [
    {"item": "Paint (5L)", "quantity": 3, "unit": "tins", "estimatedCost": 45},
    {"item": "Primer", "quantity": 2, "unit": "litres", "estimatedCost": 25}
  ]
}

Guidelines:
- complexity: 0.9 to 1.3 (simple=0.9-1.0, average=1.0-1.1, complex=1.1-1.3)
- condition: 0.85 to 1.1 (excellent=0.85-0.95, good=0.95-1.0, poor=1.0-1.1)
- access: 0.9 to 1.1 (easy=0.9-0.95, normal=0.95-1.0, difficult=1.0-1.1)
- materialQuality: 0.95 to 1.1 (basic=0.95-1.0, standard=1.0, high-end=1.0-1.1)
- insights: 3-5 specific observations about the space
- detectedIssues: true if any problems found
- confidence: 70-95 based on photo quality and coverage
- materials: List 5-10 key materials needed with realistic quantities and costs in GBP`;

    // Prepare image messages
    const imageMessages = images.slice(0, 5).map(img => ({
      type: "image_url",
      image_url: {
        url: img.data,
        detail: "auto"
      }
    }));

    // Call OpenAI Vision API
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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

    const analysisText = response.choices[0].message.content;
    console.log('AI Response:', analysisText);

    // Parse AI response
    let analysis;
    try {
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    // Calculate overall adjustment
    const overallAdjustment = 
      analysis.complexity * 
      analysis.condition * 
      analysis.access * 
      analysis.materialQuality;

    // Apply platform markup to materials (15% for supplier profit + platform fee)
    const PLATFORM_MARKUP = 1.15;
    const adjustedMaterials = (analysis.materials || []).map(material => ({
      ...material,
      baseCost: material.estimatedCost,
      estimatedCost: Math.round(material.estimatedCost * PLATFORM_MARKUP * 100) / 100
    }));

    // Return formatted response
    res.json({
      adjustment: overallAdjustment,
      confidence: analysis.confidence || 75,
      insights: analysis.insights || [],
      detectedIssues: analysis.detectedIssues || false,
      materials: adjustedMaterials,
      factors: {
        complexity: ((analysis.complexity - 1) * 100).toFixed(1),
        condition: ((analysis.condition - 1) * 100).toFixed(1),
        access: ((analysis.access - 1) * 100).toFixed(1),
        materialQuality: ((analysis.materialQuality - 1) * 100).toFixed(1)
      }
    });

  } catch (error) {
    console.error('Error analyzing photos:', error);
    res.status(500).json({ 
      error: 'Failed to analyze photos',
      message: error.message 
    });
  }
});

// Helper function to lookup UK postcode and get town/city with cost multiplier
async function lookupPostcode(postcode) {
  try {
    const cleanPostcode = postcode.trim().replace(/\s+/g, '');
    const response = await fetch(`https://api.postcodes.io/postcodes/${cleanPostcode}`);
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    
    if (data.status === 200 && data.result) {
      const specificLocation = 
        data.result.parish_ward || 
        data.result.admin_ward ||
        data.result.admin_district ||
        data.result.postcode.split(' ')[0];
      
      // Calculate cost multiplier based on real data
      const costMultiplier = calculateCostMultiplier(data.result);
      
      return {
        city: specificLocation,
        region: data.result.region,
        district: data.result.admin_district,
        country: data.result.country,
        latitude: data.result.latitude,
        longitude: data.result.longitude,
        costMultiplier: costMultiplier,
        costReason: getCostReason(data.result, costMultiplier)
      };
    }
    
    return null;
  } catch (error) {
    console.error('Postcode lookup error:', error.message);
    return null;
  }
}

// Calculate cost multiplier based on postcode data
function calculateCostMultiplier(postcodeData) {
  // London (region check)
  if (postcodeData.region === 'London') {
    return 1.5;
  }
  
  // Use average income/house prices as proxy (from parliamentary constituency)
  // High-value areas based on region and district
  const highCostRegions = ['South East', 'East of England'];
  const highCostDistricts = [
    'Oxford', 'Cambridge', 'Brighton and Hove', 'Bath and North East Somerset',
    'Windsor and Maidenhead', 'Wokingham', 'Surrey', 'Buckinghamshire',
    'Hertfordshire', 'Bristol', 'Edinburgh', 'St Albans', 'Winchester',
    'Guildford', 'Elmbridge', 'Mole Valley', 'Waverley'
  ];
  
  // Check if in high cost district
  if (highCostDistricts.some(district => 
    postcodeData.admin_district?.includes(district) || 
    postcodeData.parliamentary_constituency?.includes(district)
  )) {
    return 1.25;
  }
  
  // Check if in high cost region (but not specific district)
  if (highCostRegions.includes(postcodeData.region)) {
    return 1.15;
  }
  
  // Low cost areas (based on lower average incomes)
  const lowCostRegions = ['North East', 'Yorkshire and The Humber', 'North West', 'Wales'];
  const lowCostDistricts = [
    'Burnley', 'Blackpool', 'Stoke', 'Kingston upon Hull', 'Middlesbrough',
    'Hartlepool', 'Blackburn', 'Bradford', 'Barnsley', 'Doncaster',
    'Rotherham', 'Wakefield', 'Sunderland', 'Gateshead', 'South Tyneside',
    'Blaenau Gwent', 'Merthyr Tydfil', 'Neath Port Talbot'
  ];
  
  // Check if in low cost district
  if (lowCostDistricts.some(district => 
    postcodeData.admin_district?.includes(district)
  )) {
    return 0.85;
  }
  
  // Check if in lower cost region (but not specific low cost district)
  if (lowCostRegions.includes(postcodeData.region)) {
    return 0.92;
  }
  
  // Scotland (excluding Edinburgh)
  if (postcodeData.country === 'Scotland' && !postcodeData.admin_district?.includes('Edinburgh')) {
    return 0.95;
  }
  
  // Default average
  return 1.0;
}

// Get human-readable reason for cost multiplier
function getCostReason(postcodeData, multiplier) {
  if (multiplier === 1.5) return 'London area';
  if (multiplier === 1.25) return 'High-value area';
  if (multiplier === 1.15) return 'South East/East England';
  if (multiplier === 0.85) return 'Lower cost area';
  if (multiplier === 0.92) return 'Northern England/Wales';
  if (multiplier === 0.95) return 'Scotland';
  return 'Standard pricing area';
}

app.post('/api/search-contractors', async (req, res) => {
  try {
    const { jobType, location } = req.body;

    if (!jobType) {
      return res.status(400).json({ error: 'Job type is required' });
    }

    if (!location) {
      return res.status(400).json({ error: 'Location is required' });
    }

    // Map our job types to search queries
    const jobTypeMapping = {
        'extension': ['home extension builder', 'house extension contractor', 'building extension'],
        'loft-conversion': ['loft conversion specialist', 'attic conversion', 'loft builder'],
        'new-roof': ['roofing contractor', 'roofer', 'roof specialist'],
        'driveway': ['driveway installer', 'driveway contractor', 'paving specialist'],
        'painting-room': ['painter decorator', 'interior painter', 'painting contractor'],
        'wallpapering': ['wallpaper installer', 'wallpapering specialist', 'decorator'],
        'floor-sanding': ['floor sanding service', 'floor refinishing', 'wood floor specialist'],
        'bathroom-install': ['bathroom fitter', 'bathroom installer', 'bathroom renovation'],
        'boiler-replacement': ['boiler installer', 'heating engineer', 'boiler specialist'],
        'radiator-install': ['heating engineer', 'central heating installer', 'plumber'],
        'rewire': ['electrician rewiring', 'electrical rewiring', 'house rewire electrician'],
        'consumer-unit': ['electrician', 'electrical contractor', 'fuse box electrician'],
        'ev-charger': ['EV charger installer', 'electric car charger', 'EV charging point installer'],
        'garden-landscaping': ['garden landscaper', 'landscaping contractor', 'garden designer'],
        'window-cleaning': ['window cleaner', 'window cleaning service', 'professional window cleaner']
    };

const searchTerms = jobTypeMapping[jobType] || [jobType];
const searchQuery = searchTerms[0];

// Map job types to Google Places business types
const jobTypeToGoogleTypes = {
  // Construction
  'extension': ['general_contractor', 'home_builder', 'construction_company'],
  'loft-conversion': ['general_contractor', 'roofing_contractor', 'home_builder'],
  'new-roof': ['roofing_contractor', 'general_contractor'],
  'driveway': ['general_contractor', 'paving_contractor'],
  
  // Decoration
  'painting-room': ['painter', 'painting_contractor'],
  'wallpapering': ['painter', 'interior_decorator'],
  'floor-sanding': ['flooring_contractor', 'flooring_store'],
  
  // Plumbing
  'bathroom-install': ['plumber', 'bathroom_remodeler'],
  'boiler-replacement': ['plumber', 'heating_contractor'],
  'radiator-install': ['plumber', 'heating_contractor'],
  
  // Electrical
  'rewire': ['electrician'],
  'consumer-unit': ['electrician'],
  'ev-charger': ['electrician', 'car_repair'],

    // Outdoor
  'garden-landscaping': ['landscaping', 'landscape_designer', 'lawn_care'],
  'window-cleaning': ['window_cleaning_service', 'cleaning_service']
};

// Get relevant types for this job, default to general_contractor
const relevantTypes = jobTypeToGoogleTypes[jobType] || ['general_contractor'];
const typesString = relevantTypes.join('|');

console.log(`Using Google Places types: ${typesString}`);

// Handle UK postcodes - look them up via API
let searchLocation = location;
let locationDetails = null;

// Check if it looks like a UK postcode (e.g., "BA14 8UZ" or "SW1A1AA")
const postcodePattern = /^[A-Z]{1,2}[0-9]{1,2}[A-Z]?\s?[0-9][A-Z]{2}$/i;

if (postcodePattern.test(location.trim())) {
  console.log(`Detected postcode format: ${location}`);
  locationDetails = await lookupPostcode(location);

  console.log('=== POSTCODE LOOKUP RESULT ===');
console.log('Location input:', location);
console.log('Location details:', locationDetails);
console.log('Cost multiplier:', locationDetails?.costMultiplier);
  
if (locationDetails) {
  // Use the town/city from the postcode lookup
  searchLocation = locationDetails.city;
  
  // If it's still too generic (a county), add UK to help Google Places
  const genericLocations = ['Wiltshire', 'Somerset', 'Devon', 'Cornwall', 'Yorkshire', 'Lancashire'];
  if (genericLocations.some(loc => searchLocation.includes(loc))) {
    searchLocation = `${searchLocation} UK`;
  }
  
  console.log(`Converted postcode ${location} to: ${searchLocation} (${locationDetails.district}, ${locationDetails.region})`);
  } else {
    console.log(`Postcode lookup failed, using postcode as-is: ${location}`);
    // Keep original postcode if lookup fails
  }
} else {
  console.log(`Not a postcode format, using as city name: ${searchLocation}`);
}

console.log(`Final search location: ${searchLocation}`);



 
    const fullQuery = `${searchQuery} in ${searchLocation}`;

    console.log(`Searching for: ${fullQuery}`);

// Get coordinates from postcode if available
let searchParams;

if (locationDetails && locationDetails.latitude && locationDetails.longitude) {
  // Use nearby search with coordinates and radius
  const radiusMeters = 16000; // 10 miles = ~16km
  
  console.log(`Searching within ${radiusMeters/1000}km of coordinates: ${locationDetails.latitude}, ${locationDetails.longitude}`);
  
  searchParams = {
    location: `${locationDetails.latitude},${locationDetails.longitude}`,
    radius: radiusMeters,
    keyword: searchQuery,
    key: process.env.GOOGLE_PLACES_API_KEY,
    type: typesString
  };
  
  const response = await googlePlacesClient.placesNearby({
    params: searchParams
  });
  
  searchResults = response;
} else {
  // Fallback to text search if no coordinates
  console.log(`No coordinates available, using text search: ${fullQuery}`);
  
  const response = await googlePlacesClient.textSearch({
    params: {
      query: fullQuery,
      key: process.env.GOOGLE_PLACES_API_KEY,
      type: typesString
    }
  });
  
  searchResults = response;
}

const response = searchResults;

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API error: ${response.data.status}`);
    }

// Try strict filters first, then relax if needed
const STRICT_MIN_RATING = 4.0;
const STRICT_MIN_REVIEWS = 5;
const RELAXED_MIN_RATING = 3.5;
const RELAXED_MIN_REVIEWS = 3;

const strictContractors = response.data.results
  .filter(place => {
    const rating = place.rating || 0;
    const reviews = place.user_ratings_total || 0;
    return rating >= STRICT_MIN_RATING && reviews >= STRICT_MIN_REVIEWS;
  })
 .map(place => ({
  name: place.name,
  address: place.formatted_address || place.vicinity || 'Address not available',
  rating: place.rating || 0,
  totalReviews: place.user_ratings_total || 0,
  phoneNumber: place.formatted_phone_number || place.international_phone_number,
    website: place.website,
    location: place.geometry.location,
    placeId: place.place_id,
    openNow: place.opening_hours?.open_now,
    priceLevel: place.price_level,
    types: place.types,
    qualityVerified: true // Meets strict criteria
  }));

// If we have at least 3 strict results, use them
let contractors = strictContractors;
let filtersUsed = {
  minimumRating: STRICT_MIN_RATING,
  minimumReviews: STRICT_MIN_REVIEWS,
  relaxed: false
};

// Otherwise, relax the filters
if (strictContractors.length < 3) {
  console.log(`Only ${strictContractors.length} contractors with strict filters, relaxing criteria...`);
  
  const relaxedContractors = response.data.results
    .filter(place => {
      const rating = place.rating || 0;
      const reviews = place.user_ratings_total || 0;
      return rating >= RELAXED_MIN_RATING && reviews >= RELAXED_MIN_REVIEWS;
    })
.map(place => ({
  name: place.name,
  address: place.formatted_address || place.vicinity || 'Address not available',
  rating: place.rating || 0,
  totalReviews: place.user_ratings_total || 0,
  phoneNumber: place.formatted_phone_number || place.international_phone_number,
      website: place.website,
      location: place.geometry.location,
      placeId: place.place_id,
      openNow: place.opening_hours?.open_now,
      priceLevel: place.price_level,
      types: place.types,
      qualityVerified: false // Doesn't meet strict criteria
    }));
  
  contractors = relaxedContractors;
  filtersUsed = {
    minimumRating: RELAXED_MIN_RATING,
    minimumReviews: RELAXED_MIN_REVIEWS,
    relaxed: true
  };
}

console.log(`Found ${contractors.length} contractors matching criteria`);


// Calculate a match score with improved criteria
const scoredContractors = contractors.map(contractor => {
  let score = 0;
  let breakdown = {};
  
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
  locationData: locationDetails ? {
    costMultiplier: locationDetails.costMultiplier,
    costReason: locationDetails.costReason,
    region: locationDetails.region
  } : null
});

  } catch (error) {
    console.error('Contractor search error:', error);
    res.status(500).json({ 
      error: 'Failed to search contractors',
      message: error.message 
    });
  }
});

const Estimate = require('./models/Estimate');

// Save estimate endpoint
app.post('/api/save-estimate', async (req, res) => {
  try {
    const {
      category,
      jobType,
      jobName,
      inputType,
      roomCounts,
      areaQuantity,
      userLocation,      // Original postcode (from frontend)
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
      
      // Input details
      roomCounts: roomCounts || { small: 0, medium: 0, large: 0, extraLarge: 0 },
      areaQuantity,
      
      // Location (ANONYMIZED)
      locationHash: locationHash,  // Hashed, not actual postcode
      locationData: {
        region: locationData?.region,        // Just "London", "Manchester"
        costMultiplier: locationData?.costMultiplier,
        costReason: locationData?.costReason
        // Don't store: city, district, postcode
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
      
      // NO PERSONAL DATA:
      // ipAddress: NOT collected
      // userAgent: NOT collected
      // actual postcode: NOT stored (only hash)
    });

    // Save to database
    const savedEstimate = await newEstimate.save();
    
    console.log('💾 Estimate saved (anonymous):', savedEstimate._id);
    console.log('   Region:', savedEstimate.locationData?.region);
    console.log('   Location hash:', savedEstimate.locationHash);

    res.json({
      success: true,
      estimateId: savedEstimate._id,
      message: 'Estimate saved successfully',
      anonymous: true  // Indicate no personal data collected
    });

  } catch (error) {
    console.error('❌ Error saving estimate:', error);
    res.status(500).json({ 
      error: 'Failed to save estimate',
      message: error.message 
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
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});