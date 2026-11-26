// utils/photoErrors.js
// Turns a failed photo analysis into a distinct response, so the front end can
// say what actually happened and the logs can be counted by reason.

const UNAVAILABLE = 'AI photo analysis is temporarily unavailable.';

function classifyPhotoError(error) {
  const status = error && error.status;
  const code = String((error && (error.code || error.type)) || '');
  const text = String((error && error.message) || '');
  const name = String((error && ((error.constructor && error.constructor.name) || error.name)) || '');

  if (status === 429 && /insufficient_quota|billing|no credits|quota/i.test(`${code} ${text}`)) {
    return { reason: 'quota', httpStatus: 503, errorCode: 'photo_analysis_unavailable', message: UNAVAILABLE, alert: true };
  }
  if (status === 401 || status === 403) {
    return { reason: 'auth', httpStatus: 503, errorCode: 'photo_analysis_unavailable', message: UNAVAILABLE, alert: true };
  }
  if (status === 429) {
    return { reason: 'rate_limit', httpStatus: 503, errorCode: 'photo_analysis_unavailable', message: UNAVAILABLE, alert: false };
  }
  if (/timeout/i.test(name) || /timed? ?out/i.test(text) || code === 'ETIMEDOUT') {
    return { reason: 'timeout', httpStatus: 504, errorCode: 'photo_analysis_timeout', message: 'Photo analysis took too long.', alert: false };
  }
  const reason = status === 400 ? 'invalid_image' : 'other';
  return { reason, httpStatus: 500, errorCode: 'Photo analysis failed', message: 'Unable to analyze photos. Please try again.', alert: false };
}

module.exports = { classifyPhotoError };
