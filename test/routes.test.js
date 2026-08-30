import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialRouteState } from '../src/services/routeBuilder.js';
import { rebuildRouteWithAttachedNode } from '../src/services/routes.js';

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
  id: id('route-service-test'), version: 1,
  vertices: [vertex('v1', 3600, 0), vertex('v2', 7200, 0), vertex('v3', 10800, 0)],
  edges: [edge('e12', 'v1', 'v2'), edge('e23', 'v2', 'v3')],
};

const n1 = '11111111-1111-4111-8111-111111111111';
const n2 = '22222222-2222-4222-8222-222222222222';
const n3 = '33333333-3333-4333-8333-333333333333';

function fakeClient(previousRouteState) {
  const writes = [];
  return {
    writes,
    async query(sql, args) {
      if (sql.includes('SELECT route_data FROM day_map_routes')) {
        return { rows: previousRouteState ? [{ route_data: previousRouteState }] : [] };
      }
      if (sql.includes('INSERT INTO day_map_routes')) {
        writes.push(JSON.parse(args[1]));
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in route service test: ${sql}`);
    },
  };
}

test('route service re-anchors an unreachable client anchor and persists the attached stop', async () => {
  const existingAnchors = [anchor(n1, 'v1', 3600, 0), anchor(n2, 'v3', 10800, 0)];
  const state = buildInitialRouteState({
    roadGraph: graph,
    nodeAnchors: existingAnchors,
    currentDayTime: { secondsFromMidnight: 0 },
  });
  const client = fakeClient(state);

  const impossibleAttachedAnchor = anchor(n3, 'missing-vertex', 7200, 0);
  const result = await rebuildRouteWithAttachedNode(client, {
    dayMap: { day_map_id: 'day-map-test' },
    payload: {
      node: { id: id(n3) },
      roadGraph: graph,
      nodeAnchors: existingAnchors,
      attachedNodeAnchor: impossibleAttachedAnchor,
      currentDayTime: { secondsFromMidnight: 0 },
      completedRoute: state.completedRoute,
      maxAlternatives: 3,
    },
  });

  assert.equal(result.routeAttachmentError, undefined);
  assert.deepEqual(
    result.routeState.chosenFutureRoute.stopNodeIDs.map((value) => value.rawValue),
    [n1, n3, n2],
  );
  assert.equal(client.writes.length, 1);
});

test('route attachment still preserves the node transaction when no road insertion is possible', async () => {
  const existingAnchors = [anchor(n1, 'v1', 3600, 0), anchor(n2, 'v3', 10800, 0)];
  const state = buildInitialRouteState({
    roadGraph: graph,
    nodeAnchors: existingAnchors,
    currentDayTime: { secondsFromMidnight: 0 },
  });
  const client = fakeClient(state);
  const blockedGraph = {
    ...graph,
    edges: graph.edges.map((item) => ({
      ...item,
      travelDirection: 'closed',
      attributes: { ...item.attributes, isTraversable: false },
    })),
  };

  const result = await rebuildRouteWithAttachedNode(client, {
    dayMap: { day_map_id: 'day-map-test' },
    payload: {
      node: { id: id(n3) },
      roadGraph: blockedGraph,
      nodeAnchors: existingAnchors,
      attachedNodeAnchor: anchor(n3, 'v2', 7200, 0),
      currentDayTime: { secondsFromMidnight: 0 },
      completedRoute: state.completedRoute,
      maxAlternatives: 3,
    },
  });

  assert.deepEqual(result.routeState, state);
  assert.match(result.routeAttachmentError, /Stop was saved/);
  assert.equal(client.writes.length, 0);
});

