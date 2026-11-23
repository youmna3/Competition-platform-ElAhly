import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, localSecrets } from './package-source.mjs';
const git = (args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
const sensitive = (path) =>
  (/(?:^|\/)\.env(?:\..*)?$/.test(path) && !path.endsWith('.example')) ||
  /(?:^|\/)(?:backups?|dumps?|data)(?:\/|$)/i.test(path) ||
  (/\.(?:sql|bak|pfx|p12|key|pem|zip)$/i.test(path) &&
    !/^server\/migrations\/\d{3}_\w+\.sql$/.test(path));
export async function auditGit() {
  const secrets = (await localSecrets()).filter((v) => v.length >= 8);
  const findings = [];
  function scan(scope, path, data, object) {
    if (sensitive(path))
      findings.push({
        scope,
        path,
        object,
        reason: 'Sensitive or backup/archive path requires review',
      });
    if (secrets.some((s) => data.includes(Buffer.from(s))))
      findings.push({
        scope,
        path,
        object,
        reason: 'Matches a configured local credential (value withheld)',
      });
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/.test(
        data.toString('utf8'),
      )
    )
      findings.push({
        scope,
        path,
        object,
        reason: 'Private key or access-token pattern (value withheld)',
      });
  }
  const current = git(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const path of current)
    scan('working-tree', path, await readFile(resolve(root, path)).catch(() => Buffer.alloc(0)));
  const objects = git(['rev-list', '--objects', '--all'])
    .trim()
    .split('\n')
    .map((line) => {
      const i = line.indexOf(' ');
      return { id: i < 0 ? line : line.slice(0, i), path: i < 0 ? '' : line.slice(i + 1) };
    });
  // Supply object IDs over stdin; no file contents or secret values are printed.
  const info = execFileSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      cwd: root,
      input: objects.map((o) => o.id).join('\n') + '\n',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  )
    .trim()
    .split('\n');
  let blobs = 0;
  for (let i = 0; i < objects.length; i++) {
    const entry = objects[i],
      parts = info[i].split(' ');
    if (parts[1] !== 'blob') continue;
    blobs++;
    if (Number(parts[2]) > 10 * 1024 * 1024) {
      if (sensitive(entry.path))
        findings.push({
          scope: 'history',
          path: entry.path,
          object: entry.id,
          reason: 'Large archive/backup tracked in history',
        });
      continue;
    }
    scan(
      'history',
      entry.path,
      execFileSync('git', ['cat-file', 'blob', entry.id], {
        cwd: root,
        maxBuffer: 12 * 1024 * 1024,
        windowsHide: true,
      }),
      entry.id,
    );
  }
  const report = {
    currentTrackedFiles: current.length,
    historicalBlobsScanned: blobs,
    findings,
    limitations: [
      'Pattern and known-value scanning cannot prove that every possible secret is absent.',
      'This audit does not remove files, rewrite history, rotate credentials or contact remotes.',
    ],
  };
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(
    resolve(root, 'artifacts/production-git-audit.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      trackedFiles: current.length,
      historicalBlobs: blobs,
      findings: findings.length,
      report: 'artifacts/production-git-audit.json',
    }),
  );
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await auditGit();
