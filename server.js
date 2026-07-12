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
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Load regional data for Google Indexing API
const regionalData = require('./regionalCostData.json');

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

const ContractorClick = mongoose.model('ContractorClick', contractorClickSchema);

const app = express();
const port = process.env.PORT || 3001;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Google Places client
const googlePlacesClient = new Client({});

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
    console.error('Error checking global limit is:', error);
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
const corsOptions = {
  origin: [
    'https://getestimateai.co.uk',
    'https://www.getestimateai.co.uk',
    'http://localhost:3000',
    'http://localhost:3001'
  ],
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-reindex-secret'],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false
};

app.set('trust proxy', 1); // Trust Render's proxy so rate limiting identifies real client IPs
app.use(cors(corsOptions));

// Handle all OPTIONS preflight requests using the same corsOptions
app.options('*', cors(corsOptions));

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
  // Skip rate limiting for health check and contractor-click (has its own limiter)
  skip: (req) => req.path === '/' || req.method === 'OPTIONS' || req.path === '/api/contractor-click'
  // Using default keyGenerator which handles IPv6 correctly
});

// Contractor click limiter -- generous, lightweight write, no abuse potential
const contractorClickLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests', message: 'Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false
});

const photoAnalysisLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // Only 3 photo analysis requests per minute
  message: {
    error: 'Too many photo analysis requests',
    message: 'Please wait before analyzing more photos. Maximum 3 analyses per minute.'
  },
  standardHeaders: true,
  legacyHeaders: false
  // Using default keyGenerator which handles IPv6 correctly
});

