# Fifoo Phase 8 — Gamified Onboarding / First-Route Bootstrap

## Status

Code-complete as backend v0.9.0 plus the corresponding iOS onboarding update.

## Implemented

1. New-user onboarding persistence (`011_gamified_onboarding.sql`) with versioned sessions, player profile, obstacles, power-ups, schedule preferences, XP progress and append-only XP ledger.
2. Existing accounts are backfilled as `completed_legacy`; only new signups are required to onboard.
3. Signup remains on the existing hardened authentication stack, but iOS presents it as four game checkpoints: identity, player tag, recovery beacon and password shield.
4. Pre-auth play captures Spawn Point, Destination and Main Quest before account creation.
5. Authenticated onboarding captures Player Style, Bosses, Power-Ups, Difficulty and Typical Day and resumes from backend state after reconnect/relaunch.
6. First-route preview is server-built from personalized deterministic rules and is not committed until `START DAY 1`.
7. Commit reuses the existing authoritative daily-path generator, Day Graph persistence, prediction scoring, and Phase 3 authoritative state.
8. `home_cooking` can mark dinner as `homeMade`; Phase 7 then remains authoritative for grocery/prep support activities.
9. Onboarding awards 50 XP for building the first playable route; no XP is awarded for short-term scale movement.
10. Minimized onboarding context (version/style/difficulty/counts) is retained in Phase 4 learning context without changing the current Phase 5 model feature vector.
11. Added Socket.IO onboarding contract/state to backend and iOS.
12. Added Phase 8 unit tests and `npm run verify:phase8` schema verification.

## Validation

- `npm run check`: PASS.
- `npm test`: 112/112 PASS.
- Swift parse check for modified Phase 8 Swift files: PASS with Swift 6.2.1.
- Live PostgreSQL migration and full Xcode/iOS SDK build still need to be run in the normal development environment.

## Deployment order

1. Deploy backend v0.9.0 and run `npm run migrate`.
2. Run `npm run check && npm test && npm run verify:phase8`.
3. Deploy the updated iOS client.
4. Create a fresh account to test the complete new-user flow; existing accounts should continue directly to their current Day Map.
