import test from 'node:test';
import assert from 'node:assert/strict';
import { demoWeightLossDayAug29Rules } from '../src/rules/demoWeightLossDayAug29.js';
import { buildGeneratedDayNode, buildStandardWeightLossDay } from '../src/services/dailyPathGenerator.js';
import { buildInitialRouteState } from '../src/services/routeBuilder.js';
import { makeGridRoadGraph } from '../src/services/gridRoadGraph.js';
import { clockSeconds, alternativeCount, dailyRulesNamed } from '../src/rules/ruleRegistry.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';
const mapDate = '2026-08-29';

test('Aug 29 demo day spans midnight through late evening with representative stops', () => {
  const rules = demoWeightLossDayAug29Rules();
  assert.equal(rules.stops.length, 15);
  assert.equal(rules.stops[0].start, '00:00');
  assert.equal(rules.stops.at(-1).start, '23:30');
  assert.equal(rules.stops.at(-1).progressPercent, 100);
  assert.ok(rules.stops.every((stop) => Object.hasOwn(stop, 'imageURL')));
  assert.ok(rules.stops.every((stop) => typeof stop.imageSearchHint === 'string' && stop.imageSearchHint.length > 0));
});

test('Aug 29 demo route has nine completed, six future, and exactly two alternatives at 15:45:53', () => {
  const plan = buildStandardWeightLossDay({ userID, mapDate, rules: demoWeightLossDayAug29Rules() });
  const routeState = buildInitialRouteState({
    roadGraph: makeGridRoadGraph(),
    nodeAnchors: plan.nodes.map((entry) => entry.anchor),
    currentDayTime: { secondsFromMidnight: clockSeconds('15:45:53') },
    maxAlternatives: 2,
  });
  assert.equal(routeState.completedRoute.reachedNodeIDs.length, 9);
  assert.equal(routeState.chosenFutureRoute.stopNodeIDs.length, 6);
  assert.equal(routeState.alternativeRoutes.length, 2);
});

test('generated stop image URL is projected into marker and type-specific media', () => {
  const rules = demoWeightLossDayAug29Rules();
  const mealStop = { ...rules.stops.find((stop) => stop.key === 'dinner'), imageURL: 'https://example.com/dinner.jpg' };
  const workoutStop = { ...rules.stops.find((stop) => stop.key === 'strength-workout'), imageURL: 'https://example.com/workout.jpg' };
  const taskStop = { ...rules.stops.find((stop) => stop.key === 'evening-prep'), imageURL: 'https://example.com/task.jpg' };

  const meal = buildGeneratedDayNode({ userID, mapDate, rules, stop: mealStop }).node.content.activity._0;
  const workout = buildGeneratedDayNode({ userID, mapDate, rules, stop: workoutStop }).node.content.activity._0;
  const task = buildGeneratedDayNode({ userID, mapDate, rules, stop: taskStop }).node.content.activity._0;

  assert.equal(meal.image.remote.urlString, mealStop.imageURL);
  assert.equal(meal.meal.imageURL, mealStop.imageURL);
  assert.equal(meal.meal.meals[0].imageURL, mealStop.imageURL);
  assert.deepEqual(workout.workout.imageURLs, [workoutStop.imageURL]);
  assert.deepEqual(task.task.imageURLs, [taskStop.imageURL]);
});

test('demo CLI helpers accept named rules, clock times, and two alternatives', () => {
  assert.equal(dailyRulesNamed('demo-aug29').name, 'demo-weight-loss-day-2026-08-29');
  assert.equal(clockSeconds('15:45:53'), 56_753);
  assert.equal(alternativeCount('2'), 2);
});
