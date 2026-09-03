# Fifoo v0.12 — Decision-derived Sleep/Fasting state nodes

## Product rule

Sleep/Nap and Fasting are **results of the selected decision path**, not selectable alternate decisions themselves.

- A meal candidate such as `Breakfast — 8:00 AM` may appear in an alternative.
- Choosing that meal changes the authoritative meal timing and therefore resets the primary Fasting Hour sequence after the meal ends.
- A sleep decision/schedule determines the primary Sleep/Nap state layer.
- Sleep/Nap/Fasting never appear as alternative state tiles.

## Day Graph v3

Each completed/chosen path now has two layers:

1. `intervals` — the existing continuous, non-overlapping authoritative route used for progress, lifecycle, rerouting and topology.
2. `systemStateIntervals` — overlapping, presentation-oriented state nodes. These do not contribute potential points.

`systemStateIntervals` are never present on alternative branches.

## State generation

### Fasting

Fasting state nodes are generated for every non-meal period, including time occupied by workouts, tasks, travel and sleep. A meal ends the preceding fasting cycle; the next fasting cycle begins at the meal's end and starts at `Fasting Hour 1`.

This means an underlying Fasting node exists even during a workout. The client hides it while the higher-priority workout is visible. If a future reroute removes the workout, the fasting tile can immediately become the visible state without inventing a new semantic state.

### Sleep / Nap

Known sleep windows always generate hourly Sleep state nodes. Explicit sleep outside the normal sleep window is classified as Nap and numbered independently. Overnight numbering carries across midnight.

## Presentation priority

The iOS projection applies:

`real activity > Sleep/Nap > Fasting`

A lower-priority state node remains in the authoritative primary path even when hidden from the map.

## Alternatives

Alternative branches remain temporally connected, but any Sleep/Fasting filler interval required for branch continuity is neutralized to non-visible `freeTime`. The branch carries only decision-bearing node-backed activities as candidates when the user selects it.

When the alternate is chosen, iOS already sends only source-node-backed intervals to `game:route:reroute`. The backend compiles the new chosen future and regenerates `systemStateIntervals` from the selected activities.

## Future-only rerouting

`freezePathAt` clips system state nodes at the decision boundary. Completed state history remains on the completed path; regenerated future state nodes belong to the new chosen path. Alternatives receive no state layer.

## Persistence

No migration is needed. `day_plan_versions.graph_data` is JSONB and carries the additive path field. Existing relational `day_plan_intervals` continue storing only the authoritative continuous `intervals` layer.