// Apply rate limiter to all API routes
app.use('/api/', apiLimiter);
app.use('/api/contractor-click', contractorClickLimiter);

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
      confidence: Math.max(0, Math.min(100, confidence)),
      insights: analysis.insights || [],
      detectedIssues: analysis.detectedIssues || [],
      materials: analysis.materials || [],
      breakdown: {
        complexity: analysis.complexity || 1,
        condition: analysis.condition || 1,
        access: analysis.access || 1,
        materialQuality: analysis.materialQuality || 1
      }
    };

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Analysis complete in ${duration}s - Adjustment: ${result.adjustment}x (${result.confidence}% confidence)`);

    res.json(result);

  } catch (error) {
    console.error('Photo analysis error:', error);
    
    res.status(500).json({
      error: 'Photo analysis failed',
      message: 'Unable to analyze photos. Please try again.',
      fallback: true,
      adjustment: 1.0,
      confidence: 0,
      insights: ['Analysis unavailable. Using standard estimate.']
    });
  }
});

// Postcode validation and geocoding
async function validateAndGeocodePostcode(postcode) {
  if (!postcode || typeof postcode !== 'string') {
    return { valid: false, error: 'Invalid postcode format' };
  }

  const cleanPostcode = postcode.trim().toUpperCase();
  
  const ukPostcodeRegex = /^[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}$/i;
  if (!ukPostcodeRegex.test(cleanPostcode)) {
    return { valid: false, error: 'Invalid UK postcode format' };
  }

  try {
    const response = await googlePlacesClient.geocode({
      params: {
        address: cleanPostcode + ', UK',
        key: process.env.GOOGLE_PLACES_API_KEY,
        region: 'uk'
      }
    });

    if (response.data.results.length === 0) {
      return { valid: false, error: 'Postcode not found' };
    }

    const result = response.data.results[0];
    
    const ukComponent = result.address_components.find(
      comp => comp.types.includes('country') && comp.short_name === 'GB'
    );
    
    if (!ukComponent) {
      return { valid: false, error: 'Not a UK postcode' };
    }

    return {
      valid: true,
      formattedAddress: result.formatted_address,
      location: result.geometry.location,
      placeId: result.place_id
    };
  } catch (error) {
    console.error('Geocoding error:', error);
    return { valid: false, error: 'Failed to validate postcode' };
  }
}

// ── Postcode parsing ─────────────────────────────────────────────────────────
// Single source of truth for postcode handling. The previous implementation did
// outward = postcode.replace(/\s+/g,'').slice(0, -3), which silently assumes the
// input is a complete postcode. It is not: the frontend debounce fires on partial
// input, so "BS1 5" resolved to area "B" (Birmingham) and "BS1" resolved to
// nothing at all. Both saved. Never slice blindly again.
//
// Returns { valid: false, reason } or
//         { valid: true, complete, area, district, districtNum, formatted }
//
// An outward code on its own (BS1, SW1A) fully resolves a multiplier, so it is
// accepted as valid but incomplete. Everything else is rejected, not guessed at.
const OUTWARD_REGEX = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
const INWARD_REGEX  = /^[0-9][A-Z]{2}$/;

function parsePostcode(input) {
  if (!input || typeof input !== 'string') return { valid: false, reason: 'empty' };

  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return { valid: false, reason: 'empty' };

  let outward, inward;
  if (raw.length >= 5) {
    outward = raw.slice(0, -3);
    inward  = raw.slice(-3);
    if (!OUTWARD_REGEX.test(outward) || !INWARD_REGEX.test(inward)) {
      return { valid: false, reason: 'malformed' };
    }
  } else {
    outward = raw;
    inward  = null;
    if (!OUTWARD_REGEX.test(outward)) return { valid: false, reason: 'malformed' };
  }

  return {
    valid: true,
    complete: Boolean(inward),
    area: outward.match(/^([A-Z]+)/)[1],       // BS, SW
    district: outward,                          // BS1, SW1A - outward code only
    districtNum: outward.replace(/[A-Z]$/, ''), // SW1A -> SW1, for the Central London check
    formatted: inward ? outward + ' ' + inward : outward
  };
}

// ── Postcode area to region map ──────────────────────────────────────────────
// Full UK coverage. Previously 16 areas (BT CW DG FK GY HS IM IV JE KA KW KY PH
// SY TD ZE) had no mapping at all and fell through to region 'Unknown'.
//
// `slug` matches regionalCostData.json where a region page exists, null where the
// area has no dedicated page but still needs a name and a multiplier. `name` is
// the ONLY string ever written to locationData.region. Bare postcode letters
// ('S', 'B', 'G') and Google postal_town strings ('Whitley Bay', 'Crieff') are no
// longer written anywhere, so the field now has one controlled vocabulary.
const AREA_REGIONS = {
  'E':  { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'N':  { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'NW': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'SE': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'SW': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'W':  { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'BR': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'CR': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'DA': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'EN': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'HA': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'IG': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'KT': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'RM': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'SM': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'TN': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'TW': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'UB': { name: 'Greater London', slug: 'london-greater', m: 1.35 },
  'SL': { name: 'Slough', slug: 'slough', m: 1.25 },
  'RG': { name: 'Reading', slug: 'reading', m: 1.25 },
  'OX': { name: 'Oxford', slug: 'oxford', m: 1.25 },
  'CB': { name: 'Cambridge', slug: 'cambridge', m: 1.25 },
  'WD': { name: 'Watford', slug: 'watford', m: 1.25 },
  'BN': { name: 'Brighton & Hove', slug: 'brighton', m: 1.25 },
  'BA': { name: 'Bath', slug: 'bath', m: 1.25 },
  'AL': { name: 'St Albans', slug: null, m: 1.25 },
  'GU': { name: 'Guildford & Surrey', slug: null, m: 1.25 },
  'HP': { name: 'Hemel Hempstead & Chilterns', slug: null, m: 1.25 },
  'CM': { name: 'Chelmsford & Mid Essex', slug: null, m: 1.25 },
  'RH': { name: 'Redhill & East Surrey', slug: null, m: 1.25 },
  'SG': { name: 'Stevenage & North Hertfordshire', slug: null, m: 1.25 },
  'AB': { name: 'Aberdeen', slug: 'aberdeen', m: 1.15 },
  'B':  { name: 'Birmingham', slug: 'birmingham', m: 1.15 },
  'BD': { name: 'Bradford', slug: null, m: 1.15 },
  'BH': { name: 'Bournemouth', slug: 'bournemouth', m: 1.15 },
  'BL': { name: 'Bolton', slug: null, m: 1.15 },
  'BS': { name: 'Bristol', slug: 'bristol', m: 1.15 },
  'CH': { name: 'Chester & Birkenhead', slug: 'birkenhead', m: 1.15 },
  'CT': { name: 'Canterbury', slug: 'canterbury', m: 1.15 },
  'EH': { name: 'Edinburgh', slug: 'edinburgh', m: 1.15 },
  'G':  { name: 'Glasgow', slug: 'glasgow', m: 1.15 },
  'GL': { name: 'Gloucester & Cheltenham', slug: 'gloucester', m: 1.15 },
  'L':  { name: 'Liverpool', slug: 'liverpool', m: 1.15 },
  'LS': { name: 'Leeds', slug: 'leeds', m: 1.15 },
  'LU': { name: 'Luton', slug: 'luton', m: 1.15 },
  'M':  { name: 'Manchester', slug: 'manchester', m: 1.15 },
  'MK': { name: 'Milton Keynes', slug: 'milton-keynes', m: 1.15 },
  'ML': { name: 'Motherwell', slug: null, m: 1.15 },
  'OL': { name: 'Oldham', slug: null, m: 1.15 },
  'PA': { name: 'Paisley', slug: null, m: 1.15 },
  'PO': { name: 'Portsmouth', slug: 'portsmouth', m: 1.15 },
  'S':  { name: 'Sheffield', slug: 'sheffield', m: 1.15 },
  'SK': { name: 'Stockport', slug: null, m: 1.15 },
  'SO': { name: 'Southampton', slug: 'southampton', m: 1.15 },
  'WA': { name: 'Warrington', slug: null, m: 1.15 },
  'WF': { name: 'Wakefield', slug: null, m: 1.15 },
  'WN': { name: 'Wigan', slug: null, m: 1.15 },
  'CF': { name: 'Cardiff', slug: 'cardiff', m: 1.05 },
  'DD': { name: 'Dundee', slug: 'dundee', m: 1.05 },
  'EX': { name: 'Exeter', slug: 'exeter', m: 1.05 },
  'NE': { name: 'Newcastle', slug: 'newcastle', m: 1.05 },
  'NG': { name: 'Nottingham', slug: 'nottingham', m: 1.05 },
  'NR': { name: 'Norwich', slug: 'norwich', m: 1.05 },
  'SN': { name: 'Swindon', slug: 'swindon', m: 1.05 },
  'YO': { name: 'York', slug: 'york', m: 1.05 },
  'DT': { name: 'Dorchester & Dorset', slug: null, m: 1.05 },
  'ME': { name: 'Medway', slug: null, m: 1.05 },
  'SP': { name: 'Salisbury', slug: null, m: 1.05 },
  'SS': { name: 'Southend-on-Sea', slug: null, m: 1.05 },
  'TQ': { name: 'Torquay & Torbay', slug: null, m: 1.05 },
  'TR': { name: 'Truro & Cornwall', slug: null, m: 1.05 },
  'WR': { name: 'Worcester', slug: null, m: 1.05 },
  'HG': { name: 'Harrogate', slug: null, m: 1.05 },
  'KW': { name: 'Caithness & Orkney', slug: null, m: 1.05 },
  'HS': { name: 'Outer Hebrides', slug: null, m: 1.05 },
  'ZE': { name: 'Shetland', slug: null, m: 1.05 },
  'CO': { name: 'Colchester', slug: 'colchester', m: 1.0 },
  'CV': { name: 'Coventry', slug: 'coventry', m: 1.0 },
  'DE': { name: 'Derby', slug: 'derby', m: 1.0 },
  'DY': { name: 'Dudley', slug: null, m: 1.0 },
  'FY': { name: 'Blackpool', slug: 'blackpool', m: 1.0 },
  'IP': { name: 'Ipswich', slug: 'ipswich', m: 1.0 },
  'LE': { name: 'Leicester', slug: 'leicester', m: 1.0 },
  'NP': { name: 'Newport', slug: 'newport', m: 1.0 },
  'PE': { name: 'Peterborough', slug: 'peterborough', m: 1.0 },
  'PL': { name: 'Plymouth', slug: 'plymouth', m: 1.0 },
  'PR': { name: 'Preston', slug: 'preston', m: 1.0 },
  'SA': { name: 'Swansea', slug: 'swansea', m: 1.0 },
  'SR': { name: 'Sunderland', slug: 'sunderland', m: 1.0 },
  'TF': { name: 'Telford', slug: 'telford', m: 1.0 },
  'WV': { name: 'Wolverhampton', slug: 'wolverhampton', m: 1.0 },
  'TA': { name: 'Taunton & Somerset', slug: null, m: 1.0 },
  'HR': { name: 'Hereford', slug: null, m: 1.0 },
  'NN': { name: 'Northampton', slug: null, m: 1.0 },
  'LA': { name: 'Lancaster', slug: null, m: 1.0 },
  'LD': { name: 'Llandrindod Wells & Powys', slug: null, m: 1.0 },
  'LL': { name: 'North Wales', slug: null, m: 1.0 },
  'LN': { name: 'Lincoln', slug: null, m: 1.0 },
  'WS': { name: 'Walsall', slug: null, m: 1.0 },
  'CA': { name: 'Carlisle & Cumbria', slug: null, m: 1.0 },
  'HD': { name: 'Huddersfield', slug: null, m: 1.0 },
  'BT': { name: 'Belfast & Northern Ireland', slug: 'belfast', m: 1.0 },
  'CW': { name: 'Crewe', slug: null, m: 1.0 },
  'SY': { name: 'Shrewsbury', slug: null, m: 1.0 },
  'FK': { name: 'Falkirk', slug: null, m: 1.0 },
  'KY': { name: 'Kirkcaldy & Fife', slug: null, m: 1.0 },
  'KA': { name: 'Kilmarnock & Ayrshire', slug: null, m: 1.0 },
  'PH': { name: 'Perth & Highland Perthshire', slug: null, m: 1.0 },
  'IV': { name: 'Inverness & Highlands', slug: null, m: 1.0 },
  'DL': { name: 'Darlington', slug: null, m: 0.95 },
  'DN': { name: 'Doncaster', slug: null, m: 0.95 },
  'HU': { name: 'Hull', slug: 'hull', m: 0.95 },
  'ST': { name: 'Stoke-on-Trent', slug: 'stoke-on-trent', m: 0.95 },
  'TS': { name: 'Middlesbrough', slug: 'middlesbrough', m: 0.95 },
  'BB': { name: 'Blackburn', slug: null, m: 0.95 },
  'DH': { name: 'Durham', slug: null, m: 0.95 },
  'HX': { name: 'Halifax', slug: null, m: 0.95 },
  'TD': { name: 'Galashiels & Scottish Borders', slug: null, m: 0.95 },
  'DG': { name: 'Dumfries & Galloway', slug: null, m: 0.95 },
};

const REGION_REASONS = {
  1.55: 'Central London rates (ULEZ, parking permits, premium labour)',
  1.35: 'Greater London rates (materials, labour, access costs)',
  1.25: 'London-adjacent premium city rates',
  1.15: 'Major city rates',
  1.05: 'Above-average regional rates',
  1:    'Standard UK rates',
  0.95: 'Below-average regional rates'
};

// Central London is district-specific, so it is checked before the area map.
const CENTRAL_LONDON_AREAS     = ['EC', 'WC'];
const CENTRAL_LONDON_DISTRICTS = ['W1', 'SW1', 'SW3', 'SW5', 'SW7', 'SW10', 'SE1', 'N1', 'NW1', 'NW8'];

// Outside the UK mainland trades market. Places returns nothing usable and the
// cost model does not apply, so these are rejected rather than priced at 1.0.
const OUT_OF_SCOPE_AREAS = ['GY', 'JE', 'IM'];

// Location-based cost analysis
// Postcode area is now the only input. addressComponents is retained in the
// signature for the existing call site but is no longer read: the Google
// postal_town fallback was the source of the third region vocabulary, and with
// full area coverage above there is nothing left for it to catch.
//
// Unresolvable input still returns a usable 1.0 multiplier so the estimate saves
// and volume is preserved, but region is null and regionResolved is false, so the
// record can be cleanly excluded from regional demand reporting and the cost index.
function analyzeLocationCost(addressComponents, rawPostcode) {
  const unresolved = (resolutionReason) => ({
    region: null,
    regionSlug: null,
    costMultiplier: 1.0,
    costReason: 'UK average rates',
    regionResolved: false,
    resolutionReason
  });

  const parsed = parsePostcode(rawPostcode);
  if (!parsed.valid) return unresolved('invalid_input');
  if (OUT_OF_SCOPE_AREAS.includes(parsed.area)) return unresolved('out_of_scope');

  if (CENTRAL_LONDON_AREAS.includes(parsed.area) || CENTRAL_LONDON_DISTRICTS.includes(parsed.districtNum)) {
    return {
      region: 'Central London',
      regionSlug: 'london-central',
      costMultiplier: 1.55,
      costReason: REGION_REASONS[1.55],
      regionResolved: true,
      resolutionReason: 'matched'
    };
  }

  const match = AREA_REGIONS[parsed.area];
  if (match) {
    return {
      region: match.name,
      regionSlug: match.slug,
      costMultiplier: match.m,
      costReason: REGION_REASONS[match.m],
      regionResolved: true,
      resolutionReason: 'matched'
    };
  }

  // Valid postcode, unmapped area. Should not happen now the map is complete, but
  // Royal Mail does add areas. Logged so it surfaces rather than failing silently.
  console.warn('WARN unmapped postcode area:', parsed.area, '| district:', parsed.district);
  return unresolved('uncovered_area');
}
// ── Location cost lookup — postcode only, no Places call ──
// Used by the frontend to resolve a multiplier and show an estimate immediately,
// before the contractor search completes. Falls back to 1.0 for unknown postcodes.
app.post('/api/location-cost', async (req, res) => {
  try {
    const { postcode } = req.body;
    if (!postcode || typeof postcode !== 'string') {
      return res.status(400).json({ error: 'postcode is required' });
    }
    const parsed = parsePostcode(postcode);
    if (!parsed.valid) {
      // Forward instrumentation. locationHash is one-way, so the Render log is the
      // only place we can see what people are actually typing into the box.
      console.warn('WARN location-cost rejected:', JSON.stringify(postcode.trim()), '| reason:', parsed.reason);
      return res.status(400).json({
        error: 'invalid_postcode',
        message: "We couldn't find that postcode. Please check it and try again."
      });
    }

    // Prefix lookup does not need addressComponents — pass empty array.
    const locationData = analyzeLocationCost([], parsed.formatted);
    if (!locationData.regionResolved) {
      console.warn('WARN location-cost unresolved region:', parsed.district, '| reason:', locationData.resolutionReason);
    }
    return res.json({ locationData, district: parsed.district });
  } catch (error) {
    console.error('location-cost error:', error);
    return res.status(500).json({ error: 'Failed to resolve location cost' });
  }
});

// Contractor click logging endpoint
app.post('/api/contractor-click', async (req, res) => {
  try {
    const { estimateId, placeId, contractorName, actionType, jobType, category, region, matchScore, estimateValue, postcodeDistrict, abVariant, leadId } = req.body;
    if (!placeId || !contractorName || !actionType) {
      return res.status(400).json({ error: 'placeId, contractorName and actionType are required' });
    }
    if (!['call', 'website', 'map', 'shown', 'contact_requested'].includes(actionType)) {
      return res.status(400).json({ error: 'actionType must be call, website, map, shown, or contact_requested' });
    }
    const click = new ContractorClick({
      estimateId:       estimateId || null,
      placeId,
      contractorName,
      actionType,
      jobType:          jobType || null,
      category:         category || null,
      region:           region || null,
      matchScore:       matchScore != null ? Number(matchScore) : null,
      estimateValue:    estimateValue != null ? Number(estimateValue) : null,
      postcodeDistrict: postcodeDistrict || null,
      abVariant:        abVariant || null,
      leadId:           leadId || null,
    });
    await click.save();
    console.log(`✅ Contractor click logged: ${contractorName} | ${actionType} | ${region || 'unknown'}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ contractor-click error:', error);
    return res.status(500).json({ error: 'Failed to log contractor click' });
  }
});

