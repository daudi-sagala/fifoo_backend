# Fifoo Phase 6 — Automated Model Operations

## Status

Implemented in backend v0.7.0. Phase 6 automates the Phase 4 → Phase 5 learning lifecycle while preserving the deterministic route engine and the Phase 5 process-level authority gate.

## 1. Lifecycle

The production lifecycle is now:

`learning outcomes → retraining eligibility → offline gates → shadow challenger → fresh labeled shadow evidence → canary 10% → 25% → 50% → 100% → stable champion`

Every transition is reversible and audited.

A scheduler checks the lifecycle every six hours by default. PostgreSQL advisory locking ensures only one Container App replica operates the lifecycle at a time.

## 2. Retraining

Retraining is triggered only when:

- there are enough total labeled completion examples;
- new labels have arrived since the newest model was trained; and
- either the minimum new-label threshold and minimum retraining interval are met, or the maximum model age is reached.

No new model is trained while a shadow/canary transition is already in progress.

Automatic training uses the latest bounded chronological training window rather than freezing forever on the oldest rows after a row limit is reached.

The scheduled server launches model training in a child Node process. The Socket.IO/HTTP event loop therefore remains separate from the CPU-heavy logistic training loop.

## 3. Champion / challenger

If no active learned model exists, a qualifying new model becomes the shadow model.

If an active champion already exists, the new model is attached as `challenger_prediction_model_id`. Runtime decisions then score both models on the same candidates:

- champion prediction remains authoritative;
- challenger prediction is recorded as shadow;
- both score runs are linked to the same Phase 4 routing decision/outcome.

The challenger must outperform the champion when a champion comparator exists. Beating only the old hand-built legacy prior is not sufficient.

## 4. Runtime authority

Two independent controls remain:

1. process gate: `PREDICTION_RUNTIME_MODE=legacy|shadow|active`;
2. database deployment mode: `disabled|shadow|active`.

The database automation cannot exceed the process gate.

Production can initially deploy Phase 6 with `PREDICTION_RUNTIME_MODE=shadow`; this permits automatic training/shadow collection but no model-driven route change. After the one-time operator authorization to `active`, the scheduler can start canary rollout automatically.

## 5. Canary rollout

Default stages:

- 10%
- 25%
- 50%
- 100%

User assignment is deterministic from the user UUID hash. During a challenger canary, users outside the challenger bucket continue using the previous active champion, not the legacy heuristic.

Each rollout stage resets its evidence boundary. A stage advances only after:

- enough labeled outcomes exist for that stage;
- enough consecutive healthy checks have occurred; and
- fresh labeled evidence has appeared since the previous health check.

Repeated scheduler runs against the same outcomes cannot advance rollout.

## 6. Health and drift gates

Each shadow/canary stage records:

- learned log loss;
- learned Brier score;
- ECE calibration error;
- ROC AUC when defined;
- legacy metrics;
- champion/comparator metrics when available;
- prediction-distribution PSI versus the training holdout reference;
- completion-rate delta versus the training reference;
- sufficiently sampled cohort-level learned-vs-comparator metrics.

A materially regressing cohort can block progression even when the global average looks acceptable.

New Phase 5 models persist a monitoring reference derived from the chronological evaluation split, including prediction histogram and outcome prevalence.

## 7. Automatic rollback

An unhealthy active canary automatically rolls back:

- to the previous champion at 100% when a fallback champion exists;
- otherwise to shadow, which makes the process-level active gate harmless because the database gate no longer grants active authority.

The failed challenger is marked rejected after fallback rollback.

`npm run rollback:phase6` remains available for an operator-triggered emergency rollback.

## 8. Database control plane

Migration `009_prediction_model_operations.sql` adds:

- champion/challenger/fallback fields to `prediction_model_deployments`;
- comparator-model probabilities on `prediction_score_events`;
- `prediction_model_ops_runs`;
- `prediction_model_deployment_history`;
- `prediction_model_health_snapshots`;
- `prediction_model_alerts`;
- an updated correction-aware `prediction_shadow_evaluation_v1` view.

The deployment history is immutable. Health checks and lifecycle operations are retained for audit/debugging.

## 9. Production commands

Read-only verification:

```bash
npm run verify:phase6
```

Run one lifecycle tick manually:

```bash
npm run run:model-ops
```

Emergency rollback:

```bash
npm run rollback:phase6
```

The scheduler normally makes `run:model-ops` unnecessary.

## 10. Default production controls

```env
PREDICTION_MODEL_OPS_ENABLED=true
PREDICTION_MODEL_OPS_INTERVAL_MS=21600000
PREDICTION_MODEL_OPS_STARTUP_DELAY_MS=60000
PREDICTION_MODEL_OPS_TRAINING_LIMIT=20000
PREDICTION_MODEL_OPS_TRAINING_EPOCHS=300
PREDICTION_MODEL_OPS_MIN_TRAINING_EXAMPLES=400
PREDICTION_MODEL_OPS_RETRAIN_MIN_NEW_LABELS=100
PREDICTION_MODEL_OPS_RETRAIN_MIN_INTERVAL_HOURS=24
PREDICTION_MODEL_OPS_RETRAIN_MAX_INTERVAL_HOURS=168
PREDICTION_MODEL_OPS_MIN_SHADOW_LABELS=100
PREDICTION_MODEL_OPS_MIN_CANARY_LABELS=50
PREDICTION_MODEL_OPS_MIN_HEALTHY_CHECKS=2
PREDICTION_MODEL_OPS_ROLLOUT_STEPS=10,25,50,100
PREDICTION_MODEL_OPS_AUTOMATIC_ROLLBACK=true
```

Health/drift thresholds are also configurable in `.env.production.example`.

## 11. Safety invariants

1. Learned models still cannot violate fixed-time, dependency, busy-time, forward-time, route-continuity, completed-history, or 100-point progress invariants.
2. A model lookup/scoring failure still falls back safely.
3. A new model does not evict a stable champion merely because retraining succeeded.
4. A challenger must clear offline gates and real production shadow evidence.
5. A challenger must beat the active champion when one exists.
6. Canary users are stable across requests because rollout assignment is deterministic.
7. Non-canary users retain the previous champion during rollout.
8. No stage advances on recycled evidence.
9. Active regression triggers automatic rollback when enabled.
10. The operator retains a process-level kill switch (`PREDICTION_RUNTIME_MODE=shadow|legacy`) and a scheduler kill switch (`PREDICTION_MODEL_OPS_ENABLED=false`).
