# Pass 5.58 — Aug. 29 Rich Demo Day

Development/demo-only backend enhancement for the seeded `weightloss_demo` account.

## Generate the representative Aug. 29, 2026 Day Map

At 3:45:53 PM America/New_York:

```bash
npm run seed:dev -- \
  --date 2026-08-29 \
  --rules demo-aug29 \
  --current-time 15:45:53 \
  --alternatives 2 \
  --force-day
```

This creates 15 stops. At 15:45:53, 9 are classified into Completed and 6 into the future Chosen route. The backend route builder produces exactly 2 alternative future routes.

## Image URLs

Edit:

`src/rules/demoWeightLossDayAug29.js`

At the top of that file, replace the null values in `DEMO_AUG29_IMAGE_URLS` with durable HTTPS URLs. Cloudinary `secure_url` values are recommended.

The generator projects each URL into:
- the Activity map marker image;
- `ActivityMealNodeSummary.imageURL` and the first meal item image;
- `ActivityWorkoutNodeSummary.imageURLs`;
- `ActivityTaskNodeSummary.imageURLs`.

Each stop also has an `imageSearchHint` adjacent to its definition.

## Stops

| Time | Kind | Stop | Progress |
|---|---|---|---:|
| 12:00 AM | Task | Sleep + recovery | 0% |
| 6:30 AM | Task | Weigh-in + water | 4% |
| 7:00 AM | Workout | Morning walk + mobility | 10% |
| 7:45 AM | Meal | Protein breakfast | 16% |
| 9:30 AM | Task | Check today's meal plan | 21% |
| 10:30 AM | Workout | Movement break | 27% |
| 12:30 PM | Meal | Balanced lunch | 35% |
| 2:30 PM | Meal | Planned snack + water | 40% |
| 3:30 PM | Task | Afternoon reset | 45% |
| 4:15 PM | Meal | Pre-workout fuel | 45% |
| 6:30 PM | Workout | Full-body strength | 61% |
| 7:00 PM | Task | Cool down + hydrate | 61% |
| 8:45 PM | Meal | Balanced dinner | 74% |
| 10:30 PM | Task | Prep tomorrow + close the kitchen | 92% |
| 11:30 PM | Task | Sleep target | 100% |

No SQL migration is required.
