import test from 'node:test';
import assert from 'node:assert/strict';
import { productionPathAllowed } from './package-production.mjs';
test('production packages reject secrets, backups, fixtures, databases, source maps and dependencies', () => {
  for (const path of [
    'server/.env',
    'server/.env.demo',
    'node_modules/mysql2/index.js',
    'client/test/fixtures/users.xlsx',
    'client/dist/assets/index.js.map',
    'backups/backup.sql',
    'data/ibdata1',
    'docs/screenshots/status.png',
    '../secret',
    'server\\.env',
    'server/database.sql',
    'artifacts/build.zip',
  ])
    assert.equal(productionPathAllowed(path), false, path);
  for (const path of [
    'client/dist/index.html',
    'client/public/templates/teams.xlsx',
    'server/dist/src/index.js',
    'server/dist/scripts/db-backup.js',
    'shared/dist/index.js',
    'server/migrations/013_competition_lifecycle.sql',
    'deploy/production.env.example',
  ])
    assert.equal(productionPathAllowed(path), true, path);
});
