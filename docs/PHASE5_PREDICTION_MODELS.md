# Fifoo Phase 5 — Cohort / Personalized Prediction Models

## Status

Implemented in backend v0.6.0. Phase 5 learns completion probability and feeds it into the existing deterministic route optimizer only after explicit safety gates. No iOS protocol change is required.

## 1. Prediction target

The primary target is:

`P(activity completed | decision-time user history, candidate, schedule context)`

`actual_status == completed` is the binary training label. Partial completion remains available in Phase 4 for future richer targets but is not silently relabeled as a full completion.

The learned probability influences `expectedProgress` and therefore candidate/route ranking. It never bypasses availability, fixed-time, dependency, completed-history, forward-time, route-continuity, or 100-point progress invariants.

## 2. Model hierarchy

### Population model

A pure-JavaScript L2-regularized logistic regression is trained from `learning_completion_examples_v1`. The feature contract is versioned (`completion-v1`) and uses only values available at decision time:

- duration, schedule position/flexibility and candidate rank;
- progress/goal/priority/urgency/preferences/context/momentum;
- effort/fatigue/transition costs;
- point-in-time all-time/7-day/30-day behavior;
- activity-kind and time-bucket behavior;
- current day progress / expected finish;
- candidate kind, daypart, decision type, reroute reason and progress category.

No free-form user text is used.

### Calibration

Validation-only Platt calibration is fitted after the population model. Test data remains untouched until final evaluation.

### Cohort layer

A cohort key is derived from:

`activity kind × local daypart × prior-behavior band`

Each cohort receives a Bayesian/shrunk logit residual relative to the calibrated population model. Sparse cohorts stay close to the population model.

### Personalized layer

Users with sufficient historical outcomes receive their own shrunk logit residual. Sparse users remain dominated by population/cohort evidence. The individual calibration is versioned with the population model and is refreshed when a new model version is trained.

## 3. Temporal evaluation

Examples are sorted by `decision_at` and split chronologically into train → validation → test. There is no randomized mixing of future observations into training.

Recorded metrics:

- log loss;
- Brier score;
- ROC AUC;
- expected calibration error (ECE);
- positive/completion rate;
- comparison to a train-prevalence population baseline.

Default activation-oriented offline gates are:

- at least 50 test examples;
- log loss <= 0.75;
- Brier <= 0.25;
- ECE <= 0.15;
- AUC >= 0.55;
- log loss better than the baseline.

All thresholds can be made stricter through training environment variables.

## 4. Migration 008

`sql/008_prediction_models.sql` adds:

- `prediction_models` — immutable/versioned model artifacts, splits, metrics and safety gates;
- `prediction_model_cohorts` — cohort residual calibration;
- `prediction_model_users` — per-user residual calibration;
- `prediction_model_deployments` — explicit disabled/shadow/active deployment gate;
- `prediction_score_runs` / `prediction_score_events` — immutable runtime score traces;
- `prediction_shadow_evaluation_v1` — learned-vs-legacy predictions joined to outcomes.

## 5. Runtime modes

There are two independent gates.

### Process gate

`PREDICTION_RUNTIME_MODE=legacy|shadow|active`

Production defaults to `shadow`; development defaults to `legacy`.

### Database deployment gate

`prediction_model_deployments.deployment_mode=disabled|shadow|active`

The effective authority is the safer of the two gates.

- `legacy`: no model lookup; deterministic legacy probability is used.
- `shadow`: model is scored and logged, but legacy probability is still supplied to the router.
- `active`: learned hierarchical probability is supplied to the router.

A missing table, model, feature history, or scoring failure fails closed to legacy probability rather than failing the route request.

## 6. Train

Run after migration 008 and after Phase 4 has accumulated outcomes:

```bash
npm run train:phase5
```

Optional controls:

```bash
PHASE5_TRAIN_START_DATE=2026-09-01 \
PHASE5_TRAIN_END_DATE=2026-12-31 \
PHASE5_MIN_TEST_EXAMPLES=100 \
PHASE5_MAX_TEST_ECE=0.10 \
PHASE5_MIN_TEST_AUC=0.60 \
npm run train:phase5
```

A model that clears the configured offline gates is stored as `shadow`; a failing model remains `draft` and cannot be activated.

## 7. Shadow evaluation and promotion

Verify current state:

```bash
npm run verify:phase5
```

Promote the latest model to shadow explicitly if needed:

```bash
PREDICTION_DEPLOY_MODE=shadow npm run promote:phase5
```

Active promotion has an additional online gate. By default it requires 100 labeled shadow scores and learned log loss/Brier no worse than legacy:

```bash
PREDICTION_DEPLOY_MODE=active \
PREDICTION_MODEL_ID='<model-uuid>' \
PHASE5_MIN_SHADOW_LABELS=100 \
PHASE5_REQUIRE_SHADOW_IMPROVEMENT=true \
npm run promote:phase5
```

The backend process must also have `PREDICTION_RUNTIME_MODE=active`. This dual gate prevents an accidental database or environment change from independently enabling model-driven routing.

## 8. Routing integration

Future rerouting does the following, inside the existing authoritative mutation transaction:

1. freeze completed history at the Phase 3 decision boundary;
2. load the progress snapshot known at that boundary;
3. score every future candidate;
4. in shadow mode, retain its legacy probability; in active mode, replace it with the learned hierarchical probability;
5. run the same deterministic beam search and hard constraints;
6. persist the Day Graph;
7. persist the Phase 4 learning decision;
8. link the prediction score run to that decision for later outcome evaluation.

Initial daily generation is fixed by the current standard-day rules, so predictions do not rearrange those mandatory stops. They update expected completion/progress metadata and are captured for shadow evaluation. Future reroutes are where active learned probabilities can change ranking.

## 9. Safety invariants

1. Completed route history remains immutable.
2. A model cannot schedule through a hard busy interval or violate fixed time/dependencies.
3. Model failure falls back to legacy scoring.
4. Training uses chronological holdouts.
5. Calibration never trains on the test split.
6. Cohort/user effects are shrinkage adjustments, not unbounded overrides.
7. Offline gates are required for active status.
8. Shadow evidence is required by the promotion script before active deployment.
9. Runtime model scores are retained for learned-vs-legacy evaluation.
10. No iOS client needs model weights or model-specific logic.
