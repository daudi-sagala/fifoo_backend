import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInitialRouteState,
  rebuildRouteStateWithAttachedNode,
  resolveAttachableNodeAnchor,
  selectAlternativeRouteState,
} from '../src/services/routeBuilder.js';

const id = (rawValue) => ({ rawValue });
const vertexLocation = (rawValue) => ({ vertex: { _0: id(rawValue) } });
const anchor = (nodeUUID, vertexID, seconds, progress) => ({
  nodeID: id(nodeUUID),
  coordinate: { time: { secondsFromMidnight: seconds }, progress: { percent: progress } },
  roadLocation: vertexLocation(vertexID),
});
const vertex = (rawValue, seconds, progress) => ({
  id: id(rawValue),
  coordinate: { time: { secondsFromMidnight: seconds }, progress: { percent: progress } },
  kind: 'intersection',
});
const edge = (rawValue, from, to) => ({
  id: id(rawValue), fromID: id(from), toID: id(to), roadClass: 'local', travelDirection: 'bidirectional',
  shape: { straight: {} },
  attributes: { isTraversable: true, isGradeSeparated: false, routingCostMultiplier: 1, tags: [] },
});

const graph = {
  id: id('fifoo-grid-road-graph'),
  version: 1,
  vertices: [
    vertex('v1', 3600, 0),
    vertex('v2', 7200, 0),
    vertex('v3', 7200, 10),
    vertex('v4', 10800, 5),
  ],
  edges: [
    edge('e12', 'v1', 'v2'), edge('e24', 'v2', 'v4'),
    edge('e13', 'v1', 'v3'), edge('e34', 'v3', 'v4'),
  ],
};

const n1 = '11111111-1111-4111-8111-111111111111';
const n2 = '22222222-2222-4222-8222-222222222222';
const n3 = '33333333-3333-4333-8333-333333333333';
const anchors = [anchor(n1, 'v1', 3600, 0), anchor(n2, 'v4', 10800, 5)];

test('backend builds chosen and alternative path geometry', () => {
  const state = buildInitialRouteState({
    roadGraph: graph,
    nodeAnchors: anchors,
    currentDayTime: { secondsFromMidnight: 0 },
    maxAlternatives: 3,
  });
  assert.deepEqual(state.chosenFutureRoute.stopNodeIDs.map((x) => x.rawValue), [n1, n2]);
  assert.equal(state.chosenFutureRoute.legs.length, 1);
  assert.ok(state.chosenFutureRoute.legs[0].path.segments.length >= 2);
  assert.ok(state.alternativeRoutes.length >= 1);
  assert.notDeepEqual(
    state.alternativeRoutes[0].legs[0].path.segments.map((s) => s.edgeID.rawValue),
    state.chosenFutureRoute.legs[0].path.segments.map((s) => s.edgeID.rawValue),
  );
});

test('backend swaps only a selected server-generated alternative', () => {
  const state = buildInitialRouteState({ roadGraph: graph, nodeAnchors: anchors, currentDayTime: { secondsFromMidnight: 0 } });
  const alternativeID = state.alternativeRoutes[0].id;
  const selected = selectAlternativeRouteState({
    previousRouteState: state,
    selectedRouteID: alternativeID,
    completedRoute: state.completedRoute,
    currentDayTime: { secondsFromMidnight: 1800 },
  });
  assert.equal(selected.chosenFutureRoute.id.rawValue, alternativeID.rawValue);
  assert.ok(selected.alternativeRoutes.some((route) => route.id.rawValue === state.chosenFutureRoute.id.rawValue));
});

test('backend rebuilds existing path when a new future node is attached', () => {
  const state = buildInitialRouteState({ roadGraph: graph, nodeAnchors: anchors, currentDayTime: { secondsFromMidnight: 0 } });
  const withMiddle = [...anchors, anchor(n3, 'v2', 7200, 0)];
  const rebuilt = rebuildRouteStateWithAttachedNode({
    roadGraph: graph,
    nodeAnchors: withMiddle,
    currentDayTime: { secondsFromMidnight: 0 },
    previousRouteState: state,
    completedRoute: state.completedRoute,
    attachedNodeID: id(n3),
    maxAlternatives: 3,
  });
  assert.deepEqual(rebuilt.chosenFutureRoute.stopNodeIDs.map((x) => x.rawValue), [n1, n3, n2]);
  assert.equal(rebuilt.chosenFutureRoute.legs.length, 2);
});

test('explicit attached anchor is merged even when the general anchor list is stale', () => {
  const state = buildInitialRouteState({
    roadGraph: graph,
    nodeAnchors: anchors,
    currentDayTime: { secondsFromMidnight: 0 },
  });

  const explicit = anchor(n3, 'v2', 7200, 0);
  const rebuilt = rebuildRouteStateWithAttachedNode({
    roadGraph: graph,
    nodeAnchors: anchors,
    attachedNodeAnchor: explicit,
    currentDayTime: { secondsFromMidnight: 0 },
    previousRouteState: state,
    completedRoute: state.completedRoute,
    attachedNodeID: id(n3),
    maxAlternatives: 3,
  });

  assert.deepEqual(
    rebuilt.chosenFutureRoute.stopNodeIDs.map((x) => x.rawValue),
    [n1, n3, n2],
  );
});


test('backend re-anchors an attached stop when the client nearest-road anchor is unreachable', () => {
  const reanchorGraph = {
    id: id('reanchor-graph'),
    version: 1,
    vertices: [
      vertex('a', 3600, 0),
      vertex('b', 7200, 0),
      vertex('c', 10800, 0),
      vertex('isolated', 7200, 90),
    ],
    edges: [
      edge('ab', 'a', 'b'),
      edge('bc', 'b', 'c'),
    ],
  };

  const start = anchor(n1, 'a', 3600, 0);
  const end = anchor(n2, 'c', 10800, 0);
  const state = buildInitialRouteState({
    roadGraph: reanchorGraph,
    nodeAnchors: [start, end],
    currentDayTime: { secondsFromMidnight: 0 },
  });

  const badNearestAnchor = anchor(n3, 'isolated', 7200, 0.25);
  const resolved = resolveAttachableNodeAnchor({
    roadGraph: reanchorGraph,
    nodeAnchors: [start, end],
    attachedNodeAnchor: badNearestAnchor,
    previousRouteState: state,
  });

  assert.ok(resolved);
  assert.ok(resolved.roadLocation.edge);
  assert.notEqual(resolved.roadLocation.vertex?._0?.rawValue, 'isolated');

  const rebuilt = rebuildRouteStateWithAttachedNode({
    roadGraph: reanchorGraph,
    nodeAnchors: [start, end],
    attachedNodeAnchor: badNearestAnchor,
    currentDayTime: { secondsFromMidnight: 0 },
    previousRouteState: state,
    completedRoute: state.completedRoute,
    attachedNodeID: id(n3),
    maxAlternatives: 3,
  });

  assert.deepEqual(
    rebuilt.chosenFutureRoute.stopNodeIDs.map((x) => x.rawValue),
    [n1, n3, n2],
  );
});