// Search contractors endpoint
app.post('/api/search-contractors', async (req, res) => {
  try {
    const { jobType, userLocation, quality = 'standard', category = '', projectScale = 1 } = req.body;

    if (!jobType) {
      return res.status(400).json({ error: 'Job type is required' });
    }

    if (!userLocation) {
      return res.status(400).json({ error: 'Location is required' });
    }

    const postcodeValidation = await validateAndGeocodePostcode(userLocation);
    
    if (!postcodeValidation.valid) {
      console.warn('⚠️ Postcode validation failed:', postcodeValidation.error, '| input:', userLocation);
      return res.status(400).json({
        error: 'invalid_postcode',
        message: "We couldn't find that postcode. Please check it and try again."
      });
    }

    const geocodingResponse = await googlePlacesClient.geocode({
      params: {
        address: userLocation + ', UK',
        key: process.env.GOOGLE_PLACES_API_KEY
      }
    }).catch(err => {
      console.warn('⚠️ Geocoding failed, using fallback:', err.message);
      return {
        data: {
          results: [{
            geometry: { location: postcodeValidation.location },
            formatted_address: postcodeValidation.formattedAddress,
            address_components: [
              { long_name: 'United Kingdom', short_name: 'GB', types: ['country', 'political'] },
              { long_name: 'England', short_name: 'England', types: ['administrative_area_level_1', 'political'] }
            ]
          }]
        }
      };
    });

    if (geocodingResponse.data.results.length === 0) {
      console.warn('⚠️ No geocoding results, using validation data');
      geocodingResponse.data.results = [{
        geometry: { location: postcodeValidation.location },
        formatted_address: postcodeValidation.formattedAddress,
        address_components: [
          { long_name: 'United Kingdom', short_name: 'GB', types: ['country', 'political'] },
          { long_name: 'England', short_name: 'England', types: ['administrative_area_level_1', 'political'] }
        ]
      }];
    }

    const location = geocodingResponse.data.results[0].geometry.location;
    const addressComponents = geocodingResponse.data.results[0].address_components;
    
    const locationDetails = analyzeLocationCost(addressComponents, userLocation);

    // ── Job-type to Places type + keyword mapping ──
    // Maps each job name to the most specific Google Places type available
    // and a focused keyword so the search pool is relevant to the actual trade
    const JOB_TYPE_MAP = {
      // Plumbing
      'Full Bathroom Installation': { placesType: 'plumber',            keyword: 'bathroom plumber' },
      'Boiler Replacement':         { placesType: 'plumber',            keyword: 'boiler installation' },
      'Radiator Installation':      { placesType: 'plumber',            keyword: 'plumber radiator' },
      'Tap Leaks':                  { placesType: 'plumber',            keyword: 'plumber' },
      'Toilet Repair':              { placesType: 'plumber',            keyword: 'plumber' },
      'Radiator Repair':            { placesType: 'plumber',            keyword: 'plumber' },
      // Electrical
      'Full Rewire':                { placesType: 'electrician',        keyword: 'electrician rewire' },
      'Consumer Unit Replacement':  { placesType: 'electrician',        keyword: 'electrician' },
      'EV Charger Installation':    { placesType: 'electrician',        keyword: 'EV charger electrician' },
      // Decoration
      'Paint Room':                 { placesType: 'painter',            keyword: 'painter decorator' },
      'Wallpaper Room':             { placesType: 'painter',            keyword: 'wallpaper decorator' },
      'Floor Sanding & Varnishing': { placesType: 'general_contractor', keyword: 'floor sanding' },
      // Building
      'Single-Storey Extension':    { placesType: 'general_contractor', keyword: 'building contractor extension' },
      'Double-Storey Extension':    { placesType: 'general_contractor', keyword: 'building contractor extension' },
      'Loft Conversion':            { placesType: 'general_contractor', keyword: 'loft conversion contractor' },
      'Loft Conversion (Dormer)':   { placesType: 'general_contractor', keyword: 'loft conversion contractor' },
      'Plaster / Skim Room':        { placesType: 'general_contractor', keyword: 'plasterer' },
      'Full House Re-skim':         { placesType: 'general_contractor', keyword: 'plasterer' },
      'Kitchen Extension':          { placesType: 'general_contractor', keyword: 'kitchen extension builder' },
      // Outdoor
      'Garden Landscaping':         { placesType: 'general_contractor', keyword: 'landscaper garden' },
      'Window Cleaning':            { placesType: 'general_contractor', keyword: 'window cleaner' },
    };

    const jobConfig = JOB_TYPE_MAP[jobType] || { placesType: 'general_contractor', keyword: `${jobType} contractor` };
    const searchQuery = jobConfig.keyword;
    const fullQuery = `${searchQuery} near ${userLocation}`;

    console.log(`Searching: "${fullQuery}" (type: ${jobConfig.placesType}, quality: ${quality}, scale: ${projectScale})`);

    // ── Haversine distance helper (metres between two lat/lng points) ──
    const haversineDistance = (lat1, lng1, lat2, lng2) => {
      const R = 6371000;
      const toRad = deg => deg * Math.PI / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    // ── Quality tier to Google Places priceLevel affinity ──
    // priceLevel: 0=free, 1=inexpensive, 2=moderate, 3=expensive, 4=very expensive
    // A luxury-finish user should match with higher-priceLevel contractors and vice versa
    const QUALITY_PRICE_AFFINITY = {
      budget:   [0, 1],      // prefer inexpensive
      standard: [1, 2],      // prefer moderate
      premium:  [2, 3],      // prefer expensive
      luxury:   [3, 4],      // prefer very expensive
    };
    const preferredPriceLevels = QUALITY_PRICE_AFFINITY[quality] || QUALITY_PRICE_AFFINITY.standard;

    // ── Project scale thresholds for review weight adjustment ──
    // Large projects (big extensions, full rewires, loft conversions) warrant
    // contractors with more proven track records, so we increase the review count weight
    const isLargeProject = projectScale >= 30; // 30m² or equivalent weighted rooms

const response = await googlePlacesClient.placesNearby({
  params: {
    location: location,
    radius: 25000,
    keyword: searchQuery,
    type: jobConfig.placesType,
    key: process.env.GOOGLE_PLACES_API_KEY
  }
});

const MIN_RATING = 4.0;
const MIN_REVIEWS = 10;
const RELAXED_MIN_RATING = 3.5;
const RELAXED_MIN_REVIEWS = 3;

const mapPlace = (place, qualityVerified) => ({
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
  qualityVerified
});

let contractors = response.data.results
  .filter(place => {
    const rating = place.rating || 0;
    const reviews = place.user_ratings_total || 0;
    return rating >= MIN_RATING && reviews >= MIN_REVIEWS;
  })
  .map(place => mapPlace(place, true));

let filtersUsed = { minimumRating: MIN_RATING, minimumReviews: MIN_REVIEWS, relaxed: false };

if (contractors.length === 0) {
  console.log('No contractors found with strict filters. Trying relaxed criteria...');
  contractors = response.data.results
    .filter(place => {
      const rating = place.rating || 0;
      const reviews = place.user_ratings_total || 0;
      return rating >= RELAXED_MIN_RATING && reviews >= RELAXED_MIN_REVIEWS;
    })
    .map(place => mapPlace(place, false));
  filtersUsed = { minimumRating: RELAXED_MIN_RATING, minimumReviews: RELAXED_MIN_REVIEWS, relaxed: true };
}

console.log(`Found ${contractors.length} contractors matching criteria`);

// ── Scoring weights ──
// Rating 30% | Reviews 15-20% | Relevance 15% | Proximity 20% | Quality affinity 10% | Presence 5%
// Review weight scales up to 20% for large projects (more track record needed)
const reviewWeight = isLargeProject ? 20 : 15;
const ratingWeight = 30;
const relevanceWeight = 15;
const proximityWeight = 20;
const qualityWeight = 10;
const presenceWeight = 5;
// Total always = 100: 30 + (15|20) + 15 + 20 + 10 + 5 = 95|100
// For small projects the remaining 5 points roll into rating to keep total at 100
const effectiveRatingWeight = isLargeProject ? ratingWeight : ratingWeight + 5;

const scoredContractors = contractors.map(contractor => {
  let score = 0;
  const breakdown = {};

  // 1. Rating (30% standard / 35% small projects)
  const ratingScore = (contractor.rating / 5) * effectiveRatingWeight;
  score += ratingScore;
  breakdown.rating = ratingScore.toFixed(1);

  // 2. Review count (15% standard / 20% large projects)
  // Logarithmic — diminishing returns after ~100 reviews
  const reviewScore = Math.min(Math.log10(contractor.totalReviews + 1) / 2, 1) * reviewWeight;
  score += reviewScore;
  breakdown.reviews = reviewScore.toFixed(1);

  // 3. Relevance (15%) — keyword match against business name and Google types
  let relevanceScore = 0;
  const nameAndTypes = `${contractor.name} ${contractor.types.join(' ')}`.toLowerCase();
  searchQuery.toLowerCase().split(' ').forEach(keyword => {
    if (keyword.length > 3 && nameAndTypes.includes(keyword)) relevanceScore += 5;
  });
  relevanceScore = Math.min(relevanceScore, relevanceWeight);
  score += relevanceScore;
  breakdown.relevance = relevanceScore.toFixed(1);

  // 4. Proximity (20%) — linear decay from 0km (full) to 25km (zero)
  const distanceM = haversineDistance(
    location.lat, location.lng,
    contractor.location.lat, contractor.location.lng
  );
  const distanceKm = distanceM / 1000;
  const proximityScore = Math.max(0, (1 - distanceKm / 25)) * proximityWeight;
  score += proximityScore;
  breakdown.proximity = `${proximityScore.toFixed(1)} (${distanceKm.toFixed(1)}km)`;

  // 5. Quality affinity (10%) — price level match to user's chosen finish quality
  // Full 10 pts if contractor priceLevel is in preferred range, 5 pts if adjacent, 0 otherwise
  let qualityScore = 0;
  if (contractor.priceLevel !== undefined && contractor.priceLevel !== null) {
    if (preferredPriceLevels.includes(contractor.priceLevel)) {
      qualityScore = qualityWeight;
    } else if (
      contractor.priceLevel === preferredPriceLevels[0] - 1 ||
      contractor.priceLevel === preferredPriceLevels[1] + 1
    ) {
      qualityScore = qualityWeight / 2;
    }
  } else {
    // No price level data — award half points rather than penalising
    qualityScore = qualityWeight / 2;
  }
  score += qualityScore;
  breakdown.quality = qualityScore.toFixed(1);

  // 6. Professional presence (5%) — website and phone number
  let presenceScore = 0;
  if (contractor.website) presenceScore += 3;
  if (contractor.phoneNumber) presenceScore += 2;
  score += presenceScore;
  breakdown.presence = presenceScore.toFixed(1);

  return {
    ...contractor,
    distanceKm: Math.round(distanceKm * 10) / 10,
    matchScore: Math.round(score),
    scoreBreakdown: breakdown
  };
});

    // Sort by match score
    scoredContractors.sort((a, b) => b.matchScore - a.matchScore);

    // Enrich top 5 with Place Details -- Nearby Search doesn't return website or phone
    const top5 = scoredContractors.slice(0, 5);
    const enriched = await Promise.all(top5.map(async (contractor) => {
      try {
        const details = await googlePlacesClient.placeDetails({
          params: {
            place_id: contractor.placeId,
            fields: ['website', 'formatted_phone_number', 'international_phone_number'],
            key: process.env.GOOGLE_PLACES_API_KEY
          }
        });
        const d = details.data.result;
        return {
          ...contractor,
          website: d.website || contractor.website || null,
          phoneNumber: d.formatted_phone_number || d.international_phone_number || contractor.phoneNumber || null
        };
      } catch (detailsError) {
        console.warn(`Place Details failed for ${contractor.name}:`, detailsError.message);
        return contractor;
      }
    }));
    console.log(`Place Details enrichment complete for ${enriched.length} contractors`);

// Return top 5 contractors (enriched with website and phone from Place Details)
res.json({
  contractors: enriched,
  searchQuery: fullQuery,
  totalFound: response.data.results.length,
  filters: filtersUsed,
  locationData: locationDetails ? {
    costMultiplier: locationDetails.costMultiplier,
    costReason: locationDetails.costReason,
    region: locationDetails.region,
    regionSlug: locationDetails.regionSlug,
    regionResolved: locationDetails.regionResolved,
    resolutionReason: locationDetails.resolutionReason
  } : null
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
const EstimateReview = require('./models/EstimateReview');

// Import and mount leads routes
const leadsRouter = require('./routes/leadsRoutes');
app.use('/api/leads', leadsRouter);

// Import and mount contractor registration routes (/for-contractors founding member form)
const contractorRegistrationsRouter = require('./routes/contractorRegistrationsRoutes');
app.use('/api/contractor-registrations', contractorRegistrationsRouter);

const Job = require('./models/Job');

// Job Feed teaser aggregate - counts of open jobs by region over the last 30 days.
// Counts only, no job details - this is the /for-contractors registration nudge.
// Suppressed under 3 to avoid signalling thin volume in any one region.
app.get('/api/jobs/region-counts', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const counts = await Job.aggregate([
      {
        $match: {
          status: 'open',
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: { _id: '$region', count: { $sum: 1 } }
      },
      {
        $match: { count: { $gte: 3 } }
      },
      {
        $project: { _id: 0, region: '$_id', count: 1 }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({ success: true, counts });
  } catch (error) {
    console.error('❌ Error fetching job region counts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch region counts' });
  }
});

// Save estimate endpoint - UPDATED to handle projectSize
app.post('/api/save-estimate', async (req, res) => {
  try {
    const {
      category,
      jobType,
      jobName,
      inputType,
      projectSize,      // NEW: Single project size field
      areaQuantity,
      userLocation,      // Original postcode (from frontend)
      locationData,
      quality,
      photoAnalysis,
      estimate,
      multipliers,
      contractors,
      source,
      abVariant
    } = req.body;

    // Validation
    if (!category || !jobType || !estimate) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['category', 'jobType', 'estimate']
      });
    }

    // Validate projectSize enum if provided (not required — estimate can save before size is set)
    const validSizes = ['small', 'medium', 'large', 'extra-large'];
    if (projectSize && !validSizes.includes(projectSize)) {
      return res.status(400).json({
        error: 'Invalid project size',
        validSizes: validSizes
      });
    }

    // Validate areaQuantity for sqm/area-based jobs only
    // 'unit' type jobs (boiler, loft conversion etc.) are single-price — no area needed
    const isSqmBased = inputType === 'sqm' || inputType === 'area';
    const parsedArea = parseFloat(areaQuantity);
    if (isSqmBased && (!areaQuantity || isNaN(parsedArea) || parsedArea <= 0)) {
      return res.status(400).json({
        error: 'Area quantity is required for sqm-based jobs',
        required: ['areaQuantity']
      });
    }

    // Hash the postcode (ANONYMIZATION)
    const locationHash = hashPostcode(userLocation);

    // Outward code only, e.g. "SW1A". An outward code covers thousands of addresses,
    // so it is not personal data, and it is the field regional demand reporting needs:
    // locationHash is one-way and cannot be grouped by area. Derived server-side from
    // the raw postcode rather than trusted from the client.
    const parsedLocation = parsePostcode(userLocation);
    const district = parsedLocation.valid ? parsedLocation.district : null;

    console.log('🔒 Anonymizing postcode:');
    console.log('  Original:', userLocation);
    console.log('  Hashed:', locationHash);
    console.log('  District:', district);

    // ── Dedup guard ──
    // App.js resets its save guard whenever the postcode changes, so a single user
    // refining a postcode or changing quality could produce several documents for one
    // estimate. That inflates estimate volume (the primary metric) and pollutes the
    // cost index. Same hashed postcode + same job within 60 seconds is a double-fire,
    // not a second estimate: update the existing record and return its id.
    const recentDuplicate = await Estimate.findOne({
      locationHash,
      jobType,
      category,
      createdAt: { $gte: new Date(Date.now() - 60 * 1000) }
    }).sort({ createdAt: -1 });

    if (recentDuplicate) {
      recentDuplicate.estimate = estimate;
      recentDuplicate.multipliers = multipliers;
      recentDuplicate.quality = quality;
      recentDuplicate.locationData = {
        region:           locationData?.region ?? null,
        regionSlug:       locationData?.regionSlug ?? null,
        district,
        costMultiplier:   locationData?.costMultiplier ?? 1.0,
        costReason:       locationData?.costReason ?? 'UK average rates',
        regionResolved:   locationData?.regionResolved ?? false,
        resolutionReason: locationData?.resolutionReason ?? 'invalid_input'
      };
      await recentDuplicate.save();
      console.log('♻️ Duplicate estimate collapsed into', recentDuplicate._id.toString());
      return res.json({
        success: true,
        estimateId: recentDuplicate._id,
        message: 'Estimate updated',
        anonymous: true,
        deduped: true
      });
    }

    // Create new estimate document with ANONYMOUS data
    const newEstimate = new Estimate({
      // Job details
      category,
      jobType,
      jobName,
      inputType,
      
      // Input details - UPDATED
      projectSize: projectSize || null,  // Store single project size for room-based jobs
      areaQuantity: areaQuantity || null, // Store quantity for area/unit-based jobs
      
      // Location (ANONYMIZED)
      locationHash: locationHash,  // Hashed, not actual postcode
      locationData: {
        // region is now a controlled name from AREA_REGIONS, or null when unresolved.
        region:           locationData?.region ?? null,
        regionSlug:       locationData?.regionSlug ?? null,
        district,                                   // outward code only, not PII
        costMultiplier:   locationData?.costMultiplier ?? 1.0,
        costReason:       locationData?.costReason ?? 'UK average rates',
        regionResolved:   locationData?.regionResolved ?? false,
        resolutionReason: locationData?.resolutionReason ?? 'invalid_input'
        // Still not stored: city, full postcode
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
      
      // Source article (from ?ref= param — not personal data)
      source: source || null,

      // A/B blur gate test variant — 'blur' or 'control'. Null on pre-experiment estimates.
      abVariant: abVariant || null,

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
    
    // Increment global usage counter
    await incrementGlobalUsage();
    
    console.log('💾 Estimate saved (anonymous):', savedEstimate._id);
    console.log('   Category:', savedEstimate.category);
    console.log('   Job Type:', savedEstimate.jobType);
    console.log('   Input Type:', savedEstimate.inputType);
    console.log('   Project Size:', savedEstimate.projectSize);
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

// Update estimate with photo analysis results
app.patch('/api/save-estimate/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { estimate, photoAnalysis, multipliers, quality, userLocation, locationData } = req.body;

    if (!id || !estimate) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['id', 'estimate']
      });
    }

    // A corrected or completed postcode arriving after the first save must update the
    // region, not leave the original (possibly unresolved) one in place.
    let locationPatch = {};
    if (userLocation && locationData) {
      const parsedPatchLocation = parsePostcode(userLocation);
      locationPatch = {
        locationHash: hashPostcode(userLocation),
        locationData: {
          region:           locationData?.region ?? null,
          regionSlug:       locationData?.regionSlug ?? null,
          district:         parsedPatchLocation.valid ? parsedPatchLocation.district : null,
          costMultiplier:   locationData?.costMultiplier ?? 1.0,
          costReason:       locationData?.costReason ?? 'UK average rates',
          regionResolved:   locationData?.regionResolved ?? false,
          resolutionReason: locationData?.resolutionReason ?? 'invalid_input'
        }
      };
    }

    const updated = await Estimate.findByIdAndUpdate(
      id,
      {
        $set: {
          estimate,
          multipliers,
          ...locationPatch,
          ...(quality ? { quality } : {}),
          photoAnalysis: photoAnalysis ? {
            adjustment: photoAnalysis.adjustment,
            confidence: photoAnalysis.confidence,
            insights: photoAnalysis.insights,
            detectedIssues: photoAnalysis.detectedIssues,
            materials: photoAnalysis.materials
          } : undefined
        }
      },
      { new: true, runValidators: false }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Estimate not found' });
    }

    console.log('✅ Estimate updated with photo analysis:', id);
    res.json({ success: true, estimateId: updated._id });

  } catch (error) {
    console.error('❌ Error updating estimate:', error);
    res.status(500).json({ error: 'Failed to update estimate' });
  }
});

// Get a single estimate by ID (for shared estimate permalinks)
app.get('/api/estimate/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || id.length !== 24) {
      return res.status(400).json({ error: 'Invalid estimate ID' });
    }

    const estimate = await Estimate.findByIdAndUpdate(
      id,
      { $inc: { viewCount: 1 } },
      { new: true, strict: false, lean: true }
    );

    if (!estimate) {
      return res.status(404).json({ error: 'Estimate not found' });
    }

    console.log('👁 Estimate viewed:', id, '— viewCount:', estimate.viewCount);
    res.json({ success: true, estimate });
  } catch (error) {
    console.error('❌ Error fetching estimate:', error);
    res.status(500).json({ error: 'Failed to fetch estimate' });
  }
});

// Record a share action on an estimate
app.patch('/api/estimate/:id/share', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || id.length !== 24) {
      return res.status(400).json({ error: 'Invalid estimate ID' });
    }
    const updated = await Estimate.findByIdAndUpdate(
      id,
      {
        $set: { sharedAt: new Date() },
        $inc: { shareCount: 1 }
      },
      { new: true, strict: false }
    );
    if (!updated) return res.status(404).json({ error: 'Estimate not found' });
    console.log('🔗 Estimate shared:', id, '— shareCount:', updated.shareCount);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error recording share:', error);
    res.status(500).json({ error: 'Failed to record share' });
  }
});

