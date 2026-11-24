import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = [
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc.json',
  'eslint.config.js',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'README.md',
];
const trees = [
  'deploy',
  'scripts',
  'client/src',
  'client/public',
  'client/test',
  'server/src',
  'server/scripts',
  'server/migrations',
  'server/test',
  'shared/src',
];
const configs = [
  'client/package.json',
  'client/index.html',
  'client/tsconfig.json',
  'client/vite.config.ts',
  'server/package.json',
  'server/tsconfig.json',
  'server/tsconfig.build.json',
  'server/vitest.config.ts',
  'server/vitest.db.config.ts',
  'server/.env.example',
  'shared/package.json',
  'shared/tsconfig.json',
];
export const required = [
  ...rootFiles,
  ...configs,
  'client/src/pages/admin/evaluations/EditSubmission.tsx',
  'client/src/pages/admin/evaluations/HistoricalSubmissions.tsx',
  'client/src/pages/judge/CompetitionLeaderboardPage.tsx',
  'client/src/pages/admin/reports/ReportsPage.tsx',
  'server/src/reports/routes.ts',
  'server/src/reports/service.ts',
  'server/src/reports/format.ts',
  'shared/src/reports.ts',
  ...[
    '001_core',
    '002_rubric',
    '003_evaluations',
    '004_auth',
    '005_user_management',
    '006_teams',
    '007_rubric_management',
    '008_evaluations_access',
    '009_evaluation_history',
    '010_admin_corrections',
    '011_dynamic_rubrics',
    '012_variable_questions',
    '013_competition_lifecycle',
    '014_numeric_points',
    '015_reset_preserved_accounts',
    '016_team_resources',
  ].map((n) => `server/migrations/${n}.sql`),
];
export function allowedPath(path) {
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((p) => p === '..' || p === '.' || p === '')
  )
    return false;
  if (path === 'server/.env.example') return true;
  return (
    !path
      .split('/')
      .some(
        (p) =>
          /^(?:\.git|node_modules|dist|coverage|artifacts|backups|\.cache|\.vite|\.turbo|playwright-report|test-results|__pycache__)$/.test(
            p,
          ) || p.startsWith('.env'),
      ) &&
    !/\.(?:log|tmp|temp|zip|tsbuildinfo|pyc|pem|key|pfx|p12|bak|swp)$/i.test(path) &&
    !/(?:^|\/)(?:Thumbs\.db|\.DS_Store)$/.test(path) &&
    (!/\.sql$/i.test(path) || /^server\/migrations\/\d{3}_[a-z0-9_]+\.sql$/.test(path))
  );
}
export function checkContent(path, data, secrets = []) {
  const text = data.toString('utf8');
  if (
    /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/.test(
      text,
    )
  )
    throw new Error(`Secret-like key in ${path}`);
  if (secrets.some((secret) => data.includes(Buffer.from(secret))))
    throw new Error(`Local credential value detected in ${path} (value withheld)`);
  if (path.endsWith('.env.example')) {
    for (const line of text.split(/\r?\n/))
      if (/^[A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z_]*=.+/.test(line))
        throw new Error('Environment example must contain no credential values');
  }
}
export async function localSecrets() {
  const secrets = [];
  for (const name of ['server/.env', 'server/.env.demo']) {
    let text;
    try {
      text = await readFile(join(root, name), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^[A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z_]*=(.*)$/.exec(line);
      if (match) {
        const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (value.length >= 4) secrets.push(value);
      }
    }
  }
  return secrets;
}
export async function sourceFiles() {
  const files = new Set([...rootFiles, ...configs]);
  async function walk(folder) {
    if ((await lstat(join(root, folder))).isSymbolicLink())
      throw new Error(`Symlinks are forbidden: ${folder}`);
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (!allowedPath(path)) continue;
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are forbidden in source packages: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.add(path);
    }
  }
  for (const tree of trees) await walk(tree);
  for (const entry of await readdir(join(root, 'docs'), { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  }))
    if (entry.isFile() && entry.name.endsWith('.md')) files.add(`docs/${entry.name}`);
  for (const file of required)
    if (!files.has(file)) throw new Error(`Required file missing: ${file}`);
  const secrets = await localSecrets();
  return Promise.all(
    [...files].sort().map(async (path) => {
      if (!allowedPath(path) || (await lstat(join(root, path))).isSymbolicLink())
        throw new Error(`Forbidden package path: ${path}`);
      const data = await readFile(join(root, path));
      checkContent(path, data, secrets);
      return { path, data, sha256: createHash('sha256').update(data).digest('hex') };
    }),
  );
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Deterministic ZIP: sorted paths, fixed DOS timestamp (1980-01-01), no host metadata.
export function zip(files, prefix = 'judging-platform-local') {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const { path, data } of files) {
    const name = Buffer.from(`${prefix}/${path}`),
      compressed = deflateRawSync(data, { level: 9 }),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    chunks.push(header, name, compressed);
    central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
export async function packageSource() {
  const files = await sourceFiles();
  const archive = zip(files),
    hash = createHash('sha256').update(archive).digest('hex');
  const out = join(root, 'artifacts');
  await mkdir(out, { recursive: true });
  const name = 'ischool-ahly-source.zip';
  await writeFile(join(out, name), archive);
  await writeFile(join(out, `${name}.sha256`), `${hash}  ${name}\n`);
  await writeFile(
    join(out, 'source-manifest.json'),
    JSON.stringify(
      {
        archive: name,
        sha256: hash,
        files: files.map(({ path, sha256, data }) => ({ path, sha256, bytes: data.length })),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Source package: ${relative(root, join(out, name))}; ${files.length} files; SHA-256 ${hash}`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await packageSource();
