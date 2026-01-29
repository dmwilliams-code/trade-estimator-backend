// services/emailService.js
// Email service using Resend (works over HTTPS - no SMTP port blocking)

const { Resend } = require('resend');

// Validate API key
if (!process.env.RESEND_API_KEY) {
  console.error('❌ RESEND_API_KEY environment variable is not set!');
  console.error('Please add RESEND_API_KEY to your environment variables');
}

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Log on startup
console.log('📧 Email service initialized (Resend)');
console.log('   API Key present:', !!process.env.RESEND_API_KEY);
console.log('   API Key prefix:', process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.substring(0, 5) + '...' : 'NOT SET');

/**
 * Send welcome email with estimate details to new lead
 */
async function sendWelcomeEmail(leadData, estimateData = null) {
  try {
    const { email, jobName, category, quality, hasPhotos } = leadData;
    
    console.log('📤 Preparing welcome email for:', email);
    
    // Build email content
    const htmlContent = buildWelcomeEmailHTML(leadData, estimateData);
    const textContent = buildWelcomeEmailText(leadData, estimateData);
    
    console.log('📧 Calling Resend API...');
    
    // Send email - DKIM verified, SPF warning is OK
    const { data, error } = await resend.emails.send({
      from: 'EstimateAI <estimates@getestimateai.co.uk>',
      to: [email],
      subject: `Your ${jobName} Estimate is Ready`,
      html: htmlContent,
      text: textContent
    });
    
    // Check for errors
    if (error) {
      console.error('❌ Resend API error:', error);
      throw new Error(`Resend API error: ${JSON.stringify(error)}`);
    }
    
    // Validate response
    if (!data || !data.id) {
      console.error('⚠️ Invalid Resend response:', { data, error });
      throw new Error('Resend did not return a valid message ID');
    }
    
    console.log('✅ Email sent successfully!');
    console.log('   Message ID:', data.id);
    console.log('   Recipient:', email);
    
    return data;
    
  } catch (error) {
    console.error('❌ Failed to send welcome email');
    console.error('   Error type:', error.constructor.name);
    console.error('   Error message:', error.message);
    console.error('   Full error:', error);
    throw error;
  }
}

/**
 * Build HTML email content
 */
