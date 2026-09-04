import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blendCompletionProbability,
  optimizeDayRoutes,
  optimizeFutureRoutes,
} from '../src/algorithms/routingEngine.js';
import { compileContinuousDay, validateDayGraph } from '../src/algorithms/dayGraph.js';
import { allocateDailyBudget } from '../src/algorithms/progressEngine.js';

test('cold-start probability shifts from population to cohort to individual with evidence', () => {
  const cold = blendCompletionProbability({ population: 0.6 });
  const cohort = blendCompletionProbability({ population: 0.6, cohort: 0.8, cohortSamples: 400 });
  const personal = blendCompletionProbability({
    population: 0.6,
    cohort: 0.8,
    cohortSamples: 400,
    individual: 0.95,
    individualSamples: 100,
  });
  assert.equal(cold, 0.6);
  assert.ok(cohort > cold);
  assert.ok(personal > cohort);
});

test('beam search returns connected, diverse whole-day routes around hard constraints', () => {
  const result = optimizeDayRoutes({
    context: {
      idSeed: 'routing-test',
      wakeSecond: 7 * 3600,
      sleepSecond: 23 * 3600,
      hardBusyIntervals: [{ startSecond: 13 * 3600, endSecond: 16 * 3600 }],
      populationPriors: { meal: 0.9, workout: 0.45, movement: 0.85 },
    },
    candidates: [
      {
        key: 'breakfast', decisionGroup: 'breakfast', kind: 'meal', required: true,
        fixedStartSecond: 7 * 3600, durationMinutes: 30,
        progressCategory: 'nutrition', progressWeightHint: 10, goalImpact: 0.7,
      },
      {
        key: 'gym', decisionGroup: 'exercise-choice', kind: 'workout', required: true,
        fixedStartSecond: 17 * 3600, durationMinutes: 60,
        progressCategory: 'exercise', progressWeightHint: 25, goalImpact: 0.95, effortCost: 0.8,
      },
      {
        key: 'walk', decisionGroup: 'exercise-choice', kind: 'movement', required: true,
        fixedStartSecond: 17 * 3600, durationMinutes: 30,
        progressCategory: 'movement', progressWeightHint: 15, goalImpact: 0.65, effortCost: 0.2,
      },
      {
        key: 'dinner', decisionGroup: 'dinner', kind: 'meal', required: true,
        fixedStartSecond: 19 * 3600, durationMinutes: 30,
        progressCategory: 'nutrition', progressWeightHint: 10, goalImpact: 0.7,
      },
      {
        key: 'busy-conflict', decisionGroup: 'optional-task', kind: 'task', required: false,
        fixedStartSecond: 14 * 3600, durationMinutes: 30,
        progressCategory: 'habits', progressWeightHint: 5,
      },
    ],
    alternativeCount: 2,
  });

  assert.equal(result.chosenPath.intervals[0].startSecond, 0);
  assert.equal(result.chosenPath.intervals.at(-1).endSecond, 86_400);
  assert.ok(!result.chosenPath.selectedCandidateKeys.includes('busy-conflict'));
  assert.ok(result.alternativeBranches.length >= 1);
  assert.ok(result.alternativeBranches.every((branch) => branch.originIntervalID));
  assert.equal(result.predictionMode, 'cold-start');
});

test('future rerouting preserves history and optimizes only the remaining day', () => {
  const currentPrimaryPath = compileContinuousDay({
    idSeed: 'reroute-current',
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 7 * 3600, endSecond: 7.5 * 3600, progressWeightHint: 10 },
      { key: 'lunch', kind: 'meal', startSecond: 12 * 3600, endSecond: 12.5 * 3600, progressWeightHint: 10 },
      { key: 'old-gym', kind: 'workout', startSecond: 17 * 3600, endSecond: 18 * 3600, progressWeightHint: 20 },
      { key: 'dinner', kind: 'meal', startSecond: 19 * 3600, endSecond: 19.5 * 3600, progressWeightHint: 10 },
    ],
  });
  currentPrimaryPath.intervals = allocateDailyBudget(currentPrimaryPath.intervals);
  const decisionSecond = 14 * 3600 + 37 * 60 + 22;
  const result = optimizeFutureRoutes({
    currentPrimaryPath,
    decisionSecond,
    context: { idSeed: 'reroute-next', wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    candidates: [
      {
        key: 'walk', decisionGroup: 'exercise', kind: 'movement', required: true,
        fixedStartSecond: 17 * 3600, durationMinutes: 30,
        progressCategory: 'movement', progressWeightHint: 12,
      },
      {
        key: 'home-workout', decisionGroup: 'exercise', kind: 'workout', required: true,
        fixedStartSecond: 17 * 3600, durationMinutes: 40,
        progressCategory: 'exercise', progressWeightHint: 18,
      },
      {
        key: 'dinner', decisionGroup: 'dinner', kind: 'meal', required: true,
        fixedStartSecond: 19 * 3600, durationMinutes: 30,
        progressCategory: 'nutrition', progressWeightHint: 10,
      },
    ],
    alternativeCount: 1,
  });

  assert.equal(result.completedPath.intervals[0].startSecond, 0);
  assert.equal(result.completedPath.intervals.at(-1).endSecond, decisionSecond);
  assert.equal(result.chosenPath.intervals[0].startSecond, decisionSecond);
  assert.equal(result.chosenPath.intervals.at(-1).endSecond, 86_400);
  assert.equal(result.chosenPath.intervals[0].plannedProgressStart, result.lockedPotentialPoints);
  assert.equal(result.chosenPath.intervals.at(-1).plannedProgressEnd, 100);
  assert.equal(result.lockedPotentialPoints + result.remainingPotentialPoints, 100);
  assert.equal(
    result.completedPath.intervals.reduce((total, interval) => total + interval.potentialPoints, 0)
      + result.chosenPath.intervals.reduce((total, interval) => total + interval.potentialPoints, 0),
    100,
  );
  assert.equal(
    validateDayGraph({
      completedPath: result.completedPath,
      chosenPath: result.chosenPath,
      alternativePaths: result.alternativeBranches,
    }),
    true,
  );
  assert.ok(result.chosenPath.selectedCandidateKeys.every((key) => key !== 'old-gym'));
});

