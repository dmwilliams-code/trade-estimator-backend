// services/emailService.js
// Email service using Namecheap Private Email via SMTP

const nodemailer = require('nodemailer');

// Validate SMTP credentials
if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.error('❌ SMTP credentials not set!');
  console.error('Required: SMTP_HOST, SMTP_USER, SMTP_PASS');
}

// Create SMTP transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: true, // use SSL
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Log on startup
console.log('📧 Email service initialized (SMTP)');
console.log('   SMTP Host:', process.env.SMTP_HOST || 'NOT SET');
console.log('   SMTP User:', process.env.SMTP_USER || 'NOT SET');
console.log('   SMTP Port:', process.env.SMTP_PORT || 465);

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
    
    console.log('📧 Sending via SMTP...');
    
    // Send email
    const info = await transporter.sendMail({
      from: `"EstimateAI" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Your ${jobName} Estimate is Ready`,
      text: textContent,
      html: htmlContent
    });
    
    console.log('✅ Email sent successfully!');
    console.log('   Message ID:', info.messageId);
    console.log('   Recipient:', email);
    
    return info;
    
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
  
  // Calculate estimate range (if we have estimate data)
  let estimateHTML = '';
  if (estimateData && estimateData.total) {
    const low = (estimateData.total * 0.9).toFixed(0);
    const high = (estimateData.total * 1.1).toFixed(0);
    
    estimateHTML = `
      <div style="background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); color: white; padding: 30px; border-radius: 12px; text-align: center; margin: 30px 0;">
        <h2 style="margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Your Estimated Cost Range</h2>
        <p style="margin: 0; font-size: 36px; font-weight: 800;">£${parseInt(low).toLocaleString()} - £${parseInt(high).toLocaleString()}</p>
        <p style="margin: 10px 0 0 0; font-size: 14px; opacity: 0.9;">For ${quality.charAt(0).toUpperCase() + quality.slice(1)} Quality</p>
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
    const low = (estimateData.total * 0.9).toFixed(0);
    const high = (estimateData.total * 1.1).toFixed(0);
    estimateText = `
YOUR ESTIMATED COST RANGE
£${parseInt(low).toLocaleString()} - £${parseInt(high).toLocaleString()}
For ${quality.charAt(0).toUpperCase() + quality.slice(1)} Quality
`;
  }
  
  return `
EstimateAI - Your ${jobName} Estimate

Thank you for using EstimateAI!

${estimateText}

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

// Verify connection on startup
transporter.verify(function(error, success) {
  if (error) {
    console.error('❌ SMTP connection failed:', error.message);
  } else {
    console.log('✅ SMTP server is ready to send emails');
  }
});

module.exports = {
  sendWelcomeEmail
};
