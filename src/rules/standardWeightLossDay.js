/**
 * Temporary default rules for Pass 5.55.
 *
 * Product rules belong here, not in the route builder. Replace/extend this
 * file later with personalization, goals, preferences, availability, medical
 * constraints, work schedules, etc. The generator only consumes this plan.
 */
export const STANDARD_WEIGHT_LOSS_DAY_VERSION = 1;

export function standardWeightLossDayRules() {
  return {
    name: 'standard-weight-loss-day',
    version: STANDARD_WEIGHT_LOSS_DAY_VERSION,
    stops: [
      {
        key: 'morning-check-in',
        kind: 'task',
        start: '07:00',
        durationMinutes: 15,
        progressPercent: 5,
        title: 'Morning check-in + water',
        location: 'Home',
        description: 'Log the morning, drink water, and set one simple intention for the day.',
      },
      {
        key: 'breakfast',
        kind: 'meal',
        start: '07:30',
        durationMinutes: 25,
        progressPercent: 12,
        title: 'Protein-rich breakfast',
        location: 'Home',
        description: 'Start with a filling breakfast built around protein, fiber, and a reasonable portion.',
        calories: 400,
      },
      {
        key: 'morning-walk',
        kind: 'workout',
        start: '10:00',
        durationMinutes: 20,
        progressPercent: 21,
        title: 'Brisk walk',
        location: 'Neighborhood',
        description: 'A short brisk walk to add movement without making the day feel workout-heavy.',
        workoutFormat: 'Independent',
        categories: ['Walking', 'Cardio', 'Weight Loss'],
      },
      {
        key: 'lunch',
        kind: 'meal',
        start: '12:30',
        durationMinutes: 30,
        progressPercent: 29,
        title: 'Balanced lunch',
        location: 'Home or Work',
        description: 'A balanced lunch with lean protein, vegetables, and a measured starch or whole grain.',
        calories: 500,
      },
      {
        key: 'afternoon-reset',
        kind: 'task',
        start: '15:30',
        durationMinutes: 10,
        progressPercent: 34,
        title: 'Hydration + movement reset',
        location: 'Wherever you are',
        description: 'Water, a few minutes of movement, and a quick check before the late-afternoon hunger window.',
      },
      {
        key: 'strength-workout',
        kind: 'workout',
        start: '17:30',
        durationMinutes: 30,
        progressPercent: 49,
        title: 'Full-body strength',
        location: 'Gym or Home',
        description: 'A beginner-friendly full-body strength session focused on consistency and preserving lean mass.',
        workoutFormat: 'Independent',
        categories: ['Strength', 'Full Body', 'Weight Loss'],
      },
      {
        key: 'dinner',
        kind: 'meal',
        start: '19:00',
        durationMinutes: 35,
        progressPercent: 57,
        title: 'Balanced dinner',
        location: 'Home',
        description: 'A satisfying dinner centered on protein and vegetables with portions planned before eating.',
        calories: 550,
      },
      {
        key: 'tomorrow-prep',
        kind: 'task',
        start: '21:00',
        durationMinutes: 15,
        progressPercent: 64,
        title: 'Prep tomorrow + close the kitchen',
        location: 'Home',
        description: 'Prepare one thing for tomorrow and create a clear end to eating for the day.',
      },
    ],
  };
}
