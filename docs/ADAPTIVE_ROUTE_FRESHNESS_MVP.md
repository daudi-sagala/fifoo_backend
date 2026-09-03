# Adaptive Route Freshness Scheduler — MVP

## Purpose

Fifoo's daily generator still creates a user's route once per local calendar day. The Adaptive Route Freshness Scheduler is a separate live-day mechanism: it evaluates the active authoritative Day Graph every five minutes and creates a new **future-only** plan revision only when the current route has materially gone stale.

The scheduler reuses the existing Phase 3 rerouter, Phase 5/6 prediction runtime, progress ledger, Day Graph invariants, and Socket.IO `game:day-plan:state` broadcast. It does not introduce a second route engine.

## Default cadence

```env
ADAPTIVE_ROUTE_FRESHNESS_SCHEDULER_ENABLED=true
ADAPTIVE_ROUTE_FRESHNESS_SCHEDULER_INTERVAL_MS=300000
ADAPTIVE_ROUTE_FRESHNESS_SCHEDULER_STARTUP_DELAY_MS=90000
ADAPTIVE_ROUTE_FRESHNESS_COOLDOWN_MS=900000
```

The five-minute tick is an **evaluation cadence**, not an unconditional reroute cadence. A healthy route produces a no-op.

## MVP triggers

The evaluator ignores system filler intervals such as Sleep, Nap and Fasting and considers only intervals backed by a real `sourceNodeID`.

### 1. `activity_window_missed`

An activity has no terminal progress-ledger outcome and its planned end time plus the configured grace period is already in the past.

Default grace:

```env
ADAPTIVE_ROUTE_FRESHNESS_MISSED_GRACE_SECONDS=300
```

The missed activity remains immutable history. The router optimizes only the remaining day.

### 2. `activity_window_at_risk`

An unresolved activity is currently inside its planned window and has ten minutes or less remaining. The scheduler may rebase that one activity after the current decision boundary, preserving its original duration and allowing at most the configured shift.

```env
ADAPTIVE_ROUTE_FRESHNESS_AT_RISK_WINDOW_SECONDS=600
ADAPTIVE_ROUTE_FRESHNESS_MAX_SHIFT_SECONDS=7200
ADAPTIVE_ROUTE_FRESHNESS_REBASE_BUFFER_SECONDS=60
```

All other future scheduled candidates keep their current exact start times.

### 3. `expected_finish_degraded`

The progress engine's current expected end-of-day finish drops below the configured threshold while at least the configured number of real future activities remain.

```env
ADAPTIVE_ROUTE_FRESHNESS_MIN_EXPECTED_DAY_FINISH=0.60
ADAPTIVE_ROUTE_FRESHNESS_MIN_PROJECTION_CANDIDATES=2
```

This gives the existing prediction/routing pipeline a chance to prefer a stronger remaining route or alternate.

## Anti-churn controls

1. **15-minute cooldown** after any newly activated plan revision.
2. **Trigger fingerprinting** in `day_plan_versions.routing_context`. The same unchanged condition cannot reroute repeatedly every five minutes.
3. **End-of-day guard**: no adaptive reroute when less than 15 minutes remain in the day.
4. **Per-user/day PostgreSQL advisory transaction lock** prevents two backend replicas from refreshing the same route concurrently.
5. Reroute failures roll back to a savepoint and leave the currently active route intact.

## Candidate reconstruction

The scheduler reconstructs its candidate pool from the active chosen path plus currently exposed alternative branches. It never submits Sleep/Nap/Fasting filler intervals as candidates; the Day Graph compiler regenerates full-day coverage around the new route.

Elapsed activities are not moved back into the future. Only the current at-risk activity can be made flexible. Future activities retain their exact scheduled starts.

## Consistency and iOS behavior

When an adaptive reroute succeeds:

1. `rerouteFutureDayPlan(...)` freezes `[0, now)` and optimizes `[now, 86400)`.
2. The normal `day_maps.revision` is incremented so optimistic concurrency remains correct.
3. The server broadcasts `game:day-plan:state` to the user's current day room.
4. iOS decodes the reason as `adaptive_route_freshness` and applies the existing atomic authoritative-plan reconciliation.

No special map rendering is required.

## Files

Backend:

- `src/algorithms/adaptiveRouteFreshness.js`
- `src/services/adaptiveRouteFreshness.js`
- `src/services/adaptiveRouteFreshnessScheduler.js`
- `src/config.js`
- `src/server.js`
- `.env.example`
- `.env.production.example`
- `infra/azure/main.bicep`
- `test/adaptiveRouteFreshness.test.js`

Small iOS contract addition:

- `App/Networking/GameSocketPayloads.swift`

## Validation

The delivery should pass:

```bash
npm run check
npm test
```

The six new unit tests cover system-filler exclusion, missed activity detection, terminal-outcome suppression, at-risk detection, degraded projection fingerprinting, and candidate rebasing/reconstruction.
