require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3001;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});