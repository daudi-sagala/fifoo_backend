# Fifoo Phase 7 MVP — Activity Support / Pre-emption Planning

## Purpose

Phase 7 adds a semantic prerequisite graph alongside the existing spatial Day Graph. The MVP asks one narrow question reliably:

> When a future home-made meal is scheduled, is there a small action that should happen earlier to make that meal more likely to succeed?

The first deterministic rules can create:

- `Get groceries for <meal>` when the ActivityMeal execution plan says groceries are needed (or a clearly home-cooked meal is inferred without explicit ingredient readiness);
- `Prep for <meal>` for a future home-made meal.

The generated actions are ordinary `activityTask` GameNodes. The support graph only records *why* each task exists and which future node it supports.

## Safety / MVP invariants

1. Completed route history is never rewritten.
2. Existing fixed scheduled activities are not moved by the support slot finder.
3. A currently active sourced activity is not automatically pre-empted. The support task may be created, while route integration waits for a later scheduler/refresh pass.
4. Unknown resources are not treated as unavailable. `user_resource_state` preserves `available | unavailable | unknown` for later rules/integrations.
5. Generated support-node IDs are deterministic per `(user, target node, rule)` so refreshes are idempotent.
6. If no non-overlapping slot exists before the rule deadline, an explainable `blocked` support edge is stored instead of fabricating a schedule.
7. Support-plan failure is additive: it cannot invalidate an already-committed user mutation or replace the existing authoritative route.
8. The Phase 5/6 prediction runtime remains the authority gate. The MVP prerequisite rules themselves are deterministic; support candidates can still receive the existing completion-probability score during rerouting.

## Rolling horizon

Default: 72 hours (`ACTIVITY_SUPPORT_HORIZON_HOURS=72`). Maximum in the MVP: 168 hours.

The server evaluates the horizon on:

- snapshot/reconnect;
- node add/update/delete;
- activity task/meal/workout mutations;
- explicit `game:support-plan:refresh`;
- the production support scheduler (15 minutes by default).

## Semantic graph persistence

Migration `010_activity_support_planning_mvp.sql` adds:

- `activity_support_edges` — target → support relationship, confidence, status, deadline and reason metadata;
- `activity_support_plan_runs` — auditable planner runs and blocked/scheduled counts;
- `user_resource_state` — future integration boundary for inventory/equipment/resource knowledge.

The support edge does not replace `day_plan_versions`, `day_plan_paths` or `day_plan_intervals`.

## Socket contract

Outgoing:

- `game:support-plan:refresh`

Incoming:

- `game:support-plan:state`

Normal generated support tasks also arrive through the established:

- `game:node:upserted`
- `game:node:deleted`
- `game:day-plan:state`

The new reroute reason is `support_plan_changed`.

## Explainability metadata

A generated ActivityTask has `content.activity._0.supportPlan` containing:

- target node/date/start;
- rule key;
- relationship type;
- static MVP confidence;
- human-readable reason;
- generator version.

The user-visible task description also states why Fifoo added the task.

## Learning / Phase 5-6 compatibility

No Phase 5 model feature-vector or model artifact is changed in this MVP. That avoids invalidating existing champion/challenger models.

When a support action participates in a reroute, Phase 4 candidate features now retain minimized support fields:

- `isSupportAction`
- `supportRuleKey`
- `supportRelationshipType`
- `supportConfidence`

Completion/skip outcomes also update `activity_support_edges`. Target completion/skip is written into edge metadata. This creates evidence for a later learned prerequisite/uplift model without giving that new model authority prematurely.

## Current rule behavior

### Home-made meal: groceries

Generated when:

- `executionPlan.source == homeMade` and `groceriesNeeded == true`; or
- shopping list has items; or
- a meal is only textually inferred as home-cooked and ingredient readiness is not known.

Defaults:

- duration: 45 minutes;
- preferred previous-day time: 6:30 PM;
- previous-day latest completion: 9:30 PM;
- same-day deadline: 2 hours before meal;
- static confidence: 0.95 for explicit grocery need, 0.72 for text inference.

### Home-made meal: preparation

Generated for every future home-made meal.

Defaults:

- duration: 20 minutes;
- preferred previous-day time: 8:00 PM;
- previous-day latest completion: 10:00 PM;
- same-day deadline: 30 minutes before meal;
- static confidence: 0.88 for explicit `homeMade`, 0.70 for text inference.

## Deployment

1. Deploy backend v0.8.0.
2. Apply migration 010 (startup migration or `npm run migrate`).
3. Run `npm run check` and `npm test`.
4. Run `npm run verify:phase7` against the migrated database.
5. Keep existing Phase 6 `PREDICTION_RUNTIME_MODE` policy unchanged.

Environment defaults:

```env
ACTIVITY_SUPPORT_PLANNER_ENABLED=true
ACTIVITY_SUPPORT_HORIZON_HOURS=72
ACTIVITY_SUPPORT_SCHEDULER_ENABLED=true
ACTIVITY_SUPPORT_SCHEDULER_INTERVAL_MS=900000
ACTIVITY_SUPPORT_SCHEDULER_STARTUP_DELAY_MS=120000
```

## Deliberately deferred until user feedback

- learned probability that a prerequisite is actually needed;
- causal/uplift estimate of how much a support action improves target success;
- generalized rule library for workouts, travel, meetings, appointments, medication, chores, etc.;
- alternative support branches such as store trip vs delivery vs substitution;
- automatic movement of flexible existing activities (the MVP inserts only into free gaps);
- explicit approval UI for disruptive pre-emption;
- external inventory, weather, store-hours, traffic or calendar/resource integrations.
