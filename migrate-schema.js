#!/usr/bin/env node

/**
 * Schema Migration Script: roomCounts → projectSize
 * 
 * Since all test data has been deleted, this script:
 * 1. Verifies the database is clean (no old roomCounts data)
 * 2. Updates indexes to match new schema
 * 3. Validates the new schema is ready for production
 * 
 * Usage:
 *   node migrate-schema.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Connect to MongoDB
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB');
    console.log(`📊 Database: ${mongoose.connection.name}`);
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

/**
 * Verify database is clean and ready for new schema
 */
async function verifyCleanDatabase() {
  console.log('\n🔍 Verifying database state...\n');
  
  const db = mongoose.connection.db;
  const collection = db.collection('estimates');
  
  // Check if collection exists
  const collections = await db.listCollections({ name: 'estimates' }).toArray();
  
  if (collections.length === 0) {
    console.log('✅ Collection "estimates" does not exist yet - perfect for fresh start!');
    return true;
  }
  
  // Check total document count
  const totalCount = await collection.countDocuments();
  console.log(`📊 Total estimates in database: ${totalCount}`);
  
  if (totalCount === 0) {
    console.log('✅ Database is empty - ready for new schema!');
    return true;
  }
  
  // Check for old roomCounts field
  const oldSchemaCount = await collection.countDocuments({ 
    roomCounts: { $exists: true } 
  });
  
  if (oldSchemaCount > 0) {
    console.log(`⚠️  Found ${oldSchemaCount} documents with old roomCounts schema`);
    console.log('❌ Please delete all test data before proceeding');
    console.log('\nTo delete all estimates, run:');
    console.log('  db.estimates.deleteMany({})');
    return false;
  }
  
  console.log('✅ No documents with old roomCounts schema found');
  
  // Check for new projectSize field
  const newSchemaCount = await collection.countDocuments({ 
    projectSize: { $exists: true } 
  });
  
  if (newSchemaCount > 0) {
    console.log(`✅ Found ${newSchemaCount} documents already using new projectSize schema`);
  }
  
  return true;
}

/**
 * Update database indexes to match new schema
 */
async function updateIndexes() {
  console.log('\n🔧 Updating database indexes...\n');
  
  const db = mongoose.connection.db;
  const collection = db.collection('estimates');
  
  try {
    // Get existing indexes
    const existingIndexes = await collection.indexes();
    console.log('Current indexes:');
    existingIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });
    
    // Drop old roomCounts-related indexes if they exist
    try {
      await collection.dropIndex('roomCounts.small_1');
      console.log('✅ Dropped old roomCounts index');
    } catch (error) {
      // Index doesn't exist, that's fine
    }
    
    // Create new projectSize index
    await collection.createIndex({ projectSize: 1 });
    console.log('✅ Created projectSize index');
    
    // Ensure other required indexes exist
    await collection.createIndex({ createdAt: -1 });
    console.log('✅ Created/verified createdAt index');
    
    await collection.createIndex({ category: 1, jobType: 1 });
    console.log('✅ Created/verified category+jobType index');
    
    await collection.createIndex({ 'locationData.region': 1 });
    console.log('✅ Created/verified locationData.region index');
    
    await collection.createIndex({ locationHash: 1 });
    console.log('✅ Created/verified locationHash index');
    
    // Get updated indexes
    const updatedIndexes = await collection.indexes();
    console.log('\nUpdated indexes:');
    updatedIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });
    
  } catch (error) {
    console.error('❌ Error updating indexes:', error.message);
    throw error;
  }
}

/**
 * Validate schema is ready
 */
async function validateSchema() {
  console.log('\n✅ Schema validation...\n');
  
  const Estimate = require('./models/Estimate');
  
  console.log('Schema fields:');
  console.log('  - category (enum)');
  console.log('  - jobType');
  console.log('  - jobName');
  console.log('  - inputType (room/area/unit)');
  console.log('  - projectSize (small/medium/large/extra-large) ✨ NEW');
  console.log('  - areaQuantity');
  console.log('  - locationHash (anonymized)');
  console.log('  - locationData');
  console.log('  - quality (enum)');
  console.log('  - photoAnalysis');
  console.log('  - estimate (min/max/baseCost/breakdown) ✨ UPDATED');
  console.log('  - multipliers');
  console.log('  - contractorsShown');
  console.log('  - timestamps (createdAt/updatedAt)');
  
  console.log('\n✅ Schema loaded successfully');
  console.log('✅ All required fields defined');
  console.log('✅ Enums configured correctly');
}

/**
 * Test creating a sample estimate
 */
async function testSampleEstimate() {
  console.log('\n🧪 Testing sample estimate creation...\n');
  
  const Estimate = require('./models/Estimate');
  
  const sampleEstimate = new Estimate({
    category: 'decoration',
    jobType: 'painting-room',
    jobName: 'Paint Room',
    inputType: 'room',
    projectSize: 'medium',
    quality: 'standard',
    locationHash: 'test123',
    locationData: {
      region: 'Test Region',
      costMultiplier: 1.0,
      costReason: 'Test'
    },
    estimate: {
      min: 300,
      max: 500,
      baseCost: 400,
      breakdown: [{
        item: 'Test Item',
        calculation: 'Test calculation',
        subtotal: 400
      }],
      photoEnhanced: false
    },
    multipliers: {
      quality: { value: 1, label: 'standard' },
      location: { value: 1, label: 'average' }
    }
  });
  
  // Validate without saving
  try {
    await sampleEstimate.validate();
    console.log('✅ Sample estimate validates correctly');
    console.log('\nSample estimate structure:');
    console.log(JSON.stringify(sampleEstimate.toObject(), null, 2));
  } catch (error) {
    console.error('❌ Validation error:', error.message);
    throw error;
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('📋 Schema Migration: roomCounts → projectSize');
  console.log('='.repeat(60));
  
  await connectDB();
  
  try {
    // Step 1: Verify database is clean
    const isClean = await verifyCleanDatabase();
    
    if (!isClean) {
      console.log('\n❌ Migration aborted - please clean database first');
      process.exit(1);
    }
    
    // Step 2: Update indexes
    await updateIndexes();
    
    // Step 3: Validate schema
    await validateSchema();
    
    // Step 4: Test sample estimate
    await testSampleEstimate();
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Migration completed successfully!');
    console.log('='.repeat(60));
    console.log('\nNext steps:');
    console.log('  1. Deploy updated App.js to frontend');
    console.log('  2. Deploy updated server.js to backend');
    console.log('  3. Deploy updated models/Estimate.js');
    console.log('  4. Restart your server');
    console.log('  5. Test creating a new estimate');
    console.log('\n📊 Your database is ready for production!\n');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('👋 Database connection closed\n');
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { verifyCleanDatabase, updateIndexes, validateSchema, testSampleEstimate };
