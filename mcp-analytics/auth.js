// Bearer token auth, ahead of the MCP handler. Accepts the token either as
// an Authorization header (preferred) or a /mcp/:token path segment
// (fallback, if a connector UI doesn't support custom headers -- see spec
// section 13).
const crypto = require('crypto');

function extractToken(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (match) return match[1];
  if (req.params && req.params.token) return req.params.token;
  return null;
}

// Same 401 with no body detail whether the token is missing, wrong length,
// or wrong value -- the response never distinguishes why. Failures are
// logged with a timestamp only, never the token itself.
function authMiddleware(req, res, next) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    console.error(`[${new Date().toISOString()}] auth failure: MCP_AUTH_TOKEN not configured`);
    return res.status(401).end();
  }

  const provided = extractToken(req);
  if (!provided) {
    console.error(`[${new Date().toISOString()}] auth failure: no token provided`);
    return res.status(401).end();
  }

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  // Length check first, then constant-time compare on equal-length buffers.
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    console.error(`[${new Date().toISOString()}] auth failure: invalid token`);
    return res.status(401).end();
  }

  next();
}

module.exports = { authMiddleware };
