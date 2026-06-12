// google-indexing-submit-march2026.js
// Submits all URLs changed in the March 2026 deployment to Google Indexing API
// Run with: node google-indexing-submit-march2026.js

const { google } = require('googleapis');
const SERVICE_ACCOUNT_KEY = require('./service-account-key.json');

const URLS = [
  // New article
  'https://getestimateai.co.uk/articles/why-do-electricians-charge-so-much-uk-2026',

  // Glasgow — content + meta updated
  'https://getestimateai.co.uk/costs/glasgow',

  // All other regional pages — meta titles, descriptions, and widgets updated
  'https://getestimateai.co.uk/costs/london-central',
  'https://getestimateai.co.uk/costs/london-greater',
  'https://getestimateai.co.uk/costs/birmingham',
  'https://getestimateai.co.uk/costs/manchester',
  'https://getestimateai.co.uk/costs/liverpool',
  'https://getestimateai.co.uk/costs/leeds',
  'https://getestimateai.co.uk/costs/sheffield',
  'https://getestimateai.co.uk/costs/edinburgh',
  'https://getestimateai.co.uk/costs/bristol',
  'https://getestimateai.co.uk/costs/cardiff',
  'https://getestimateai.co.uk/costs/nottingham',
  'https://getestimateai.co.uk/costs/leicester',
  'https://getestimateai.co.uk/costs/coventry',
  'https://getestimateai.co.uk/costs/newcastle',
  'https://getestimateai.co.uk/costs/sunderland',
  'https://getestimateai.co.uk/costs/portsmouth',
  'https://getestimateai.co.uk/costs/southampton',
  'https://getestimateai.co.uk/costs/brighton',
  'https://getestimateai.co.uk/costs/plymouth',
  'https://getestimateai.co.uk/costs/derby',
  'https://getestimateai.co.uk/costs/stoke-on-trent',
  'https://getestimateai.co.uk/costs/wolverhampton',
  'https://getestimateai.co.uk/costs/hull',
  'https://getestimateai.co.uk/costs/reading',
  'https://getestimateai.co.uk/costs/preston',
  'https://getestimateai.co.uk/costs/middlesbrough',
  'https://getestimateai.co.uk/costs/swansea',
  'https://getestimateai.co.uk/costs/newport',
  'https://getestimateai.co.uk/costs/luton',
  'https://getestimateai.co.uk/costs/exeter',
  'https://getestimateai.co.uk/costs/cheltenham',
  'https://getestimateai.co.uk/costs/bournemouth',
  'https://getestimateai.co.uk/costs/swindon',
  'https://getestimateai.co.uk/costs/dundee',
  'https://getestimateai.co.uk/costs/blackpool',
  'https://getestimateai.co.uk/costs/peterborough',
  'https://getestimateai.co.uk/costs/oxford',
  'https://getestimateai.co.uk/costs/slough',
  'https://getestimateai.co.uk/costs/york',
  'https://getestimateai.co.uk/costs/cambridge',
  'https://getestimateai.co.uk/costs/ipswich',
  'https://getestimateai.co.uk/costs/birkenhead',
  'https://getestimateai.co.uk/costs/telford',
  'https://getestimateai.co.uk/costs/gloucester',
  'https://getestimateai.co.uk/costs/watford',
  'https://getestimateai.co.uk/costs/colchester',
  'https://getestimateai.co.uk/costs/bath',
  'https://getestimateai.co.uk/costs/milton-keynes',
  'https://getestimateai.co.uk/costs/aberdeen',
  'https://getestimateai.co.uk/costs/norwich',
  'https://getestimateai.co.uk/costs/canterbury',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function submitUrls() {
  console.log('Service account:', SERVICE_ACCOUNT_KEY.client_email);
  console.log(`\n🚀 Submitting ${URLS.length} URLs to Google Indexing API...\n`);

  const jwtClient = new google.auth.JWT({
    email: SERVICE_ACCOUNT_KEY.client_email,
    key: SERVICE_ACCOUNT_KEY.private_key,
    scopes: ['https://www.googleapis.com/auth/indexing'],
  });

  await jwtClient.authorize();

  const indexing = google.indexing({ version: 'v3', auth: jwtClient });

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const url of URLS) {
    try {
      await indexing.urlNotifications.publish({
        requestBody: { url, type: 'URL_UPDATED' },
      });
      successCount++;
      console.log(`✅ ${url}`);
    } catch (error) {
      errorCount++;
      errors.push({ url, error: error.message });
      console.log(`❌ ${url}: ${error.message}`);
    }

    // 100ms between requests to stay within quota
    await sleep(100);
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 SUBMISSION SUMMARY — March 2026 deployment');
  console.log('='.repeat(60));
  console.log(`✅ Successful: ${successCount}`);
  console.log(`❌ Failed:     ${errorCount}`);
  console.log(`📈 URLs submitted: ${successCount} of ${URLS.length}`);

  if (errors.length > 0) {
    console.log('\n❌ Errors:');
    errors.forEach(e => console.log(`   ${e.url}: ${e.error}`));
  }

  console.log('\n✨ Done. Google typically crawls submitted URLs within a few hours.');
  console.log('📊 Monitor progress in Google Search Console > URL Inspection.\n');
}

submitUrls().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
