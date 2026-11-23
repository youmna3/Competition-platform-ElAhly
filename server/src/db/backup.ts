import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import mysql, { type RowDataPacket } from 'mysql2/promise';

export interface MysqlServer {
  host: string;
  port: number;
  user: string;
  password: string;
}

const XAMPP_BIN = 'C:\\xampp\\mysql\\bin';
const DUMP_COMPLETE_MARKER = '-- Dump completed';
const SAFE_DB = /^[A-Za-z0-9_]{1,64}$/;

function assertSafeDbName(name: string) {
  if (!SAFE_DB.test(name)) throw new Error(`Unsafe database name "${name}"`);
}

/** Finds mysqldump / mysql: MYSQL_BIN_DIR, then XAMPP's default folder, then PATH. */
export function resolveMysqlBinary(tool: 'mysqldump' | 'mysql', binDir?: string): string {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  if (binDir) {
    const candidate = join(binDir, exe);
    if (!existsSync(candidate)) throw new Error(`${exe} not found in MYSQL_BIN_DIR (${binDir})`);
    return candidate;
  }
  if (process.platform === 'win32' && existsSync(join(XAMPP_BIN, exe))) return join(XAMPP_BIN, exe);
  return exe;
}

/**
 * Credentials go in a short-lived option file instead of the command line, so
 * the password never appears in the process list.
 */
function withOptionFile<T>(server: MysqlServer, run: (file: string) => Promise<T>): Promise<T> {
  const file = join(tmpdir(), `judging-mysql-${randomBytes(8).toString('hex')}.cnf`);
  const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  writeFileSync(
    file,
    `[client]\nuser=${quote(server.user)}\npassword=${quote(server.password)}\n` +
      `host=${quote(server.host)}\nport=${server.port}\n`,
    { mode: 0o600 },
  );
  return run(file).finally(() => rmSync(file, { force: true }));
}

