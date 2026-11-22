import { createHash } from 'node:crypto';

export function scratchDatabaseName(application: string, suffix: string, reserve = suffix): string {
  if (
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(application) ||
    ['mysql', 'information_schema', 'performance_schema', 'sys'].includes(
      application.toLowerCase(),
    ) ||
    !/^_[a-z_]+$/.test(suffix) ||
    !/^_[a-z_]+$/.test(reserve) ||
    reserve.length < suffix.length ||
    reserve.length > 24
  )
    throw new Error('Unsafe scratch database name');
  const hash = createHash('sha256').update(application.toLowerCase()).digest('hex').slice(0, 16);
  const length = 64 - 'jptest_'.length - 1 - hash.length - reserve.length;
  const target = `jptest_${application.slice(0, length)}_${hash}${suffix}`;
  if (target.toLowerCase() === application.toLowerCase())
    throw new Error('Scratch database collides with application database');
  return target;
}

export function assertScratchTarget(application: string, target: string, suffix: string) {
  if (
    target.toLowerCase() === application.toLowerCase() ||
    target !== scratchDatabaseName(application, suffix)
  )
    throw new Error('Refusing unsafe scratch database target');
}