// Save estimate review endpoint
app.post('/api/estimate-reviews', async (req, res) => {
  try {
    const { estimateId, rating, actualCost, estimatedTotal, comment } = req.body;

    console.log('📝 Review payload received:', JSON.stringify({
      estimateId,
      rating,
      actualCost,
      estimatedTotal,
      comment,
      bodyKeys: Object.keys(req.body)
    }));

    if (!estimateId || !rating) {
      console.warn('⚠️ Review rejected — missing fields. estimateId:', estimateId, 'rating:', rating);
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['estimateId', 'rating']
      });
    }

    const validRatings = ['low', 'accurate', 'high'];
    if (!validRatings.includes(rating)) {
      console.warn('⚠️ Review rejected — invalid rating:', rating);
      return res.status(400).json({
        error: 'Invalid rating value',
        validRatings
      });
    }

    const actualCostNum = actualCost ? parseFloat(actualCost) : null;
    const estimatedTotalNum = estimatedTotal ? parseFloat(estimatedTotal) : null;

    const variance = actualCostNum && estimatedTotalNum
      ? Math.round((actualCostNum - estimatedTotalNum) * 100) / 100
      : null;

    const variancePct = variance && estimatedTotalNum
      ? Math.round((variance / estimatedTotalNum) * 100 * 10) / 10
      : null;

    const review = new EstimateReview({
      reviewId:   crypto.randomUUID(),
      estimateId,
      rating,
      actualCost:  actualCostNum,
      variance,
      variancePct,
      comment:    comment || null,
    });

    console.log('💾 Attempting review save...');
    const savedReview = await review.save();

    console.log('✅ Review saved:', savedReview.reviewId);
    console.log('   Estimate ID:', savedReview.estimateId);
    console.log('   Rating:', savedReview.rating);
    if (savedReview.variancePct !== null) {
      console.log('   Variance:', savedReview.variancePct + '%');
    }

    res.json({
      success: true,
      reviewId: savedReview.reviewId,
      message: 'Review saved successfully'
    });

  } catch (error) {
    console.error('❌ Error saving review:', error.message);
    console.error('❌ Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));

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
      error: 'Failed to save review',
      message: 'Unable to save your review. Please try again.'
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

// ============================================
// GOOGLE INDEXING API - SEO Brief 5
// ============================================
// Environment variables needed:
// - REINDEX_SECRET: Secret key to protect the endpoint
// - GOOGLE_SERVICE_ACCOUNT_PATH: Path to service account JSON key

const REINDEX_SECRET = process.env.REINDEX_SECRET;
const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
const BASE_URL = 'https://getestimateai.co.uk';

// Initialize Google Indexing API client
function getIndexingClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/indexing'],
  });

  return google.indexing({
    version: 'v3',
    auth: auth,
  });
}

