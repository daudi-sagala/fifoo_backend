# Backend Integration Step 6 — Production Deployment

This pass turns the Step 5.58 backend into a production-deployment package for Azure App Service + Azure Database for PostgreSQL Flexible Server.

It does **not** contain live credentials. Production secrets are injected through Azure Key Vault/App Service settings at deployment time.

## 1. Production architecture

Recommended first production topology:

```text
Internet / iOS / Web
        |
        | HTTPS only, TLS 1.2+
        v
Azure App Service (Linux, Node 22)
        |
        |-- Application Insights / Log Analytics
        |
        |-- Azure Key Vault references
        |      |-- DATABASE_URL
        |      `-- ACS email connection string (or managed identity endpoint)
        |
        |-- Azure Communication Services Email
        |
        `-- TLS-verified PostgreSQL connection
                v
Azure Database for PostgreSQL Flexible Server
        |-- automated snapshot + WAL backups
        |-- 35-day PITR target
        `-- geo-redundant backup if selected when the server is created
```

The included App Service template deliberately starts with **one web worker**. The current Socket.IO room/broadcast state is process-local. Before scaling the backend to multiple web workers, add the Socket.IO Redis adapter (Azure Managed Redis or equivalent) so clients connected to different instances share realtime broadcasts.

## 2. Runtime changes in this pass

### HTTPS / reverse proxy security

`src/server.js` + `src/http/security.js`

- `TRUST_PROXY=true` in production.
- `REQUIRE_HTTPS=true` fails requests that reach the Node process without HTTPS-forwarding metadata.
- HSTS, `nosniff`, frame denial, no-referrer and restrictive API CSP headers are applied.
- App Service IaC also sets `httpsOnly=true`, minimum site TLS 1.2, SCM minimum TLS 1.2 and FTPS disabled.
- Native mobile clients with no browser `Origin` remain valid; browser origins must match the explicit `CORS_ORIGIN` allowlist.

### PostgreSQL TLS

`src/db.js`

Step 5 used:

```js
ssl: { rejectUnauthorized: false }
```

That is removed for production. Step 6 uses:

```env
PGSSL=true
PGSSL_REJECT_UNAUTHORIZED=true
```

and optional `PGSSL_CA` when a custom CA bundle is necessary. Standard system roots are otherwise used.

Pool/query operational limits are configurable through:

- `PG_POOL_MAX`
- `PG_IDLE_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`
- `PG_STATEMENT_TIMEOUT_MS`
- `PG_IDLE_TRANSACTION_TIMEOUT_MS`

### Startup-safe migrations

`src/services/migrations.js`

`RUN_MIGRATIONS_ON_START=true` is the production default.

The bootstrap process:

1. acquires a PostgreSQL advisory lock;
2. creates `fifoo_schema_migrations` if necessary;
3. checks migration SHA-256 values;
4. applies only missing numbered SQL files;
5. refuses to silently re-run an already-recorded migration whose contents changed;
6. releases the lock before the HTTP server starts.

This lets a new App Service deployment safely start without two simultaneous workers racing the migration set.

### Password-reset email delivery

`src/services/emailService.js`

Production now directly supports Azure Communication Services Email.

Preferred environment:

```env
EMAIL_PROVIDER=azure-communication-services
AZURE_COMMUNICATION_EMAIL_ENDPOINT=https://<resource>.communication.azure.com
EMAIL_SENDER_ADDRESS=donotreply@<verified-domain>
EMAIL_REPLY_TO_ADDRESS=support@fifoo.ai
```

With `AZURE_COMMUNICATION_EMAIL_ENDPOINT`, `DefaultAzureCredential` can use the App Service managed identity after that identity has permission to send through the Communication Services resource.

The included `infra/azure/main.bicep` uses a connection string stored in Key Vault because it is immediately deployable even before the managed-identity email role is configured:

```env
AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING=@Microsoft.KeyVault(...)
```

The application supports both forms. The endpoint + managed-identity form is preferred once IAM is configured.

The reset flow remains enumeration-safe: `/auth/password/forgot` always returns the same generic success message whether the address exists or not.

Production requires an HTTPS reset URL:

```env
PASSWORD_RESET_URL_BASE=https://fifoo.ai/reset-password
```

The email contains that URL plus the one-time reset token. Tokens continue to be stored only as SHA-256 hashes in PostgreSQL and all active sessions are revoked after a successful password change.

### Observability

`src/observability.js`, `src/lib/logger.js`, `src/bootstrap.js`

Production requires:

```env
APPLICATIONINSIGHTS_CONNECTION_STRING=<App Insights connection string>
```

Azure Monitor OpenTelemetry is initialized before Express, PostgreSQL and Socket.IO are imported.

The application also emits structured JSON logs to stdout/stderr with:

- timestamp;
- severity;
- service name;
- HTTP request ID;
- method/path/status/duration;
- scheduler outcomes;
- migration outcomes;
- reset-delivery outcomes;
- database/health failures.

Common secret-looking fields (`token`, `password`, `secret`, connection strings, authorization, cookies) are redacted by the logger.

HTTP responses receive `x-request-id` so a device/server failure can be correlated with Application Insights logs.

### Rate limiting

`src/http/rateLimit.js`

Application limits are a second line of defense:

- general HTTP requests;
- login attempts;
- signup attempts;
- password-reset requests;
- Socket.IO connection attempts;
- acknowledged realtime mutations.

Production defaults are configured through `.env.production.example`.

These in-process limits protect a single App Service worker. For internet-scale/global enforcement, place Azure Front Door WAF in front of App Service and create edge rate-limit rules, especially for `/auth/login`, `/auth/signup`, `/auth/password/forgot`, `/socket.io/`, and obvious abuse patterns.

### Daily production path scheduler

`src/services/dailyPathScheduler.js`

Step 6 now closes the missing scheduling gap from Pass 5.55.

On startup and then every five minutes by default, the scheduler:

1. loads all users;
2. resolves each user's latest known Day Map timezone, falling back to `DEFAULT_TIME_ZONE`;
3. calculates that user's current local calendar date and local seconds-from-midnight;
4. checks whether that date already has a recorded generator run;
5. for a missing day, opens a transaction and takes a per-user/per-date PostgreSQL advisory transaction lock;
6. calls `generateDailyPathForUser(...)`;
7. commits the generated nodes, chosen route, alternatives and generation ledger atomically.

The lock plus the generator's existing deterministic IDs/idempotence makes repeated scheduler ticks and overlapping app starts safe.

Production must use:

```env
DAILY_PATH_SCHEDULER_ENABLED=true
DAILY_PATH_SCHEDULER_INTERVAL_MS=300000
```

If the backend was offline at midnight and starts later in the day, the scheduler passes the user's current local time into the route builder, so already-past stops are classified into the completed portion rather than pretending the day starts at midnight.

## 3. Files added / changed

Core production runtime:

```text
src/bootstrap.js
src/observability.js
src/config.js
src/db.js
src/server.js
src/lib/logger.js
src/lib/runtimeConfig.js
src/lib/errors.js
src/http/security.js
src/http/rateLimit.js
src/http/authRoutes.js
src/services/emailService.js
src/services/migrations.js
src/services/dailyPathScheduler.js
src/services/authService.js
src/socket/registerGameSocket.js
```

Deployment:

```text
.env.production.example
infra/azure/main.bicep
scripts/deploy-azure-infrastructure.sh
scripts/verify-production.sh
.github/workflows/deploy-production.yml
```

Tests:

```text
test/productionHardening.test.js
test/rateLimit.test.js
```

## 4. Azure resources to create

The included Bicep template creates:

- Linux App Service plan;
- Linux App Service running Node 22;
- system-assigned App Service managed identity;
- Log Analytics workspace;
- Application Insights resource;
- Key Vault with RBAC, soft delete and purge protection;
- Key Vault Secrets User access for the App Service identity;
- Key Vault secrets for `DATABASE_URL` and ACS email connection string;
- App Service production environment settings;
- App Service `/ready` health-check path.

It intentionally does **not** create your PostgreSQL Flexible Server or ACS Email/domain because those resources need production-specific networking, sizing, region, DNS/domain verification, backup redundancy and ownership choices.

## 5. PostgreSQL production configuration

Use Azure Database for PostgreSQL **Flexible Server**.

Recommended production settings:

- PostgreSQL current supported major version appropriate for the workload;
- TLS required;
- TLS 1.2 minimum, or TLS 1.3 if all clients are verified compatible;
- connection certificate validation from Node (`PGSSL_REJECT_UNAUTHORIZED=true`);
- dedicated application database/user rather than using the server admin credential at runtime;
- high availability where the chosen SKU/region supports it;
- storage auto-grow;
- 35-day backup retention;
- geo-redundant backup **selected at server creation** if cross-region restore is required;
- periodic restore drills;
- long-term retention/export policy if business/legal requirements exceed the PITR window.

### App database user

Create a least-privilege database role for the app instead of using the PostgreSQL server administrator in `DATABASE_URL`.

For the initial migration, the migration identity needs DDL rights. After migrations, the runtime role needs DML rights on Fifoo tables/sequences. A stricter separation can later use `DATABASE_MIGRATION_URL` and `DATABASE_URL` as two Key Vault secrets.

### Backups

Flexible Server automatically provides snapshot/WAL backup for PITR. Set the normal PITR retention target to 35 days.

Geo-redundant backup storage is a creation-time selection. If the existing production server was created without it, it cannot simply be toggled on later; create/plan the DR topology intentionally rather than assuming that changing an app setting adds geo restore.

## 6. Azure Communication Services Email setup

Before the first password reset is tested:

1. create an Email Communication Services resource;
2. provision an Azure-managed domain for initial testing or verify the Fifoo custom sending domain;
3. link the email domain to the Communication Services resource;
4. copy the verified MailFrom address into `EMAIL_SENDER_ADDRESS`;
5. either:
   - place the ACS connection string into the Key Vault deployment parameter; or
   - set `AZURE_COMMUNICATION_EMAIL_ENDPOINT` and grant the App Service identity the required Communication Services send permissions.

For production deliverability on a custom domain, complete the DNS sender-authentication records supplied by Azure (SPF/DKIM/domain verification) before sending user-facing resets.

## 7. Deploy infrastructure

Set shell variables locally or in Azure Cloud Shell:

```bash
export AZURE_RESOURCE_GROUP=fifoo-production
export AZURE_LOCATION=eastus
export AZURE_WEBAPP_NAME=fifoo-game-api-prod
export PUBLIC_BASE_URL=https://api.fifoo.ai
export CORS_ORIGIN=https://fifoo.ai,https://www.fifoo.ai
export PASSWORD_RESET_URL_BASE=https://fifoo.ai/reset-password
export EMAIL_SENDER_ADDRESS=donotreply@fifoo.ai
export EMAIL_REPLY_TO_ADDRESS=support@fifoo.ai
export DATABASE_URL='postgresql://...'
export ACS_EMAIL_CONNECTION_STRING='endpoint=https://...;accesskey=...'