function buildWelcomeEmailHTML(leadData, estimateData) {
  const { jobName, quality, hasPhotos } = leadData;
  
  // Build estimate section with exact costs
  let estimateHTML = '';
  if (estimateData && estimateData.total) {
    const photoEnhanced = estimateData.photoEnhanced ? ' (AI-Enhanced)' : '';
    const confidence = estimateData.confidence || 60;
    
    estimateHTML = `
      <div style="background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); color: white; padding: 30px; border-radius: 12px; text-align: center; margin: 30px 0;">
        <h2 style="margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Your Estimated Total Cost${photoEnhanced}</h2>
        <p style="margin: 0; font-size: 42px; font-weight: 800;">£${estimateData.total.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        <p style="margin: 15px 0 0 0; font-size: 14px; opacity: 0.9;">For ${quality.charAt(0).toUpperCase() + quality.slice(1)} Quality</p>
        ${estimateData.photoEnhanced ? `<p style="margin: 5px 0 0 0; font-size: 12px; opacity: 0.8;">${confidence}% confidence</p>` : ''}
      </div>
      
      <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #1e293b;">Cost Breakdown</h3>
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #e5e7eb;">
          <span style="color: #64748b; font-size: 14px;">Labour</span>
          <span style="color: #1e293b; font-weight: 600; font-size: 14px;">£${estimateData.labour.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #e5e7eb;">
          <span style="color: #64748b; font-size: 14px;">Materials</span>
          <span style="color: #1e293b; font-weight: 600; font-size: 14px;">£${estimateData.materials.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #1e293b; font-weight: 700; font-size: 16px;">Total</span>
          <span style="color: #0d9488; font-weight: 800; font-size: 16px;">£${estimateData.total.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
      </div>
      
      <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px; margin: 20px 0;">
        <p style="margin: 0; font-size: 14px; color: #374151;">
          <strong>Please note:</strong> This is an ${estimateData.photoEnhanced ? 'AI-enhanced ' : ''}indicative estimate. Actual costs may vary based on specific requirements, site conditions, and individual contractor rates.
        </p>
      </div>
    `;
  }
  
  // Build contractors section
  let contractorsHTML = '';
  if (leadData.contractors && leadData.contractors.length > 0) {
    const contractorCards = leadData.contractors.map(contractor => `
      <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
          <h4 style="margin: 0; font-size: 16px; color: #1e293b; font-weight: 700;">${contractor.name}</h4>
          ${contractor.rating ? `<span style="background: #f0fdfa; color: #075F58; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">⭐ ${contractor.rating}/5</span>` : ''}
        </div>
        ${contractor.totalReviews ? `<p style="margin: 0 0 8px 0; font-size: 12px; color: #64748b;">${contractor.totalReviews} reviews</p>` : ''}
        ${contractor.address ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: #64748b;">📍 ${contractor.address}</p>` : ''}
        ${contractor.phoneNumber ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: #64748b;">📞 ${contractor.phoneNumber}</p>` : ''}
        <div style="margin-top: 12px;">
          ${contractor.mapsUrl ? `<a href="${contractor.mapsUrl}" style="display: inline-block; background: #0d9488; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; margin-right: 8px;">View on Google Maps</a>` : ''}
          ${contractor.website ? `<a href="${contractor.website}" style="display: inline-block; background: white; color: #0d9488; border: 1px solid #0d9488; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">Visit Website</a>` : ''}
        </div>
      </div>
    `).join('');
    
    contractorsHTML = `
      <div style="margin: 30px 0;">
        <h3 style="margin: 0 0 15px 0; font-size: 18px; color: #1e293b;">Recommended Local Contractors</h3>
        <p style="margin: 0 0 15px 0; font-size: 14px; color: #64748b;">We've found these highly-rated contractors near you:</p>
        ${contractorCards}
      </div>
    `;
  }
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 40px 30px;">
    
    <div style="text-align: center; margin-bottom: 30px;">
      <h1 style="margin: 0; font-size: 28px; font-weight: 800; color: #0d9488;">EstimateAI</h1>
      <p style="margin: 10px 0 0 0; color: #64748b;">AI-Powered Cost Estimates</p>
    </div>
    
    <h2 style="margin: 0 0 10px 0; font-size: 24px; color: #1e293b;">Your ${jobName} Estimate</h2>
    <p style="margin: 0 0 30px 0; color: #64748b; font-size: 16px;">Thank you for using EstimateAI!</p>
    
    ${estimateHTML}
    
    ${contractorsHTML}
    
    <div style="margin: 30px 0;">
      <h3 style="margin: 0 0 15px 0; font-size: 18px; color: #1e293b;">What's Next?</h3>
      
      <div style="background: #f0fdfa; border-left: 4px solid #0d9488; padding: 15px; border-radius: 4px; margin-bottom: 15px;">
        <h4 style="margin: 0 0 5px 0; font-size: 16px; color: #075F58;">1. Get Multiple Quotes</h4>
        <p style="margin: 0; font-size: 14px; color: #374151;">We recommend getting at least 3 quotes from local contractors.</p>
      </div>
      
      <div style="background: #f0fdfa; border-left: 4px solid #0d9488; padding: 15px; border-radius: 4px; margin-bottom: 15px;">
        <h4 style="margin: 0 0 5px 0; font-size: 16px; color: #075F58;">2. Check References</h4>
        <p style="margin: 0; font-size: 14px; color: #374151;">Always verify contractor credentials and read recent reviews.</p>
      </div>
      
      <div style="background: #f0fdfa; border-left: 4px solid #0d9488; padding: 15px; border-radius: 4px;">
        <h4 style="margin: 0 0 5px 0; font-size: 16px; color: #075F58;">3. Get It in Writing</h4>
        <p style="margin: 0; font-size: 14px; color: #374151;">Ensure you have a detailed written quote with all costs included.</p>
      </div>
    </div>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="https://getestimateai.co.uk" style="display: inline-block; background: #0d9488; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">Get Another Estimate</a>
    </div>
    
    <div style="border-top: 1px solid #e5e7eb; margin-top: 40px; padding-top: 20px; text-align: center;">
      <p style="margin: 0; color: #9ca3af; font-size: 12px;">
        Questions? <a href="mailto:${process.env.SMTP_USER}" style="color: #0d9488;">${process.env.SMTP_USER}</a>
      </p>
      <p style="margin: 10px 0 0 0; color: #9ca3af; font-size: 12px;">
        <a href="mailto:${process.env.SMTP_USER}?subject=Unsubscribe" style="color: #9ca3af;">Unsubscribe</a>
      </p>
    </div>
    
  </div>
</body>
</html>
  `;
}

/**
 * Build plain text email content
 */
function buildWelcomeEmailText(leadData, estimateData) {
  const { jobName, quality } = leadData;
  
  let estimateText = '';
  if (estimateData && estimateData.total) {
    const photoEnhanced = estimateData.photoEnhanced ? ' (AI-Enhanced)' : '';
    estimateText = `
YOUR ESTIMATED TOTAL COST${photoEnhanced}
£${estimateData.total.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
For ${quality.charAt(0).toUpperCase() + quality.slice(1)} Quality

COST BREAKDOWN:
Labour:    £${estimateData.labour.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Materials: £${estimateData.materials.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Total:     £${estimateData.total.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}

Please note: This is an ${estimateData.photoEnhanced ? 'AI-enhanced ' : ''}indicative estimate. Actual costs may vary.
`;
  }
  
  let contractorsText = '';
  if (leadData.contractors && leadData.contractors.length > 0) {
    const contractorList = leadData.contractors.map((c, i) => `
${i + 1}. ${c.name}
   ${c.rating ? `Rating: ${c.rating}/5 (${c.totalReviews} reviews)` : ''}
   ${c.address ? `Address: ${c.address}` : ''}
   ${c.phoneNumber ? `Phone: ${c.phoneNumber}` : ''}
   ${c.mapsUrl ? `Maps: ${c.mapsUrl}` : ''}
   ${c.website ? `Website: ${c.website}` : ''}
`).join('\n');
    
    contractorsText = `
RECOMMENDED LOCAL CONTRACTORS:
${contractorList}
`;
  }
  
  return `
EstimateAI - Your ${jobName} Estimate

Thank you for using EstimateAI!

${estimateText}

${contractorsText}

WHAT'S NEXT?

1. Get Multiple Quotes
We recommend getting at least 3 quotes from local contractors.

2. Check References
Always verify contractor credentials and read recent reviews.

3. Get It in Writing
Ensure you have a detailed written quote with all costs included.

Get another estimate: https://getestimateai.co.uk

Questions? Contact us at ${process.env.SMTP_USER}
Unsubscribe: ${process.env.SMTP_USER}

© 2026 EstimateAI
  `;
}

module.exports = {
  sendWelcomeEmail
};