// Helper function to submit URL to Google Indexing API
async function submitUrlToGoogle(url, type = 'URL_UPDATED') {
  try {
    const indexing = getIndexingClient();
    
    const response = await indexing.urlNotifications.publish({
      requestBody: {
        url: url,
        type: type, // 'URL_UPDATED' or 'URL_DELETED'
      },
    });

    console.log(`✅ Submitted to Google: ${url}`);
    return { success: true, url, response: response.data };
  } catch (error) {
    console.error(`❌ Failed to submit ${url}:`, error.message);
    return { success: false, url, error: error.message };
  }
}

// Helper function to add delay between requests (avoid rate limits)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// PROTECTED ROUTE: Trigger reindexing of all regional pages
app.post('/api/admin/reindex', async (req, res) => {
  // Security check
  const providedSecret = req.headers['x-reindex-secret'] || req.query.secret;
  
  if (!providedSecret || providedSecret !== REINDEX_SECRET) {
    console.log('❌ Unauthorized reindex attempt');
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid or missing reindex secret'
    });
  }

  console.log('🚀 Starting Google Indexing API submission...');
  
  try {
    const results = {
      total: 0,
      successful: 0,
      failed: 0,
      urls: [],
    };

    // Submit homepage
    const homepageResult = await submitUrlToGoogle(`${BASE_URL}/`);
    results.urls.push(homepageResult);
    results.total++;
    if (homepageResult.success) results.successful++;
    else results.failed++;
    
    await delay(1000); // 1 second delay

    // Submit regional hub page
    const hubResult = await submitUrlToGoogle(`${BASE_URL}/costs`);
    results.urls.push(hubResult);
    results.total++;
    if (hubResult.success) results.successful++;
    else results.failed++;
    
    await delay(1000);

    // Submit all regional pages from regionalCostData.json
    for (const region of regionalData.regions) {
      const url = `${BASE_URL}/costs/${region.slug}`;
      const result = await submitUrlToGoogle(url);
      
      results.urls.push(result);
      results.total++;
      if (result.success) results.successful++;
      else results.failed++;
      
      // Rate limiting: Google allows 200 requests/minute for Indexing API
      // Add 1 second delay between requests to be safe (60 requests/minute)
      await delay(1000);
    }

    // Submit article pages
    const articles = [
      '/articles',
      '/articles/house-rewire-costs-uk-2026',
      '/articles/boiler-installation-costs-uk-2026',
      '/articles/loft-conversion-costs-uk-2026',
      '/articles/3-bed-house-renovation-costs-uk-2026',
    ];

    for (const article of articles) {
      const url = `${BASE_URL}${article}`;
      const result = await submitUrlToGoogle(url);
      
      results.urls.push(result);
      results.total++;
      if (result.success) results.successful++;
      else results.failed++;
      
      await delay(1000);
    }

    console.log(`✅ Reindexing complete: ${results.successful}/${results.total} successful`);

    return res.json({
      success: true,
      message: 'Reindexing request completed',
      summary: {
        total: results.total,
        successful: results.successful,
        failed: results.failed,
      },
      details: results.urls,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('❌ Reindexing error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Optional: Route to check indexing status of a URL
app.get('/api/admin/indexing-status', async (req, res) => {
  const providedSecret = req.headers['x-reindex-secret'] || req.query.secret;
  
  if (!providedSecret || providedSecret !== REINDEX_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }

  try {
    const indexing = getIndexingClient();
    const response = await indexing.urlNotifications.getMetadata({ url });
    
    return res.json({
      success: true,
      url,
      metadata: response.data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// END GOOGLE INDEXING API
// ============================================

// ============================================
// ANNOTATIONS — intervention log for analysis
// ============================================
// Records deliberate site changes so future GSC/GA4 analysis sessions
// can distinguish organic ranking movements from intervention effects.
//
// Protected by REINDEX_SECRET (same admin key as indexing routes).
// POST /api/admin/annotations  — create an annotation
// GET  /api/admin/annotations  — retrieve annotations (supports ?since=ISO&type=seo)

const Annotation = require('./models/Annotation');
const costIndexRoutes = require('./routes/costIndexRoutes');
app.use('/api/cost-index', costIndexRoutes);

// POST — log a new intervention
app.post('/api/admin/annotations', async (req, res) => {
  const providedSecret = req.headers['x-reindex-secret'] || req.query.secret;
  if (!providedSecret || providedSecret !== REINDEX_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const {
      date,
      type,
      description,
      affectedUrls,
      hypothesis,
      filesChanged
    } = req.body;

    if (!type || !description) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['type', 'description']
      });
    }

    const annotation = new Annotation({
      date: date ? new Date(date) : new Date(),
      type,
      description,
      affectedUrls:  Array.isArray(affectedUrls)  ? affectedUrls  : [],
      hypothesis:    Array.isArray(hypothesis)     ? hypothesis    : [],
      filesChanged:  Array.isArray(filesChanged)   ? filesChanged  : []
    });

    const saved = await annotation.save();
    console.log(`📝 Annotation saved: [${saved.type}] ${saved.description}`);

    return res.status(201).json({
      success: true,
      annotationId: saved._id,
      annotation: saved
    });

  } catch (error) {
    console.error('❌ Error saving annotation:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation failed',
        details: Object.keys(error.errors).map(k => ({
          field: k,
          message: error.errors[k].message
        }))
      });
    }
    return res.status(500).json({ error: 'Failed to save annotation' });
  }
});

// GET — retrieve annotations for analysis context
// Optional query params:
//   ?since=2026-03-11   — only annotations on or after this date
//   ?type=seo           — filter by type
//   ?limit=50           — max results (default 100)
app.get('/api/admin/annotations', async (req, res) => {
  const providedSecret = req.headers['x-reindex-secret'] || req.query.secret;
  if (!providedSecret || providedSecret !== REINDEX_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { since, type, limit = 100 } = req.query;

    const filter = {};
    if (since) filter.date = { $gte: new Date(since) };
    if (type)  filter.type = type;

    const annotations = await Annotation.find(filter)
      .sort({ date: -1 })
      .limit(Math.min(parseInt(limit), 500));

    return res.json({
      success: true,
      count: annotations.length,
      annotations
    });

  } catch (error) {
    console.error('❌ Error fetching annotations:', error);
    return res.status(500).json({ error: 'Failed to fetch annotations' });
  }
});

// PATCH — add retrospective outcome to an existing annotation
app.patch('/api/admin/annotations/:id', async (req, res) => {
  const providedSecret = req.headers['x-reindex-secret'] || req.query.secret;
  if (!providedSecret || providedSecret !== REINDEX_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { outcome } = req.body;
    if (!outcome) {
      return res.status(400).json({ error: 'outcome field is required' });
    }

    const annotation = await Annotation.findByIdAndUpdate(
      req.params.id,
      { outcome },
      { new: true }
    );

    if (!annotation) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    console.log(`📝 Annotation updated: ${annotation._id}`);
    return res.json({ success: true, annotation });

  } catch (error) {
    console.error('❌ Error updating annotation:', error);
    return res.status(500).json({ error: 'Failed to update annotation' });
  }
});

// ============================================
// END ANNOTATIONS
// ============================================

// ============================================
// GENERIC COLLECTION EXPORT — pull any MongoDB collection
// ============================================

// GET — list all collection names available to export
// e.g. /api/admin/collections?secret=xxxxxx
app.get('/api/admin/collections', async (req, res) => {
  const providedSecret = req.headers['x-reindex-secret'] || req.query.secret;
  if (!providedSecret || providedSecret !== REINDEX_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const collections = await mongoose.connection.db.listCollections().toArray();
    return res.json({
      success: true,
      collections: collections.map(c => c.name).sort()
    });
  } catch (error) {
    console.error('❌ Error listing collections:', error);
    return res.status(500).json({ error: 'Failed to list collections' });
  }
});

// GET — export documents from any named collection
// e.g. /api/admin/export/contractorclicks?secret=xxxxxx
// Optional query params:
//   ?since=2026-06-13       — filter on createdAt or timestamp >= this date (whichever field exists on the doc)
//   ?limit=1000             — max docs returned (default 1000, hard cap 20000)
//   ?filter={"actionType":"contact_requested"}  — raw JSON filter, merged with the since filter
app.get('/api/admin/export/:collection', async (req, res) => {
  const providedSecret = req.headers['x-reindex-secret'] || req.query.secret;
  if (!providedSecret || providedSecret !== REINDEX_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { collection } = req.params;
    const { since, limit = 1000, filter } = req.query;

    // Only allow real, existing collections - prevents querying arbitrary/system collections
    const existing = await mongoose.connection.db.listCollections({ name: collection }).toArray();
    if (existing.length === 0) {
      return res.status(404).json({
        error: `Collection "${collection}" not found`,
        hint: 'Use /api/admin/collections to see available collection names'
      });
    }

    let query = {};
    if (filter) {
      try {
        query = JSON.parse(filter);
      } catch (e) {
        return res.status(400).json({ error: 'filter must be valid JSON' });
      }
    }

    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: 'since must be a valid date' });
      }
      // Try createdAt first, fall back to timestamp - most schemas in this app use one or the other
      query.$or = [
        { createdAt: { $gte: sinceDate } },
        { timestamp: { $gte: sinceDate } }
      ];
    }

    const safeLimit = Math.min(parseInt(limit) || 1000, 20000);

    const docs = await mongoose.connection.db
      .collection(collection)
      .find(query)
      .limit(safeLimit)
      .toArray();

    console.log(`📤 Exported ${docs.length} docs from "${collection}"`);

    return res.json({
      success: true,
      collection,
      count: docs.length,
      [collection]: docs
    });

  } catch (error) {
    console.error(`❌ Error exporting collection "${req.params.collection}":`, error);
    return res.status(500).json({ error: 'Failed to export collection' });
  }
});

