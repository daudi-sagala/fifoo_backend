# Fifoo Phase 7 MVP — Activity Support Planning Completion

## Status

Code-complete as backend v0.8.0 and iOS Phase 7 support-contract update.

## Implemented

1. Added migration `010_activity_support_planning_mvp.sql` for semantic support edges, planner audit runs and user resource state.
2. Added a deterministic 72-hour support planner with backward slot selection.
3. Added initial home-made meal rules for grocery acquisition and meal preparation.
4. Generated support actions are ordinary task GameNodes with deterministic IDs and explainability metadata.
5. The planner detects blocked prerequisites instead of inventing an impossible schedule.
6. Existing scheduled activities are treated as busy intervals; generated support tasks are inserted only into free time.
7. A currently active sourced activity is not automatically pre-empted.
8. Support-node changes can reroute only the authoritative future Day Graph using the existing Phase 3 rerouter.
9. Added snapshot/mutation refreshes, an explicit refresh event and a production 15-minute support scheduler.
10. Added `game:support-plan:refresh` / `game:support-plan:state` and `support_plan_changed` reroute reason.
11. Added minimized support-candidate fields to Phase 4 learning observations without changing the Phase 5 model feature vector.
12. Support and target completion/skip outcomes are retained on support edges for later model training.
13. Added iOS payload/state support and optional support metadata on `ActivityNodeContent`.
14. Added `npm run verify:phase7` and rule/slot/idempotency tests.

## Validation

- `npm run check`: passes.
- `npm test`: 110/110 tests pass (104 prior tests + 6 new Phase 7 tests).
- Modified Swift files parse successfully with Swift 6.2.1 `swiftc -frontend -parse`.

## MVP boundary

The support-rule decision is deterministic in Phase 7. Existing Phase 5/6 completion models may rank generated candidates during rerouting, but no new prerequisite model is promoted or given authority by this change.
