# Fifoo Game Backend — Backend Integration Step 3

Runnable Node.js 20 + Express + Socket.IO + PostgreSQL server for the validated Pass 5.37 iOS contract.

## What is implemented

- `game:auth` with explicit development dummy auth or an external existing-auth verifier.
- Full `game:sync:request` -> `game:sync:snapshot` flow.
- Per-user/per-day Socket.IO rooms and cross-device authoritative broadcasts.
- Request UUID idempotency through `day_map_mutations`.
- Optimistic concurrency using the Day Map revision; stale clients receive a conflict and must reconcile before retry.
- One PostgreSQL transaction + exactly one Day Map revision increment per authoritative mutation.
- Generic node add/update/delete.
- ActivityTask update/reschedule/skip/complete.
- ActivityMeal update/skip/complete using the full canonical execution-plan node snapshot.
- ActivityWorkout update/select/reschedule/check-in, with check-ins persisted separately from membership.
- Tile reveal persistence and `game:tile:reveal:state` broadcasts.
- Suggested-stop accept/reject persistence.
- Post replies, post saves and Day-Map-scoped hyperlink votes.
- Backend-authoritative route generation/attachment and alternative selection. Client-authored route commits are rejected.
- Debounced server search results.
- Full Fifoo Play workout/exercise lifecycle persistence, live messages and reactions.
- Health/readiness HTTP endpoints.

## 1. Database

Apply your existing Fifoo schema first, then:

```bash
# Either use the included Node migration runner:
npm run migrate

# Or apply it directly with psql:
psql "$DATABASE_URL" -f sql/001_step3_game_backend.sql
```

The migration is additive. It does not replace `day_maps`, `day_map_nodes`, `activities`, `tasks`, `workouts`, `posts`, etc.

### Development dummy user

`DUMMY_USER_ID` must point to a real `users.user_id`. You can use an existing development user. The server never trusts the client envelope's `context.userID`; the authenticated socket identity is authoritative.

## 2. Configure

```bash
cp .env.example .env
```

Set at minimum `DATABASE_URL` and authentication settings.

### Development auth

```env
AUTH_MODE=development
ALLOW_DUMMY_AUTH=true
DUMMY_AUTH_TOKEN=DUMMY_AUTH_TOKEN
DUMMY_USER_ID=<existing users.user_id UUID>
```

This accepts the Pass 5.37 placeholder token but maps it to the real UUID from `DUMMY_USER_ID`.

### Existing/production auth integration

Use:

```env
NODE_ENV=production
AUTH_MODE=external
AUTH_VERIFY_URL=https://your-existing-backend.example.com/internal/verify-session
ALLOW_DUMMY_AUTH=false
CORS_ORIGIN=https://your-web-app.example.com
```

Production startup fails fast if dummy/development auth is enabled, `AUTH_VERIFY_URL` is missing, or CORS is left as `*`.

The game backend POSTs:

```json
{"userID":"client hint","deviceID":"..."}
```

with `Authorization: Bearer <authToken>`. The verifier must return HTTP 200 and JSON containing a UUID `userID` (or `user_id` / `sub`). This lets Step 3 use the existing Fifoo login/session authority instead of inventing a second login system.

## 3. Run

```bash
npm install
npm run migrate
npm run check
npm test
npm run dev
```

Health checks:

```text
GET /health
GET /ready
```

## 4. Enable the iOS client

After this backend is reachable, replace the Pass 5.37 placeholder configuration with the deployed Socket.IO server URL, authenticated user/token/device values, and set `isEnabled: true`.

Do not enable networking before applying the migration: Pass 5.37 clears development fixtures once a real backend is enabled and expects the first authoritative snapshot to populate the app.

## Persistence model

`day_map_nodes.node_data` is the lossless Swift `GameMapNode` Codable snapshot. Indexed relational columns (`node_kind`, `source_id`, `time_seconds`, `progress`, `is_enabled`) are projections. Activity/Post/Task/Workout/SuggestedMeal tables are updated in the same transaction as the node snapshot so they cannot drift after a successful commit.

Road-attached nodes do not carry a semantic progress percentage in their Swift placement payload. For those nodes the server preserves the existing relational `progress` projection (or 0 on first insert); `node_data` remains authoritative.

## Intentional Step 3 boundaries

- Meal/Workout catalog browsing remains local until those catalogs are made server-backed.
- Legacy route draft/preview telemetry remains non-authoritative; client-authored route commit mutations are rejected.
- Recipe countdown ticks, SpriteKit pan/zoom, animations, voice mute and pedometer sampling are client mechanics.
- The iOS client now uses a durable, ordered mutation outbox with stable request IDs and revision rebasing after reconnect/conflict.

## Production hardening baseline

