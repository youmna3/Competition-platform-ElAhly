import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import {
  RESET_ADMIN_EMAIL,
  RESET_PHRASE,
  RESET_PRESERVED_EMAILS,
  type PreservedAccount,
  type ResetPreview,
} from '@judging/shared';
import {
  backupDatabase,
  compareFingerprints,
  fingerprintDatabase,
  restoreDatabase,
  verifyBackupChecksum,
  verifyDumpComplete,
  sha256File,
  type BackupResult,
  type MysqlServer,
} from '../db/backup.js';
import { assertScratchTarget, scratchDatabaseName } from '../db/scratchName.js';
import { RuleError } from '../errors.js';
import type { Actor } from '../teams/service.js';

export interface MaintenanceOptions {
  server: MysqlServer;
  database: string;
  backupDir: string;
  binDir?: string;
  /** Explicit operator opt-in; false until the real reset is approved. */
  executionEnabled: boolean;
}
const tables = [
  'audit_log',
  'competition',
  'evaluation_events',
  'evaluation_scores',
  'evaluation_section_notes',
  'evaluations',
  'governorates',
  'maintenance_reset_context',
  'maintenance_reset_permits',
  'rubric',
  'rubric_criteria',
  'rubric_scale_levels',
  'rubric_sections',
  'rubric_versions',
  'schema_migrations',
  'sessions',
  'team_judges',
  'teams',
  'users',
];
const retained = new Set([
  'competition',
  'governorates',
  'schema_migrations',
  'rubric',
  'sessions',
  'maintenance_reset_context',
  'maintenance_reset_permits',
]);
const failure = (message: string, status = 409) => new RuleError(status, 'RESET_REFUSED', message);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const RESTORE_SUFFIX = '_reset_restore';
interface PreservedRow extends PreservedAccount {
  passwordHash: string;
}
interface Ticket {
  actorId: number;
  sessionHash: string;
  instance: string;
  snapshot: string;
  credentialHash: string;
  expires: number;
  backup: BackupResult;
  preserved: PreservedRow[];
  preview: ResetPreview;
}
const publicAccount = ({ passwordHash: _hash, ...account }: PreservedRow): PreservedAccount =>
  account;

/** Tickets are session-bound, expire in ten minutes and disappear on restart. */
export class CompetitionReset {
  private tickets = new Map<string, Ticket>();
  constructor(private options: MaintenanceOptions) {
    if (
      !/^[A-Za-z0-9_]{1,64}$/.test(options.database) ||
      /^(mysql|sys|performance_schema|information_schema)$/i.test(options.database)
    )
      throw failure('Unsafe maintenance target.');
  }
  get executionEnabled() {
    return this.options.executionEnabled;
  }

