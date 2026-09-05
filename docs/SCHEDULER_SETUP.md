# Fifoo scheduler release — setup and operating guide

Backend **0.15.0** · iOS source release **0.16.0** · September 5, 2026

## What this release changes

This release implements the five approved scheduler passes on the supplied backend 0.14.0 and iOS 0.15.0 archives. The two explicit payload initializers from iOS 0.15.1 are reapplied to that supplied iOS source; the rest of the supplied source is not replaced with an older archive.

1. **Coordinated map motion.** Retained visible activities keep their SpriteKit objects across grid moves. New cards slide in, obsolete cards slide out, and persistent arrows follow the actual animated endpoints. The map coalesces property updates into a single frame. Completed history is not rewritten. Stable presentation keys are additional metadata, not ledger or route IDs. Reduce Motion disables large slides. Automatic advancement uses the existing `levelup` sound once when the scene settles, without reconnect catch-up sounds.
2. **Revision-aware processing.** A map-local status panel appears after 500 ms, with a 250 ms minimum display period. The acknowledgement AND a rendered applicable revision are required for a mutation to finish. A day load waits for the authoritative plan, not just its legacy node snapshot. After four seconds the copy explains the wait; after twelve it offers a status check. Retryable/uncertain writes keep their existing durable request IDs. Known failures can be dismissed without pretending success.
3. **Next-action UI.** A Now/Next dock, morning/remaining schedule review, recorded-progress summary, next-day access, and a schedule inbox/settings sheet. Live newly published reminders can appear inline; there is no old-notification burst when reopening. Existing encounter copy describes schedule settings/actions rather than rewards or pep talks. The review includes explicit **Go To Sleep**, with a confirmation that overlapping future chosen stops will be removed. Existing **Break Fast** and **I Am Awake** are preserved.
4. **Transactional reminders and APNs.** PostgreSQL jobs are inserted by triggers in the day-plan transaction. A bounded worker reconciles activity/preparation reminders, revalidates current plan and ledger outcomes, publishes the inbox, and optionally sends APNs alerts. Completed, partially completed, skipped, disabled, or deleted activities cancel outstanding reminders transactionally. Schedule-change messages are inbox-only. No hourly Sleep/Fasting pushes are created.
5. **Validation and setup.** Backend unit/mock-service tests, actual Swift core and payload-definition executable harnesses, source parse checks, Apple signing/configuration instructions, and a device checklist. See `TEST_REPORT.md` for what actually ran.

These are source-level changes, not a deployment to your Azure subscription or Apple account. Live infrastructure/signing verification is still required.

## Install the backend

Merge the updated source into your existing repository. Preserve deployment secrets and your working environment settings. The GitHub/Azure workflow in the supplied archive is left unchanged; do not overwrite a newer workflow you already maintain.

No new npm dependency was introduced. APNs uses Node's built-in `crypto` and HTTP/2 APIs. Install dependencies through your normal build/deployment process; retain your existing lockfile if your repository has one. The uploaded archive did not include a lockfile, so this delivery does not invent or regenerate one.

**Apply the new migration before enabling the worker or deploying its handlers:**

```bash
npm run migrate
npm run verify:notifications:db
```

`sql/013_scheduler_notifications.sql` adds notification preferences, registered devices, scheduled notifications/inbox records, delivery attempts, plan jobs, and three triggers. Older migrations are unchanged. Existing active plans are enqueued once for reconciliation. The verification command is read-only; it checks table/trigger presence and prints status counts. It was supplied but not executed against a live database in this environment.

The existing application can be deployed in this safe configuration first:

```dotenv
NOTIFICATION_SCHEDULER_ENABLED=true
NOTIFICATION_TICK_MS=15000
APNS_ENABLED=false
```

With APNs disabled, schedule reminders still enter the in-app inbox. Push preferences default to off per user. Configure a continuously running backend worker/replica for timely delivery: a process that is scaled to zero cannot poll its database. Existing schedulers and readiness checks are preserved.

### APNs credentials

Configure these as deployment settings; store the key itself in a secret, never in Git or a ZIP:

```dotenv
APNS_ENABLED=true
APNS_TOPIC=<the actual iOS bundle identifier>
APNS_TEAM_ID=<your Apple developer team identifier>
APNS_KEY_ID=<the identifier of the APNs signing key>
APNS_PRIVATE_KEY=<PEM content supplied from a secret>
```

