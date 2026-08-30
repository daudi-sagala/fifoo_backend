# Backend Integration Step 2 — Authoritative Socket.IO Contract

Pass 5.37 turns the Step 1 `SocketManager` action surface into an explicit backend protocol without changing the finished SwiftUI/SpriteKit interaction model.

## 1. Contract boundary

The client uses three classes of events:

1. **Authoritative mutations** — change durable application state. They use `emitWithAck`, carry a UUID `requestID`, are idempotent on the server, increment the selected day-map revision when they affect day-map state, and are replayable from the client outbox.
2. **Synchronization / query events** — request server data or synchronize transient collaborative state. They do not perform optimistic domain mutation by themselves.
3. **Application-action traces** — `game:application:action` records UI intent/analytics. These never replace an authoritative mutation.

A single user action may emit both an application-action trace and an authoritative mutation. The trace answers “what did the user do?”; the mutation answers “what durable state must the server commit?”

## 2. Standard request envelope

Except `game:auth`, application events use the existing envelope:

```json
{
  "context": {
    "requestID": "UUID",
    "userID": "authenticated-user-id",
    "deviceID": "device-id",
    "mapDate": "YYYY-MM-DD",
    "timeZoneIdentifier": "America/New_York",
    "clientRevision": 42,
    "sentAt": "ISO-8601"
  },
  "payload": {}
}
```

The authenticated socket identity is authoritative. A server must not grant access merely because `context.userID` names another user.

## 3. Standard mutation acknowledgement

Every authoritative mutation returns:

```json
{
  "success": true,
  "requestID": "same request UUID",
  "revision": 43,
  "message": null,
  "errorCode": null
}
```

Failure uses the same shape with `success = false`. Recommended stable error codes include `unauthorized`, `forbidden`, `invalid_payload`, `not_found`, `conflict`, `validation_failed`, and `server_error`.

### Idempotency rule

`context.requestID` is the idempotency key. Replaying a completed request must return the original logical result and must not repeat the PostgreSQL side effect. The planned server implementation stores requests in `day_map_mutations` (or an equivalent idempotency ledger).

`clientRevision` is reconciliation context, not permission to overwrite server state. The server serializes mutations for a user/day, commits a new revision, and returns the resulting revision. Domain-specific validation may still reject a logically stale mutation when necessary.

## 4. Incoming authoritative state

The UI remains driven by the same compact incoming state events:

| Event | Meaning |
|---|---|
| `game:sync:snapshot` | Full authoritative state for the selected day |
| `game:node:upserted` | One node was created/changed |
| `game:node:deleted` | One node was removed |
| `game:tile:reveal:state` | One explicit tile reveal state changed |
| `game:route:state` | Full semantic route state changed |
| `game:search:results` | Server search result nodes |
| `game:play:workout` | Authoritative Fifoo Play workout/session snapshot |
| `game:play:message(s)` | Live workout message state |
| `game:play:reaction` | Live workout reaction |
| `game:error` | Push error not associated with an acknowledgement |

Domain-specific ActivityTask/Meal/Workout mutations do **not** require separate incoming event types. After committing the transaction, the server broadcasts `game:node:upserted` (or `game:node:deleted` for Meal Skip). This keeps the view layer independent of backend table structure.

`GameDaySnapshotPayload` now includes optional `revealedTiles`, allowing explicit discovery state to survive reconnect/device changes while remaining backward-compatible with a server that omits the field.

---

# 5. Authoritative mutation matrix

## 5.1 Generic stop/node lifecycle

| Socket event | Payload | Ack | PostgreSQL contract |
|---|---|---:|---|
| `game:node:add` | `GameNodeMutationPayload` | Yes | Resolve/create `day_maps`; insert `day_map_nodes`; create/upsert the referenced domain entity when the node represents Activity/Post data; increment `day_maps.revision` |
| `game:node:update` | `GameNodeMutationPayload` | Yes | Update `day_map_nodes` snapshot/time/progress/enabled state and the appropriate domain entity; increment revision |
| `game:node:delete` | `GameNodeDeletePayload` | Yes | Delete the user's `day_map_nodes` row; apply domain-specific ownership/deletion policy; increment revision |

