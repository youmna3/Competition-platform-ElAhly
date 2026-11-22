import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedPath, checkContent, sourceFiles, required, zip } from './package-source.mjs';
test('rejects credentials, artifacts, caches and traversal-like destinations', () => {
  for (const path of [
    '../server/.env.example',
    '/server/src/a.ts',
    'server/.env',
    'server/.env.demo',
    'backups/data.sql',
    '.git/config',
    'node_modules/a.js',
    'client/dist/a.js',
    'server/cache.key',
    'a.log',
    'artifacts/a.zip',
    'client/node_modules/.vite/a.js',
  ])
    assert.equal(allowedPath(path), false, path);
  assert.equal(allowedPath('server/.env.example'), true);
  assert.equal(allowedPath('server/migrations/010_admin_corrections.sql'), true);
  assert.throws(() => checkContent('file.ts', Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')));
  assert.throws(() =>
    checkContent('server/.env.example', Buffer.from('DB_PASSWORD=not-a-placeholder')),
  );
  assert.throws(() =>
    checkContent('file.ts', Buffer.from('accidentally-copied-password'), ['copied-password']),
  );
});
test('includes all required source, fixtures and migrations; ZIP is reproducible', async () => {
  const files = await sourceFiles();
  const names = new Set(files.map((f) => f.path));
  for (const name of required) assert.ok(names.has(name), name);
  assert.ok(names.has('client/test/fixtures/teams.xlsx'));
  assert.deepEqual(zip(files), zip(files));
});
