# Fifoo planning details + reusable catalog suggestions

Backend 0.15.2

- Planning-information questions retain their existing ranking, persistence and rerouting semantics, but user-facing copy is direct scheduling language. Internal `road_encounter` / `scout_report` / `quick_duel` style identifiers remain protocol-compatible and are not displayed to the user.
- `game:catalog:search` searches reusable meal, workout or task catalog rows plus rows created by the authenticated user.
- `game:catalog:suggestion:create` creates a reusable user-owned meal/workout/task suggestion when an exact title does not already exist. Exact matches are reused rather than duplicated.
- User suggestions are marked by `created_by` plus the `user_suggested` tag; they remain normal active catalog rows so existing status constraints and future catalog tooling remain compatible.
- No SQL migration is required. Existing `meals`, `workouts`, and `tasks` tables are used.
