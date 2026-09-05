# Fifoo Route Knowledge Encounters MVP

> **Current product language (v0.15.2):** Internal style identifiers are retained for protocol compatibility. User-facing question titles, prompts, options, defer actions, and result copy use plain scheduling language.


## Purpose

Route Knowledge Encounters turn missing routing/profile information into short, gamified events rather than a conventional onboarding questionnaire. The backend decides whether information is valuable enough to ask for, chooses one question, and sends a presentation contract to iOS. Answers are persisted as structured route knowledge and can immediately affect the authoritative future Day Graph.

The three presentation families are:

- **Road Encounter** — major route-shaping discoveries such as work structure and sleep pattern.
- **Scout Report** — contextual intelligence such as allergies, cooking frequency, commute behavior and meal patterns.
- **Quick Duel** — fast one-tap preference decisions such as schedule predictability, gym access, workout timing and grocery readiness.

## Core rules

1. Ask one thing at a time.
2. The backend owns question eligibility/ranking; iOS owns presentation and animation.
3. New players receive higher-value questions more frequently; cadence decays as knowledge grows.
4. Do not present during an active sourced activity or within five minutes of the next sourced activity.
5. Already-known knowledge is not repeatedly requested.
6. Answers are structured and versioned; question copy is snapshotted with each encounter for auditability.
7. Work/sleep answers can reroute only the future. Completed history remains immutable.
8. Safety-sensitive information such as allergies is explicitly user supplied and never inferred as medically verified.
9. The UI shows an immediate payoff: XP, increased Route Knowledge and whether the map changed.
10. Deferring a question is supported and does not count as an answer.

## Persistence

Migration `012_route_knowledge_encounters.sql` adds:

- `user_route_knowledge` — current structured knowledge by `(user_id, knowledge_key)`;
- `route_knowledge_encounters` — offered/answered/deferred encounter audit records including the question snapshot, trigger context, answer and reward.

Schedule-shaped answers are also mirrored to the existing `user_schedule_preferences` table so established routing/sleep code benefits immediately.

## Initial question catalog

The MVP includes twelve questions:

| Key | Style | Primary route use |
| --- | --- | --- |
| `work_structure` | Road Encounter | protected work windows / route structure |
| `sleep_pattern` | Road Encounter | sleep windows / Sleep-Nap system tiles |
| `food_allergies` | Scout Report | user-declared meal safety constraints |
| `diet_style` | Road Encounter | meal candidate filtering/intents |
| `schedule_predictability` | Quick Duel | routing flexibility preference |
| `gym_access` | Quick Duel | gym vs home/bodyweight workout candidates |
| `cooking_frequency` | Scout Report | home-cooking and support planning |
| `commute_pattern` | Scout Report | future logistics/route constraints |
| `workout_time_preference` | Quick Duel | workout candidate timing |
| `meal_pattern` | Scout Report | meal candidate structure |
| `weekend_structure` | Quick Duel | future weekend route structure |
| `groceries_readiness` | Quick Duel | grocery/prep support planning |

For a brand-new player, routing-value boosts intentionally make **work structure**, then **sleep pattern**, the first two major discoveries. Allergy safety then outranks ordinary preference questions.

## Adaptive cadence

The server computes eligibility from answered encounter count:

- 0 answers: first encounter can be immediate;
- 1–2 answers: minimum ~2 hours between answered encounters;
- 3–5 answers: ~12 hours;
- 6–8 answers: ~24 hours;
- established profile: ~72 hours.

This is a minimum cadence, not a promise to show a question. Timing guards can postpone it further.

## Route effects

### Work structure

A fixed work answer creates protected busy windows for future route generation. Meals may still occur inside work hours; non-meal activities are placed outside protected work time when feasible. A current-day answer can trigger `route_knowledge_updated`, invoking the existing Phase 3 future-only rerouter.

### Sleep pattern

Sleep answers update wake/bed preferences and sleep windows. The representation supports schedules that cross midnight in either direction, including third-shift/day sleepers (for example 8 AM–4 PM sleep). Current-day answers can immediately reroute the future.

### Diet and allergy knowledge

Diet style adjusts meal candidate intent. Allergy data is stored as a hard user-declared constraint and carried into meal metadata/descriptions. Fifoo must not claim that any meal is medically verified allergen-free; the user is reminded to verify ingredients and preparation.

### Gym access

When gym access is unavailable, standard strength candidates can become at-home/bodyweight alternatives.

### Cooking / grocery readiness

Home-cooking knowledge can mark dinner as home-made and feed the existing Phase 7 support planner. Grocery readiness can determine whether a grocery prerequisite is needed before meal preparation.

## Socket contract

Client -> server:

- `game:route-knowledge:encounter:request`
- `game:route-knowledge:encounter:answer`
- `game:route-knowledge:encounter:defer`

Server -> client:

- `game:route-knowledge:encounter`
- `game:route-knowledge:result`

The result includes XP, Route Knowledge percentage, the route-impact class, feedback copy and whether the authoritative map was updated.

## iOS presentation

`DayMapView` hosts a full-screen encounter overlay above the map only when Play is not active.

Motion language:

- dimmed backdrop fades in;
- encounter card springs from a small scale + vertical offset + slight rotation;
- selectable cards use spring highlights;
- single-choice responses briefly lock the selected answer before submission;
- successful answers transform into a reward/result card;
- success plays the existing `levelup.wav`;
- entrance/defer/exit transitions use the existing `swish.wav`;
- result exits upward with a fade/scale transition;
- Reduce Motion is respected.

No new binary sound or image assets are required in this MVP.

## Environment

```env
ROUTE_KNOWLEDGE_ENCOUNTERS_ENABLED=true
```

## Deployment

1. Deploy backend v0.11.0.
2. Run `npm run migrate` to apply migration 012.
3. Run `npm run check && npm test`.
4. Deploy the updated iOS client.
5. Test with a fresh account: after the first authoritative Day Map state loads, the first eligible Road Encounter should be work structure.