  private async connect() {
    const conn = await mysql.createConnection({
      ...this.options.server,
      database: this.options.database,
      connectTimeout: 5000,
    });
    try {
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT DATABASE() AS name,c.instance_id,c.database_name,@@foreign_key_checks AS foreign_keys FROM competition c WHERE id=1',
      );
      if (
        rows[0]?.name !== this.options.database ||
        rows[0]?.database_name !== this.options.database ||
        Number(rows[0]?.foreign_keys) !== 1
      )
        throw failure('Reset database identity mismatch.');
      return { conn, instance: String(rows[0].instance_id) };
    } catch (error) {
      await conn.end().catch(() => {});
      throw error;
    }
  }

  private async authorize(conn: Connection, actor: Actor, password: string) {
    if (actor.email.toLowerCase() !== RESET_ADMIN_EMAIL)
      throw failure('Only the authorized reset administrator may request a reset.', 403);
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT id,password_hash FROM users WHERE id=? AND email=? AND role='admin' AND status='active'",
      [actor.id, RESET_ADMIN_EMAIL],
    );
    if (!rows[0] || !(await bcrypt.compare(password, String(rows[0].password_hash))))
      throw failure('Fresh password verification failed.', 403);
    return String(rows[0].password_hash);
  }

  /** The three-account reset procedure arrives with migration 015; refuse on an older schema. */
  private async requireResetProcedure(conn: Connection) {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT 1 FROM schema_migrations WHERE version=15 LIMIT 1',
    );
    if (!rows.length)
      throw failure(
        'Database migration 015 (three-account reset) is not applied. The operator must run the database migration before a reset. Nothing was deleted.',
      );
  }

  /** Locks and returns the three preserved accounts; refuses the reset if any is missing. */
  private async preservedAccounts(conn: Connection): Promise<PreservedRow[]> {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT id,email,full_name,role,status,password_hash FROM users WHERE LOWER(email) IN (?) ORDER BY id FOR UPDATE',
      [RESET_PRESERVED_EMAILS],
    );
    const found = new Set(rows.map((r) => String(r.email).toLowerCase()));
    const missing = RESET_PRESERVED_EMAILS.filter((e) => !found.has(e));
    if (missing.length)
      throw failure(
        `Reset blocked: ${missing.length === 1 ? 'this preserved account does' : 'these preserved accounts do'} not exist: ${missing.join(', ')}. Create ${missing.length === 1 ? 'it' : 'them'} first. No backup was taken and nothing was deleted.`,
      );
    return rows.map((r) => ({
      id: Number(r.id),
      email: String(r.email),
      fullName: String(r.full_name),
      role: r.role,
      status: r.status,
      passwordHash: String(r.password_hash),
    }));
  }

  /** Restores the dump into a guarded scratch database and proves it matches the live data. */
  private async verifyRestore(file: string) {
    const live = this.options.database;
    const scratch = scratchDatabaseName(live, RESTORE_SUFFIX);
    assertScratchTarget(live, scratch, RESTORE_SUFFIX);
    const admin = await mysql.createConnection({ ...this.options.server, connectTimeout: 5000 });
    let owned = false;
    try {
      // A leftover copy from an interrupted attempt is ours (name is derived from this database).
      await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
      await admin.query(
        `CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      owned = true;
      assertScratchTarget(live, scratch, RESTORE_SUFFIX);
      await restoreDatabase(this.options.server, file, scratch, {
        binDir: this.options.binDir,
        inPlace: true,
      });
      const [before, after] = await Promise.all([
        fingerprintDatabase(this.options.server, live),
        fingerprintDatabase(this.options.server, scratch),
      ]);
      // Sessions can be touched by other requests; everything else is locked by this transaction.
      delete before.tables.sessions;
      delete after.tables.sessions;
      const problems = compareFingerprints(before, after);
      if (problems.length)
        throw failure(
          `Restore verification failed; nothing was deleted. The restored copy differs: ${problems.slice(0, 3).join('; ')}`,
        );
      return {
        tables: Object.keys(after.tables).length + 1,
        rows: Object.values(after.tables).reduce((n, t) => n + t.rows, 0),
        triggers: after.triggers.length,
        routines: after.routines?.length ?? 0,
      };
    } finally {
      if (owned) {
        assertScratchTarget(live, scratch, RESTORE_SUFFIX);
        await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``).catch(() => {});
      }
      await admin.end().catch(() => {});
    }
  }

  private async snapshot(conn: Connection, preservedIds: number[]) {
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
    );
    if (
      found
        .map((r) => String(r.name))
        .sort()
        .join() !== [...tables].sort().join() ||
      found.some((r) => r.engine !== 'InnoDB')
    )
      throw failure('Unexpected schema. Maintenance review is required before reset.');
    const counts: Record<string, number> = {};
    const hashes: string[] = [];
    // Range locks include empty tables and stop inserts/updates while backing up/deleting.
    for (const table of tables) {
      const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` FOR UPDATE`);
      if (table.startsWith('maintenance_') && rows.length)
        throw failure('Unexpected maintenance authorization. Operator review is required.');
      if (!retained.has(table)) counts[table] = rows.length;
      if (table === 'users')
        counts.users = rows.filter((r) => !preservedIds.includes(Number(r.id))).length;
      if (table !== 'sessions' && !table.startsWith('maintenance_'))
        hashes.push(
          table +
            digest(
              rows
                .map((r) => JSON.stringify(r))
                .sort()
                .join('\n'),
            ),
        );
    }
    const [triggers] = await conn.query<RowDataPacket[]>(
      'SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME',
    );
    hashes.push(JSON.stringify(triggers));
    counts.projects = counts.teams ?? 0; // Projects are stored on teams in this application.
    return { counts, hash: digest(hashes.join('\n')) };
  }

  private async secureDirectory() {
    const dir = resolve(this.options.backupDir, 'competition-maintenance');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const identity = `${process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : ''}${userInfo().username}`;
      await promisify(execFile)(
        'icacls.exe',
        [
          dir,
          '/inheritance:r',
          '/grant:r',
          `${identity}:(OI)(CI)F`,
          '*S-1-5-18:(OI)(CI)F',
          '*S-1-5-32-544:(OI)(CI)F',
        ],
        { windowsHide: true },
      );
    }
    return dir;
  }
  private log(dir: string, event: Record<string, unknown>) {
    const file = join(dir, 'maintenance.jsonl');
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', {
      mode: 0o600,
    });
    const fd = openSync(file, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  async prepare(actor: Actor, session: string, password: string): Promise<ResetPreview> {
    const { conn, instance } = await this.connect();
    try {
      await this.authorize(conn, actor, password);
      const dir = await this.secureDirectory();
      await conn.beginTransaction();
      await conn.query('SELECT id FROM competition WHERE id=1 FOR UPDATE');
      const credentialHash = await this.authorize(conn, actor, password);
      await this.requireResetProcedure(conn);
      // Refuse before any backup if one of the accounts to keep is missing.
      const preserved = await this.preservedAccounts(conn);
      const snap = await this.snapshot(
        conn,
        preserved.map((p) => p.id),
      );
      const backup = await backupDatabase(this.options.server, this.options.database, {
        dir,
        binDir: this.options.binDir,
        label: 'before_competition_reset',
      });
      verifyDumpComplete(backup.file);
      await verifyBackupChecksum(backup.file);
      const restored = await this.verifyRestore(backup.file);
      const token = randomBytes(32).toString('hex');
      const expires = Date.now() + 10 * 60_000;
      const preview: ResetPreview = {
        token,
        expiresAt: new Date(expires).toISOString(),
        database: this.options.database,
        counts: snap.counts,
        preservedAccounts: preserved.map(publicAccount),
        backup: {
          name: basename(backup.file),
          sha256: backup.sha256,
          bytes: backup.bytes,
          checksumVerified: true,
          restoreVerified: true,
          restored,
        },
      };
      this.log(dir, {
        event: 'reset.preview_backed_up',
        request: digest(token),
        actor: actor.email,
        database: this.options.database,
        instance,
        counts: snap.counts,
        preserved: preserved.map(({ id, email, role, status }) => ({ id, email, role, status })),
        backup: backup.file,
        sha256: backup.sha256,
        restoreVerified: restored,
      });
      for (const [key, t] of this.tickets)
        if (t.expires < Date.now() || t.actorId === actor.id) this.tickets.delete(key);
      this.tickets.set(digest(token), {
        actorId: actor.id,
        sessionHash: digest(session),
        instance,
        snapshot: snap.hash,
        credentialHash,
        expires,
        backup,
        preserved,
        preview,
      });
      await conn.rollback();
      return preview;
    } finally {
      await conn.rollback().catch(() => {});
      await conn.end();
    }
  }

  async execute(
    actor: Actor,
    session: string,
    input: { token: string; password: string; phrase: string; confirmed: boolean },
  ) {
    if (!this.executionEnabled)
      throw failure(
        'Reset execution is disabled. The operator must explicitly enable it after reviewing the backup and deletion preview.',
        403,
      );
    if (input.phrase !== RESET_PHRASE || input.confirmed !== true)
      throw failure('The exact reset phrase and final confirmation are required.', 400);
    const key = digest(input.token),
      t = this.tickets.get(key);
    if (!t || t.actorId !== actor.id || t.sessionHash !== digest(session) || t.expires < Date.now())
      throw failure('Reset preview expired or belongs to another session. Create a new preview.');
    const { conn, instance } = await this.connect();
    let committed = false;
    try {
      const hash = await this.authorize(conn, actor, input.password);
      if (instance !== t.instance || hash !== t.credentialHash)
        throw failure('Reset identity or credentials changed. Create a new preview.');
      const dir = await this.secureDirectory();
      await conn.beginTransaction();
      await conn.query('SELECT id FROM competition WHERE id=1 FOR UPDATE');
      const currentHash = await this.authorize(conn, actor, input.password);
      await this.requireResetProcedure(conn);
      const preserved = await this.preservedAccounts(conn);
      const snap = await this.snapshot(
        conn,
        preserved.map((p) => p.id),
      );
      if (snap.hash !== t.snapshot || currentHash !== t.credentialHash)
        throw failure(
          'Data changed after the preview. No data was deleted. Create and review a fresh preview and backup.',
        );
      verifyDumpComplete(t.backup.file);
      await verifyBackupChecksum(t.backup.file);
      if ((await sha256File(t.backup.file)) !== t.backup.sha256)
        throw failure('The reviewed backup changed. Create a new verified backup and preview.');
      await conn.query(
        'INSERT INTO maintenance_reset_permits(permit_hash,instance_id,actor_id,backup_sha256,expires_at) VALUES(?,?,?,?,?)',
        [key, instance, actor.id, t.backup.sha256, new Date(t.expires)],
      );
      this.log(dir, {
        event: 'reset.execution_started',
        request: key,
        actor: actor.email,
        database: this.options.database,
        instance,
        counts: snap.counts,
        preserved: preserved.map(({ id, email, role, status }) => ({ id, email, role, status })),
        backup: t.backup.file,
        sha256: t.backup.sha256,
      });
      await conn.query('CALL reset_competition(?,?,?,?)', [
        this.options.database,
        instance,
        key,
        actor.id,
      ]);
      // Exactly the preserved accounts remain, with the same ID, e-mail, password hash, role and status.
      const [survivors] = await conn.query<RowDataPacket[]>(
        'SELECT id,email,role,status,password_hash FROM users ORDER BY id',
      );
      const expected = t.preserved;
      if (
        survivors.length !== expected.length ||
        survivors.some((s, i) => {
          const p = expected[i]!;
          return (
            Number(s.id) !== p.id ||
            s.email !== p.email ||
            s.role !== p.role ||
            s.status !== p.status ||
            s.password_hash !== p.passwordHash
          );
        }) ||
        !survivors.some((s) => Number(s.id) === actor.id && s.password_hash === hash)
      )
        throw failure('Reset survivor verification failed. Changes rolled back.');
      for (const table of tables.filter((n) => !retained.has(n) && n !== 'users')) {
        const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
        if (Number(rows[0]?.n) !== 0)
          throw failure('Reset completeness verification failed. Changes rolled back.');
      }
      // A durable precommit entry permits reconciliation even if the process stops at COMMIT.
      this.log(dir, { event: 'reset.commit_pending', request: key, instance });
      await conn.commit();
      committed = true;
      this.tickets.delete(key);
      try {
        this.log(dir, {
          event: 'reset.completed',
          request: key,
          instance,
          preserved: expected.map(({ id, email }) => ({ id, email })),
        });
      } catch {
        return { reset: true, signInRequired: true, maintenanceLogNeedsReconciliation: true };
      }
      return { reset: true, signInRequired: true };
    } catch (error) {
      if (!committed) await conn.rollback().catch(() => {});
      throw error;
    } finally {
      await conn.end();
    }
  }
}
