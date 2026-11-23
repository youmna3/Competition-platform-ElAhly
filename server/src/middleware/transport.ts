import type { RequestHandler } from 'express';
import type { WebConfig } from '../config.js';

/** Exact origin allowlist; no reflected origins, wildcard credentials or host-header trust. */
export function transportSecurity(web: WebConfig): RequestHandler {
  const allowed = new Set([web.publicOrigin, ...web.corsOrigins].filter((s): s is string => !!s));
  return (req, res, next) => {
    if (web.requireHttps && !req.secure && req.path !== '/api/health') {
      res.status(403).json({
        error: { code: 'HTTPS_REQUIRED', message: 'Use the secure application address.' },
      });
      return;
    }
    const supplied = req.get('origin');
    if (supplied && !allowed.has(supplied)) {
      res.status(403).json({
        error: {
          code: 'ORIGIN_MISMATCH',
          message: 'This request did not come from the judging platform.',
        },
      });
      return;
    }
    if (supplied) {
      res.vary('Origin');
      res.set('Access-Control-Allow-Origin', supplied);
      res.set('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      if (!supplied) {
        res.sendStatus(403);
        return;
      }
      const method = req.get('access-control-request-method');
      const headers = (req.get('access-control-request-headers') ?? '')
        .toLowerCase()
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      if (
        !method ||
        !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
        headers.some((h) => !['content-type', 'accept'].includes(h))
      ) {
        res.sendStatus(403);
        return;
      }
      res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.status(204).end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({
        error: { code: 'ORIGIN_MISMATCH', message: 'Cross-site writes are not allowed.' },
      });
      return;
    }
    next();
  };
}
