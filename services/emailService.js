// services/emailService.js
// Email service using Resend (recommended for simplicity)

const Resend = require('resend').Resend;

// Initialize Resend with your API key
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send welcome email with estimate details to new lead
 * @param {Object} leadData - Lead information
 * @param {Object} estimateData - Estimate details (optional)
 * @returns {Promise} - Send result
 */
async function sendWelcomeEmail(leadData, estimateData = null) {
  try {
    const { email, jobName, category, quality } = leadData;
    
    // Build email content
    const htmlContent = buildWelcomeEmailHTML(leadData, estimateData);
    const textContent = buildWelcomeEmailText(leadData, estimateData);
    
    const result = await resend.emails.send({
      from: 'EstimateAI <support@getestimateai.co.uk>',
      to: [email],
      subject: `Your ${jobName} Estimate is Ready`,
      html: htmlContent,
      text: textContent,
      // Optional: Add reply-to
      reply_to: 'support@getestimateai.co.uk',
      // Optional: Tag for analytics
      tags: [
        { name: 'category', value: category },
        { name: 'email_type', value: 'welcome' }
      ]
    });
    
    console.log('✅ Welcome email sent:', {
      to: email,
      messageId: result.id,
      jobName
    });
    
    return result;
    
  } catch (error) {
    console.error('❌ Error sending welcome email:', error);
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
      
      <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px; margin: 20px 0;">
        <p style="margin: 0; font-size: 14px; color: #374151;">
          <strong>Please note:</strong> This is an indicative estimate. Final costs may vary based on specific requirements, site conditions, and individual contractor rates.
        </p>
      </div>
    `;
  }
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your ${jobName} Estimate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; background-color: white;">
    
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #dbeafe 0%, #e0f2fe 33%, #f0fdfa 66%, #ecfeff 100%); padding: 40px 30px; text-align: center;">
      <div style="background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); width: 60px; height: 60px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 20px;">
        <span style="color: white; font-size: 30px;">📊</span>
      </div>
      <h1 style="margin: 0; font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #0d9488 0%, #3b82f6 50%, #8b5cf6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">EstimateAI</h1>
      <p style="margin: 10px 0 0 0; color: #374151; font-size: 14px;">AI-Powered Cost Estimates</p>
    </div>
    
    <!-- Main Content -->
    <div style="padding: 40px 30px;">
      
      <h2 style="margin: 0 0 10px 0; font-size: 24px; font-weight: 700; color: #1e293b;">Your ${jobName} Estimate</h2>
      <p style="margin: 0 0 30px 0; color: #64748b; font-size: 16px;">Thank you for using EstimateAI! Here's your personalized cost estimate.</p>
      
      ${estimateHTML}
      
      <!-- Next Steps -->
      <div style="margin: 30px 0;">
        <h3 style="margin: 0 0 15px 0; font-size: 18px; font-weight: 700; color: #1e293b;">What's Next?</h3>
        
        <div style="background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 20px; margin-bottom: 15px;">
          <h4 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600; color: #075F58;">1. Get Multiple Quotes</h4>
          <p style="margin: 0; font-size: 14px; color: #374151; line-height: 1.6;">
            We recommend getting at least 3 quotes from local contractors. This helps you compare prices and find the best value.
          </p>
        </div>
        
        <div style="background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 20px; margin-bottom: 15px;">
          <h4 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600; color: #075F58;">2. Check References</h4>
          <p style="margin: 0; font-size: 14px; color: #374151; line-height: 1.6;">
            Always verify contractor credentials, insurance, and read recent reviews before hiring.
          </p>
        </div>
        
        <div style="background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 20px;">
          <h4 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600; color: #075F58;">3. Get Everything in Writing</h4>
          <p style="margin: 0; font-size: 14px; color: #374151; line-height: 1.6;">
            Ensure you have a detailed written quote that includes materials, labor, timeline, and payment terms.
          </p>
        </div>
      </div>
      
      <!-- CTA Button -->
      <div style="text-align: center; margin: 40px 0 30px 0;">
        <a href="https://getestimateai.co.uk" style="display: inline-block; background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
          Get Another Estimate
        </a>
      </div>
      
      <!-- Helpful Tips -->
      <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin-top: 30px;">
        <h4 style="margin: 0 0 15px 0; font-size: 16px; font-weight: 600; color: #1e293b;">💡 Helpful Tips for Your Project</h4>
        <ul style="margin: 0; padding-left: 20px; color: #374151; font-size: 14px; line-height: 1.8;">
          <li>Book contractors 2-4 weeks in advance for best availability</li>
          <li>Material costs can vary by 20-30% - ask contractors about options</li>
          <li>Consider project timing - prices may be lower in winter months</li>
          ${hasPhotos ? '<li>Your photos help contractors provide more accurate quotes</li>' : ''}
        </ul>
      </div>
      
    </div>
    
    <!-- Footer -->
    <div style="background: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb;">
      <p style="margin: 0 0 10px 0; color: #64748b; font-size: 14px;">
        Questions? We're here to help!
      </p>
      <p style="margin: 0 0 20px 0;">
        <a href="mailto:support@getestimateai.co.uk" style="color: #0d9488; text-decoration: none; font-weight: 600;">support@getestimateai.co.uk</a>
      </p>
      
      <div style="margin: 20px 0; padding-top: 20px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0 0 10px 0; color: #9ca3af; font-size: 12px;">
          <a href="https://getestimateai.co.uk/privacy" style="color: #9ca3af; text-decoration: none; margin: 0 10px;">Privacy Policy</a>
          <a href="https://getestimateai.co.uk/terms" style="color: #9ca3af; text-decoration: none; margin: 0 10px;">Terms of Service</a>
        </p>
        <p style="margin: 10px 0 0 0; color: #9ca3af; font-size: 12px;">
          You're receiving this because you requested an estimate on EstimateAI.<br>
          <a href="mailto:support@getestimateai.co.uk?subject=Unsubscribe" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a>
        </p>
      </div>
      
      <p style="margin: 20px 0 0 0; color: #9ca3af; font-size: 12px;">
        © 2026 EstimateAI. All rights reserved.
      </p>
    </div>
    
  </div>
</body>
</html>
  `;
}

/**
 * Build plain text email content (fallback)
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

Please note: This is an indicative estimate. Final costs may vary based on specific requirements, site conditions, and individual contractor rates.
`;
  }
  
  return `
EstimateAI - Your ${jobName} Estimate

Thank you for using EstimateAI! Here's your personalized cost estimate.

${estimateText}

WHAT'S NEXT?

1. Get Multiple Quotes
We recommend getting at least 3 quotes from local contractors. This helps you compare prices and find the best value.

2. Check References
Always verify contractor credentials, insurance, and read recent reviews before hiring.

3. Get Everything in Writing
Ensure you have a detailed written quote that includes materials, labor, timeline, and payment terms.

HELPFUL TIPS FOR YOUR PROJECT
• Book contractors 2-4 weeks in advance for best availability
• Material costs can vary by 20-30% - ask contractors about options
• Consider project timing - prices may be lower in winter months

Get another estimate: https://getestimateai.co.uk

Questions? Contact us at support@getestimateai.co.uk

---
You're receiving this because you requested an estimate on EstimateAI.
Unsubscribe: support@getestimateai.co.uk

© 2026 EstimateAI. All rights reserved.
  `;
}

/**
 * Send follow-up email (Day 3)
 */
async function sendFollowUpEmail(leadData) {
  try {
    const { email, jobName } = leadData;
    
    const result = await resend.emails.send({
      from: 'EstimateAI <estimates@getestimateai.co.uk>',
      to: [email],
      subject: `Have you contacted contractors for your ${jobName}?`,
      html: buildFollowUpEmailHTML(leadData),
      text: buildFollowUpEmailText(leadData),
      reply_to: 'support@getestimateai.co.uk'
    });
    
    console.log('✅ Follow-up email sent:', {
      to: email,
      messageId: result.id
    });
    
    return result;
    
  } catch (error) {
    console.error('❌ Error sending follow-up email:', error);
    throw error;
  }
}

function buildFollowUpEmailHTML(leadData) {
  const { jobName } = leadData;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; background-color: white;">
    
    <div style="background: linear-gradient(135deg, #dbeafe 0%, #f0fdfa 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: #1e293b;">Still planning your ${jobName}?</h1>
    </div>
    
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
        Hi there,
      </p>
      
      <p style="margin: 0 0 20px 0; color: #374151; font-size: 16px; line-height: 1.6;">
        We wanted to check in and see how your ${jobName} project is going. Have you had a chance to contact any contractors yet?
      </p>
      
      <div style="background: #f0fdfa; border-left: 4px solid #0d9488; padding: 20px; border-radius: 4px; margin: 30px 0;">
        <h3 style="margin: 0 0 10px 0; font-size: 18px; font-weight: 600; color: #075F58;">Need Help?</h3>
        <p style="margin: 0; color: #374151; font-size: 14px; line-height: 1.6;">
          If you're having trouble finding contractors or have questions about your estimate, just reply to this email. We're here to help!
        </p>
      </div>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="https://getestimateai.co.uk" style="display: inline-block; background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">
          Get Another Estimate
        </a>
      </div>
      
      <p style="margin: 30px 0 0 0; color: #64748b; font-size: 14px; line-height: 1.6;">
        Best regards,<br>
        The EstimateAI Team
      </p>
    </div>
    
    <div style="background: #f9fafb; padding: 20px 30px; text-align: center; border-top: 1px solid #e5e7eb;">
      <p style="margin: 0; color: #9ca3af; font-size: 12px;">
        <a href="mailto:support@getestimateai.co.uk?subject=Unsubscribe" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a>
      </p>
    </div>
    
  </div>
</body>
</html>
  `;
}

function buildFollowUpEmailText(leadData) {
  const { jobName } = leadData;
  
  return `
Still planning your ${jobName}?

Hi there,

We wanted to check in and see how your ${jobName} project is going. Have you had a chance to contact any contractors yet?

NEED HELP?
If you're having trouble finding contractors or have questions about your estimate, just reply to this email. We're here to help!

Get another estimate: https://getestimateai.co.uk

Best regards,
The EstimateAI Team

Unsubscribe: support@getestimateai.co.uk
  `;
}

module.exports = {
  sendWelcomeEmail,
  sendFollowUpEmail
};