// ============================================
// END GENERIC COLLECTION EXPORT
// ============================================

// ============================================
// BLOG — reaction votes + email subscribers
// ============================================

// Blog reaction schema
const blogReactionSchema = new mongoose.Schema(
  {
    slug:      { type: String, required: true, trim: true },
    value:     { type: String, enum: ['yes', 'no'], required: true },
    anonIp:    { type: String },
    userAgent: { type: String },
  },
  { timestamps: true }
);
blogReactionSchema.index({ slug: 1, value: 1 });
blogReactionSchema.index({ slug: 1, anonIp: 1, createdAt: 1 });
const BlogReaction = mongoose.model('BlogReaction', blogReactionSchema);

// POST /api/blog-reaction
app.post('/api/blog-reaction', async (req, res) => {
  try {
    const { slug, value } = req.body;

    if (!slug || typeof slug !== 'string' || slug.trim().length === 0) {
      return res.status(400).json({ error: 'slug is required' });
    }
    if (!['yes', 'no'].includes(value)) {
      return res.status(400).json({ error: 'value must be yes or no' });
    }

    const rawIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress || '';
    const anonIp = rawIp.split('.').slice(0, 3).join('.') + '.x';

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const existing = await BlogReaction.findOne({
      slug: slug.trim(),
      anonIp,
      createdAt: { $gte: dayStart },
    });

    if (existing) {
      return res.status(200).json({ saved: false, reason: 'duplicate' });
    }

    await BlogReaction.create({
      slug:      slug.trim(),
      value,
      anonIp,
      userAgent: req.headers['user-agent']?.slice(0, 200) || '',
    });

    console.log(`📝 Blog reaction saved: slug=${slug} value=${value}`);
    return res.status(201).json({ saved: true });

  } catch (err) {
    console.error('❌ Error saving blog reaction:', err);
    return res.status(500).json({ error: 'Failed to save reaction' });
  }
});

// POST /api/subscribe
const BlogSubscriber = require('./models/BlogSubscriber');

app.post('/api/subscribe', async (req, res) => {
  try {
    const { name, email, source, post } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (!validator.isEmail(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const result = await BlogSubscriber.findOneAndUpdate(
      { email: cleanEmail },
      {
        $set: {
          name:      name?.trim().slice(0, 100) || '',
          source:    source || 'blog',
          updatedAt: new Date(),
        },
        $setOnInsert: {
          email:     cleanEmail,
          post:      post || null,
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    const isNew = result.createdAt.getTime() === result.updatedAt?.getTime();
    console.log(`📧 Blog subscriber ${isNew ? 'added' : 'updated'}: ${cleanEmail} (source=${source}, post=${post})`);
    return res.status(isNew ? 201 : 200).json({ saved: true });

  } catch (err) {
    console.error('❌ Error saving subscriber:', err);
    return res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// ============================================
// END BLOG
// ============================================

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
