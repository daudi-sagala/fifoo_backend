# Scheduler socket contract v1

These additive events are registered separately from the existing day mutation contract.
The authenticated socket supplies user and device identity. Payload user identifiers are ignored.
All requests use the Socket.IO acknowledgement callback and are limited to 8 KiB / 120 requests per user per minute.

| Event | Payload | Successful acknowledgement |
| --- | --- | --- |
| `game:scheduler:state` | `{}` | `{success:true, preferences, items}` |
| `game:scheduler:preferences` | whitelisted preference patch | `{success:true,preferences}` |
| `game:scheduler:device` | `{token,environment:"sandbox"|"production"}` | `{success:true}` |
| `game:scheduler:presence` | `{active:true|false}` | `{success:true}` |
| `game:scheduler:unregister` | `{}` | `{success:true}` |
| `game:scheduler:action` | `{id,action:"open"|"read"|"snooze",requestID?}` | `{success:true,current,sourceNodeID,mapDate,message}` |
| `game:scheduler:reminder` | `{mapDate,intervalID,minutesBefore,requestID}` | `{success:true,current,sourceNodeID,mapDate,message}` |

Snooze requires a UUID `requestID`, has a fixed ten-minute delay and never edits the schedule. `game:scheduler:reminder` creates a user-requested reminder for an interval that is still on the active chosen plan; `minutesBefore` is 0–1440 and the resulting reminder must still be in the future. Both reminder APIs are idempotent by request ID and never edit route timing. Open/read/snooze/reminder are user-scoped. A stale activity opens today's current schedule and returns a null sourceNodeID. No route mutation is performed from these endpoints.

Preferences: `push_enabled`, `activity_reminders`, `preparation_reminders`, `discreet`, `sound_enabled`, `daily_limit` (0–8), `min_spacing_minutes` (15–720), `quiet_start_minute`/`quiet_end_minute` (0–1439 or both null). These are authenticated settings, not schedule advice.

Inbox: most recent 60 published items. `id,title,body,kind,read_at,published_at,source_node_id,interval_id,plan_revision,map_date,current`. Read and published timestamps are display/audit strings. Clients must use returned IDs, not synthesize activity IDs from titles.

Existing `game:route:reroute` adds a supported system action `goToSleep`, alongside preserved `breakFast` and `iAmAwake`. It is sent only from an explicit current-day user decision. Sleep ends at the next planned wake within the current wall-clock day, or the day boundary when wake is tomorrow; next-day planning continues through the existing sleep context. It filters overlapping future candidates, never retroactively completes an activity and never rewrites completed history.

New day-plan interval metadata adds `presentationKey`. Day-plan/full-snapshot responses add `mapDate`; relevant individual node/route responses also carry it where produced. Older payloads without optional fields remain decodable. A current client rejects a response that explicitly belongs to another day.

No APNs device token, signing key or access token belongs in the inbox payload. APNs alert payload contains notificationID/mapDate/planRevision; the app resolves that notification with the authenticated backend before opening a node.
