/**
 * npm run auth:secret — adds a strong random SESSION_SECRET to server/.env if
 * it doesn't have one. Never prints the secret. Changing it later signs
 * everyone out.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runScript } from './lib/cli.js';

runScript(async () => {
  const envFile = resolve(process.cwd(), '.env');
  if (!existsSync(envFile)) {
    copyFileSync(resolve(process.cwd(), '.env.example'), envFile);
    console.log('OK  created server/.env from server/.env.example');
  }
  const content = readFileSync(envFile, 'utf8');
  if (/^\s*SESSION_SECRET\s*=\s*\S{32,}/m.test(content)) {
    console.log('OK  server/.env already has a SESSION_SECRET (unchanged)');
    return 0;
  }
  const secret = randomBytes(48).toString('hex');
  const emptyLine = /^[ \t]*SESSION_SECRET[ \t]*=[ \t\r]*$/m; // tolerate Windows CRLF
  if (emptyLine.test(content)) {
    // Fill the empty placeholder line from .env.example in place.
    writeFileSync(envFile, content.replace(emptyLine, `SESSION_SECRET=${secret}`));
  } else if (/^\s*SESSION_SECRET\s*=/m.test(content)) {
    console.error(
      'FAIL  server/.env has a SESSION_SECRET that is too short. Delete that line and run this again.',
    );
    return 1;
  } else {
    appendFileSync(
      envFile,
      `${content.endsWith('\n') ? '' : '\n'}\n# Signs session cookies. Keep it private; changing it signs everyone out.\nSESSION_SECRET=${secret}\n`,
    );
  }
  console.log('OK  added a new 96-character SESSION_SECRET to server/.env');
  return 0;
});
