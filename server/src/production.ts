import type { Pool, RowDataPacket } from 'mysql2/promise';
import { readMigrations } from './db/migrate.js';

export function supportedProductionDatabase(version: string) {
  return /mariadb/i.test(version)
    ? /^(10\.11|11\.4|11\.8|12\.3)\./.test(version)
    : /^8\.4\./.test(version);
}
/** Read-only release gate. Schema installation remains an explicit operator action. */
export async function verifyProductionDatabase(pool: Pool) {
  const [[server]] = await pool.query<RowDataPacket[]>('SELECT VERSION() AS version');
  if (!supportedProductionDatabase(String(server?.version)))
    throw new Error(
      'Unsupported production database series. Use a maintained MySQL 8.4 or MariaDB LTS release.',
    );
  const [applied] = await pool.query<RowDataPacket[]>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  const expected = readMigrations();
  if (
    applied.length !== expected.length ||
    expected.some(
      (m, i) => Number(applied[i]?.version) !== m.version || applied[i]?.checksum !== m.checksum,
    )
  )
    throw new Error(
      'Database migrations are missing or differ from this release. Run the controlled migration step before startup.',
    );
}
