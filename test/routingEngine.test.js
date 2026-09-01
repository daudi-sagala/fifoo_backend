import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blendCompletionProbability,
  optimizeDayRoutes,
} from '../src/algorithms/routingEngine.js';

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