### Node persistence rule

`day_map_nodes.node_data` stores the exact Codable `GameMapNode` snapshot for round-trip restoration. The relational columns remain queryable/indexable projections:

- `node_id` ← `GameNodeID`
- `node_kind` ← content kind
- `source_id` ← domain object UUID when a real UUID exists
- `time_seconds` ← `DayTime.secondsFromMidnight`
- `progress` ← map progress percentage
- `is_enabled` ← node enabled state

The server should update normalized domain tables and `node_data` in the **same PostgreSQL transaction** so they cannot diverge.

## 5.2 Tile reveal / discovery state

| Socket event | Payload | Ack | PostgreSQL contract |
|---|---|---:|---|
| `game:tile:reveal` | `GameTileRevealMutationPayload` | Yes | Upsert/delete explicit reveal state for `(day_map_id, column, row)`; increment revision |

The existing schema does not have a row for empty-map tiles, so `day_map_nodes.node_data` alone cannot persist every reveal. Step 3 should add an additive table such as:

```sql
CREATE TABLE day_map_tile_reveals (
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    column_index INTEGER NOT NULL,
    row_index INTEGER NOT NULL,
    node_id UUID,
    revealed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day_map_id, column_index, row_index)
);
```

The server broadcasts `game:tile:reveal:state` after commit.

## 5.3 Suggested-stop decision

| Socket event | Payload | Ack | PostgreSQL contract |
|---|---|---:|---|
| `game:suggested-stop:decision` | `GameSuggestedStopDecisionPayload` (`accepted` / `rejected`) | Yes | Persist consumption/rejection for the exact day-map cell so the suggestion is not offered again incorrectly; increment revision if suggestion state belongs to the day snapshot |

Viewed/edit-opened remain traces only. Accepting a suggestion is followed by the normal `game:node:add` for the accepted stop.

The current schema has no generic path-suggestion ownership table. Step 3 should add a provider-backed suggestion table/decision table rather than overloading `day_map_nodes`.

## 5.4 ActivityTask

| Socket event | Payload | Ack | PostgreSQL contract |
|---|---|---:|---|
| `game:activity:task:update` | full `GameNodeMutationPayload` | Yes | Update `activities`, `tasks`, `activities_tasks`, `day_map_nodes`; increment revision |
| `game:activity:task:reschedule` | full `GameNodeMutationPayload` | Yes | Update canonical activity start/end scheduling plus node time/progress snapshot; increment revision |
| `game:activity:task:skip` | `GameActivityMutationPayload` | Yes | Set activity/task status to skipped according to ownership rules; update node snapshot; increment revision |
| `game:activity:task:complete` | `GameActivityMutationPayload` | Yes | Set completed state; update node snapshot; increment revision |

The full node snapshot is intentionally sent so server validation can use both the normalized task fields and the exact map representation.

## 5.5 ActivityMeal

| Socket event | Payload | Ack | PostgreSQL contract |
|---|---|---:|---|
| `game:activity:meal:update` | full `GameNodeMutationPayload` | Yes | Update `activities`, meal/suggestion execution state, `activities_suggested_meals` as applicable, and `day_map_nodes`; increment revision |
| `game:activity:meal:skip` | `GameActivityMutationPayload` | Yes | Mark source activity/suggestion skipped as appropriate, remove the day-map stop (current product behavior), increment revision, broadcast `game:node:deleted` |
| `game:activity:meal:complete` | `GameActivityMutationPayload` | Yes | Mark completed state in activity/suggestion data and update node snapshot; increment revision |

### Why meal micro-actions are not separate mutations

