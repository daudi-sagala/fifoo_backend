# Fifoo Future-Only Rerouting — v1

## Delivered behavior

The backend can now replace only the mutable future of an active Day Graph.
Rerouting creates a child plan revision atomically; it never edits the previous
revision or its ledger rows in place.

At decision second `t`:

- the completed path covers `[0, t)`;
- the chosen future covers `[t, 86400)`;
- the two paths meet exactly at `t`;
- alternatives originate on the combined completed/chosen spine and rejoin it
  or continue through end-of-day;
- fixed-time candidates before `t` are rejected;
- flexible candidates are clamped forward to `t`;
- completed potential points remain locked;
- the new suffix receives exactly `100 - lockedPotentialPoints`.

## Boundary interval policy

Progress is value-based, not proportional to duration. If `t` cuts an interval,
the interval is split geometrically at the exact second, but its original
potential points stay on the elapsed side. The obsolete right tail has zero
potential and is superseded. The new suffix receives a freshly allocated
remaining budget.

If the caller supplies `boundaryOutcome`, the backend evaluates and records the
active interval before publishing the new revision. Without it, the historical
opportunity remains in the denominator and earns no points until an explicit
outcome exists; rerouting cannot manufacture progress.

## Revision and ledger lineage

Migration `006_future_only_rerouting.sql` adds:

- `day_plan_versions.parent_plan_id`;
- `reroute_reason` and `decision_second`;
- `locked_potential_points`;
- `day_plan_interval_lineage` for carried/split/replacement relationships.

Latest ledger outcomes on completed intervals are copied into the active child
revision with provenance in `evidence`. The parent revision and its ledger remain
unchanged and queryable.

## Socket extension

Request event: `game:route:reroute`

```json
{
  "currentDayTime": { "secondsFromMidnight": 52642 },
  "reason": "activity_skipped",
  "maxAlternatives": 2,
  "boundaryOutcome": {
    "status": "partiallyCompleted",
    "completedSeconds": 600,
    "reasonCode": "reroute_boundary"
  },
  "routingContext": {
    "wakeSecond": 25200,
    "sleepSecond": 82800
  },
  "candidates": [
    {
      "key": "evening-walk",
      "decisionGroup": "exercise-choice",
      "kind": "movement",
      "required": true,
      "earliestStartSecond": 61200,
      "latestEndSecond": 68400,
      "durationMinutes": 30,
      "progressCategory": "movement",
      "progressWeightHint": 12
    }
  ]
}
```

Success is acknowledged through the existing mutation ack. The richer graph is
published separately on `game:day-plan:state` with `dayPlan`,
`progressSnapshot`, `planRevision`, and the standard Day Map `revision`.

The existing `game:route:state` shape is not changed. Current iOS builds can
therefore continue using `{"route":[...]}`/route-state decoding while a newer
client opts into the Day Graph event.

## Transaction order

1. Lock the Day Map and active plan.
2. Optionally record the boundary outcome.
3. Freeze/split the active primary path.
4. Beam-search candidates from `t` forward.
5. Allocate only the remaining point budget.
6. Validate full coverage and branch connectivity.
7. Supersede the old plan and insert the child revision.
8. Record interval lineage and carry completed ledger outcomes.
9. Record the reroute decision event.
10. Commit once; only then broadcast the new Day Graph.

## Verification

`npm test` covers arbitrary-second splitting, value-based locking, exact suffix
allocation, elapsed-candidate rejection, connected alternatives, separate
completed/chosen persistence, parent revision linkage, and lineage creation.
