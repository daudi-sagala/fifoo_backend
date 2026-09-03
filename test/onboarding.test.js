import test from 'node:test';
import assert from 'node:assert/strict';
import { OUT, IN } from '../src/events.js';
import { personalizedOnboardingRules } from '../src/services/onboarding.js';
import { buildStandardWeightLossDay } from '../src/services/dailyPathGenerator.js';

const userID = '11111111-1111-4111-8111-111111111111';

test('Phase 8 onboarding socket contract is stable', () => {
  assert.equal(OUT.onboardingStateRequest, 'game:onboarding:state:request');
  assert.equal(OUT.onboardingStart, 'game:onboarding:start');
  assert.equal(OUT.onboardingUpdate, 'game:onboarding:update');
  assert.equal(OUT.onboardingPreview, 'game:onboarding:preview');
  assert.equal(OUT.onboardingComplete, 'game:onboarding:complete');
  assert.equal(IN.onboardingState, 'game:onboarding:state');
  assert.equal(IN.onboardingPreviewState, 'game:onboarding:preview:state');
  assert.equal(IN.onboardingCompleted, 'game:onboarding:completed');
});

test('personalized onboarding route compiles and exposes home-cooked support intent', () => {
  const sessionData = {
    playerStyle: 'planner',
    difficulty: 'balanced',
    obstacles: ['late_night_eating'],
    powerups: ['walking', 'home_cooking', 'strength_training'],
    typicalDay: {
      wakeTime: '06:45', workStartTime: '09:00', workEndTime: '17:00',
      lunchTime: '12:15', workoutTime: '18:00', dinnerTime: '19:30', bedTime: '22:45',
      groceriesReady: false,
    },
  };
  const rules = personalizedOnboardingRules(sessionData);
  const dinner = rules.stops.find((stop) => stop.key === 'dinner');
  assert.equal(dinner.title, 'Home-cooked dinner');
  assert.equal(dinner.start, '19:30');
  assert.equal(dinner.executionPlan.source, 'homeMade');
  assert.equal(dinner.executionPlan.groceriesNeeded, true);
  assert.equal(rules.stops.find((stop) => stop.key === 'strength-workout').start, '18:00');

  const built = buildStandardWeightLossDay({ userID, mapDate: '2026-09-04', rules });
  assert.equal(built.nodes.length, rules.stops.length);
  assert.equal(built.dayGraph.chosenPath.intervals[0].startSecond, 0);
  assert.equal(built.dayGraph.chosenPath.intervals.at(-1).endSecond, 86_400);
});
