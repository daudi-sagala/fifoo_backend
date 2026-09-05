# Device / deployment validation checklist — NOT EXECUTED HERE

These are release gates, not claimed test results. Record device, OS, signed build, backend revision, date and outcome for each.

## Build/signing
- Full Xcode target build; no duplicate payload definitions; all five new production files in the target, standalone Tests files excluded.
- Confirm Push Notifications capability/provisioning and correct APNs environment/topic for development and TestFlight.
- Check foreground permission denial, later enablement in Settings, logout, login as a different user, reinstall/token rotation, and two devices for one account.

## Map consistency and motion
- Add/move/delete a stop; choose an alternate; complete/skip/partially complete an activity; Break Fast; I Am Awake; Go To Sleep.
- Confirm unchanged cards persist; moving cards slide from their displayed positions; arrow endpoints track them; obsolete future cards slide out; new cards slide in.
- Verify 10% extra NOW scaling, neon NOW label, no countdown, no flashing border, and no missing Sleep/Fasting arrows.
- Completed route/earned points remain unchanged by future-only recalculation.
- Rapid consecutive revisions, same-interval clipping, overlapping system state fragments, stacked tiles, offscreen targets, mid-slide camera pan/pinch, day change during a pending request, old-day late response, and alternate preview.
- Reduce Motion and VoiceOver labels; large text; small-screen safe areas and existing tab/overlay controls.
- Profile on physical hardware for frame delivery, CPU, memory and image loading. No frame-rate/performance benchmark has been claimed by the automated suite.

## Processing/recovery
- Under 500 ms: no loading flash. Above 500 ms: status visible over last valid map.
- Ack before broadcast, broadcast before ack, repeated same-revision refresh, dropped ack, dropped broadcast, dropped network and reconnection.
- At 4 seconds: waiting explanation. At 12 seconds: status check available, existing durable mutation UUID retained. Known validation rejection can be dismissed.
- A cancelled day view must not allow its late response to replace the new day. A same-revision notification-open refresh must still open its node after the plan is applied.
- Slow/missing artwork must use fallback content without delaying the entire map.
- Hear one levelup when an automatic transition settles; no swish for automatic advancement, no sound burst after reopening, no sounds with map sound off or during sleep/Play.

## Notifications/database
- Apply migration 013 on staging; run verify:notifications:db; confirm three triggers and initial reconciliation jobs.
- Commit and roll back a plan transaction; only the committed one should produce a usable reminder plan.
- Commit completion/partial/skip/node disable/delete without a reroute; outstanding reminders must be cancelled in the transaction.
- Run two backend replicas/workers; verify no ordinary double processing and correctly serialized user budgets.
- Worker restart, transport timeout, 429, 5xx, bad token, credential failure, token renewal during a failed attempt, expiry during retry, and process crash after provider acceptance.
- Verify one most recently active eligible device is selected and revoked sessions are ineligible.
- Sleep overnight, nap, third-shift sleep, additional quiet hours, DST transition, changed timezone, midnight, actual running workout and passive fasting.
- No reminder for an alternate-only, completed, deleted or expired activity. Explicit snooze changes the reminder only and is idempotent under replay.
- APNs disabled and push permission denied: inbox still works. Foreground app: inline/inbox presentation, no duplicate system banner.
- Push accepted / displayed / read / acted are distinguished. No personal details on lock screen with discreet mode on; no reward for opening.
- Open a push from the previous day after midnight, a deleted activity, a moved stop, and a different signed-in account. Never open the obsolete or wrong-account node.
- Check settings editing while polling: unsaved switches stay in the local draft rather than being overwritten.
