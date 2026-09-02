import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSupportTaskNode,
  findSupportSlot,
  supportRequirementsForNode,
  targetSecondsFromNow,
} from '../src/services/activitySupportRules.js';

function mealNode({
  id = '11111111-1111-4111-8111-111111111111',
  title = 'Home-cooked dinner',
  time = 19 * 3600,
  source = 'homeMade',
  groceriesNeeded = true,
  ingredientsReady = false,
  shoppingList = ['chicken'],
} = {}) {
  return {
    id: { rawValue: id },
    time: { secondsFromMidnight: time },
    placement: { coordinate: { _0: { time: { secondsFromMidnight: time }, progress: { percent: 0 } } } },
    content: {
      activity: {
        _0: {
          activityID: '22222222-2222-4222-8222-222222222222',
          title,
          date: '2026-09-03',
          startTime: '7:00 PM',
          endTime: '8:00 PM',
          location: '',
          description: '',
          activityType: 'meal',
          status: 'Not Started',
          meal: {
            suggestedMealID: 'meal-1',
            title,
            estimatedTimeMinutes: 60,
            priceRange: '$',
            executionPlan: {
              selectedMealName: title,
              source,
              completedStepIDs: [],
              skippedStepIDs: [],
              isPaused: false,
              recipeName: title,
              ingredientsReady,
              groceriesNeeded,
              venueName: '',
              venueLocation: '',
              venueHours: '',
              venueAvailable: false,
              fulfillmentMode: '',
              hostName: '',
              eventLocation: '',
              invitationConfirmed: false,
              contribution: '',
              shoppingList,
            },
          },
        },
      },
    },
    isEnabled: true,
  };
}

test('explicit home-made meal with missing groceries creates groceries and prep requirements', () => {
  const requirements = supportRequirementsForNode(mealNode());
  assert.deepEqual(requirements.map((item) => item.ruleKey), [
    'meal.home-made.groceries.v1',
    'meal.home-made.prep.v1',
  ]);
  assert.equal(requirements[0].confidence, 0.95);
  assert.equal(requirements[1].relationshipType, 'prepares_for');
});

test('home-made meal with ingredients ready creates prep only', () => {
  const requirements = supportRequirementsForNode(mealNode({
    groceriesNeeded: false,
    ingredientsReady: true,
    shoppingList: [],
  }));
  assert.deepEqual(requirements.map((item) => item.ruleKey), ['meal.home-made.prep.v1']);
});

test('restaurant/store meal does not create home-made support actions', () => {
  const requirements = supportRequirementsForNode(mealNode({
    title: 'Dinner reservation',
    source: 'restaurantOrStore',
    groceriesNeeded: false,
    shoppingList: [],
  }));
  assert.equal(requirements.length, 0);
});

test('slot finder stays near preference while respecting occupied intervals', () => {
  const slot = findSupportSlot({
    existingIntervals: [
      { startSecond: 18 * 3600, endSecond: 19 * 3600 + 30 * 60 },
      { startSecond: 20 * 3600 + 30 * 60, endSecond: 21 * 3600 },
    ],
    earliestStartSecond: 17 * 3600,
    latestEndSecond: 22 * 3600,
    durationSeconds: 45 * 60,
    preferredStartSecond: 18 * 3600 + 30 * 60,
  });
  assert.deepEqual(slot, {
    startSecond: 19 * 3600 + 30 * 60,
    endSecond: 20 * 3600 + 15 * 60,
  });
});

test('support task identity is stable and carries explainable target metadata', () => {
  const requirement = supportRequirementsForNode(mealNode())[0];
  const args = {
    userID: '33333333-3333-4333-8333-333333333333',
    supportMapDate: '2026-09-02',
    slot: { startSecond: 18 * 3600 + 30 * 60, endSecond: 19 * 3600 + 15 * 60 },
    targetNodeID: '11111111-1111-4111-8111-111111111111',
    targetMapDate: '2026-09-03',
    targetStartSecond: 19 * 3600,
    requirement,
  };
  const first = buildSupportTaskNode(args);
  const second = buildSupportTaskNode(args);
  assert.equal(first.id.rawValue, second.id.rawValue);
  assert.equal(first.content.activity._0.supportPlan.targetNodeID, args.targetNodeID);
  assert.equal(first.content.activity._0.supportPlan.ruleKey, requirement.ruleKey);
  assert.match(first.content.activity._0.description, /Added automatically by Fifoo/);
});

test('rolling-horizon helper measures future local target seconds', () => {
  assert.equal(targetSecondsFromNow({
    anchorMapDate: '2026-09-02',
    nowSecond: 18 * 3600,
    targetMapDate: '2026-09-03',
    targetNode: mealNode({ time: 19 * 3600 }),
  }), 25 * 3600);
});