function runTool(
  binary: string,
  args: string[],
  { stdinFile, stdoutFile }: { stdinFile?: string; stdoutFile?: string },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(
              `${basename(binary)} was not found. Set MYSQL_BIN_DIR in server/.env (XAMPP: ${XAMPP_BIN}).`,
            )
          : error,
      );
    });
    const done = Promise.all([
      stdoutFile
        ? pipeline(child.stdout, createWriteStream(stdoutFile))
        : Promise.resolve(child.stdout.resume()),
      stdinFile
        ? pipeline(createReadStream(stdinFile), child.stdin)
        : Promise.resolve(child.stdin.end()),
    ]);
    child.on('close', (code) => {
      done
        .then(() => {
          if (code === 0) resolvePromise();
          else
            reject(
              new Error(
                `${basename(binary)} exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
              ),
            );
        })
        .catch(reject);
    });
  });
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', reject);
  });
}

function timestamp(date = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(
    date.getMinutes(),
  )}${p(date.getSeconds())}`;
}

export interface BackupResult {
  file: string;
  checksumFile: string;
  sha256: string;
  bytes: number;
}

/**
 * Consistent snapshot of one database with mysqldump (no downtime). Writes
 * <dir>/<db>_<label>_<timestamp>.sql plus a .sha256 file, and checks that the
 * dump finished completely.
 */
export async function backupDatabase(
  server: MysqlServer,
  database: string,
  { dir, binDir, label = 'backup' }: { dir: string; binDir?: string; label?: string },
): Promise<BackupResult> {
  assertSafeDbName(database);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${database}_${label}_${timestamp()}_${randomBytes(2).toString('hex')}.sql`,
  );
  const binary = resolveMysqlBinary('mysqldump', binDir);

  await withOptionFile(server, (optionFile) =>
    runTool(
      binary,
      [
        `--defaults-extra-file=${optionFile}`, // must be the first option
        '--single-transaction',
        '--routines',
        '--triggers',
        '--hex-blob',
        '--no-tablespaces',
        '--default-character-set=utf8mb4',
        '--add-drop-table',
        database,
      ],
      { stdoutFile: file },
    ),
  ).catch((error: unknown) => {
    rmSync(file, { force: true });
    throw error;
  });

  verifyDumpComplete(file);
  const sha256 = await sha256File(file);
  const checksumFile = `${file}.sha256`;
  writeFileSync(checksumFile, `${sha256}  ${basename(file)}\n`);
  return { file, checksumFile, sha256, bytes: statSync(file).size };
}

/** mysqldump writes a completion marker at the very end; a cut-off file lacks it. */
export function verifyDumpComplete(file: string) {
  const size = statSync(file).size;
  const length = Math.min(size, 300);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const tail = buffer.toString('utf8');
  if (!tail.includes(DUMP_COMPLETE_MARKER)) {
    throw new Error(`${basename(file)} is incomplete (no "${DUMP_COMPLETE_MARKER}" marker)`);
  }
}

/** Compares a backup file with its .sha256 file. */
export async function verifyBackupChecksum(file: string): Promise<void> {
  const checksumFile = `${file}.sha256`;
  if (!existsSync(checksumFile))
    throw new Error(`Checksum file missing: ${basename(checksumFile)}`);
  const expected = readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0];
  const actual = await sha256File(file);
  if (expected !== actual) {
    throw new Error(
      `${basename(file)} does not match its checksum: the file is damaged or was edited`,
    );
  }
}

/**
 * Restores a backup into `database`, replacing it completely. The file's
 * checksum and completeness are verified first. Callers are responsible for
 * confirmation and for a safety backup of the current data.
 */
export async function restoreDatabase(
  server: MysqlServer,
  file: string,
  database: string,
  { binDir, inPlace = false }: { binDir?: string; inPlace?: boolean } = {},
): Promise<void> {
  assertSafeDbName(database);
  await verifyBackupChecksum(file);
  verifyDumpComplete(file);

  if (inPlace) {
    // Accept only single-database dumps produced by our backup command.
    // Refuse scripts that can redirect the mysql client to a different schema.
    const sql = readFileSync(file, 'utf8');
    if (/^\s*(?:USE\b|(?:CREATE|DROP|ALTER)\s+(?:DATABASE|SCHEMA)\b|SOURCE\b|\\[.!])/im.test(sql))
      throw new Error('In-place restoration refuses database switching or external commands');
    const conn = await mysql.createConnection({ ...server, database, connectTimeout: 5_000 });
    await conn.end(); // Existing target is required; never create or drop it.
  } else {
    const conn = await mysql.createConnection({ ...server, connectTimeout: 5_000 });
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await conn.query(
        `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } finally {
      await conn.end();
    }
  }

  const binary = resolveMysqlBinary('mysql', binDir);
  await withOptionFile(server, (optionFile) =>
    runTool(
      binary,
      [`--defaults-extra-file=${optionFile}`, '--default-character-set=utf8mb4', database],
      {
        stdinFile: file,
      },
    ),
  );
}

/** Newest backup file in a folder, or undefined. */
export function latestBackup(dir: string, database: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${database}_`) && f.endsWith('.sql'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export interface DatabaseFingerprint {
  tables: Record<string, { rows: number; checksum: string }>;
  triggers: string[];
  views: string[];
}

/** Row counts and CHECKSUM TABLE values for every table, plus trigger and view names. */
export async function fingerprintDatabase(
  server: MysqlServer,
  database: string,
): Promise<DatabaseFingerprint> {
  assertSafeDbName(database);
  const conn = await mysql.createConnection({ ...server, database, connectTimeout: 5_000 });
  try {
    const [tables] = await conn.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [database],
    );
    const result: DatabaseFingerprint = { tables: {}, triggers: [], views: [] };
    for (const { name } of tables) {
      const table = String(name);
      const [[count]] = (await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``)) as unknown as [
        { n: number }[],
      ];
      const [[sum]] = (await conn.query(`CHECKSUM TABLE \`${table}\``)) as unknown as [
        { Checksum: string | number | null }[],
      ];
      result.tables[table] = { rows: Number(count?.n ?? 0), checksum: String(sum?.Checksum ?? '') };
    }
    const [triggers] = await conn.query<RowDataPacket[]>(
      'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
      [database],
    );
    result.triggers = triggers.map((t) => String(t.name));
    const [views] = await conn.query<RowDataPacket[]>(
      'SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database],
    );
    result.views = views.map((v) => String(v.name));
    return result;
  } finally {
    await conn.end();
  }
}

/** Human-readable differences between two fingerprints; empty means identical. */
export function compareFingerprints(
  live: DatabaseFingerprint,
  restored: DatabaseFingerprint,
): string[] {
  const problems: string[] = [];
  const names = new Set([...Object.keys(live.tables), ...Object.keys(restored.tables)]);
  for (const name of names) {
    const a = live.tables[name];
    const b = restored.tables[name];
    if (!a) problems.push(`table ${name} exists only in the restored copy`);
    else if (!b) problems.push(`table ${name} is missing from the restored copy`);
    else if (a.rows !== b.rows)
      problems.push(`table ${name}: ${a.rows} rows live, ${b.rows} restored`);
    else if (a.checksum !== b.checksum) problems.push(`table ${name}: data checksum differs`);
  }
  if (live.triggers.join() !== restored.triggers.join()) problems.push('triggers differ');
  if (live.views.join() !== restored.views.join()) problems.push('views differ');
  return problems;
}