./scripts/deploy-azure-infrastructure.sh
```

The secure Bicep parameters are written into Key Vault. They are not checked into the repository.

## 8. Custom domain and TLS

After the App Service exists:

1. add `api.fifoo.ai` as an App Service custom domain;
2. create the required DNS verification/CNAME records;
3. bind an App Service managed certificate or another trusted certificate;
4. keep **HTTPS Only** enabled;
5. keep both the application and SCM minimum TLS version at 1.2 or higher.

Do not add a self-signed production certificate.

## 9. GitHub Actions deployment

`.github/workflows/deploy-production.yml` uses GitHub -> Azure OpenID Connect rather than an App Service publish-profile password.

Configure the Azure federated identity and repository production environment, then set:

GitHub environment secrets:

```text
AZURE_CLIENT_ID
AZURE_TENANT_ID
AZURE_SUBSCRIPTION_ID
```

GitHub environment variables:

```text
AZURE_WEBAPP_NAME
PRODUCTION_API_BASE_URL=https://api.fifoo.ai
```

On every production deployment the workflow:

1. installs Node 22 dependencies;
2. runs syntax checks;
3. runs the test suite;
4. signs into Azure using OIDC;
5. deploys the application;
6. polls `/ready` until PostgreSQL-backed readiness succeeds.

## 10. Production verification

Run:

```bash
export API_BASE_URL=https://api.fifoo.ai
./scripts/verify-production.sh
```

Then manually test:

- signup;
- login;
- token refresh;
- logout/logout-all;
- forgotten password to a real inbox;
- reset link -> new password -> old sessions invalidated;
- Socket.IO authentication;
- initial Day Map snapshot;
- one node mutation + reconnect;
- one Fifoo Play mutation;
- scheduler generation for a user whose local date has no generation run.

## 11. Observability alerts

Create Azure Monitor alerts for at least:

- App Service HTTP 5xx rate;
- App Service response latency;
- App Service CPU/memory and restarts;
- `/ready` health failures;
- PostgreSQL CPU/storage/connections;
- PostgreSQL failed connections;
- PostgreSQL storage approaching capacity;
- Application Insights exception rate;
- password-reset delivery failures;
- daily scheduler failure logs;
- unusually high 401/429 rates.

Do not alert on individual wrong-password attempts. Alert on sustained rates/patterns.

## 12. Backup / restore operations

A backup is only useful if restore is exercised.

Production operations should include:

- 35-day PITR retention;
- at least quarterly test restores into a nonproduction Flexible Server;
- validation that the restored database passes `npm run migrate` with no drift;
- application smoke test against the restored copy;
- documented recovery ownership/RTO/RPO;
- optional Azure Backup Vault / long-term-retention backups if recovery requirements exceed standard PITR.

## 13. Rate limiting at Azure edge

The application-level throttles in this pass are deliberately conservative and local to each web worker.

Before large public traffic, put Azure Front Door WAF in front of App Service and configure:

- managed WAF rules;
- bot protection as appropriate;
- rate-limit rules for authentication routes;
- rate-limit/abuse rules for Socket.IO handshake traffic;
- origin restriction so direct App Service traffic is not a bypass path.

If Front Door becomes the only intended public ingress, restrict the App Service origin to the specific Front Door instance/service tag or use Front Door Premium Private Link.

## 14. Scaling beyond one App Service worker

Do **not** simply change `workerCount` from 1 to 2+ yet.

Socket.IO rooms, connection presence and broadcasts currently live inside one Node process. Before horizontal scale-out:

1. add `@socket.io/redis-adapter`;
2. connect it to Azure Managed Redis (or equivalent production Redis);
3. keep auth/session state in PostgreSQL as it is today;
4. verify cross-instance node/route/play broadcasts;
5. then increase App Service workers to 2+ and enable health-based instance replacement.

The daily scheduler itself is already safe across multiple instances because generation is protected by PostgreSQL advisory locks and idempotent generation records.

## 15. Secret rotation

Rotate independently:

- PostgreSQL app password / `DATABASE_URL`;
- ACS connection string if connection-string auth is retained;
- any external auth verifier credential if `AUTH_MODE=external` is used in the future.

Key Vault references without pinned secret versions can move to the newest secret version. Restart/refresh the App Service after emergency rotations instead of waiting for normal reference refresh.

No real secret belongs in `.env.production.example`, Bicep parameter files, GitHub source, or application logs.

## 16. Step 6 completion boundary

The code/config portion of production deployment is complete when:

- the production startup validation passes;
- the app starts only behind HTTPS;
- PostgreSQL TLS verification succeeds;
- migrations run under the advisory lock;
- Application Insights receives telemetry;
- a real password-reset email is delivered;
- daily path generation occurs automatically per user's local calendar day;
- `/ready` is healthy;
- secrets resolve through Key Vault;
- the GitHub OIDC workflow deploys successfully;
- backup retention and restore procedure are verified in Azure.

The final Azure resource creation/DNS/credential values must be executed in the actual Azure subscription; they are intentionally not embedded in this repository.

## 17. Validation performed for this package

The generated Step 6 package was checked in the build environment with:

```bash
npm run check
bash -n scripts/deploy-azure-infrastructure.sh scripts/verify-production.sh
node --test test/productionHardening.test.js test/rateLimit.test.js
```

Results:

- all JavaScript files passed Node syntax validation;
- both shell scripts passed `bash -n`;
- the GitHub Actions YAML parsed successfully;
- all 11 Step 6 production-hardening/rate-limiter tests passed;
- repository scan found no executable `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`, or `sslmode=disable` setting.

The complete pre-existing test suite could not be executed in the artifact-generation environment because npm dependency installation was not available there. The production GitHub Actions workflow therefore installs dependencies and runs the complete `npm test` suite before Azure deployment; a failing suite prevents deployment.

The Bicep template was syntax-reviewed but not compiled with Azure CLI/Bicep in the artifact-generation environment because those tools were not installed. Run an Azure `what-if`/deployment in the target subscription before production cutover.
