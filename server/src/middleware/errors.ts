import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiErrorBody } from '@judging/shared';
import { RuleError } from '../errors.js';

export const apiNotFound: RequestHandler = (req, res) => {
  const body: ApiErrorBody = {
    error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.originalUrl}` },
  };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof RuleError) {
    res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message }, ...(err.extra ?? {}) });
    return;
  }
  const status = typeof err?.status === 'number' ? err.status : 500;

  if (err?.type === 'entity.parse.failed') {
    res
      .status(400)
      .json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    return;
  }

  if (status >= 500) console.error('[api] unhandled error:', err);
  const body: ApiErrorBody = {
    error: {
      code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      // Never leak internal details or stack traces to the client.
      message:
        status >= 500
          ? 'Something went wrong on the server'
          : String(err?.message ?? 'Bad request'),
    },
  };
  res.status(status).json(body);
};

/** One line per request in development: "GET /api/health 200 3.1ms". */
export const requestLogger: RequestHandler = (req, res, next) => {
  const started = performance.now();
  res.on('finish', () => {
    const ms = (performance.now() - started).toFixed(1);
    console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
};
