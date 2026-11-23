import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';
export function databaseSsl(db: AppConfig['db']) {
  return db.tls
    ? {
        ca: readFileSync(db.tls.caFile, 'utf8'),
        rejectUnauthorized: true,
        verifyIdentity: true,
        minVersion: 'TLSv1.2',
      }
    : undefined;
}
