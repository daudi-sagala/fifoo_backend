# Temporary Production Test Seed

This replaces the old development seed. The development seed files and `seed:dev` / `seed:ui-fixes` commands have been removed.

## Safety

The seed never deletes existing users while seeding and never targets arbitrary production users during cleanup. All temporary records use deterministic IDs under the batch `temporary-production-seed-v2026-09-03`. Cleanup removes only those IDs; admin and other non-seed users are preserved.

The command requires **both** `NODE_ENV=production` and `ALLOW_TEMP_PRODUCTION_SEED=YES`. It is not called by server startup, migration, or the production scheduler.

## Seed production

Run from the backend directory with the production `DATABASE_URL` available:

```bash
NODE_ENV=production \
ALLOW_TEMP_PRODUCTION_SEED=YES \
npm run seed:production-test
```

Optional environment variables:

```bash
SEED_TEST_PASSWORD='YourTemporaryPassword123!'
SEED_TEST_TIME_ZONE='America/New_York'
```

Default password for all 15 temporary test accounts:

```text
FifooProdTest123!
```

Primary account:

```text
username: maya_march
email:    maya_march@seed.fifoo.ai
password: FifooProdTest123!
```

Third-shift sleep test:

```text
username: omar_shift
email:    omar_shift@seed.fifoo.ai
wake:     16:00
bed:      08:00
```

Late-night / cross-midnight test:

```text
username: nia_night
email:    nia_night@seed.fifoo.ai
wake:     09:30
bed:      01:30
```

The seed creates:

- 15 login-capable users with completed onboarding/game profiles.
- varied wake/bed/work schedules, including daytime sleep / third shift.
- route-knowledge preferences and obstacles/powerups.
- 20 meals.
- 12 suggested meals.
- 24 exercises.
- 15 workouts with five exercise assignments each.
- 12 reusable tasks.
- 45 accepted friendship edges, giving every seed user six friends.
- six direct-message threads plus a Fifoo Support thread for `maya_march`.
- 38 community posts, 13 with image media.
- replies on the first 15 posts (2–5 replies each).
- Road Encounter / Scout Report / Quick Duel rows for six users.
- resource-state rows for support-planning testing.
- Day Maps for all 15 users for yesterday, today, and tomorrow (45 maps total).
- today's elapsed activities are deterministically mixed between completed, skipped, and partial workout outcomes, producing distinct progress values and both positive/negative progress behavior.
- generated routes use the current authoritative daily generator, including primary-route Sleep/Fasting semantics and current v0.13 routing behavior.

Because map dates are calculated at execution time, the same seed can be rerun on a later day. IDs remain deterministic and rows are updated/re-generated rather than duplicated.

## Cleanup before app launch

```bash
NODE_ENV=production \
ALLOW_TEMP_PRODUCTION_SEED=YES \
npm run cleanup:production-test
```

Cleanup removes only the deterministic temporary batch. It does **not** delete admin accounts, Fifoo Support, or other users that were not created by this seed.
