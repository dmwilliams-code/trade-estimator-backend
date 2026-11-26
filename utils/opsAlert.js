// utils/opsAlert.js
// Throttled operational alert emails. The recipient comes from the ALERT_EMAIL
// environment variable and sending is injected, so this is testable offline.

const SIX_HOURS = 6 * 60 * 60 * 1000;

function createOpsAlerter({ send, recipient, now = Date.now, intervalMs = SIX_HOURS, log = console }) {
  const lastSent = new Map();

  return async function alertOps(key, subject, text) {
    const to = recipient();
    if (!to) {
      log.warn('OPS_ALERT skipped: ALERT_EMAIL is not set');
      return false;
    }
    const previous = lastSent.get(key);
    if (previous !== undefined && now() - previous < intervalMs) return false;
    lastSent.set(key, now());
    try {
      await send({ to, subject, text });
      log.log(`OPS_ALERT sent key=${key}`);
      return true;
    } catch (error) {
      lastSent.delete(key); // let the next failure try again
      log.error('OPS_ALERT send failed:', error.message);
      return false;
    }
  };
}

module.exports = { createOpsAlerter };
