# Fifoo Game Backend — Continuous Routing & Progress Foundation

Runnable Node.js 22+ + Express + Socket.IO + PostgreSQL server for the validated Pass 5.37 iOS contract.

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
- Continuous Day Graph intervals covering exactly `[00:00:00, 24:00:00)`.
- Fasting/sleep/free-time filler nodes with metabolic context and no temporal gaps.
- Versioned 100-point progress budgets and append-only progress-ledger outcomes.
- Deterministic beam-search routing with hard constraints, diverse alternatives,
  and population/cohort/individual cold-start probability blending.

## 1. Database

Apply your existing Fifoo schema first, then:

```bash
# Either use the included Node migration runner:
npm run migrate

# Or apply it directly with psql:
psql "$DATABASE_URL" -f sql/001_step3_game_backend.sql
```

The migration is additive. It does not replace `day_maps`, `day_map_nodes`, `activities`, `tasks`, `workouts`, `posts`, etc.

`npm run migrate` now also applies `sql/005_day_graph_progress_routing.sql`.
That migration adds the algorithm read/write model while preserving the current
iOS node and route payloads.

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

## Routing and progress algorithms v1 + future-only rerouting

The implementation is split into pure, independently testable layers:

- `src/algorithms/dayGraph.js` compiles interval nodes, generates filler nodes,
  splits intervals at exact seconds, and enforces connected branch invariants.
- `src/algorithms/progressEngine.js` allocates exactly 100 value-weighted points,
  caps fasting rewards, evaluates partial/binary/composite outcomes, and
  calculates actual plus expected end-of-day progress.
- `src/algorithms/routingEngine.js` performs hard-constraint filtering and beam
  search, scores complete routes, diversifies alternatives, and blends
  population/cohort/individual completion probabilities by confidence.
- `src/services/dayPlanning.js` persists versioned graph plans and progress-ledger
  outcomes. Activity complete/skip socket mutations now update the ledger and
  `day_maps.current_progress` in the same authoritative transaction.
- Future-only rerouting freezes `[0, now)`, splits the boundary interval at the
  exact second, allocates only the remaining progress budget, and publishes a
  child revision with connected chosen/alternative futures.

The existing `day_map_routes.route_data` and `game:route:state` payload remain
compatible with the current iOS build. The richer graph is opt-in through
`game:route:reroute` / `game:day-plan:state`.

See `docs/ROUTING_PROGRESS_ALGORITHMS_V1.md` for invariants, scoring behavior,
schema details, and the next implementation stage.
See `docs/FUTURE_ONLY_REROUTING_V1.md` for the reroute boundary policy,
transaction order, migration, and socket payload.

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

## Phase 5 — cohort/personalized prediction models

Backend v0.6.0 adds a versioned completion-probability model hierarchy (population → cohort → individual), temporal evaluation/calibration, shadow scoring and dual-gated active route ranking. See `docs/PHASE5_PREDICTION_MODELS.md`.

```bash
npm run train:phase5
npm run verify:phase5
PREDICTION_DEPLOY_MODE=shadow npm run promote:phase5
```

Production defaults to `PREDICTION_RUNTIME_MODE=shadow`; learned predictions cannot affect authoritative rerouting until both the process gate and database deployment are explicitly active.

## Phase 6 — automated model lifecycle

Backend v0.7.0 adds automated model operations around the Phase 5 completion models. See `docs/PHASE6_AUTOMATED_MODEL_OPERATIONS.md` and `PHASE6_COMPLETION.md`.

Useful commands:

```bash
npm run verify:phase6
npm run run:model-ops
npm run rollback:phase6
```

Production automation is enabled with `PREDICTION_MODEL_OPS_ENABLED=true`. Keep `PREDICTION_RUNTIME_MODE=shadow` for observation-only operation; set it to `active` once to authorize the database-controlled automatic canary lifecycle.

## Phase 7 MVP — future activity support planning

Backend v0.8.0 adds a deterministic rolling prerequisite graph beside the authoritative Day Graph. The first rule family supports future home-made meals by scheduling grocery/prep tasks into available earlier time, preserving an explainable target relationship and feeding prediction-ready learning data.

See `docs/PHASE7_ACTIVITY_SUPPORT_PLANNING_MVP.md` and `PHASE7_COMPLETION.md`.

```bash
npm run migrate
npm run check
npm test
npm run verify:phase7
```

## Adaptive Route Freshness Scheduler

Backend v0.10.0 adds a five-minute live-route freshness evaluator. The cadence is intentionally not a five-minute unconditional reroute: missed activity windows, at-risk windows, or materially degraded expected finish can publish a new future-only authoritative Day Graph, while healthy routes remain unchanged. Completed history is still immutable and successful automatic reroutes increment the normal Day Map revision before broadcasting `game:day-plan:state`.

See `docs/ADAPTIVE_ROUTE_FRESHNESS_MVP.md` and `ADAPTIVE_ROUTE_FRESHNESS_COMPLETION.md`.


## Road Encounters / Route Knowledge (v0.11.0)

Fifoo can now turn high-value profile/route knowledge gaps into gamified Road Encounters, Scout Reports and Quick Duels. Questions are backend-ranked, become less frequent as the profile fills, avoid interrupting active activities, and can update the authoritative future route immediately. See `docs/ROAD_ENCOUNTERS_ROUTE_KNOWLEDGE_MVP.md` and `ROAD_ENCOUNTERS_COMPLETION.md`.

## Decision-derived Sleep/Fasting state nodes (v0.12.0)

The authoritative Day Graph now separates **decision/activity intervals** from **primary-route state nodes**. Completed/chosen paths carry an additive `systemStateIntervals` layer that always generates hourly Sleep/Nap and Fasting nodes from the selected route decisions. The iOS client renders them by priority (`activity > sleep/nap > fasting`). Alternative branches contain no Sleep/Fasting state nodes; neutral coverage placeholders keep branch timing connected until the user chooses an activity decision, at which point the normal future-only rerouter recomputes the primary state layer.

No SQL migration is required. The additive payload schema is `fifoo.day-graph.v3`.

## Primary activity-state + map feedback fixes (v0.13.0)

Sleep/Nap/Fasting state nodes are now explicitly persisted as primary completed/chosen activity state, with future state recomputed on every authoritative reroute and no state nodes on alternatives. User day-start/day-end boundaries drive sleep timing, including third-shift daytime sleep. User-facing state titles no longer expose internal hour counters.

For the companion iOS progress-badge/countdown/animation regression data, run `npm run seed:ui-fixes`. See `ADDITIONAL_MAP_FIXES_V0_13.md` and `UI_FIXES_SEED.md`.
