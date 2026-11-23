# Production deployment and release gates

This runbook prepares a single Node.js 24 process behind an HTTPS reverse proxy,
with MySQL 8.4 LTS or a maintained MariaDB LTS database. Nothing is deployed by
the packaging command. Do not point verification jobs at the competition database.

## Packages

From the development checkout, use Node.js 24 and run:

```powershell
npm ci
npm run check
npm run test:db
npm run package:production
npm audit
```

`npm run test:db` creates guarded scratch databases. Use an isolated database server
for release verification, with test-only DB credentials supplied in the process
environment. It must never run as the production service account against real data.

Two deterministic archives are written to `artifacts/`, each with a SHA-256 sidecar
and a per-file manifest:

- `ischool-ahly-production-runtime.zip`: compiled application, browser assets,
  shared runtime, all three workspace manifests, lockfile, compiled maintenance
  tools, unchanged migrations 001–013 and this runbook. Install production dependencies
  from the lockfile on the target; dependencies are not embedded as `node_modules`.
- `ischool-ahly-production-build-source.zip`: production application source,
  assets, manifests, lockfile, build configurations, production maintenance source
  and migrations. It excludes tests, test fixtures and demo/reset scripts. This
  archive can be installed and built independently; it is not the complete developer
  repository and is not intended to run the developer test suite.

Neither archive includes real environment files, credentials, SQL backups, database
data directories, Git metadata, dependencies, source maps, screenshots, caches or logs.
The environment template contains blank secrets. Packaging scans for configured local
credential values and private-key/token patterns, refusing a package if detected.
Untracked required implementation files are included by explicit source allowlists.
Keep the original checkout and backups; packaging does not delete them.

## Target requirements and release blockers

- Node.js **24.x LTS**, updated to a currently supported security patch; npm's
  lockfile installation must succeed. The install and startup commands reject
  other Node major versions.
- MySQL **8.4 LTS** or MariaDB **10.11/11.4/11.8/12.3 LTS**, using InnoDB and
  `utf8mb4`. Use the current maintenance patch for the selected series. Older
  XAMPP/MariaDB 10.4 is a development compatibility target and is rejected by
  production startup because it is out of maintenance.
- A real hostname, valid HTTPS certificate, DNS, firewall rules and a supervised
  service account. These infrastructure decisions cannot be verified before the
  target host/domain is supplied. Verify the actual proxy and certificate in staging.
- The runtime DB account must have only application grants. A separate maintenance
  account needs the privileges necessary to apply tables, views, triggers and stored
  procedures and to back up/restore them. Managed services must support those features
  and permit the required definer privileges. Validate this on the exact provider.
- Keep Node and the database on loopback/private interfaces. A remote database must
  use verified TLS; certificate hostname and CA validation cannot be disabled.
- Keep application and database servers in the same configured timezone. The existing
  DATETIME model uses local timestamps; review historical timestamp interpretation
  before a cross-region/server move. Do not silently reinterpret existing records.
- This release uses one API process. IP rate limits and reset preview tickets are
  process-local. Do not introduce multiple processes/replicas without shared rate
  limiting and coordinated maintenance. MySQL sessions alone do not solve that.
- Restore a verified backup in an isolated database before opening a release.
  Define and test backup storage, encryption, off-host replication, monitoring and
  recovery time/data-loss objectives. The package does not provision these services.

Startup checks DB version and all migration checksums, without applying migrations.
Migration 007 contains MariaDB's historical `PERSISTENT` alias. The migration runner
translates only its two generated-column declarations to MySQL's `STORED` spelling
when connected to MySQL; original migration files and recorded source checksums are
unchanged. Do not edit or squash applied SQL files.

