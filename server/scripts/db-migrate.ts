/** npm run db:migrate — applies pending migrations. `-- --status` lists them instead. */
import { loadToolConfig } from '../src/config.js';
import { migrate, migrationStatus } from '../src/db/migrate.js';
import { adminTarget, hasFlag, runScript } from './lib/cli.js';

runScript(async () => {
  const config = loadToolConfig();
  const target = adminTarget(config);

  if (hasFlag('--status')) {
    const rows = await migrationStatus(target);
    for (const row of rows) {
      const state = row.modified
        ? 'MODIFIED!'
        : row.appliedAt
          ? `applied ${row.appliedAt.toISOString()}`
          : 'pending';
      console.log(`${String(row.version).padStart(3, '0')}_${row.name.padEnd(24)} ${state}`);
    }
    return rows.some((r) => r.modified) ? 1 : 0;
  }

  console.log(
    `Migrating database "${target.database}" on ${target.host}:${target.port} as "${target.user}"…`,
  );
  const result = await migrate(target, { log: (line) => console.log(line) });
  if (result.applied.length === 0) {
    console.log(`OK  already up to date (${result.alreadyApplied} migrations applied)`);
  } else {
    for (const m of result.applied)
      console.log(`OK  ${String(m.version).padStart(3, '0')}_${m.name} (${m.ms} ms)`);
  }
  return 0;
});