Alternatively, leave `APNS_PRIVATE_KEY` **unset** and use a mounted secret file:

```dotenv
APNS_KEY_PATH=/run/secrets/apns-key.p8
```

Do not set the private-key variable to an empty string when relying on the file fallback. Escaped `\n` line breaks in the environment value are normalized. An invalid or incomplete key does not make the application forge a successful delivery; attempts fail or the provider stays disabled while the inbox remains usable.

The provider uses an ES256 token, a short-lived JWT cache, environment-specific APNs hosts, 10-second request timeout, alert push type, and event-specific expiry/collapse IDs. Standard alerts only: no critical or Time Sensitive escalation. Topic/token environment mismatches must be corrected, not bypassed by weakening checks.

## Install the iOS source

**The uploaded iOS archive contains source/assets, but no `.xcodeproj` or `.xcworkspace`.** This delivery therefore cannot edit your actual target build settings or provisioning profiles. Merge the source into your existing Xcode project rather than creating a second app target.

Add the following new production Swift files to the existing app target, unless your project uses automatically synchronized folders:

- `App/Scheduler/SchedulerCore.swift`
- `App/Scheduler/MapOperationCoordinator.swift`
- `App/Scheduler/NotificationCoordinator.swift`
- `App/Scheduler/SchedulerViews.swift`
- `Game/Store/GameStore+Scheduler.swift`

Replace the changed existing files at their existing paths, especially `SocketManager.swift`, `GameSocketPayloads.swift`, `DayMapView.swift`, `MapGridRenderer.swift`, `VirtualMapScene.swift`, `fifoogameApp.swift`, and the authentication integration. **Do not add duplicate definitions** of the payload structs or app delegate.

Do not add the standalone Swift files under `Tests/` to the app target: each executable harness has its own `@main`. They are run by the supplied scripts. Keep your existing app assets, fonts, bundle identifier, capabilities, Cloudinary settings, and backend URL. No font files are included in this delivery.

### Enable push capability and select the environment

Enable **Push Notifications** for the existing app identifier and Xcode target, and refresh the signing/provisioning configuration as appropriate. Merge the `aps-environment` key into your existing entitlements rather than replacing other entitlements. `Configuration/Scheduler.entitlements.example` is a merge example, not an automatically activated signing file.

The added `Info.plist` key `FIFOO_APNS_ENVIRONMENT` reads `$(FIFOO_APNS_ENVIRONMENT)` from build settings. Include the relevant sample xcconfig in your existing configuration or add equivalent user-defined settings:

| Build signing/environment | FIFOO_APNS_ENVIRONMENT | Signed aps-environment |
| --- | --- | --- |
| Development/sandbox | `sandbox` | `development` |
| Distribution/TestFlight/production | `production` | `production` |

`Configuration/Scheduler.Debug.xcconfig` and `Scheduler.Release.xcconfig` provide these values. Select values based on the actual signing environment, not merely the name of a custom configuration. No team ID or bundle identifier is hard-coded in these files.

If your Xcode target generates its Info.plist rather than using this file, add the equivalent custom key in the target's Info settings. If the value remains the literal unresolved build-setting macro, the app will show a configuration message and will not guess which APNs environment to use.

This implementation uses ordinary alert pushes and foreground action handling. It does not depend on silent push delivery, a background socket, or background timer execution. No remote-notification background mode is required for the implemented alert/action flow.

### Permission and first-device check

1. Launch and sign in on a physical device using the updated backend.
2. Open the inbox, then Notifications settings, then **Allow scheduled reminders**. Login alone does not trigger a permission prompt.
3. Save **Send push reminders** enabled. Confirm iOS notification settings permit delivery.
4. Confirm a registration row exists for the user/device with the correct environment and topic. Do not paste device tokens into public logs.
5. Choose an upcoming real activity, background the app, and inspect the inbox and delivery-attempt result after its reminder becomes due. Test outside sleep/quiet intervals and the automatic budget/cooldown.
6. Verify tapping the push restores authentication, refreshes the day, and opens the current stop. A stale push should open today's current schedule instead of an obsolete activity.

Simulator results do not replace the signed physical-device/APNs check. This check was not performed in the coding environment.

## Reminder policy and behavior