For MySQL backups, the dump stream also removes the redundant terminator from
version-wrapped single-statement protection triggers before calculating its checksum.
This works around [MySQL bug 77856](https://bugs.mysql.com/bug.php?id=77856), so the
dump imports with the native client. Trigger behavior and quoted message content are
preserved; reviewed backup files are never edited during restore. Recovery fingerprints
cover tables/data, triggers, views and stored routine names.

## Production environment variables

Use `production.env.example` as a list of names. Inject values through the service
manager or a protected secret store. **Production does not load local `.env` files.**
Never put actual secrets into an archive, browser `VITE_*` variable, Git or command
history. Keep environment/CA files outside the release directory with restricted ACLs.

| Name                        | Production value/purpose                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                  | `production`; `npm start` enforces production mode                                                                             |
| `HOST`                      | `127.0.0.1` behind a proxy on the same host                                                                                    |
| `PORT`                      | Private application port, normally `4000`                                                                                      |
| `ALLOW_NETWORK_ACCESS`      | `false` for loopback; only enable for an explicitly firewalled private network binding                                         |
| `PUBLIC_ORIGIN`             | Exact canonical HTTPS origin, e.g. `https://judging.example.com`, without a trailing slash/path                                |
| `TRUST_PROXY`               | Exact proxy IPs/CIDRs separated by commas, or `loopback` for a same-host proxy; never `true`, a hop count, or a blanket subnet |
| `CORS_ORIGINS`              | Blank for same-origin hosting; otherwise exact additional HTTPS origins separated by commas. No wildcard or reflected origins  |
| `COOKIE_SECURE`             | Required `true`                                                                                                                |
| `SESSION_SECRET`            | Required independently generated random secret, at least 32 characters; use 48 random bytes or more                            |
| `SESSION_IDLE_MINUTES`      | Idle expiry, default `240`; choose a competition-appropriate timeout                                                           |
| `SESSION_MAX_HOURS`         | Absolute session lifetime, default `12`                                                                                        |
| `LOGIN_RATE_LIMIT`          | Failed sign-ins per client IP per 15 minutes, default `20`                                                                     |
| `LOCKOUT_THRESHOLD`         | Account-wide failed-login threshold, default `5`                                                                               |
| `LOCKOUT_MINUTES`           | Account lockout, default `15`                                                                                                  |
| `DB_HOST`, `DB_PORT`        | Database hostname and port; default port `3306`                                                                                |
| `DB_NAME`                   | Explicit target application database name; never use another application's database                                            |
| `DB_USER`, `DB_PASSWORD`    | Restricted runtime account and a unique strong password, at least 12 characters. `root`/admin runtime accounts are refused     |
| `DB_CONNECTION_LIMIT`       | Pool size, default `10`; size for database and host capacity                                                                   |
| `DB_TLS`                    | `true` for remote database connections; can also be enabled on loopback                                                        |
| `DB_TLS_CA_FILE`            | Trusted PEM CA file for DB TLS. Chain and hostname verification are enabled; minimum TLS 1.2                                   |
| `MAINTENANCE_API_ENABLED`   | Default `false` in production. Keep disabled in the ordinary web service                                                       |
| `COMPETITION_RESET_ENABLED` | Default `false`. Do not enable without explicit approval of the fresh backup and deletion preview                              |

Cookies are Secure, HttpOnly and SameSite=Strict. Use one public origin for browser
and API. Additional CORS origins do not change cookie SameSite policy and do not
enable a cross-site frontend. Cross-site writes remain rejected. The application
does not accept an arbitrary public URL from request headers. The configured proxy
must overwrite forwarding headers and be the only network path to Node.

Supply these additional variables only in a separate, protected maintenance session:

| Name                                 | Purpose                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD` | Schema/backup/restore operator account; never give these to the normal web process                                                                 |
| `DB_APP_USER`, `DB_APP_PASSWORD`     | Account provisioned by `production:app-user`; must match the runtime credentials                                                                   |
| `ADMIN_EMAIL`, `ADMIN_FULL_NAME`     | Initial administrator; preserve `youmna54@gmail.com` when migrating existing competition data                                                      |
| `ADMIN_INITIAL_PASSWORD`             | Optional one-time seed password on an empty installation. Omit to generate one; never reseed/reset an existing administrator as part of deployment |
| `MYSQL_BIN_DIR`                      | Directory with matching vendor `mysql`/`mysqldump` executables, or let them resolve through PATH                                                   |
| `BACKUP_DIR`                         | Absolute protected directory outside the release/static trees                                                                                      |

The maintenance tools validate the normal production environment as well; provide
the application configuration to the maintenance session plus these operator values.
Do not print a complete environment when troubleshooting. Backup tool credentials
use short-lived private option files, not process-list password arguments.

## Clean installation and controlled database changes

Extract into a **new** release directory; do not overlay files on an old build.
Verify the ZIP checksum first, for example on Windows:

```powershell
Get-FileHash .\ischool-ahly-production-runtime.zip -Algorithm SHA256
Expand-Archive .\ischool-ahly-production-runtime.zip -DestinationPath .\release
cd .\release\judging-platform
node -v
npm -v
npm ci --omit=dev
```

Compare the reported SHA-256 with the sidecar through a trusted channel. The archive
contains no `node_modules`; `npm ci --omit=dev` installs locked runtime dependencies
and workspace links. Do not use `--ignore-scripts` to bypass the Node version check.

To verify or rebuild from the build-source archive instead:

```powershell
npm ci --include=dev
npm run build
```

Use `--include=dev` even if the build machine's environment says production. Build
tools are needed at build time. Build on the target OS/architecture or a compatible
build agent. Never use Vite's development/preview servers for public hosting.

With the protected production/maintenance environment injected, run from the release
root, **before** starting the web service:

```powershell
# Existing installation: stop/drain writers, take and verify a safety backup first.
npm run production:backup
npm run production:migrate -- --status
# Review pending migrations and their effects, then explicitly apply them.
npm run production:migrate
```

For a genuinely new, empty installation only, first create the configured database
with `npm run production:create`, then migrate. Seed the initial administrator with
`npm run production:seed` only after confirming the database is the intended empty
installation. Provision runtime grants with `npm run production:app-user`, using
the selected runtime password. That command sets the configured account's password
and grants; review existing account use before running it on an existing server.

Do not run `db:reset`, demo scripts, fixture imports or competition reset during
deployment. Those development reset/demo commands are not shipped in the runtime
package. Ordinary service startup never creates tables, applies migrations or seeds
accounts. Schema migrations involve DDL and are not atomic: restore the safety backup
if a migration fails; do not open judging on a partially migrated schema.

## HTTPS, startup and supervision

Replace the domain and certificate paths in `nginx.conf.example`. Run `nginx -t`
before reloading the proxy. The example redirects HTTP to a fixed canonical hostname,
terminates HTTPS, preserves that Host and overwrites forwarded client/protocol headers.
It must proxy the entire application, including `/api`, through the same HTTPS origin.
Firewall the Node port from public access and restrict database access to required hosts.

After injecting the runtime-only environment (no maintenance credentials), start:

```powershell
npm start
```

On Linux, use the included `ischool.service.example` with reviewed absolute paths,
a dedicated unprivileged user and an environment file outside the release. On Windows,
configure the same Node executable, working directory `release\server`, command
`node dist/src/index.js --production` and environment through your approved Windows
service manager. A foreground terminal is suitable for verification, not unattended
operation. Configure automatic restart, log rotation, disk monitoring and graceful
SIGTERM/service-stop handling. Do not use clustered process mode for this release.

The application refuses non-HTTPS traffic except the minimal `/api/health` liveness
check. Secure cookies require the trusted proxy to report HTTPS. HSTS is enabled for
production without preload or implicit subdomain commitments. Match `TRUST_PROXY` to
the real topology; exposing Node directly undermines that trust boundary.

## Backup, restore and rollback

Schedule `npm run production:backup` from the protected maintenance environment at
an agreed interval (at least hourly during active judging), and before every migration
or approved reset. Keep encrypted off-host copies; monitor failures and disk space.
Do not delete existing backups as part of release packaging. SQL dumps include tables,
data, views, triggers and routines, with completion and SHA-256 verification.

On POSIX create the backup directory with owner-only permissions and umask `077`.
New dump/checksum files are created with mode `0600`. On Windows restrict the backup
directory ACL to the maintenance identity, SYSTEM and Administrators before use.
Protect temporary directories too. Dump files contain account password hashes and
competition data, so a checksum is not a substitute for encryption/access control.

First validate recovery using `npm run production:restore-check`.
It takes a fresh backup, restores only into the guarded scratch target and compares fingerprints; review
required CREATE/DROP privileges for that scratch database. Use matching vendor tools.
Never transplant a MariaDB dump into MySQL, or the reverse, as an untested upgrade.

For an approved real recovery, stop all writers and preserve the current state:

```powershell
npm run production:restore -- --in-place "D:\secure-backups\approved-backup.sql"
```

Type the exact configured target database name at the prompt. The tool verifies the
sidecar checksum and creates a pre-restore safety backup. `--in-place` restores into
the existing target without dropping/recreating the database itself. Do not use `--yes`
for an interactive production recovery. DDL restoration is not transactional: keep
writers stopped if it fails. Restore matching code/schema together, verify migration
checksums, then invalidate restored sessions in the selected database's admin SQL console:

```sql
START TRANSACTION;
UPDATE sessions SET expires=0,data=NULL;
UPDATE users SET session_epoch=session_epoch+1;
COMMIT;
```

These statements preserve password hashes. Retain the external maintenance log.
Switching application code back alone is unsafe after incompatible schema changes;
recover the matched data/schema backup and release. Rehearse that recovery in staging.

## Acceptance checks before public release

1. Confirm HTTPS certificate/hostname, HTTP redirect, CSP/HSTS and Secure/HttpOnly/
   SameSite cookies through the real proxy. Verify direct Node access is blocked.
2. Check `/api/health` is minimal; guests/judges cannot access admin diagnostics,
   Settings, reports, lifecycle transitions or correction APIs. Errors must not expose
   SQL, database names, credentials, connection strings or stack traces.
3. Sign in/out as both roles; check password changes, expiry, account disable/session
   invalidation, login throttling and account lockout. Confirm the proxy supplies the
   actual client IP so all judges do not share the proxy's rate-limit bucket.
4. On isolated staging data: prepare teams and a rubric, start, submit three judges'
   evaluations on the locked rubric, correct/reopen with immutable history, reject
   stale edits, check exact averages/ties and exports, then close and confirm read-only
   behavior. Verify fewer-judge teams and historical exclusions still work.
5. Confirm both maintenance API and Reset Competition execution are disabled in the
   normal service. A production reset is a separate owner-approved operation requiring
   a fresh verified backup, deletion preview, password, exact phrase and final confirmation.
6. Verify backup/restore, migration checksums, cold restart and operational monitoring.
   Check the final readiness report for actual test coverage and unresolved blockers.

References: [Node LTS policy](https://nodejs.org/en/about/previous-releases),
[Express proxy trust](https://expressjs.com/en/guide/behind-proxies/),
[MariaDB maintenance policy](https://mariadb.org/about/#maintenance-policy).
