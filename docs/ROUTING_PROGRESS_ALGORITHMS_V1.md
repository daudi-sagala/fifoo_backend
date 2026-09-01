# Fifoo Routing and Progress Algorithms — v1 Foundation

## Delivered scope

This iteration implements the deterministic foundation required before learned
models are allowed to influence a user's day:

1. A continuous interval graph for the full local day.
2. A 100-point achievement-value budget.
3. Type-specific completion scoring and immutable outcome history.
4. Cold-start probability blending.
5. Hard-constraint scheduling plus beam-search route optimization.
6. Meaningfully different alternatives compiled into connected branches.
7. PostgreSQL persistence alongside the current iOS-compatible read model.

## Day Graph invariants

- The chosen path covers the end-exclusive interval `[0, 86400)` exactly.
- Adjacent primary intervals meet at the same second; gaps and overlaps fail
  validation.
- The graph stores maximal intervals, not 86,400 one-second database records.
- Otherwise-unoccupied spans become `fasting`, `sleep`, or `freeTime` nodes.
- Fasting can also be metabolic context on a workout/task without creating two
  overlapping primary nodes.
- An alternative originates at a completed/chosen interval and either rejoins
  a known primary interval at the same second or continues through `86400`.
- Every edge advances time. The graph is therefore acyclic by construction.

## Progress invariants

- Every active chosen plan contains exactly 100 potential points.
- Point allocation is based on health/goal value, not elapsed duration.
- Fasting intervals are capped at four points each; extending a fast beyond the
  intended interval cannot produce extra points.
- Completion evaluators currently support binary, presence, duration, quantity,
  target range, fasting adherence, meal composite, and general composite forms.
- `skipped` earns zero while retaining its planned weight in the denominator.
- `superseded` and `cancelledByConstraint` are non-penalizing system outcomes.
- Progress-ledger corrections append a new entry referencing the prior entry;
  service code never rewrites an earlier outcome.
- The snapshot contains actual day progress, achievable remaining points, and
  behavior-adjusted expected end-of-day progress.

## Cold start and collective intelligence

Completion probability is blended hierarchically:

```text
population prior
  -> behaviorally similar cohort (as cohort samples grow)
  -> individual behavior (dominant only after sufficient personal samples)
```

The router accepts aggregated cohort priors keyed by a feature signature.
Demographic data is not hard-coded into routing rules; a consented demographic
feature may contribute to a cohort signature, but behavioral/context similarity
is designed to become the stronger signal.

## Route optimization

The v1 router uses bounded beam search:

1. Group mutually exclusive candidate choices.
2. Reject hard exclusions, calendar conflicts, dependency failures, invalid
   availability windows, and impossible durations.
3. Score feasible choices using expected progress, goal impact, priority,
   urgency, preference/context fit, and schedule fit.
4. Apply sequence-level fatigue, repetition, variety, and coverage adjustments.
5. Retain only the best bounded set of partial routes at each decision point.
6. Rank complete routes and apply a diversity distance before exposing
   alternatives.
7. Compile selected schedules into a continuous Day Graph.

## PostgreSQL model

Migration `005_day_graph_progress_routing.sql` adds:

- `user_routing_profiles`
- `routing_prediction_priors`
- `day_plan_versions`
- `day_plan_paths`
- `day_plan_intervals`
- `progress_ledger_entries`
- `routing_decision_events`

The active plan is versioned and the previous plan becomes `superseded`.
`day_map_nodes` and `day_map_routes` remain the current mobile read model.

## Current integration behavior

- Automatic daily generation now creates and persists a continuous chosen path
  and its 100-point budget in the same transaction as legacy nodes/routes.
- Generator idempotency also checks that the corresponding active Day Plan
  exists, so an older generated map is upgraded after migration.
- Generic/task/meal complete and skip socket events append progress outcomes and
  update `day_maps.current_progress` transactionally.
- Existing iOS clients continue decoding the same route and node payloads.

## Next implementation stage

The next stage should preserve the completed prefix and ledger while rerouting
only the future suffix. It will:

1. split the active interval at the exact decision second;
2. freeze completed intervals and their ledger results;
3. calculate the remaining unallocated point budget;
4. beam-search only the remaining candidate window;
5. emit chosen plus two diverse content-level branches;
6. supersede only future intervals removed by the system;
7. add a socket-contract extension so iOS renders algorithmic branch stops,
   not merely alternate road geometry;
8. log candidate impressions, predictions, selections, skips, delays, and
   outcomes for later offline evaluation and model training.

## Verification

Run:

```bash
DATABASE_URL=postgres://localhost/fifoo_test node --test
npm run check
```

The algorithm tests cover exact full-day coverage, interval splitting, branch
connectivity, overlap rejection, 100-point allocation, fasting caps, partial
completion, skip/supersede semantics, cold-start blending, hard constraints,
and diverse beam-search alternatives.
