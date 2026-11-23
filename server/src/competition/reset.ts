import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { RESET_ADMIN_EMAIL, RESET_PHRASE, type ResetPreview } from '@judging/shared';
import {
  backupDatabase,
  verifyBackupChecksum,
  verifyDumpComplete,
  sha256File,
  type BackupResult,
  type MysqlServer,
} from '../db/backup.js';
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
interface Ticket {
  actorId: number;
  sessionHash: string;
  instance: string;
  snapshot: string;
  credentialHash: string;
  expires: number;
  backup: BackupResult;
  preview: ResetPreview;
}

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
      throw failure('Only the preserved administrator may request a reset.', 403);
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT id,password_hash FROM users WHERE id=? AND email=? AND role='admin' AND status='active'",
      [actor.id, RESET_ADMIN_EMAIL],
    );
    if (!rows[0] || !(await bcrypt.compare(password, String(rows[0].password_hash))))
      throw failure('Fresh password verification failed.', 403);
    return String(rows[0].password_hash);
  }

  private async snapshot(conn: Connection) {
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
      if (table === 'users') counts.users = Math.max(0, rows.length - 1);
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
      const snap = await this.snapshot(conn);
      const backup = await backupDatabase(this.options.server, this.options.database, {
        dir,
        binDir: this.options.binDir,
        label: 'before_competition_reset',
      });
      verifyDumpComplete(backup.file);
      await verifyBackupChecksum(backup.file);
      const token = randomBytes(32).toString('hex');
      const expires = Date.now() + 10 * 60_000;
      const preview: ResetPreview = {
        token,
        expiresAt: new Date(expires).toISOString(),
        counts: snap.counts,
        preservedEmail: RESET_ADMIN_EMAIL,
        backup: { name: basename(backup.file), sha256: backup.sha256, bytes: backup.bytes },
      };
      this.log(dir, {
        event: 'reset.preview_backed_up',
        request: digest(token),
        actor: actor.email,
        database: this.options.database,
        instance,
        counts: snap.counts,
        backup: backup.file,
        sha256: backup.sha256,
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
      const snap = await this.snapshot(conn);
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
        backup: t.backup.file,
        sha256: t.backup.sha256,
      });
      await conn.query('CALL reset_competition(?,?,?,?)', [
        this.options.database,
        instance,
        key,
        actor.id,
      ]);
      const [survivors] = await conn.query<RowDataPacket[]>(
        'SELECT id,email,role,password_hash FROM users',
      );
      if (
        survivors.length !== 1 ||
        survivors[0]?.id !== actor.id ||
        survivors[0]?.email.toLowerCase() !== RESET_ADMIN_EMAIL ||
        survivors[0]?.role !== 'admin' ||
        survivors[0]?.password_hash !== hash
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
          preservedEmail: RESET_ADMIN_EMAIL,
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
