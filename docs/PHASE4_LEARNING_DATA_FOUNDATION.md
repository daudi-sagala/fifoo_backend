# Fifoo Phase 4 — Learning-Data Foundation

## Status

Implemented in backend v0.5.0. Phase 4 intentionally does **not** train or serve a machine-learning model. It makes every future Phase 5 training/evaluation example reproducible from immutable production observations.

## 1. Learning unit

One learning decision records the state known **at decision time**:

`context -> candidates considered -> routes exposed -> selected route -> actual outcome -> earned progress`

The decision record includes:

- user/day and plan revision lineage;
- decision type, reroute reason and exact local decision second;
- algorithm name/version, rules hash, prediction model/policy version, feature schema version and learning policy version;
- sanitized scheduling context;
- progress snapshot before the decision;
- behavioral features computed strictly from outcomes observed before the decision;
- every activity candidate considered, including rejected/hard-excluded candidates;
- chosen and exposed alternative routes;
- predicted completion probability / expected progress values that were actually available at the time.

## 2. Migration 007

`sql/007_learning_data_foundation.sql` extends `routing_decision_events` and adds:

- `learning_decision_candidates`
- `learning_decision_routes`
- `learning_feature_snapshots`
- `learning_outcome_observations`

It also creates three versioned read views:

- `learning_candidate_choice_examples_v1`
- `learning_completion_examples_v1`
- `learning_route_choice_examples_v1`

The versioned view names are deliberate. Phase 5 can freeze a model-training contract to `*_v1` even after a future Phase 4 schema evolves.

## 3. Point-in-time feature rule

`buildBehavioralFeatureSnapshot(...)` queries only outcomes with `observed_at < decision_at`. A decision can therefore never learn from its own outcome or from later behavior.

Current descriptive features include:

- all-time, trailing-7-day and trailing-30-day sample counts;
- completion, skip and partial-completion rates;
- average completion score;
- earned/potential progress ratio;
- the same aggregates by activity kind;
- the same aggregates by local time bucket.

These are descriptive features only. No learned weights or model are produced in Phase 4.

## 4. Outcome lineage

Every immutable `progress_ledger_entries` write is mirrored into `learning_outcome_observations` in the same database transaction. Corrections create a new ledger entry and a new learning observation; history is never rewritten.

When possible, an outcome is linked to:

1. the plan decision that exposed it;
2. the specific candidate shown/selected at that decision;
3. its plan interval and source node;
4. its potential points, completion score and earned points.

`user_routing_profiles.behavioral_features` remains a mutable **derived projection** of the immutable outcome stream so Phase 5 can read current online features efficiently.

## 5. Data minimization

Training capture does not copy arbitrary user text. `sanitizeLearningContext(...)` and candidate feature normalization retain scheduling/behavioral features but omit titles, notes, messages, addresses and other free-form content.

Exports never emit raw `user_id`. `scripts/export-learning-data.js` requires `LEARNING_EXPORT_HMAC_KEY` and emits a stable HMAC-derived `userKey`, allowing personalized longitudinal training without placing account UUIDs in exported datasets.

## 6. Export

Examples:

```bash
LEARNING_DATASET=completion \
LEARNING_EXPORT_HMAC_KEY='<long-random-secret>' \
LEARNING_EXPORT_PATH='./completion-training.jsonl' \
npm run export:learning
```

Optional date bounding:

```bash
LEARNING_DATASET=choice \
LEARNING_START_DATE=2026-09-01 \
LEARNING_END_DATE=2026-09-30 \
LEARNING_EXPORT_HMAC_KEY='<long-random-secret>' \
npm run export:learning
```

Supported datasets:

- `completion` — selected candidates with observed completion labels;
- `choice` — all candidate exposures with `was_selected` labels;
- `routes` — chosen/alternative route exposures with route-selection labels.

## 7. Runtime integration

### Initial day generation

The deterministic daily planner records an `initial_day_plan` learning decision after the plan is persisted. Source-node intervals are recorded as selected candidate exposures and the chosen route is stored.

### Future reroute

`rerouteFutureDayPlan(...)` records:

- the progress state at the reroute boundary;
- the full normalized candidate pool;
- completion probabilities used by the router;
- the chosen and exposed alternative route set;
- the reroute cause;
- parent/new plan revision lineage;
- request ID for idempotent mutation provenance.

### Completion / skip / partial completion

The existing progress-ledger path is the single source for actual outcomes. Activity completion and skip mutations already pass through it, and Phase 3 partial-completion reroutes do as well. Phase 4 mirrors those ledger writes into learning observations automatically.

## 8. Phase 4 invariants

1. No model is trained from mutable application-action logs.
2. No training example uses information observed after its decision timestamp.
3. Non-selected candidates are never mislabeled as failed completions.
4. Progress corrections append new observations instead of overwriting history.
5. Completed-route rerouting invariants from Phase 3 remain unchanged.
6. Training exports are pseudonymous and do not contain free-form user text.
7. Model/rules/feature-policy versions are persisted with every decision.

## 9. Production verification

After deployment/migration, run:

```bash
npm run verify:phase4
```

It verifies migration 007, all Phase 4 tables/views, record counts, version metadata and outcome linkage without mutating production data.

## 10. Phase 5 handoff

Phase 5 can now build two model families independently:

1. **Completion prediction** — estimate `P(completion | user/context/candidate)` from `learning_completion_examples_v1`.
2. **Choice/ranking** — estimate which candidate/route should be selected from the candidate and route exposure views.

Cold start should continue to use population priors first, then cohort priors, then individual predictions as sample confidence grows. The Phase 4 data contract allows all three to be trained and evaluated without changing iOS or the authoritative Day Graph protocol.
