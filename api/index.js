'use strict';

/**
 * Vercel serverless entry — all /api/* paths are rewritten here (see vercel.json).
 * Rebuilds the original API path from the __fcpath query param, then hands the
 * request to the same handler the local server uses.
 */

const { handleRequest } = require('../server');

module.exports = async (req, res) => {
  const qIndex = req.url.indexOf('?');
  const pathPart = qIndex === -1 ? req.url : req.url.slice(0, qIndex);

  if (pathPart === '/api' || pathPart === '/api/' || pathPart === '/api/index' || pathPart === '/api/index.js') {
    const u = new URL(req.url, 'http://freshcatch.local');
    const route = u.searchParams.get('__fcpath');
    if (route) {
      u.searchParams.delete('__fcpath');
      const qs = u.searchParams.toString();
      req.url = `/api/${route}${qs ? `?${qs}` : ''}`;
    }
  }

  return handleRequest(req, res);
};
