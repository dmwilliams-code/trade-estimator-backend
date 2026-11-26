// middleware/rateLimits.js
// Per-visitor rate limits, sized to what each route costs. Counts live in memory
// for the length of the window only (GDPR: legitimate interest, Article 6(1)(f)).
//
// Two things this module exists to get right:
// 1. Render serves every request through Cloudflare, so req.ip is a proxy
//    address that changes between requests. The visitor's address is in
//    CF-Connecting-IP, which Cloudflare sets and overwrites.
// 2. Inside app.use('/api/', ...) req.path has no /api prefix, so the exemption
//    list below is written without it.

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const DEFAULTS = {
  general: 60,          // cheap routes, abuse guard only
  locationCost: 120,    // local lookup, no external calls
  searchPerMinute: 10,  // up to 7 billable Google calls per search
  searchPerDay: 50,
  contractorClick: 30,
  leadsAndEstimate: 20,
  photoAnalysis: 3      // OpenAI cost
};

// Routes with their own limiter, so the general one skips them. Relative to /api.
const OWN_LIMIT_PATHS = ['/contractor-click', '/leads', '/save-estimate', '/location-cost', '/search-contractors'];

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  return (typeof cf === 'string' && cf.trim()) || req.ip || 'unknown';
}

// Route for the log line. Ids are masked and no IP address is ever logged.
function routeLabel(req) {
  const path = `${req.baseUrl || ''}${req.path || ''}`.replace(/[a-f0-9]{24}/gi, ':id');
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

function createLimiter({ name, windowMs, limit, message, log, skip }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true, // RateLimit-* headers, plus Retry-After on 429
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    message: { error: 'Too many requests', message },
    handler: (req, res, next, options) => {
      log.warn(`RATE_LIMIT route=${routeLabel(req)} limiter=${name} method=${req.method}`);
      res.status(options.statusCode).json(options.message);
    },
    ...(skip ? { skip } : {})
  });
}

function skipGeneral(req) {
  if (req.method === 'OPTIONS') return true;
  const path = req.path.toLowerCase();
  return OWN_LIMIT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

function createRateLimiters(overrides = {}, log = console) {
  const limits = { ...DEFAULTS, ...overrides };
  const wait = 'Please wait a moment before trying again.';
  const make = (name, windowMs, limit, message = wait, skip = null) =>
    createLimiter({ name, windowMs, limit, message, log, skip });

  return {
    general: make('general', MINUTE, limits.general, wait, skipGeneral),
    locationCost: make('location-cost', MINUTE, limits.locationCost),
    searchPerMinute: make('search-minute', MINUTE, limits.searchPerMinute),
    searchPerDay: make('search-day', DAY, limits.searchPerDay, "You have reached today's limit for contractor searches."),
    contractorClick: make('contractor-click', MINUTE, limits.contractorClick),
    // One shared bucket: a single estimate flow fires several of these.
    leadsAndEstimate: make('leads-estimate', MINUTE, limits.leadsAndEstimate),
    photoAnalysis: make('photo-analysis', MINUTE, limits.photoAnalysis,
      'Please wait before analyzing more photos. Maximum 3 analyses per minute.')
  };
}

// Mounts everything except the photo limiter, which is applied on its route.
function applyRateLimits(app, limiters) {
  app.use('/api/', limiters.general);
  app.use('/api/location-cost', limiters.locationCost);
  app.use('/api/search-contractors', limiters.searchPerMinute, limiters.searchPerDay);
  app.use('/api/contractor-click', limiters.contractorClick);
  app.use('/api/leads', limiters.leadsAndEstimate);
  app.use('/api/save-estimate', limiters.leadsAndEstimate);
}

module.exports = { createRateLimiters, applyRateLimits, clientIp, DEFAULTS };
