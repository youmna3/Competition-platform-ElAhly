/**
 * npm run demo:dev — starts the usual development servers, but pointed at the
 * separate demo database written by `npm run db:demo` (server/.env.demo).
 * Environment variables override server/.env, so nothing is edited.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '..', '.env.demo');
if (!existsSync(file)) {
  console.error('FAIL  server/.env.demo not found. Run  npm run db:demo  first.');
  process.exit(1);
}
const settings: Record<string, string> = {};
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && ['DB_NAME', 'DB_USER', 'DB_PASSWORD'].includes(m[1]!)) settings[m[1]!] = m[2]!;
}
if (!settings.DB_NAME?.endsWith('_demo')) {
  console.error(
    'FAIL  server/.env.demo does not point at a *_demo database. Run  npm run db:demo  again.',
  );
  process.exit(1);
}
console.log(
  `\n*** DEMO MODE: using the demo database "${settings.DB_NAME}". Real data is not used. ***\n`,
);
const child = spawn('npm run dev', {
  cwd: resolve(import.meta.dirname, '..', '..'),
  env: { ...process.env, ...settings },
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
