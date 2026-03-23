const mongoose = require('mongoose');
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');

// -------------------------------------------------------
// CONFIG — uses same .env as your backend
// -------------------------------------------------------
require('dotenv').config();
const MONGODB_URI = process.env.MONGODB_URI;
// -------------------------------------------------------

const AnnotationSchema = new mongoose.Schema({}, { strict: false });
const Annotation = mongoose.model('Annotation', AnnotationSchema, 'annotations');

async function exportAnnotations() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.');

    const annotations = await Annotation.find({}).sort({ date: -1 }).lean();
    console.log(`Found ${annotations.length} annotations.`);

    if (annotations.length === 0) {
      console.log('No annotations found. Exiting.');
      process.exit(0);
    }

    const rows = annotations.map(doc => ({
      id:           doc._id.toString(),
      date:         doc.date ? new Date(doc.date).toISOString().split('T')[0] : '',
      type:         doc.type || '',
      description:  doc.description || '',
      affectedUrls: Array.isArray(doc.affectedUrls)  ? doc.affectedUrls.join(' | ')  : '',
      hypothesis:   Array.isArray(doc.hypothesis)     ? doc.hypothesis.join(' | ')    : '',
      filesChanged: Array.isArray(doc.filesChanged)   ? doc.filesChanged.join(' | ')  : '',
      outcome:      doc.outcome || '',
      createdAt:    doc.createdAt ? new Date(doc.createdAt).toISOString() : '',
    }));

    const outputPath = path.join(__dirname, 'annotations-export.csv');

    const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: [
        { id: 'id',           title: 'id' },
        { id: 'date',         title: 'date' },
        { id: 'type',         title: 'type' },
        { id: 'description',  title: 'description' },
        { id: 'affectedUrls', title: 'affectedUrls' },
        { id: 'hypothesis',   title: 'hypothesis' },
        { id: 'filesChanged', title: 'filesChanged' },
        { id: 'outcome',      title: 'outcome' },
        { id: 'createdAt',    title: 'createdAt' },
      ],
    });

    await csvWriter.writeRecords(rows);
    console.log(`✅ Export complete: ${outputPath}`);
    console.log(`   Rows: ${rows.length}`);

  } catch (err) {
    console.error('Export failed:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

exportAnnotations();
