import { createInterface } from 'node:readline/promises';
import mysql from 'mysql2/promise';
import { ConfigError, type ToolConfig } from '../../src/config.js';
import { describeDatabaseError } from '../../src/db/pool.js';

/** Runs a script's main function with friendly error output and exit codes. */
export function runScript(main: () => Promise<number | void>) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error: unknown) => {
      if (error instanceof ConfigError) {
        console.error(error.message);
      } else if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
      ) {
        // Driver errors: reuse the plain-language hints from the health check.
        const info = describeDatabaseError(error, {
          host: process.env.DB_HOST ?? '127.0.0.1',
          port: Number(process.env.DB_PORT ?? 3306),
          user: process.env.DB_ADMIN_USER ?? process.env.DB_USER ?? '?',
          database: process.env.DB_NAME ?? 'judging_platform',
        });
        console.error(`FAIL  ${info.code}: ${info.message}\nFix: ${info.hint}`);
      } else {
        console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exit(1);
    });
}

/** Admin-account target for schema work, optionally without selecting a database. */
export function adminServer(config: ToolConfig) {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.dbAdmin.user,
    password: config.dbAdmin.password,
  };
}

export function adminTarget(config: ToolConfig, database = config.db.database) {
  return { ...adminServer(config), database };
}

export async function ensureDatabase(
  config: ToolConfig,
  database = config.db.database,
): Promise<boolean> {
  const conn = await mysql.createConnection({ ...adminServer(config), connectTimeout: 5_000 });
  try {
    const [rows] = await conn.query(
      'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database],
    );
    if ((rows as unknown[]).length > 0) return false;
    await conn.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    return true;
  } finally {
    await conn.end();
  }
}

export function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

export function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function confirmByTyping(expected: string, prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt}\nType "${expected}" to continue: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

export function printSecretBox(lines: string[]) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '='.repeat(width);
  console.log(`\n${bar}`);
  for (const line of lines) console.log(`  ${line}`);
  console.log(`${bar}\n`);
}