This build now fails fast on unsafe production auth/CORS configuration, caps mutation payload size, disconnects sockets that never authenticate, sanitizes non-mutation server errors, and enforces optimistic Day Map revisions. The iOS Release configuration is intentionally disabled until the real authenticated backend bootstrap is supplied, so local dummy credentials are DEBUG-only.

Before public production traffic, still configure the real external auth verifier, rotate/manage secrets through the deployment platform, enforce TLS at the reverse proxy/App Service boundary, add platform-level rate limiting and structured observability, and use the Socket.IO Redis adapter (or equivalent) when running more than one server instance.


## Container / Azure App Service

A `Dockerfile` is included for container deployment. The server reads the platform-provided `PORT` variable and starts with `npm start`, so it can also run as a normal Node application in Azure App Service without Docker. Configure `DATABASE_URL`, authentication variables, `PGSSL=true` when required by the managed PostgreSQL service, and a production `CORS_ORIGIN` in the App Service environment.

## Frozen client contract

`contract/` contains the exact Pass 5.37 `GameSocketEvents.swift` and `GameSocketPayloads.swift` used to implement this server. `docs/` contains the Step 2 Socket.IO/PostgreSQL contract. Keep these files with the backend while the iOS and server implementations evolve so event drift is visible in code review.

## Pass 5.54 — Authentication & Account Lifecycle

Run `npm run migrate` after applying Pass 5.54. The migration runner now applies every numbered SQL file, including `sql/002_step5_authentication.sql`.

First-party auth endpoints live under `/auth`. For local testing, `AUTH_MODE=development` accepts both real Fifoo login sessions and the existing explicit dummy token fallback. For production Fifoo-managed auth, use `AUTH_MODE=internal`, disable dummy auth/reset-token exposure, configure an explicit CORS allowlist, and provide `PASSWORD_RESET_DELIVERY_URL`.

## Pass 5.55 — development seed + daily path generation

Apply migrations first:

```bash
npm run migrate
```

### Seed realistic development data

Development only (`NODE_ENV=production` is refused):

```bash
npm run seed:dev
```

Default test login:

- email: `demo.weightloss@fifoo.local`
- username: `weightloss_demo`
- password: `FifooTest123!`

The seed is repeatable. It creates/updates a small reusable catalog of exercises,
workouts, meals, tasks and posts, then generates today's standard Day Map for
the demo account.

Useful options:

```bash
npm run seed:dev -- --date 2026-08-29 --force-day
npm run seed:dev -- --email test@example.com --username tester --password 'ExamplePass123!' --reset-password
npm run seed:dev -- --no-day
```

### Generate daily paths

One user:

```bash
npm run generate:daily -- --email demo.weightloss@fifoo.local --date 2026-08-29 --force
```

All users:

```bash
npm run generate:daily -- --date 2026-08-29
```

Product code can call:

```js
await generateDailyPathForUser(client, {
  userID,
  mapDate,
  timeZoneIdentifier,
});
```

or the scheduler-oriented batch entry point:

```js
await generateDailyPathsForAllUsers({ mapDate });
```

The temporary product rules are isolated in
`src/rules/standardWeightLossDay.js`. Replacing those rules does not require
rewriting route/pathfinding code.

## Aug. 29, 2026 rich demo Day Map

For the seeded `demo.weightloss@fifoo.local` account, a richer full-day visual fixture is available via the `demo-aug29` rules set:

```bash
npm run seed:dev -- \
  --date 2026-08-29 \
  --rules demo-aug29 \
  --current-time 15:45:53 \
  --alternatives 2 \
  --force-day
```

Edit `src/rules/demoWeightLossDayAug29.js` and replace the null values in
`DEMO_AUG29_IMAGE_URLS` with durable HTTPS image URLs (Cloudinary `secure_url`
values are recommended). Each stop also includes an `imageSearchHint` to make
finding a representative image straightforward. Regenerate after changing URLs.

---

## Backend Integration Step 6 — production deployment

The production deployment implementation is documented in:

```text
docs/BACKEND_INTEGRATION_STEP6_PRODUCTION_DEPLOYMENT.md
```

Step 6 adds:

- Azure App Service deployment configuration with HTTPS-only/TLS 1.2+ settings;
- Azure Key Vault secret references;
- PostgreSQL server-certificate verification;
- safe startup migrations with advisory locking + migration checksums;
- Azure Communication Services password-reset email delivery;
- Azure Monitor OpenTelemetry/Application Insights bootstrap;
- structured/redacted JSON logging and request correlation IDs;
- HTTP/auth/Socket.IO application throttles;
- timezone-aware automatic daily-path generation in production;
- GitHub Actions OIDC deployment;
- Azure Bicep/App Service infrastructure configuration;
- backup/restore, alerts, domain/TLS and production verification runbooks.

Use `.env.production.example` as the non-secret environment contract. Do not create a real production `.env` file in the repository.