Meal confirmation, source selection, recipe selection, ingredients, shopping list, venue, fulfillment, host/invitation, contribution, address, and step forward/back/skip remain `game:application:action` traces. The finished UI already calls `persistDraft()` after state-changing operations, and that canonical draft reaches `updateActivityMeal(_:)`. Therefore `game:activity:meal:update` is the durable source of truth and the server avoids dozens of partial-write event contracts.

Local recipe timer start/pause/reset, sheet scrolling, animation and drag offsets remain client-only.

## 5.6 ActivityWorkout stop

| Socket event | Payload | Ack | PostgreSQL contract |
|---|---|---:|---|
| `game:activity:workout:update` | full `GameNodeMutationPayload` | Yes | Update `activities`, `workouts`/activity-workout relation where owned, and `day_map_nodes`; increment revision |
| `game:activity:workout:select` | full `GameNodeMutationPayload` | Yes | Replace the selected workout/class relationship in `activities_workouts`, update node snapshot; increment revision |
| `game:activity:workout:reschedule` | full `GameNodeMutationPayload` | Yes | Update independent activity scheduling and node map time; increment revision |
| `game:activity:workout:check-in` | full `GameNodeMutationPayload` | Yes | Persist the user's class/activity check-in state and node snapshot; increment revision |

Attempting to edit a fixed class time remains a trace-only rejected UI intent. Opening workout/class browsing is a query/navigation action, not a durable mutation.

Fifoo Play workout execution remains separate (`game:play:*`) because it persists workout-session/exercise runtime state rather than the Day Map stop definition.

## 5.7 Post / social

| Socket event | Payload | Ack | PostgreSQL contract |
|---|---|---:|---|
| `game:post:reply:create` | `GamePostReplyCreatePayload` | Yes | Validate post UUID/permissions; insert `post_replies`; update any denormalized reply count/snapshot; broadcast updated post node when relevant |
| `game:post:save` | `GamePostSavePayload` | Yes | Persist per-user save state; update/broadcast node snapshot if counts/status change |
| `game:hyperlink:vote` | `GameHyperlinkVotePayload` | Yes | Persist one current vote per user/link once hyperlink ownership tables exist |

`respondToPost`, view-poster and view-linked-content are application-action traces only.

### Social schema gaps

The supplied schema contains `posts` and `post_replies`, so reply creation is directly supported. It does not yet define per-user saved-post or hyperlink-vote ownership. Step 3 should add additive tables such as `post_saves(user_id, post_id, created_at)` and a hyperlink vote table once the canonical hyperlink entity is finalized.

## 5.8 Route/path state

Existing route contracts remain valid:

| Event | Ack | Durable? | PostgreSQL contract |
|---|---:|---:|---|
| `game:route:select` | Yes | Yes | Store full semantic selected route state in `day_map_routes`; increment revision |
| `game:route:draft:update` | No | No by default | Ephemeral synchronization only |
| `game:route:preview:update` | No | No by default | Ephemeral synchronization only |
| `game:route:preview:commit` | Yes | Yes | Persist committed completed/chosen/alternate state in `day_map_routes`; increment revision |

Route geometry remains JSONB because the deterministic road topology/rendering engine is a client/game-domain concern.

## 5.9 Fifoo Play

Existing typed events remain authoritative:

- `game:play:workout:start`
- `game:play:workout:pause`
- `game:play:workout:resume`
- `game:play:workout:end`
- `game:play:workout:complete`
- `game:play:exercise:select`
- `game:play:exercise:start`
- `game:play:exercise:pause`
- `game:play:exercise:resume`
- `game:play:exercise:complete`
- `game:play:exercise:skip`
- `game:play:message:send`
- `game:play:reaction:send`

Workout/exercise mutations carry the full optimistic `Workout` snapshot. PostgreSQL persists session/runtime state in `workout_sessions` and related live-message/reaction tables; reusable workout definitions continue to live in `workouts`, `exercises`, and `workouts_exercises`.

