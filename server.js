require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { Client } = require('@googlemaps/google-maps-services-js');

const app = express();
const port = process.env.PORT || 3001;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Google Places client
const googlePlacesClient = new Client({});

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
        detail: "high"
      }
    }));

    // Call OpenAI Vision API
    const response = await openai.chat.completions.create({
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

app.post('/api/search-contractors', async (req, res) => {
  try {
    const { jobType, location } = req.body;

    if (!jobType) {
      return res.status(400).json({ error: 'Job type is required' });
    }

    if (!location) {
      return res.status(400).json({ error: 'Location is required' });
    }

    const searchLocation = location;
    console.log(`Searching for contractors in: ${searchLocation}`);

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
        'ev-charger': ['EV charger installer', 'electric car charger', 'EV charging point installer']

    };

    const searchTerms = jobTypeMapping[jobType] || [jobType];
    const searchQuery = searchTerms[0]; // Use primary term for now
    const fullQuery = `${searchQuery} in ${searchLocation}`;

    console.log(`Searching for: ${fullQuery}`);

    // Search Google Places
    const response = await googlePlacesClient.textSearch({
      params: {
        query: fullQuery,
        key: process.env.GOOGLE_PLACES_API_KEY,
        type: 'electrician|general_contractor|plumber|painter'
      }
    });

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API error: ${response.data.status}`);
    }

    // Filter and map results
const MINIMUM_RATING = 4.0;
const MINIMUM_REVIEWS = 5;

const allContractors = response.data.results
  .filter(place => {
    // Filter by minimum rating and review count
    const rating = place.rating || 0;
    const reviews = place.user_ratings_total || 0;
    return rating >= MINIMUM_RATING && reviews >= MINIMUM_REVIEWS;
  })
  .map(place => ({
    name: place.name,
    address: place.formatted_address,
    rating: place.rating || 0,
    totalReviews: place.user_ratings_total || 0,
    phoneNumber: place.formatted_phone_number,
    website: place.website,
    location: place.geometry.location,
    placeId: place.place_id,
    openNow: place.opening_hours?.open_now,
    priceLevel: place.price_level,
    types: place.types
  }));

console.log(`Found ${allContractors.length} contractors matching criteria (${MINIMUM_RATING}+ rating, ${MINIMUM_REVIEWS}+ reviews)`);

// If we don't have enough contractors, relax the filters
const contractors = allContractors.length >= 3 
  ? allContractors 
  : response.data.results.slice(0, 5).map(place => ({
      name: place.name,
      address: place.formatted_address,
      rating: place.rating || 0,
      totalReviews: place.user_ratings_total || 0,
      phoneNumber: place.formatted_phone_number,
      website: place.website,
      location: place.geometry.location,
      placeId: place.place_id,
      openNow: place.opening_hours?.open_now,
      priceLevel: place.price_level,
      types: place.types
    }));

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

res.json({
  contractors: scoredContractors.slice(0, 5),
  searchQuery: fullQuery,
  totalFound: response.data.results.length,
  qualityFiltered: allContractors.length,
  filters: {
    minimumRating: MINIMUM_RATING,
    minimumReviews: MINIMUM_REVIEWS
  }
});

  } catch (error) {
    console.error('Contractor search error:', error);
    res.status(500).json({ 
      error: 'Failed to search contractors',
      message: error.message 
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});