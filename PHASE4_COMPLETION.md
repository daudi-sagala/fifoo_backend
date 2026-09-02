# Fifoo Phase 4 — Learning-Data Foundation Completion

## Status

Code-complete in backend v0.5.0. No iOS protocol change is required for Phase 4: the backend derives learning observations from the authoritative Phase 3 Day Plan, reroute and progress-ledger flows.

## Implemented

1. Added migration `007_learning_data_foundation.sql`.
2. Extended every routing decision with plan/version/time/rules/prediction/feature-policy lineage.
3. Added normalized candidate exposures, route exposures, point-in-time behavioral feature snapshots and immutable outcome observations.
4. Initial daily generation records an `initial_day_plan` decision.
5. Future-only reroutes record the entire candidate pool, chosen route, exposed alternatives, reroute reason and pre-decision progress snapshot.
6. Progress ledger writes automatically produce learning outcome observations and refresh the derived `user_routing_profiles` behavioral projection.
7. Feature snapshots use only outcomes observed before the decision timestamp to prevent target leakage.
8. Added versioned training views for candidate choice, completion prediction and route choice.
9. Added pseudonymous JSONL export with HMAC user keys; raw account UUIDs and free-form user text are excluded from exports.
10. Added `npm run verify:phase4` read-only production verification.
11. Updated the deployment workflow to the current Azure Container Apps target and `azure/login@v3` so this bundle does not regress to the historical App Service workflow.

## Validation

- `npm run check`: passes.
- `npm test`: 85/85 tests pass.
- New Phase 4 tests cover data minimization, point-in-time feature construction, candidate/route exposure capture, outcome linkage/corrections, optimizer observation output, and pseudonymous export.

## Deployment

The production startup migration runner will apply `sql/007_learning_data_foundation.sql` once when the new image starts (assuming the existing production `RUN_MIGRATIONS_ON_START=true` setting remains enabled).

After deployment:

```bash
npm run verify:phase4
```

To create a pseudonymous completion dataset later:

```bash
LEARNING_DATASET=completion \
LEARNING_EXPORT_HMAC_KEY='<long-random-secret>' \
LEARNING_EXPORT_PATH='./completion-training.jsonl' \
npm run export:learning
```

Do not commit the HMAC key or exported production datasets to Git.

## Phase 5 handoff

The next phase is cohort/personalized prediction models. Start with completion probability, not a full reinforcement-learning policy:

1. define temporal train/validation/test splits;
2. train a calibrated population baseline from `learning_completion_examples_v1`;
3. add cohort priors;
4. add individual personalization only after sufficient per-user samples;
5. evaluate calibration, ranking lift and progress lift offline before enabling predictions in routing;
6. shadow-score production decisions before allowing model output to affect the authoritative Day Plan.
