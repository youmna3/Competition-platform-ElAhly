/**
 * npm run db:rubric-check — READ-ONLY report of rubric versions and the
 * versions used by evaluations, using the API's settings in server/.env.
 * It never changes data. Exit code 0 = no problems found, 2 = problems found.
 */
import { ConfigError, loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { rubricCheck } from './lib/rubricCheck.js';

async function main() {
  const config = loadConfig();
  console.log(
    `Read-only rubric check on database "${config.db.database}" (no changes are made)…\n`,
  );
  const pool = createPool(config.db);
  try {
    const r = await rubricCheck(pool);
    console.log(
      `Competition: ${r.competition ? `${r.competition.state}, locked version ${r.competition.lockedVersionNo ?? 'none'}` : 'lifecycle not available'}`,
    );
    console.log(
      `Published version: ${r.publishedVersionNo ?? 'none'} · Draft: ${r.draftVersionNo ?? 'none'}`,
    );
    console.log('\nRubric versions:');
    for (const v of r.versions)
      console.log(`  v${v.versionNo}  ${v.status.padEnd(9)} format ${v.scoringFormat}  ${v.title}`);
    if (!r.versions.length) console.log('  (none)');
    console.log('\nEvaluations by rubric version:');
    for (const v of r.evaluationsByVersion)
      console.log(`  v${v.versionNo}  ${v.submitted} submitted, ${v.draft} draft`);
    if (!r.evaluationsByVersion.length) console.log('  (none)');
    if (r.mixedTeams.length) {
      console.log('\nActive teams with mixed versions (assigned judges only):');
      for (const t of r.mixedTeams)
        console.log(`  ${t.teamCode} ${t.name}: ${t.versions.map((v) => `v${v}`).join(', ')}`);
    }
    if (r.offVersion.length) {
      console.log('\nAssigned evaluations not on the reference version:');
      for (const e of r.offVersion.slice(0, 50))
        console.log(`  ${e.teamCode} · ${e.judge}: v${e.versionNo} (${e.status})`);
      if (r.offVersion.length > 50) console.log(`  … and ${r.offVersion.length - 50} more`);
    }
    console.log('');
    if (!r.problems.length) {
      console.log('OK  rubric versions are consistent.');
      return 0;
    }
    for (const p of r.problems) console.log(`WARN  ${p}`);
    return 2;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  });
