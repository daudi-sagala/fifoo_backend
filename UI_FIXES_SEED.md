# UI / Routing Regression Seed

The existing development seed now has a dedicated regression mode:

```bash
npm install
npm run migrate
npm run seed:ui-fixes
```

`seed:ui-fixes` is development-only and refuses to run with `NODE_ENV=production`.

All UI-fix accounts use the same password as the normal development seed unless you override `--password`:

`FifooTest123!`

Accounts created:

| Username | Email | Wake | Bed | Purpose |
|---|---|---:|---:|---|
| `ui_standard` | `ui.standard@fifoo.local` | 07:00 | 23:00 | Standard overnight sleep, fasting, upcoming-workout countdown |
| `ui_workout` | `ui.workout@fifoo.local` | 06:30 | 22:30 | Current workout emphasis, active countdown, completion transition |
| `ui_thirdshift` | `ui.thirdshift@fifoo.local` | 16:00 | 08:00 | Third-shift daytime `Sleep hour` window driven by day-start/day-end |
| `ui_dinner` | `ui.dinner@fifoo.local` | 07:00 | 23:30 | Meal countdown plus positive/negative opportunity badges |

The command force-regenerates today's Day Map for these accounts and asks for two alternatives, so primary-vs-alternative Sleep/Fasting behavior is available for regression testing.

You can still use the normal seed flags, for example:

```bash
npm run seed:dev -- --ui-fixes --date 2026-09-03 --timezone America/New_York --force-day
```