- Upcoming real chosen activities: a ten-minute lead; preparation/shopping tasks: a fifteen-minute lead. Alternative routes and hourly Sleep/Fasting are not reminder candidates.
- Automatic push budget: three per rolling 24 hours by default (configurable 0–8), with a 90-minute spacing default. The UI explicitly says rolling 24 hours; it is not a counter reset at midnight.
- Explicit **Remind in 10 min** creates an idempotent reminder only. It does not shift a route or extend the activity expiry, and is rejected when the activity ends before the reminder. Explicit reminders bypass the automatic count/spacing but not category settings, quiet periods or expiry.
- Sleep/nap windows, additional configured quiet hours, actual active-workout intervals and fresh foreground presence suppress routine pushes. Passive fasting does not count as a busy state. Suppressed events remain in the inbox rather than producing a wake-up backlog.
- Inbox polling is every 30 seconds in the foreground; foreground-presence freshness lasts 75 seconds. In-app presentation suppresses duplicate system banners. There can still be race conditions when app state changes during delivery; APNs itself is not a transactional extension of the app UI.
- One eligible installation is selected per notification: the most recently active registered device with a still-valid login session. This avoids sending identical routine reminders to all devices. Token re-registration/reassociation and logout/account switching clear old associations or make them ineligible.
- Lock-screen details are discreet by default. Notification opens/read state never award activity progress. APNs acceptance is logged separately from a read/action.
- Scope: this release schedules activity and preparation reminders plus schedule-change inbox records. It does not add marketing, social-feed/reply pushes, alarms, medical alerts, or automatic location tracking.

## Recovery, consistency, and limits

The outbox worker rechecks plan revision, schedule, ledger outcome, preferences, quiet time, device/session eligibility, expiry and budget before an attempt. It uses row locks plus a per-user advisory transaction lock so parallel workers do not independently spend the same budget. APNs requests occur while that bounded transaction holds the event claim (one device per event, 10-second transport cap).

This is **at-least-once external delivery**, not exactly once. A process can fail after APNs accepts a message but before PostgreSQL commits the attempt. The same event/collapse identifier reduces duplicate visible alerts, but cannot guarantee that APNs retracts an already delivered message. A future higher-throughput implementation can move to a dedicated leased dispatcher without changing the public socket/UI contract.

Retries are bounded (initial attempt plus at most five retries), with exponential delay and a maximum 900-second delay. Expiry is rechecked before every retry. Invalid tokens are disabled conditionally against their exact registration version to avoid disabling a freshly re-registered token. Read/action handlers scope every identifier to the authenticated user; no payload can choose another user ID.

Database-trigger cancellation prevents future sends, not recall of a push already handed to APNs. Notification action handling always resolves the current plan. Device Focus, user settings, network conditions and platform policy can defer or prevent delivery; do not treat APNs acceptance as proof of display.

Notifications are retained in PostgreSQL; the inbox returns the latest 60 published records. No automated retention deletion is enabled. Establish your retention/access policy before public rollout; a 90-day retention task can be introduced separately after reviewing support/audit requirements.

Existing immutable completed intervals, earned ledger points, system-activity evaluator/caps, source node IDs and route geometry contracts are preserved. Presentation identity is a rendering aid only. The current NOW card keeps its existing extra 10% scaling and neon label, without restoring a countdown or flashing border.

## Tests and release gates

Executable checks:

```bash
# Backend: pure/module tests and fake-database/provider tests; no live database required.
npm run check
DATABASE_URL=postgresql://test:test@localhost:5432/test NODE_ENV=test npm test
npm run test:notifications

# iOS source folder: real production Foundation definitions compiled with Swift 6.
bash Tests/run-scheduler-core-tests.sh
python3 Tests/run-payload-tests.py
```

`TEST_REPORT.md` contains the commands actually run and results. SQL-query mocks test caller ownership, transaction composition and delivery decisions; they do NOT establish SQL execution correctness against PostgreSQL. The Swift harnesses type-check selected production definitions; full source syntax parsing does NOT establish a UIKit/SpriteKit target build.

Before production enablement, run the checks in `DEVICE_VALIDATION.md`, apply/verify migration 013 on a staging copy, then build the real iOS target and test signed push delivery. These gates are intentionally not pre-marked as passed.

## Official implementation references

- Apple: Registering your app with APNs — https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns
- Apple: Sending notification requests to APNs — https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
- Apple: Establishing a token-based connection — https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- Apple: Handling notifications and notification-related actions — https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions
- Apple: SKAction custom actions — https://developer.apple.com/documentation/spritekit/skaction/customaction(withduration:actionblock:)
