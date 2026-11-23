import request from 'supertest';
import { expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { supportedProductionDatabase } from '../src/production.js';
import { readMigrations, migrationSqlForServer } from '../src/db/migrate.js';
import { normalizeMysqlDumpLine } from '../src/db/backup.js';

const valid = {
  NODE_ENV: 'production',
  DB_USER: 'judging_app',
  DB_NAME: 'production_fixture',
  DB_PASSWORD: 'Synthetic-runtime-password-1!',
  SESSION_SECRET: '9b2a45678123adbc'.repeat(4),
  PUBLIC_ORIGIN: 'https://judging.example.com',
  TRUST_PROXY: 'loopback',
  COOKIE_SECURE: 'true',
};

it('makes simple MySQL trigger dumps restorable without altering literals or compound programs', () => {
  const prefix =
    '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `protect` BEFORE UPDATE ON `audit_log` FOR EACH ROW ';
  const line =
    prefix + "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'History; stays immutable'; */;;";
  expect(normalizeMysqlDumpLine(line)).toBe(
    prefix + "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'History; stays immutable' */;;",
  );
  const compound = prefix + "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'History'; END */;;";
  expect(normalizeMysqlDumpLine(compound)).toBe(compound);
  expect(normalizeMysqlDumpLine("INSERT INTO notes VALUES ('Literal; */;;');")).toBe(
    "INSERT INTO notes VALUES ('Literal; */;;');",
  );
});

it('adapts historical generated-column syntax for MySQL without changing migration source or checksums', () => {
  const file = readMigrations().find((m) => m.version === 7)!;
  const raw = file.sql,
    checksum = file.checksum;
  expect(migrationSqlForServer(file, '11.4.14-MariaDB')).toBe(raw);
  const mysql = migrationSqlForServer(file, '8.4.13');
  expect(mysql).not.toContain(' PERSISTENT');
  expect(mysql.match(/ STORED/g)).toHaveLength(2);
  expect(file.sql).toBe(raw);
  expect(file.checksum).toBe(checksum);
});
it('fails closed on missing HTTPS, cookies, secrets, restricted accounts, proxy or unsafe origins', () => {
  const c = parseConfig(valid);
  expect(c.maintenance).toEqual({ enabled: false, resetExecutionEnabled: false });
  for (const overrides of [
    { PUBLIC_ORIGIN: 'http://judging.example.com' },
    { PUBLIC_ORIGIN: 'https://judging.example.com/path' },
    { TRUST_PROXY: 'true' },
    { TRUST_PROXY: '0.0.0.0/0' },
    { TRUST_PROXY: '' },
    { COOKIE_SECURE: 'false' },
    { SESSION_SECRET: '' },
    { DB_PASSWORD: '' },
    { DB_USER: 'root' },
    { CORS_ORIGINS: '*' },
    { CORS_ORIGINS: 'http://elsewhere.example.com' },
    { COMPETITION_RESET_ENABLED: 'true' },
  ])
    expect(() => parseConfig({ ...valid, ...overrides })).toThrow();
});
function app(proxy = 'loopback') {
  return createApp({
    environment: 'production',
    version: 'fixture',
    web: parseConfig({ ...valid, TRUST_PROXY: proxy }).web,
    checkDatabase: async () => ({
      status: 'ok',
      database: 'private_name',
      serverVersion: 'private_version',
      latencyMs: 1,
    }),
  });
}
it('trusts HTTPS only from explicit proxies and keeps health diagnostics private', async () => {
  expect((await request(app()).get('/')).status).toBe(403);
  expect((await request(app()).get('/api/missing').set('X-Forwarded-Proto', 'https')).status).toBe(
    404,
  );
  expect(
    (await request(app('192.0.2.1')).get('/api/missing').set('X-Forwarded-Proto', 'https')).status,
  ).toBe(403);
  const health = await request(app()).get('/api/health');
  expect(health.status).toBe(200);
  expect(JSON.stringify(health.body)).not.toMatch(/private_name|private_version/);
  expect(health.headers['strict-transport-security']).toContain('max-age=31536000');
  expect(health.headers['content-security-policy']).toContain('upgrade-insecure-requests');
});
it('uses exact CORS origins, rejects untrusted preflights and blocks cross-site writes', async () => {
  const target = app();
  const allowed = await request(target)
    .options('/api/auth/login')
    .set('X-Forwarded-Proto', 'https')
    .set('Origin', valid.PUBLIC_ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type');
  expect(allowed.status).toBe(204);
  expect(allowed.headers['access-control-allow-origin']).toBe(valid.PUBLIC_ORIGIN);
  expect(allowed.headers['vary']).toContain('Origin');
  for (const bad of ['https://judging.example.com.evil.test', 'null', 'https://evil.test']) {
    const res = await request(target)
      .options('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', bad)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  }
  const cross = await request(target)
    .post('/api/auth/login')
    .set('X-Forwarded-Proto', 'https')
    .set('Origin', valid.PUBLIC_ORIGIN)
    .set('Sec-Fetch-Site', 'cross-site')
    .send({});
  expect(cross.status).toBe(403);
});
it('recognizes maintained target database families and rejects obsolete local MariaDB for production', () => {
  expect(supportedProductionDatabase('8.4.13')).toBe(true);
  expect(supportedProductionDatabase('11.4.14-MariaDB')).toBe(true);
  expect(supportedProductionDatabase('10.4.32-MariaDB')).toBe(false);
  expect(supportedProductionDatabase('5.7.44')).toBe(false);
});
