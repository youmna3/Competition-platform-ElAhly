import type { Connection, RowDataPacket } from 'mysql2/promise';

/**
 * Tables the running app may delete rows from. Everything else (users,
 * evaluations, scores, notes, audit log) is never deleted by the app.
 */
export const APP_DELETABLE_TABLES = new Set([
  'sessions',
  'team_judges',
  'rubric_versions', // only drafts; triggers refuse the rest
  'rubric_sections',
  'rubric_criteria',
  'rubric_scale_levels',
]);

/** Tables the app may never update. */
export const APP_APPEND_ONLY_TABLES = new Set(['audit_log', 'evaluation_events']);

/**
 * Creates (or re-grants) the least-privilege account the API uses at runtime.
 * It can read and write data but cannot change the schema, drop tables, delete
 * history or edit the audit log. Run as an admin account after migrations.
 */
export async function createAppUser(
  conn: Connection,
  { user, password, database }: { user: string; password: string; database: string },
): Promise<{ grants: string[] }> {
  if (!/^[A-Za-z0-9_]{1,32}$/.test(user)) throw new Error('Invalid database user name');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('Invalid database name');

  const [tables] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [database],
  );
  if (tables.length === 0)
    throw new Error(`Database "${database}" has no tables. Run npm run db:migrate first.`);

  const grants: string[] = [];
  // XAMPP connections over 127.0.0.1 can be matched as either host name.
  for (const host of ['localhost', '127.0.0.1']) {
    const account = `'${user}'@'${host}'`;
    await conn.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, [password]);
    await conn.query(`ALTER USER ${account} IDENTIFIED BY ?`, [password]);
    await conn.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`);
    for (const { name, type } of tables) {
      const table = String(name);
      const privileges =
        type === 'VIEW' || table === 'schema_migrations'
          ? ['SELECT']
          : [
              'SELECT',
              'INSERT',
              ...(APP_APPEND_ONLY_TABLES.has(table) ? [] : ['UPDATE']),
              ...(APP_DELETABLE_TABLES.has(table) ? ['DELETE'] : []),
            ];
      const statement = `GRANT ${privileges.join(', ')} ON \`${database}\`.\`${table}\` TO ${account}`;
      await conn.query(statement);
      if (host === 'localhost') grants.push(`${table}: ${privileges.join(', ')}`);
    }
  }
  await conn.query('FLUSH PRIVILEGES');
  return { grants };
}
