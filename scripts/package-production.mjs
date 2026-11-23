import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { root, zip, checkContent, localSecrets } from './package-source.mjs';

export const maintenanceScripts = [
  'db-migrate',
  'db-backup',
  'db-restore',
  'db-restore-check',
  'db-check',
  'db-create',
  'db-seed',
  'db-app-user',
  'auth-secret',
  'auth-reset-password',
];
const rootFiles = [
  'package.json',
  'package-lock.json',
  '.nvmrc',
  'scripts/check-node.mjs',
  'client/package.json',
  'server/package.json',
  'shared/package.json',
];
const buildConfigs = [
  'tsconfig.base.json',
  'client/index.html',
  'client/tsconfig.json',
  'client/vite.config.ts',
  'server/tsconfig.json',
  'server/tsconfig.build.json',
  'shared/tsconfig.json',
  'scripts/package-source.mjs',
  'scripts/package-production.mjs',
];
export function productionPathAllowed(path) {
  return (
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /^(?:\.git|node_modules|backups|data|test|tests|fixtures|screenshots|artifacts|coverage|\.cache|\.vite|\.turbo|__pycache__)$/.test(
            p,
          ) ||
          p.startsWith('.env'),
      ) &&
    !/\.(?:map|log|tmp|temp|bak|zip|sql|pem|key|pfx|p12|tsbuildinfo)$/i.test(
      path.replace(/^server\/migrations\/\d{3}_[a-z0-9_]+\.sql$/, 'migration.allowed'),
    )
  );
}
export async function productionFiles(kind) {
  if (!['runtime', 'build-source'].includes(kind))
    throw new Error('Unknown production package kind');
  const paths = new Set(rootFiles);
  async function add(path) {
    if (!productionPathAllowed(path)) throw new Error('Forbidden production path: ' + path);
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error('Production symlinks are forbidden: ' + path);
    if (stat.isDirectory())
      for (const e of await readdir(join(root, path), { withFileTypes: true })) {
        const child = `${path}/${e.name}`;
        if (productionPathAllowed(child)) await add(child);
      }
    else if (stat.isFile()) paths.add(path);
  }
  await add('deploy');
  await add('server/migrations');
  if (kind === 'runtime') {
    await add('client/dist');
    await add('server/dist/src');
    await add('shared/dist');
    for (const name of maintenanceScripts) await add(`server/dist/scripts/${name}.js`);
    await add('server/dist/scripts/lib/cli.js');
  } else {
    for (const path of buildConfigs) await add(path);
    for (const path of ['client/src', 'client/public', 'server/src', 'shared/src']) await add(path);
    for (const name of maintenanceScripts) await add(`server/scripts/${name}.ts`);
    await add('server/scripts/lib/cli.ts');
  }
  const required =
    kind === 'runtime'
      ? [
          'client/dist/index.html',
          'server/dist/src/index.js',
          'shared/dist/index.js',
          'server/dist/scripts/db-migrate.js',
        ]
      : ['client/src/main.tsx', 'server/src/index.ts', 'shared/src/index.ts'];
  for (const path of required)
    if (!paths.has(path)) throw new Error('Missing required production file: ' + path);
  const migrations = [...paths].filter((p) => p.startsWith('server/migrations/')).sort();
  if (
    migrations.length !== 13 ||
    !migrations.some((p) => p.endsWith('013_competition_lifecycle.sql'))
  )
    throw new Error('All 13 unchanged migrations are required');
  const secrets = await localSecrets();
  return Promise.all(
    [...paths].sort().map(async (path) => {
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) throw new Error('Symlink: ' + path);
      const data = await readFile(join(root, path));
      checkContent(path, data, secrets);
      return { path, data, sha256: createHash('sha256').update(data).digest('hex') };
    }),
  );
}
export async function packageProduction() {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Package production releases using Node.js 24');
  const out = join(root, 'artifacts');
  await mkdir(out, { recursive: true });
  for (const kind of ['runtime', 'build-source']) {
    const files = await productionFiles(kind),
      name = `ischool-ahly-production-${kind}.zip`,
      archive = zip(files, 'judging-platform'),
      sha256 = createHash('sha256').update(archive).digest('hex');
    const manifest = {
      archive: name,
      kind,
      nodeMajor: 24,
      dependencies:
        'Install from package-lock.json with npm ci; node_modules is intentionally excluded',
      sha256,
      files: files.map(({ path, data, sha256 }) => ({ path, bytes: data.length, sha256 })),
    };
    await writeFile(join(out, name), archive);
    await writeFile(join(out, name + '.sha256'), `${sha256}  ${name}\n`);
    await writeFile(
      join(out, `production-${kind}-manifest.json`),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    console.log(
      JSON.stringify({ kind, archive: name, files: files.length, bytes: archive.length, sha256 }),
    );
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await packageProduction();
