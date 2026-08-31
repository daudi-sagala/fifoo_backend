/**
 * Rich development/demo fixture for Saturday, August 29, 2026.
 *
 * IMAGE CUSTOMIZATION:
 * Replace the null values in DEMO_AUG29_IMAGE_URLS with durable HTTPS URLs
 * (Cloudinary secure_url values are ideal), then regenerate the day. The
 * generator copies each URL into the Activity marker and the type-specific
 * Meal / Workout / Task media fields used by iOS.
 */
export const DEMO_AUG29_IMAGE_URLS = Object.freeze({
  sleepRecovery: null,
  morningCheckIn: null,
  morningWalk: null,
  breakfast: null,
  mealPlan: null,
  movementBreak: null,
  lunch: null,
  plannedSnack: null,
  afternoonReset: null,
  preWorkout: null,
  strengthWorkout: null,
  cooldown: null,
  dinner: null,
  eveningPrep: null,
  sleepTarget: null,
});

export const DEMO_WEIGHT_LOSS_DAY_AUG29_VERSION = 1;

export function demoWeightLossDayAug29Rules() {
  return {
    name: 'demo-weight-loss-day-2026-08-29',
    version: DEMO_WEIGHT_LOSS_DAY_AUG29_VERSION,
    stops: [
      {
        key: 'sleep-recovery', kind: 'task', start: '00:00', durationMinutes: 390, progressPercent: 0,
        title: 'Sleep + recovery', location: 'Home',
        description: 'Protect the overnight recovery window so hunger, energy, and training are easier to manage tomorrow.',
        imageURL: DEMO_AUG29_IMAGE_URLS.sleepRecovery,
        imageSearchHint: 'calm dark bedroom sleep recovery healthy lifestyle',
      },
      {
        key: 'morning-check-in', kind: 'task', start: '06:30', durationMinutes: 15, progressPercent: 4,
        title: 'Weigh-in + water', location: 'Home',
        description: 'Log the morning weight, drink a full glass of water, and set the day intention.',
        imageURL: DEMO_AUG29_IMAGE_URLS.morningCheckIn,
        imageSearchHint: 'bathroom scale water bottle morning wellness',
      },
      {
        key: 'morning-walk', kind: 'workout', start: '07:00', durationMinutes: 30, progressPercent: 10,
        workoutTemplateRulesName: 'standard-weight-loss-day', workoutTemplateRulesVersion: 1, workoutTemplateKey: 'morning-walk',
        title: 'Morning walk + mobility', location: 'Neighborhood',
        description: 'Easy outdoor walking plus a few minutes of mobility to start the day moving.',
        workoutFormat: 'Independent', categories: ['Walking', 'Mobility', 'Weight Loss'],
        imageURL: DEMO_AUG29_IMAGE_URLS.morningWalk,
        imageSearchHint: 'morning neighborhood walk fitness sunrise',
      },
      {
        key: 'breakfast', kind: 'meal', start: '07:45', durationMinutes: 30, progressPercent: 16,
        title: 'Protein breakfast', location: 'Home', calories: 390,
        description: 'Greek yogurt, berries, oats, and a measured portion of nuts for protein and fiber.',
        imageURL: DEMO_AUG29_IMAGE_URLS.breakfast,
        imageSearchHint: 'greek yogurt berries oats healthy breakfast bowl',
      },
      {
        key: 'meal-plan-check', kind: 'task', start: '09:30', durationMinutes: 15, progressPercent: 21,
        title: 'Check today\'s meal plan', location: 'Home',
        description: 'Confirm lunch, snack, and dinner before the day gets busy.',
        imageURL: DEMO_AUG29_IMAGE_URLS.mealPlan,
        imageSearchHint: 'healthy meal plan grocery list kitchen notebook',
      },
      {
        key: 'movement-break', kind: 'workout', start: '10:30', durationMinutes: 15, progressPercent: 27,
        workoutTemplateRulesName: 'standard-weight-loss-day', workoutTemplateRulesVersion: 1, workoutTemplateKey: 'morning-walk',
        title: 'Movement break', location: 'Outside',
        description: 'A brisk fifteen-minute walk to break up sitting and accumulate daily steps.',
        workoutFormat: 'Independent', categories: ['Walking', 'Cardio', 'Steps'],
        imageURL: DEMO_AUG29_IMAGE_URLS.movementBreak,
        imageSearchHint: 'brisk walking city park fitness break',
      },
      {
        key: 'lunch', kind: 'meal', start: '12:30', durationMinutes: 35, progressPercent: 35,
        title: 'Balanced lunch', location: 'Home or Work', calories: 510,
        description: 'Chicken grain bowl with vegetables, lean protein, and a measured whole-grain portion.',
        imageURL: DEMO_AUG29_IMAGE_URLS.lunch,
        imageSearchHint: 'healthy chicken grain bowl vegetables lunch',
      },
      {
        key: 'planned-snack', kind: 'meal', start: '14:30', durationMinutes: 15, progressPercent: 40,
        title: 'Planned snack + water', location: 'Wherever you are', calories: 190,
        description: 'Apple and Greek yogurt before the late-afternoon hunger window.',
        imageURL: DEMO_AUG29_IMAGE_URLS.plannedSnack,
        imageSearchHint: 'apple greek yogurt healthy snack water',
      },
      {
        key: 'afternoon-reset', kind: 'task', start: '15:30', durationMinutes: 10, progressPercent: 45,
        title: 'Afternoon reset', location: 'Wherever you are',
        description: 'Refill water, stand up, and check the evening plan before making an unplanned food decision.',
        imageURL: DEMO_AUG29_IMAGE_URLS.afternoonReset,
        imageSearchHint: 'refillable water bottle office movement break',
      },
      {
        key: 'pre-workout', kind: 'meal', start: '16:15', durationMinutes: 15, progressPercent: 45,
        title: 'Pre-workout fuel', location: 'Home', calories: 160,
        description: 'A light planned snack and water before strength training.',
        imageURL: DEMO_AUG29_IMAGE_URLS.preWorkout,
        imageSearchHint: 'banana protein snack pre workout water',
      },
      {
        key: 'strength-workout', kind: 'workout', start: '18:30', durationMinutes: 40, progressPercent: 61,
        workoutTemplateRulesName: 'standard-weight-loss-day', workoutTemplateRulesVersion: 1, workoutTemplateKey: 'strength-workout',
        title: 'Full-body strength', location: 'Gym or Home',
        description: 'Beginner-friendly full-body resistance training focused on consistency and preserving lean mass.',
        workoutFormat: 'Independent', categories: ['Strength', 'Full Body', 'Weight Loss'],
        imageURL: DEMO_AUG29_IMAGE_URLS.strengthWorkout,
        imageSearchHint: 'full body strength training dumbbells gym',
      },
      {
        key: 'cooldown', kind: 'task', start: '19:00', durationMinutes: 15, progressPercent: 61,
        title: 'Cool down + hydrate', location: 'Gym or Home',
        description: 'Bring the heart rate down, drink water, and log the completed workout.',
        imageURL: DEMO_AUG29_IMAGE_URLS.cooldown,
        imageSearchHint: 'post workout stretching hydration gym',
      },
      {
        key: 'dinner', kind: 'meal', start: '20:45', durationMinutes: 40, progressPercent: 74,
        title: 'Balanced dinner', location: 'Home', calories: 560,
        description: 'Salmon, roasted potatoes, and vegetables with portions decided before eating.',
        imageURL: DEMO_AUG29_IMAGE_URLS.dinner,
        imageSearchHint: 'salmon roasted potatoes vegetables healthy dinner',
      },
      {
        key: 'evening-prep', kind: 'task', start: '22:30', durationMinutes: 30, progressPercent: 92,
        title: 'Prep tomorrow + close the kitchen', location: 'Home',
        description: 'Prep tomorrow\'s lunch, put food away, and start a screen-light wind-down routine.',
        imageURL: DEMO_AUG29_IMAGE_URLS.eveningPrep,
        imageSearchHint: 'healthy meal prep containers clean kitchen evening routine',
      },
      {
        key: 'sleep-target', kind: 'task', start: '23:30', durationMinutes: 29, progressPercent: 100,
        title: 'Sleep target', location: 'Home',
        description: 'Be in bed on time and close the day at the 100% target.',
        imageURL: DEMO_AUG29_IMAGE_URLS.sleepTarget,
        imageSearchHint: 'peaceful bedroom sleep healthy routine night',
      },
    ],
  };
}