test('future rerouting rejects a fixed candidate in elapsed time', () => {
  const currentPrimaryPath = compileContinuousDay({ scheduledIntervals: [] });
  currentPrimaryPath.intervals = allocateDailyBudget(currentPrimaryPath.intervals);
  assert.throws(() => optimizeFutureRoutes({
    currentPrimaryPath,
    decisionSecond: 12 * 3600,
    candidates: [{
      key: 'past', kind: 'task', required: true,
      fixedStartSecond: 11 * 3600, durationMinutes: 15,
    }],
  }), /before the reroute boundary/i);
});

test('meal alternatives carry the meal decision only while primary fasting state is recomputed from the selected meal time', () => {
  const result = optimizeDayRoutes({
    context: {
      idSeed: 'meal-decision-state-routing',
      wakeSecond: 7 * 3600,
      sleepSecond: 23 * 3600,
      populationPriors: { meal: 0.9 },
    },
    candidates: [
      {
        key: 'breakfast-8', decisionGroup: 'breakfast-time', kind: 'meal', required: true,
        fixedStartSecond: 8 * 3600, durationMinutes: 30,
        progressCategory: 'nutrition', progressWeightHint: 10, goalImpact: 0.8,
      },
      {
        key: 'breakfast-9', decisionGroup: 'breakfast-time', kind: 'meal', required: true,
        fixedStartSecond: 9 * 3600, durationMinutes: 30,
        progressCategory: 'nutrition', progressWeightHint: 10, goalImpact: 0.79,
      },
      {
        key: 'lunch', decisionGroup: 'lunch', kind: 'meal', required: true,
        fixedStartSecond: 13 * 3600, durationMinutes: 30,
        progressCategory: 'nutrition', progressWeightHint: 10, goalImpact: 0.8,
      },
    ],
    alternativeCount: 1,
  });

  assert.ok(result.chosenPath.systemStateIntervals.length > 0);
  assert.ok(result.alternativeBranches.length >= 1);
  assert.ok(result.alternativeBranches.every((branch) => branch.systemStateIntervals.length === 0));
  assert.ok(result.alternativeBranches.every((branch) => (
    branch.intervals.every((interval) => !['sleep', 'fasting'].includes(interval.intervalKind))
  )));

  const chosenBreakfast = result.chosenPath.intervals.find((interval) => interval.intervalKind === 'meal');
  const firstPostMealFasting = result.chosenPath.systemStateIntervals.find((interval) => (
    interval.intervalKind === 'fasting'
    && interval.startSecond >= chosenBreakfast.endSecond
  ));
  assert.equal(firstPostMealFasting.metadata.hourNumber, 1);
  assert.equal(firstPostMealFasting.metadata.cycleStartSecond, chosenBreakfast.endSecond);
});

test('future-only rerouting splits primary system-state nodes at the immutable decision boundary', () => {
  const currentPrimaryPath = optimizeDayRoutes({
    context: { idSeed: 'state-boundary-before', wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    candidates: [
      { key: 'breakfast', decisionGroup: 'breakfast', kind: 'meal', required: true, fixedStartSecond: 8 * 3600, durationMinutes: 30 },
      { key: 'dinner', decisionGroup: 'dinner', kind: 'meal', required: true, fixedStartSecond: 19 * 3600, durationMinutes: 30 },
    ],
    alternativeCount: 0,
  }).chosenPath;
  const decisionSecond = 10 * 3600 + 20 * 60;
  const result = optimizeFutureRoutes({
    currentPrimaryPath,
    decisionSecond,
    context: { idSeed: 'state-boundary-after', wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    candidates: [
      { key: 'lunch', decisionGroup: 'lunch', kind: 'meal', required: true, fixedStartSecond: 13 * 3600, durationMinutes: 30 },
      { key: 'dinner', decisionGroup: 'dinner', kind: 'meal', required: true, fixedStartSecond: 19 * 3600, durationMinutes: 30 },
    ],
    alternativeCount: 0,
  });

  assert.ok(result.completedPath.systemStateIntervals.length > 0);
  assert.ok(result.chosenPath.systemStateIntervals.length > 0);
  assert.ok(result.completedPath.systemStateIntervals.every((interval) => interval.endSecond <= decisionSecond));
  assert.ok(result.chosenPath.systemStateIntervals.every((interval) => interval.startSecond >= decisionSecond));
  assert.ok(result.completedPath.systemStateIntervals.every((interval) => interval.metadata?.routeMembership === 'completed'));
  assert.ok(result.completedPath.systemStateIntervals.every((interval) => interval.lifecycleStatus === 'completed'));
  assert.ok(result.chosenPath.systemStateIntervals.every((interval) => interval.metadata?.routeMembership === 'chosen'));
  assert.ok(result.chosenPath.systemStateIntervals.every((interval) => ['active', 'planned'].includes(interval.lifecycleStatus)));
});
