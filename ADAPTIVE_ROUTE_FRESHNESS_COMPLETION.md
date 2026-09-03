# Adaptive Route Freshness Scheduler — Completion

## Status

Code-complete as backend v0.10.0 with a backward-compatible iOS reroute-reason addition.

## Implemented

1. Five-minute production freshness evaluation scheduler.
2. Conditional future-only rerouting; healthy routes remain untouched.
3. Missed activity, at-risk activity and degraded expected-finish triggers.
4. Completed/skipped outcomes suppress stale-route triggers.
5. Sleep/Nap/Fasting system intervals are excluded from freshness decisions.
6. Current at-risk activity can be safely rebased; elapsed activities are never moved back into the future.
7. Current chosen path plus exposed alternatives seed the reroute candidate pool.
8. 15-minute cooldown, trigger fingerprinting, end-of-day guard and advisory locking prevent churn/races.
9. Adaptive reroutes increment the standard Day Map revision and broadcast `game:day-plan:state`.
10. Existing Phase 3 immutable-history rule and Phase 5/6 prediction authority are reused unchanged.
11. iOS recognizes `adaptive_route_freshness` through `GameRerouteReason`.
12. Six focused tests added.

## Validation

- `npm run check`: PASS
- `npm test`: 125/125 PASS
- No SQL migration required.
