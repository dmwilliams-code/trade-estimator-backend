const mongoose = require('mongoose');
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');

// -------------------------------------------------------
// CONFIG — paste your Atlas connection string here
// -------------------------------------------------------
const MONGODB_URI = 'mongodb+srv://estimator-admin:Msgp5lZHcCJdr91i@estimateaicluster.eg9ssbu.mongodb.net/trade-estimator?retryWrites=true&w=majority';
// -------------------------------------------------------

const EstimateSchema = new mongoose.Schema({}, { strict: false });
const Estimate = mongoose.model('Estimate', EstimateSchema, 'estimates');

function flattenObject(obj, prefix = '') {
  return Object.keys(obj || {}).reduce((acc, key) => {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      Object.assign(acc, flattenObject(val, fullKey));
    } else if (Array.isArray(val)) {
      acc[fullKey] = JSON.stringify(val);
    } else {
      acc[fullKey] = val;
    }
    return acc;
  }, {});
}

async function exportEstimates() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.');

    const estimates = await Estimate.find({}).lean();
    console.log(`Found ${estimates.length} estimates.`);

    if (estimates.length === 0) {
      console.log('No estimates found. Exiting.');
      process.exit(0);
    }

    // Flatten all docs and collect every unique key
    const flattened = estimates.map(doc => {
      const { _id, __v, ...rest } = doc;
      return { id: _id.toString(), ...flattenObject(rest) };
    });

    const allKeys = [...new Set(flattened.flatMap(Object.keys))];

    const outputPath = path.join(__dirname, 'estimates-export.csv');

    const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: allKeys.map(key => ({ id: key, title: key })),
    });

    await csvWriter.writeRecords(flattened);
    console.log(`✅ Export complete: ${outputPath}`);
    console.log(`   Rows: ${flattened.length} | Columns: ${allKeys.length}`);

  } catch (err) {
    console.error('Export failed:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

exportEstimates();
