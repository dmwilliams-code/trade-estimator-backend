// middleware/coalesce.js
// De-duplicates identical requests that are in flight at the same moment: the
// first runs the handler, the rest receive the same response. Nothing is kept
// after the response is sent, so this is not a cache.

function coalesce(keyFor) {
  const inFlight = new Map();

  return (req, res, next) => {
    const key = keyFor(req);
    if (!key) return next();

    const pending = inFlight.get(key);
    if (pending) {
      return pending.then((result) => {
        if (!result) return next(); // the first request was dropped, run our own
        return res.status(result.status).json(result.body);
      });
    }

    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    inFlight.set(key, promise);

    const finish = (result) => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
      settle(result); // later calls on a settled promise are ignored
    };

    const sendJson = res.json.bind(res);
    res.json = (body) => {
      finish({ status: res.statusCode, body });
      return sendJson(body);
    };
    res.on('close', () => finish(null));
    return next();
  };
}

// Key for a contractor search: every input that changes the result.
function searchKey(req) {
  const { jobType, userLocation, quality = 'standard', category = '', projectScale = 1 } = req.body || {};
  if (typeof jobType !== 'string' || typeof userLocation !== 'string') return null;
  const postcode = userLocation.replace(/\s+/g, '').toUpperCase();
  return JSON.stringify([postcode, jobType, quality, category, projectScale]);
}

module.exports = { coalesce, searchKey };
