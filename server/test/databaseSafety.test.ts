import { describe, expect, it } from 'vitest';
import { assertTestDatabase, testDatabaseNames } from './databaseSafety.js';
import { scratchDatabaseName, assertScratchTarget } from '../src/db/scratchName.js';

describe('database test safety (no MySQL connection)', () => {
  it('also protects the operational restore drill for 64-character names', () => {
    const live = 'a'.repeat(64),
      scratch = scratchDatabaseName(live, '_restore_check');
    expect(scratch.length).toBeLessThanOrEqual(64);
    expect(scratch).not.toBe(live);
    expect(() => assertScratchTarget(live, live, '_restore_check')).toThrow();
    expect(() => assertScratchTarget(live, scratch, '_restore_check')).not.toThrow();
  });
  it.each([1, 28, 50, 58, 63, 64])('reserves both suffixes for names of length %i', (length) => {
    const application = 'a'.repeat(length);
    const names = testDatabaseNames(application);
    expect(names.test.length).toBeLessThanOrEqual(64);
    expect(names.restore.length).toBeLessThanOrEqual(64);
    expect(names.test).toMatch(/_test$/);
    expect(names.restore).toMatch(/_test_restore$/);
    expect(names.test).not.toBe(names.restore);
    for (const name of Object.values(names)) {
      expect(name).not.toBe(application);
      expect(() => assertTestDatabase(name, application, 'test')).not.toThrow();
    }
  });
  it('distinguishes long names sharing a truncated prefix', () => {
    expect(testDatabaseNames('a'.repeat(63) + 'b')).not.toEqual(
      testDatabaseNames('a'.repeat(63) + 'c'),
    );
  });
  it.each([
    '',
    ' mysql',
    'mysql',
    'sys',
    'information_schema',
    'performance_schema',
    'a;DROP DATABASE x',
    'a`',
    'a/b',
    'a'.repeat(65),
  ])('rejects ambiguous/unsafe names: %s', (name) => {
    expect(() => testDatabaseNames(name)).toThrow();
  });
  it('rejects application, production, sibling and forged test targets', () => {
    const app = 'judging_platform';
    for (const target of [
      app,
      app.toUpperCase(),
      'judging_platform_demo',
      'judging_platform_test',
      'mysql',
      testDatabaseNames('other').test,
    ])
      expect(() => assertTestDatabase(target, app, 'test')).toThrow();
    expect(() => assertTestDatabase(testDatabaseNames(app).test, app, 'production')).toThrow(
      /production/,
    );
  });
});