---

# 6. Non-mutating request/trace matrix

These finished UI actions **do not** need their own PostgreSQL write:

- date-picker open, node/card tap, Add Stop sheet/type selection;
- Browse Meal/Workout open and local query typing while the catalog remains local;
- local photo selection, AI preview result, upload started/completed/failed telemetry (the resulting Cloudinary URLs are persisted with the node snapshot);
- Meal resource-sheet opens and micro-action traces described above;
- Workout browse open and fixed-class-time edit attempt;
- Post respond/focus, view poster, view linked content;
- User conversation/progress navigation entry points;
- map background/road/intersection taps;
- search-open/result-selection UI intents;
- voice mute and local pedometer/countdown mechanics.

If/when Meal/Workout catalogs become server-backed, add dedicated query events and result DTOs without changing the public Step 1 `SocketManager` APIs.

# 7. PostgreSQL transaction rules for Step 3

For each authoritative day-map mutation, the server should execute one transaction:

1. authenticate/authorize the socket user;
2. resolve `(user_id, map_date)` to `day_map_id`;
3. claim `requestID` in the idempotency ledger;
4. validate payload/domain ownership;
5. mutate normalized domain table(s);
6. mutate `day_map_nodes`, `day_map_routes`, reveal/suggestion state as applicable;
7. increment `day_maps.revision` exactly once for the logical mutation;
8. store the successful acknowledgement against `requestID`;
9. commit;
10. acknowledge the caller and broadcast the corresponding compact incoming state event to the user's other connected devices.

On failure, roll back domain changes and store a stable failure response for the same request ID where safe.

# 8. Client reconciliation rules

- Local UI behavior remains optimistic and unchanged.
- Disconnected/failed mutations stay in the existing in-memory outbox.
- After reconnect: authenticate → request/apply authoritative snapshot → replay queued mutations in original order.
- A successful acknowledgement advances `serverRevision`.
- Server broadcasts can replace the optimistic node/route/reveal state with the authoritative committed representation.
- Durable outbox persistence across app termination remains a later offline/persistence step.

# 9. Pass 5.37 code changes

`GameSocketEvents.swift`
- Added authoritative ActivityTask/Meal/Workout events.
- Added tile reveal, suggested-stop decision and post-reply events.
- Added incoming `game:tile:reveal:state`.

`GameSocketPayloads.swift`
- Added tile-cell/reveal payloads.
- Added suggested-stop decision payload.
- Added post-reply creation payload.
- Extended the day snapshot with optional revealed tiles.

`SocketManager.swift`
- Domain-specific Activity APIs now emit their authoritative domain event instead of collapsing to generic `game:node:update` / generic activity events.
- Meal micro-actions remain traces; canonical draft persistence uses `game:activity:meal:update`.
- Post reply submission now emits an acknowledged mutation.
- Tile reveal and suggestion decisions now emit acknowledged mutations.
- Existing legacy adapters and generic events remain for compatibility.

`GameStore.swift`
- Added authoritative snapshot/apply helpers for explicit tile reveal state.

# 10. Completion check

Step 2 is complete when:

1. every durable finished-UI action maps to one authoritative Socket.IO event;
2. every authoritative mutation has a concrete payload and acknowledgement contract;
3. every durable event has an explicit PostgreSQL transaction target or a clearly identified additive-schema gap;
4. the iOS UI does not know event names or database table names;
5. existing optimistic/local behavior is unchanged while backend networking remains disabled;
6. Step 3 can implement the Node/Express/Socket.IO server directly from this document and `GameSocketEvents.swift`/`GameSocketPayloads.swift`.

## Next step

**Backend Integration Step 3 — implement the Node.js/Express/Socket.IO server handlers and PostgreSQL transactions against this contract, beginning with authentication + day snapshot + node CRUD, then ActivityTask → ActivityMeal → ActivityWorkout → social → reveal/suggestion state.**
