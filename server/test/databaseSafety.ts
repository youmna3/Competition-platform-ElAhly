import { scratchDatabaseName } from '../src/db/scratchName.js';

const identifier = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const systemNames = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
export function testDatabaseNames(application: string) {
  if (!identifier.test(application) || systemNames.has(application.toLowerCase()))
    throw new Error('Unsafe application database name');
  return {
    test: scratchDatabaseName(application, '_test', '_test_restore'),
    restore: scratchDatabaseName(application, '_test_restore'),
  };
}

export function assertTestDatabase(name: string, application: string, environment?: string) {
  if (environment === 'production') throw new Error('Database tests are forbidden in production');
  const names = testDatabaseNames(application);
  if (
    !identifier.test(name) ||
    name.toLowerCase() === application.toLowerCase() ||
    ![names.test.toLowerCase(), names.restore.toLowerCase()].includes(name.toLowerCase())
  ) {
    throw new Error('Refusing unsafe or non-owned test database target');
  }
}
