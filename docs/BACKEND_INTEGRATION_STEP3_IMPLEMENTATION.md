# Backend Integration Step 3 — Server Implementation

This server implements the frozen Pass 5.37 iOS Socket.IO contract using Node.js, Express, Socket.IO and PostgreSQL.

## Architecture

- `src/server.js` — Express/HTTP/Socket.IO bootstrap and health endpoints.
- `src/socket/registerGameSocket.js` — complete Pass 5.37 event registration and broadcasts.
- `src/services/mutations.js` — transaction, idempotency and Day Map revision coordinator.
- `src/services/dayMaps.js` — `(user_id, map_date)` resolution, rooms and authoritative snapshots.
- `src/services/nodes.js` — exact `GameMapNode` JSONB persistence plus normalized Activity/Task/Workout/Meal/Post projections.
- `src/services/reveals.js` — tile discovery and suggested-stop decisions.
- `src/services/routes.js` — durable semantic route state.
- `src/services/social.js` — reply creation and post-node response-count reconciliation.
- `src/services/play.js` — Fifoo Play session snapshots, messages and reactions.
- `src/auth.js` — explicit development auth and integration hook for the existing Fifoo auth authority.
- `sql/001_step3_game_backend.sql` — additive schema required by Step 3.

## Durable transaction rule

Each acknowledged Day Map mutation:

1. parses and validates the Pass 5.37 request envelope;
2. uses the authenticated socket identity, never `context.userID`, for authorization;
3. resolves and row-locks the user's Day Map;
4. claims `context.requestID` in `day_map_mutations`;
5. executes normalized-domain + `day_map_nodes`/route/reveal changes in one transaction;
6. increments `day_maps.revision` exactly once;
7. stores the successful acknowledgement against the request ID;
8. commits;
9. acknowledges the caller and broadcasts compact authoritative state.

Completed duplicate request IDs replay the stored acknowledgement and do not repeat side effects.

## Additive PostgreSQL support

The migration adds:

- `day_map_mutations`
- `day_map_tile_reveals`
- `day_map_suggestion_decisions`
- `post_saves`
- `post_replies.reply_text`
- `day_map_hyperlink_votes`
- `activity_check_ins`
- optional `day_map_application_actions`
- `suggested_meals.execution_state`
- one authoritative `day_map_routes` state index
- `workout_sessions.session_data` and `client_workout_id`
- live workout message/reaction tables

## Security/ownership rules implemented

- Client envelope `userID` is a hint only; authenticated server identity is authoritative.
- A node UUID already owned by another Day Map cannot be moved/overwritten by an upsert.
- Shared/class Activity rows can be referenced without letting the Day Map user overwrite their canonical record.
- Post nodes do not overwrite an existing canonical Post authored elsewhere.
- Tile reveal `nodeID` must belong to the same Day Map.
- Hyperlink votes target a hyperlink node owned by the current Day Map.
- Post replies must target the exact Post node and Post UUID present in that Day Map.
- Map dates and IANA time zones are validated before database use.

## Status semantics

The server enforces `Skipped` / `Completed` from `GameActivityMutationPayload.action` before persistence. This is important for ActivityMeal skip, where the current iOS behavior removes the local node immediately while sending the pre-delete snapshot.

## Validation completed in the generation environment

- Node syntax check: all `src/` and `test/` JavaScript files passed `node --check` under Node 22.16.0.
- Unit/contract tests: 9/9 passed.
- Pass 5.37 event parity: 45/45 outgoing and 11/11 incoming event strings match exactly.
- ZIP integrity is checked when the release artifact is packaged.

A live PostgreSQL/Socket.IO integration test is intentionally environment-dependent and should be run after installing dependencies, applying the migration to a test database, and configuring a real/dummy development user.

## Next integration checkpoint

Deploy/run this service against a development PostgreSQL database, then update `GameBackendConfiguration` in the iOS project with the reachable server URL and authentication values and set `isEnabled = true`. Validate the connection in this order:

1. `GET /health` and `GET /ready`;
2. `game:auth` acknowledgement;
3. `game:sync:request` -> empty/real `game:sync:snapshot`;
4. add/edit/delete one stop and verify revision/idempotency;
5. Task/Meal/Workout mutations;
6. reveal/suggestion persistence across reconnect;
7. Post reply/save and hyperlink vote;
8. route commit;
9. Fifoo Play lifecycle/live messages/reactions;
10. reconnect with a queued client mutation.
