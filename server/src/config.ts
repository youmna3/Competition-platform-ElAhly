import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const booleanFlag = z
  .enum(['true', 'false'], { message: 'must be "true" or "false"' })
  .default('false')
  .transform((value) => value === 'true');

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: port(4000),
    ALLOW_NETWORK_ACCESS: booleanFlag,
    DB_HOST: z.string().trim().min(1).default('127.0.0.1'),
    DB_PORT: port(3306),
    DB_USER: z.string().trim().min(1, 'DB_USER is required'),
    // XAMPP's root account has an empty password by default, so empty is allowed.
    DB_PASSWORD: z.string().default(''),
    DB_NAME: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{1,64}$/, 'DB_NAME may only contain letters, digits and _')
      .default('judging_platform'),
    DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
    // ---- authentication (Phase 2) ----
    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters (run: npm run auth:secret)')
      .refine(
        (v) => !/change|example|secret_here|xxxx/i.test(v),
        'SESSION_SECRET still looks like a placeholder',
      )
      .optional(),
    SESSION_IDLE_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(240),
    SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(72).default(12),
    COOKIE_SECURE: booleanFlag,
    LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(20),
    LOCKOUT_THRESHOLD: z.coerce.number().int().min(1).max(50).default(5),
    LOCKOUT_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15),
  })
  .superRefine((env, ctx) => {
    if (!LOOPBACK_HOSTS.has(env.HOST) && !env.ALLOW_NETWORK_ACCESS) {
      ctx.addIssue({
        code: 'custom',
        path: ['HOST'],
        message:
          `HOST=${env.HOST} would expose the API to the network. Use 127.0.0.1, ` +
          'or set ALLOW_NETWORK_ACCESS=true only after HTTPS and the firewall rule are configured.',
      });
    }
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  host: string;
  port: number;
  allowNetworkAccess: boolean;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit: number;
  };
  auth: AuthConfig;
}

export interface AuthConfig {
  /** Undefined only for the database tools; the API refuses to start without it. */
  sessionSecret?: string;
  idleTimeoutMs: number;
  maxSessionMs: number;
  cookieSecure: boolean;
  /** Failed sign-in attempts allowed per IP address per 15 minutes. */
  loginRateLimit: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Validates raw environment variables. Pure: does not read files. */
export function parseConfig(raw: Record<string, string | undefined>): AppConfig {
  // Treat empty strings as "not set" so defaults apply, except for the password.
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    cleaned[key] = value === '' && key !== 'DB_PASSWORD' ? undefined : value;
  }

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const env = result.data;
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    host: env.HOST,
    port: env.PORT,
    allowNetworkAccess: env.ALLOW_NETWORK_ACCESS,
    db: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      connectionLimit: env.DB_CONNECTION_LIMIT,
    },
    auth: {
      sessionSecret: env.SESSION_SECRET,
      idleTimeoutMs: env.SESSION_IDLE_MINUTES * 60_000,
      maxSessionMs: env.SESSION_MAX_HOURS * 3_600_000,
      cookieSecure: env.COOKIE_SECURE,
      loginRateLimit: env.LOGIN_RATE_LIMIT,
      lockoutThreshold: env.LOCKOUT_THRESHOLD,
      lockoutMinutes: env.LOCKOUT_MINUTES,
    },
  };
}

/**
 * Loads server/.env (if present) into process.env using Node's built-in loader,
 * then validates. Variables already set in the environment win over the file.
 */
export function loadConfig(envFile = resolve(process.cwd(), '.env')): AppConfig {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseConfig(process.env);
}

// ---------------------------------------------------------------------------
// Settings used only by the command-line database tools (migrate, seed,
// backup, restore, app-user). The running API never needs these.
// ---------------------------------------------------------------------------

const toolSchema = z.object({
  DB_ADMIN_USER: z.string().trim().min(1).optional(),
  DB_ADMIN_PASSWORD: z.string().optional(),
  DB_APP_USER: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,32}$/, 'DB_APP_USER may only contain letters, digits and _')
    .default('judging_app'),
  DB_APP_PASSWORD: z.string().optional(),
  ADMIN_EMAIL: z.email('ADMIN_EMAIL must be a valid e-mail address').default('youmna54@gmail.com'),
  ADMIN_FULL_NAME: z.string().trim().min(1).max(200).default('Administrator'),
  ADMIN_INITIAL_PASSWORD: z.string().optional(),
  MYSQL_BIN_DIR: z.string().trim().optional(),
  BACKUP_DIR: z.string().trim().optional(),
});

export interface ToolConfig extends AppConfig {
  /** Account used for schema changes, backups and restores (defaults to DB_USER). */
  dbAdmin: { user: string; password: string };
  dbApp: { user: string; password?: string };
  admin: { email: string; fullName: string; initialPassword?: string };
  mysqlBinDir?: string;
  backupDir: string;
}

export function parseToolConfig(raw: Record<string, string | undefined>): ToolConfig {
  const base = parseConfig(raw);
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    const keepEmpty = key === 'DB_ADMIN_PASSWORD';
    cleaned[key] = value === '' && !keepEmpty ? undefined : value;
  }
  const result = toolSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const env = result.data;
  const adminUser = env.DB_ADMIN_USER ?? base.db.user;
  return {
    ...base,
    dbAdmin: {
      user: adminUser,
      password: env.DB_ADMIN_USER ? (env.DB_ADMIN_PASSWORD ?? '') : base.db.password,
    },
    dbApp: { user: env.DB_APP_USER, password: env.DB_APP_PASSWORD },
    admin: {
      email: env.ADMIN_EMAIL.toLowerCase(),
      fullName: env.ADMIN_FULL_NAME,
      initialPassword: env.ADMIN_INITIAL_PASSWORD,
    },
    mysqlBinDir: env.MYSQL_BIN_DIR,
    backupDir: resolve(process.cwd(), env.BACKUP_DIR ?? '../backups'),
  };
}

export function loadToolConfig(envFile = resolve(process.cwd(), '.env')): ToolConfig {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseToolConfig(process.env);
}
