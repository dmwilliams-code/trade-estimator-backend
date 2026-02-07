// google-indexing-submit-trades.js
// Submit all trade-specific pages to Google Indexing API for faster crawling
// Run with: node google-indexing-submit-trades.js

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Load regional cost data
const regionalCostData = require('./regionalCostData.json');

const DOMAIN = 'https://getestimateai.co.uk';

// Load your service account key
// Download this from Google Cloud Console > IAM & Admin > Service Accounts
const SERVICE_ACCOUNT_KEY = require('./service-account-key.json');

// ADD THESE DEBUG LINES:
console.log('Service account key loaded:', !!SERVICE_ACCOUNT_KEY);
console.log('Client email:', SERVICE_ACCOUNT_KEY.client_email);
console.log('Has private key:', !!SERVICE_ACCOUNT_KEY.private_key);

async function submitToIndexingAPI() {
  try {
    // Set up JWT client for authentication
    const jwtClient = new google.auth.JWT({
  email: SERVICE_ACCOUNT_KEY.client_email,
  key: SERVICE_ACCOUNT_KEY.private_key,
  scopes: ['https://www.googleapis.com/auth/indexing']
});

    // Authorize the client
    await jwtClient.authorize();

    const indexing = google.indexing({
      version: 'v3',
      auth: jwtClient,
    });

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    console.log('🚀 Starting Google Indexing API submission...\n');

    // Submit regional overview pages
    console.log('📍 Submitting regional overview pages...');
    for (const region of regionalCostData.regions) {
      const url = `${DOMAIN}/costs/${region.slug}`;
      
      try {
        await indexing.urlNotifications.publish({
          requestBody: {
            url: url,
            type: 'URL_UPDATED',
          },
        });
        successCount++;
        console.log(`✅ ${url}`);
        
        // Rate limiting: wait 100ms between requests to avoid hitting quota
        await sleep(100);
      } catch (error) {
        errorCount++;
        errors.push({ url, error: error.message });
        console.log(`❌ ${url}: ${error.message}`);
      }
    }

    // Submit trade-specific pages (300 pages)
    console.log('\n🔧 Submitting trade-specific pages...');
    console.log(`Total to submit: ${regionalCostData.regions.length * Object.keys(regionalCostData.trades).length} pages\n`);

    let pageCount = 0;
    const totalPages = regionalCostData.regions.length * Object.keys(regionalCostData.trades).length;

    for (const region of regionalCostData.regions) {
      for (const tradeSlug of Object.keys(regionalCostData.trades)) {
        const url = `${DOMAIN}/costs/${region.slug}/${tradeSlug}`;
        pageCount++;

        try {
          await indexing.urlNotifications.publish({
            requestBody: {
              url: url,
              type: 'URL_UPDATED',
            },
          });
          successCount++;
          
          // Progress indicator every 10 pages
          if (pageCount % 10 === 0) {
            console.log(`📊 Progress: ${pageCount}/${totalPages} (${Math.round(pageCount/totalPages*100)}%)`);
          }
          
          // Rate limiting: wait 100ms between requests
          await sleep(100);
        } catch (error) {
          errorCount++;
          errors.push({ url, error: error.message });
          
          // Log errors for important pages
          if (errorCount < 10) {
            console.log(`❌ ${url}: ${error.message}`);
          }
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUBMISSION SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successful submissions: ${successCount}`);
    console.log(`❌ Failed submissions: ${errorCount}`);
    console.log(`📈 Success rate: ${Math.round(successCount/(successCount+errorCount)*100)}%`);
    
    if (errors.length > 0 && errors.length <= 20) {
      console.log('\n❌ Errors:');
      errors.forEach(err => {
        console.log(`   ${err.url}: ${err.error}`);
      });
    } else if (errors.length > 20) {
      console.log(`\n⚠️  ${errors.length} errors occurred. Check logs for details.`);
    }

    console.log('\n✨ Submission complete!');
    console.log('\n💡 Note: Google may take 24-48 hours to crawl submitted URLs.');
    console.log('📊 Monitor indexing status in Google Search Console.');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the submission
submitToIndexingAPI();

// SETUP INSTRUCTIONS:
//
// 1. Enable Google Indexing API:
//    - Go to https://console.cloud.google.com
//    - Enable "Web Search Indexing API"
//    - Add your site to Google Search Console first
//
// 2. Create Service Account:
//    - Go to IAM & Admin > Service Accounts
//    - Create new service account
//    - Download JSON key file and save as service-account-key.json
//
// 3. Grant Permissions in Search Console:
//    - Go to Search Console > Settings > Users and permissions
//    - Add the service account email as an Owner
//
// 4. Install dependencies:
//    npm install googleapis
//
// 5. Run script:
//    node google-indexing-submit-trades.js
//
// QUOTA LIMITS:
// - 200 requests per day for URL updates
// - Consider batching submissions over multiple days for 300+ pages
// - Or request quota increase from Google Cloud Console

module.exports = { submitToIndexingAPI };
