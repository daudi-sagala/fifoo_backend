import test from 'node:test';
import assert from 'node:assert/strict';

import { nodeKind } from '../src/lib/nodeCodec.js';
import { buildInitialRouteState } from '../src/services/routeBuilder.js';
import {
  buildStandardWeightLossDay,
} from '../src/services/dailyPathGenerator.js';
import {
  gridRoadConstants,
  makeGridRoadGraph,
} from '../src/services/gridRoadGraph.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';

test('backend grid mirrors the current deterministic iOS grid dimensions', () => {
  const graph = makeGridRoadGraph();
  assert.equal(graph.id.rawValue, 'fifoo.cartesian.grid.v1');
  assert.equal(graph.version, 4);
  assert.equal(gridRoadConstants.progressPerPitch, 12.5);
  assert.equal(gridRoadConstants.hoursPerPitch, 1.5);
  assert.equal(graph.vertices.length, 17 * 33);
  assert.equal(graph.edges.length, (17 * 32) + (33 * 16));
});

test('standard weight-loss day produces deterministic Activity nodes in chronological order', () => {
  const a = buildStandardWeightLossDay({ userID, mapDate: '2026-08-29' });
  const b = buildStandardWeightLossDay({ userID, mapDate: '2026-08-29' });
  const nextDay = buildStandardWeightLossDay({ userID, mapDate: '2026-08-30' });

  assert.equal(a.nodes.length, 8);
  assert.deepEqual(
    a.nodes.map((entry) => entry.nodeID),
    b.nodes.map((entry) => entry.nodeID),
  );
  assert.notDeepEqual(
    a.nodes.map((entry) => entry.nodeID),
    nextDay.nodes.map((entry) => entry.nodeID),
  );

  const seconds = a.nodes.map((entry) => entry.node.time.secondsFromMidnight);
  assert.deepEqual(seconds, [...seconds].sort((x, y) => x - y));
  assert.deepEqual(
    a.nodes.map((entry) => nodeKind(entry.node)),
    ['activityTask', 'activityMeal', 'activityWorkout', 'activityMeal', 'activityTask', 'activityWorkout', 'activityMeal', 'activityTask'],
  );
});

test('standard generated stops build a complete backend-authoritative route with alternatives', () => {
  const plan = buildStandardWeightLossDay({ userID, mapDate: '2026-08-29' });
  const routeState = buildInitialRouteState({
    roadGraph: makeGridRoadGraph(),
    nodeAnchors: plan.nodes.map((entry) => entry.anchor),
    currentDayTime: { secondsFromMidnight: 0 },
    maxAlternatives: 3,
  });

  assert.equal(routeState.chosenFutureRoute.stopNodeIDs.length, 8);
  assert.equal(routeState.chosenFutureRoute.legs.length, 7);
  assert.ok(routeState.chosenFutureRoute.legs.every((leg) => leg.path.segments.length > 0));
  assert.ok(routeState.alternativeRoutes.length >= 1);
});

test('generated routing anchors preserve node coordinates while using nearest vertical streets internally', () => {
  const plan = buildStandardWeightLossDay({ userID, mapDate: '2026-08-29' });
  const breakfast = plan.nodes.find((entry) => entry.key === 'breakfast');
  assert.equal(breakfast.node.placement.coordinate._0.progress.percent, 12);
  assert.equal(breakfast.anchor.coordinate.progress.percent, 12);
  assert.equal(breakfast.anchor.roadLocation.edge.edgeID.rawValue, 'street.v.c01.r05-06');
});

test('standard generation also produces a continuous 100-point Day Graph', () => {
  const plan = buildStandardWeightLossDay({ userID, mapDate: '2026-08-29' });
  const intervals = plan.dayGraph.chosenPath.intervals;
  assert.equal(intervals[0].startSecond, 0);
  assert.equal(intervals.at(-1).endSecond, 86_400);
  assert.equal(
    intervals.reduce((duration, interval) => duration + interval.endSecond - interval.startSecond, 0),
    86_400,
  );
  assert.ok(Math.abs(
    intervals.reduce((points, interval) => points + interval.potentialPoints, 0) - 100,
  ) < 0.000001);
  assert.ok(intervals.some((interval) => interval.intervalKind === 'fasting'));
});
