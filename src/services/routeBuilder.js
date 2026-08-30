import { randomUUID } from 'node:crypto';
import { GameError } from '../lib/errors.js';

const EPSILON = 0.000001;

function rawID(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.rawValue === 'string') return value.rawValue;
  return null;
}

function wrappedID(rawValue) {
  return { rawValue };
}

function nodeID(anchor) {
  return rawID(anchor?.nodeID);
}

function seconds(anchor) {
  const value = Number(anchor?.coordinate?.time?.secondsFromMidnight ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function vertexTime(vertex) {
  const value = Number(vertex?.coordinate?.time?.secondsFromMidnight ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function progress(vertex) {
  const value = Number(vertex?.coordinate?.progress?.percent ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function edgeLength(edge, vertices) {
  const from = vertices.get(rawID(edge.fromID));
  const to = vertices.get(rawID(edge.toID));
  if (!from || !to) return 1;
  const dx = progress(to) - progress(from);
  const dy = ((vertexTime(to) - vertexTime(from)) / 3600) / 0.12;
  return Math.max(Math.hypot(dx, dy), EPSILON);
}

function edgeMultiplier(edge, penalties) {
  const base = Number(edge?.attributes?.routingCostMultiplier ?? 1);
  const penalty = Number(penalties.get(rawID(edge.id)) ?? 1);
  return Math.max(Number.isFinite(base) ? base : 1, EPSILON) * Math.max(Number.isFinite(penalty) ? penalty : 1, EPSILON);
}

function edgeAllows(edge, fromVertexID, toVertexID) {
  if (edge?.attributes?.isTraversable === false || edge?.travelDirection === 'closed') return false;
  const from = rawID(edge.fromID);
  const to = rawID(edge.toID);
  const direction = edge.travelDirection ?? 'bidirectional';
  if (fromVertexID === from && toVertexID === to) return direction === 'bidirectional' || direction === 'fromTo';
  if (fromVertexID === to && toVertexID === from) return direction === 'bidirectional' || direction === 'toFrom';
  return false;
}

function graphLookup(graph, penalties = new Map()) {
  if (!graph || typeof graph !== 'object') throw new GameError('invalid_payload', 'payload.roadGraph is required.');
  const vertices = new Map((graph.vertices ?? []).map((v) => [rawID(v.id), v]).filter(([id]) => id));
  const edges = new Map((graph.edges ?? []).map((e) => [rawID(e.id), e]).filter(([id]) => id));
  const adjacency = new Map();
  for (const id of vertices.keys()) adjacency.set(id, []);

  for (const edge of edges.values()) {
    const a = rawID(edge.fromID);
    const b = rawID(edge.toID);
    if (!a || !b || !vertices.has(a) || !vertices.has(b)) continue;
    const cost = edgeLength(edge, vertices) * edgeMultiplier(edge, penalties);
    const va = vertices.get(a);
    const vb = vertices.get(b);

    if (edgeAllows(edge, a, b) && vertexTime(vb) + EPSILON >= vertexTime(va)) {
      adjacency.get(a).push({ to: b, edge, fromFraction: 0, toFraction: 1, cost });
    }
    if (edgeAllows(edge, b, a) && vertexTime(va) + EPSILON >= vertexTime(vb)) {
      adjacency.get(b).push({ to: a, edge, fromFraction: 1, toFraction: 0, cost });
    }
  }

  return { vertices, edges, adjacency, penalties };
}

function parseRoadLocation(location) {
  const vertex = location?.vertex?._0;
  if (vertex) return { type: 'vertex', vertexID: rawID(vertex), original: location };
  const edge = location?.edge;
  if (edge) {
    const edgeID = rawID(edge.edgeID);
    const fraction = Math.max(0, Math.min(1, Number(edge.fraction ?? 0)));
    if (edgeID) return { type: 'edge', edgeID, fraction, original: location };
  }
  return null;
}

function segment(edgeID, fromFraction, toFraction) {
  return { edgeID: wrappedID(edgeID), fromFraction, toFraction };
}

function canTraversePartial(edge, fromFraction, toFraction) {
  const from = rawID(edge.fromID);
  const to = rawID(edge.toID);
  if (Math.abs(toFraction - fromFraction) <= EPSILON) return true;
  if (toFraction > fromFraction) return edgeAllows(edge, from, to);
  return edgeAllows(edge, to, from);
}

function partialCost(edge, fromFraction, toFraction, lookup) {
  return edgeLength(edge, lookup.vertices) * edgeMultiplier(edge, lookup.penalties) * Math.abs(toFraction - fromFraction);
}

function endpointCandidates(anchor, lookup, isStart) {
  const location = parseRoadLocation(anchor.roadLocation);
  if (!location) return [];
  if (location.type === 'vertex') {
    return lookup.vertices.has(location.vertexID)
      ? [{ vertexID: location.vertexID, segments: [], cost: 0 }]
      : [];
  }

  const edge = lookup.edges.get(location.edgeID);
  if (!edge) return [];
  const fromID = rawID(edge.fromID);
  const toID = rawID(edge.toID);
  const anchorTime = seconds(anchor);
  const candidates = [];

  if (isStart) {
    for (const candidate of [
      { vertexID: toID, fromFraction: location.fraction, toFraction: 1 },
      { vertexID: fromID, fromFraction: location.fraction, toFraction: 0 },
    ]) {
      const vertex = lookup.vertices.get(candidate.vertexID);
      if (!vertex || vertexTime(vertex) + EPSILON < anchorTime) continue;
      if (!canTraversePartial(edge, candidate.fromFraction, candidate.toFraction)) continue;
      candidates.push({
        vertexID: candidate.vertexID,
        segments: Math.abs(candidate.toFraction - candidate.fromFraction) <= EPSILON ? [] : [segment(location.edgeID, candidate.fromFraction, candidate.toFraction)],
        cost: partialCost(edge, candidate.fromFraction, candidate.toFraction, lookup),
      });
    }
  } else {
    for (const candidate of [
      { vertexID: fromID, fromFraction: 0, toFraction: location.fraction },
      { vertexID: toID, fromFraction: 1, toFraction: location.fraction },
    ]) {
      const vertex = lookup.vertices.get(candidate.vertexID);
      if (!vertex || anchorTime + EPSILON < vertexTime(vertex)) continue;
      if (!canTraversePartial(edge, candidate.fromFraction, candidate.toFraction)) continue;
      candidates.push({
        vertexID: candidate.vertexID,
        segments: Math.abs(candidate.toFraction - candidate.fromFraction) <= EPSILON ? [] : [segment(location.edgeID, candidate.fromFraction, candidate.toFraction)],
        cost: partialCost(edge, candidate.fromFraction, candidate.toFraction, lookup),
      });
    }
  }

  return candidates;
}

function directSameEdge(start, end, lookup) {
  const a = parseRoadLocation(start.roadLocation);
  const b = parseRoadLocation(end.roadLocation);
  if (!a || !b || a.type !== 'edge' || b.type !== 'edge' || a.edgeID !== b.edgeID) return null;
  if (seconds(end) + EPSILON < seconds(start)) return null;
  const edge = lookup.edges.get(a.edgeID);
  if (!edge || !canTraversePartial(edge, a.fraction, b.fraction)) return null;
  return {
    startLocation: start.roadLocation,
    endLocation: end.roadLocation,
    vertexIDs: [],
    segments: Math.abs(a.fraction - b.fraction) <= EPSILON ? [] : [segment(a.edgeID, a.fraction, b.fraction)],
    totalCost: partialCost(edge, a.fraction, b.fraction, lookup),
  };
}

function shortestVertexPath(startID, endID, lookup) {
  if (startID === endID) return { vertexIDs: [wrappedID(startID)], segments: [], cost: 0 };
  const dist = new Map([[startID, 0]]);
  const previous = new Map();
  const queue = [{ id: startID, cost: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (current.cost > (dist.get(current.id) ?? Infinity) + EPSILON) continue;
    if (current.id === endID) break;
    for (const connection of lookup.adjacency.get(current.id) ?? []) {
      const nextCost = current.cost + connection.cost;
      if (nextCost + EPSILON >= (dist.get(connection.to) ?? Infinity)) continue;
      dist.set(connection.to, nextCost);
      previous.set(connection.to, { from: current.id, connection });
      queue.push({ id: connection.to, cost: nextCost });
    }
  }

  if (!dist.has(endID)) return null;
  const ids = [endID];
  const segments = [];
  let cursor = endID;
  while (cursor !== startID) {
    const step = previous.get(cursor);
    if (!step) return null;
    segments.push(segment(rawID(step.connection.edge.id), step.connection.fromFraction, step.connection.toFraction));
    cursor = step.from;
    ids.push(cursor);
  }
  ids.reverse();
  segments.reverse();
  return { vertexIDs: ids.map(wrappedID), segments, cost: dist.get(endID) };
}

function findPath(start, end, graph, penalties = new Map()) {
  if (seconds(end) + EPSILON < seconds(start)) return null;
  const lookup = graphLookup(graph, penalties);
  let best = directSameEdge(start, end, lookup);
  let bestCost = best?.totalCost ?? Infinity;

  const starts = endpointCandidates(start, lookup, true);
  const ends = endpointCandidates(end, lookup, false);
  for (const s of starts) {
    for (const e of ends) {
      const middle = shortestVertexPath(s.vertexID, e.vertexID, lookup);
      if (!middle) continue;
      const totalCost = s.cost + middle.cost + e.cost;
      if (totalCost + EPSILON >= bestCost) continue;
      bestCost = totalCost;
      best = {
        startLocation: start.roadLocation,
        endLocation: end.roadLocation,
        vertexIDs: middle.vertexIDs,
        segments: [...s.segments, ...middle.segments, ...e.segments],
        totalCost,
      };
    }
  }
  return best;
}

function makeRoute(anchors, graph, { penalties = new Map(), entryAnchor = null } = {}) {
  const route = {
    id: wrappedID(randomUUID()),
    stopNodeIDs: anchors.map((a) => a.nodeID),
    entryLeg: null,
    legs: [],
  };
  if (!anchors.length) return route;

  if (entryAnchor) {
    const path = findPath(entryAnchor, anchors[0], graph, penalties);
    if (!path) throw new GameError('validation_failed', 'Backend could not connect the current path boundary to the first future stop.');
    route.entryLeg = {
      startAnchor: { coordinate: entryAnchor.coordinate, roadLocation: entryAnchor.roadLocation },
      toNodeID: anchors[0].nodeID,
      path,
    };
  }

  for (let i = 0; i + 1 < anchors.length; i += 1) {
    const from = anchors[i];
    const to = anchors[i + 1];
    const path = findPath(from, to, graph, penalties);
    if (!path) {
      throw new GameError('validation_failed', `Backend could not build a forward road path between stops ${i + 1} and ${i + 2}.`);
    }
    route.legs.push({ fromNodeID: from.nodeID, toNodeID: to.nodeID, path });
  }
  return route;
}

function routeSegments(route) {
  const result = [];
  if (route?.entryLeg?.path?.segments) result.push(...route.entryLeg.path.segments);
  for (const leg of route?.legs ?? []) if (leg?.path?.segments) result.push(...leg.path.segments);
  return result;
}

function routeCost(route) {
  let total = Number(route?.entryLeg?.path?.totalCost ?? 0);
  for (const leg of route?.legs ?? []) total += Number(leg?.path?.totalCost ?? 0);
  return total;
}

function signature(route) {
  return routeSegments(route).map((s) => `${rawID(s.edgeID)}:${Number(s.fromFraction).toFixed(6)}>${Number(s.toFraction).toFixed(6)}`).join('|');
}

function uniquePrimaryEdges(route) {
  const seen = new Set();
  const result = [];
  for (const s of routeSegments(route)) {
    const id = rawID(s.edgeID);
    if (id && !seen.has(id)) { seen.add(id); result.push(id); }
  }
  return result;
}

function generateAlternatives(anchors, graph, primary, { entryAnchor = null, maxAlternatives = 3 } = {}) {
  if (anchors.length < 2 || maxAlternatives <= 0) return [];
  const primarySignature = signature(primary);
  const candidates = [];
  const seen = new Set([primarySignature]);
  const edges = uniquePrimaryEdges(primary);

  const penaltySets = [];
  for (const edgeID of edges) penaltySets.push(new Map([[edgeID, 12]]));
  for (let i = 0; i + 1 < edges.length && penaltySets.length < 12; i += 1) {
    penaltySets.push(new Map([[edges[i], 10], [edges[i + 1], 10]]));
  }

  for (const penalties of penaltySets) {
    try {
      const route = makeRoute(anchors, graph, { penalties, entryAnchor });
      const sig = signature(route);
      if (!sig || seen.has(sig)) continue;
      seen.add(sig);
      candidates.push(route);
    } catch {
      // A penalty can intentionally make a candidate unreachable.
    }
  }

  candidates.sort((a, b) => routeCost(a) - routeCost(b));
  return candidates.slice(0, maxAlternatives);
}


function coordinateMetric(coordinate) {
  const secondsValue = Number(coordinate?.time?.secondsFromMidnight ?? 0);
  const progressValue = Number(coordinate?.progress?.percent ?? 0);
  return {
    x: Number.isFinite(progressValue) ? progressValue : 0,
    y: ((Number.isFinite(secondsValue) ? secondsValue : 0) / 3600) / 0.12,
  };
}

function edgeProjectionCandidate(anchor, edge, lookup, preferredEdgeIDs = new Set()) {
  if (!anchor?.coordinate) return null;
  const edgeID = rawID(edge?.id);
  const fromID = rawID(edge?.fromID);
  const toID = rawID(edge?.toID);
  const from = lookup.vertices.get(fromID);
  const to = lookup.vertices.get(toID);
  if (!edgeID || !from || !to) return null;
  if (edge?.attributes?.isTraversable === false || edge?.travelDirection === 'closed') return null;

  const point = coordinateMetric(anchor.coordinate);
  const a = coordinateMetric(from.coordinate);
  const b = coordinateMetric(to.coordinate);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = (dx * dx) + (dy * dy);
  const fraction = denominator <= EPSILON
    ? 0
    : Math.max(0, Math.min(1, (((point.x - a.x) * dx) + ((point.y - a.y) * dy)) / denominator));
  const projectedX = a.x + (dx * fraction);
  const projectedY = a.y + (dy * fraction);
  const distance = Math.hypot(point.x - projectedX, point.y - projectedY);
  const projectedSeconds = vertexTime(from) + ((vertexTime(to) - vertexTime(from)) * fraction);
  const timeDelta = Math.abs(seconds(anchor) - projectedSeconds);

  // Prefer geometry already used by the chosen route, then spatial proximity,
  // then time proximity. The node itself is not moved; this is an internal
  // routing anchor only.
  const preferredPenalty = preferredEdgeIDs.has(edgeID) ? 0 : 25;
  const score = preferredPenalty + distance + ((timeDelta / 3600) * 2);

  return {
    anchor: {
      ...anchor,
      roadLocation: {
        edge: {
          edgeID: wrappedID(edgeID),
          fraction,
        },
      },
    },
    score,
    edgeID,
    fraction,
    distance,
    timeDelta,
  };
}

function routeEdgeIDs(route) {
  const ids = new Set();
  for (const item of routeSegments(route)) {
    const id = rawID(item?.edgeID);
    if (id) ids.add(id);
  }
  return ids;
}

function insertionNeighbors(previousRouteState, anchorByID, attachedAnchor) {
  const attachedTime = seconds(attachedAnchor);
  const stops = (previousRouteState?.chosenFutureRoute?.stopNodeIDs ?? [])
    .map(rawID)
    .filter(Boolean)
    .map((id) => anchorByID.get(id))
    .filter(Boolean);

  let insertionIndex = stops.findIndex((anchor) => seconds(anchor) > attachedTime + EPSILON);
  if (insertionIndex < 0) insertionIndex = stops.length;

  const previous = insertionIndex > 0
    ? stops[insertionIndex - 1]
    : previousRouteState?.chosenFutureRoute?.entryLeg?.startAnchor ?? null;
  const next = insertionIndex < stops.length ? stops[insertionIndex] : null;

  return { previous, next, insertionIndex };
}

function candidateFitsInsertion(candidate, neighbors, graph) {
  if (!candidate) return false;
  if (neighbors.previous && !findPath(neighbors.previous, candidate, graph)) return false;
  if (neighbors.next && !findPath(candidate, neighbors.next, graph)) return false;
  return true;
}

export function resolveAttachableNodeAnchor({ roadGraph, nodeAnchors, attachedNodeAnchor, previousRouteState }) {
  if (!attachedNodeAnchor) return null;

  const baseAnchors = sortedAnchors(nodeAnchors);
  const anchorByID = new Map(baseAnchors.map((anchor) => [nodeID(anchor), anchor]));
  const attachedID = nodeID(attachedNodeAnchor);
  if (attachedID) anchorByID.set(attachedID, attachedNodeAnchor);
  const neighbors = insertionNeighbors(previousRouteState, anchorByID, attachedNodeAnchor);

  // Keep the client-resolved anchor whenever it is already compatible with
  // the current route. This preserves the normal near-road behavior.
  if (candidateFitsInsertion(attachedNodeAnchor, neighbors, roadGraph)) {
    return attachedNodeAnchor;
  }

  const lookup = graphLookup(roadGraph);
  const preferredEdges = routeEdgeIDs(previousRouteState?.chosenFutureRoute);
  const candidates = [];
  for (const edge of lookup.edges.values()) {
    const projected = edgeProjectionCandidate(attachedNodeAnchor, edge, lookup, preferredEdges);
    if (projected) candidates.push(projected);
  }

  candidates.sort((a, b) => a.score - b.score || a.edgeID.localeCompare(b.edgeID));

  // Keep this bounded even on a much larger future road graph. The first
  // pass heavily favors chosen-route geometry; the remaining candidates give
  // the backend room to extend the path onto a connected neighboring road.
  for (const candidate of candidates.slice(0, 48)) {
    if (candidateFitsInsertion(candidate.anchor, neighbors, roadGraph)) {
      return candidate.anchor;
    }
  }

  return null;
}

function sortedAnchors(rawAnchors) {
  const byID = new Map();
  for (const anchor of rawAnchors ?? []) {
    const id = nodeID(anchor);
    if (!id || !parseRoadLocation(anchor?.roadLocation)) continue;
    byID.set(id, anchor);
  }
  return [...byID.values()].sort((a, b) => seconds(a) - seconds(b) || nodeID(a).localeCompare(nodeID(b)));
}

// The stop being attached is sent explicitly by current clients. Merge it
// over the general anchor collection so route attachment cannot depend on
// whether the optimistic GameStore insertion has already been reflected in a
// derived array. Older Pass 5.43 clients remain compatible because the second
// argument is optional.
export function mergeRouteNodeAnchors(rawAnchors, attachedNodeAnchor = null) {
  const result = [...(rawAnchors ?? [])];
  const attachedID = nodeID(attachedNodeAnchor);
  if (!attachedID) return result;

  const filtered = result.filter((anchor) => nodeID(anchor) !== attachedID);
  filtered.push(attachedNodeAnchor);
  return filtered;
}

function emptyCompletedRoute() {
  return { segments: [], reachedNodeIDs: [], throughTime: null, boundary: null };
}

function emptyRoute() {
  return { id: wrappedID(randomUUID()), stopNodeIDs: [], entryLeg: null, legs: [] };
}

function initialCompletedRoute(pastAnchors, graph, currentDayTime) {
  if (!pastAnchors.length) return emptyCompletedRoute();
  let segments = [];
  if (pastAnchors.length > 1) {
    try { segments = routeSegments(makeRoute(pastAnchors, graph)); } catch { segments = []; }
  }
  return {
    segments,
    reachedNodeIDs: pastAnchors.map((a) => a.nodeID),
    throughTime: currentDayTime,
    boundary: pastAnchors[pastAnchors.length - 1].roadLocation,
  };
}

function entryAnchorFromPast(pastAnchors) {
  const last = pastAnchors[pastAnchors.length - 1];
  return last ? { coordinate: last.coordinate, roadLocation: last.roadLocation } : null;
}

function buildFutureRoutes(futureAnchors, graph, entryAnchor, maxAlternatives) {
  if (!futureAnchors.length) return { chosen: emptyRoute(), alternatives: [] };
  const chosen = makeRoute(futureAnchors, graph, { entryAnchor });
  const alternatives = generateAlternatives(futureAnchors, graph, chosen, { entryAnchor, maxAlternatives });
  return { chosen, alternatives };
}

export function buildInitialRouteState({ roadGraph, nodeAnchors, currentDayTime, maxAlternatives = 3 }) {
  const anchors = sortedAnchors(nodeAnchors);
  if (!anchors.length) {
    return {
      completedRoute: emptyCompletedRoute(),
      chosenFutureRoute: emptyRoute(),
      alternativeRoutes: [],
      chosenFutureRouteActivatedAt: null,
    };
  }
  const now = Number(currentDayTime?.secondsFromMidnight ?? 0);
  const past = anchors.filter((a) => seconds(a) <= now + EPSILON);
  const future = anchors.filter((a) => seconds(a) > now + EPSILON);
  const completedRoute = initialCompletedRoute(past, roadGraph, currentDayTime);
  const { chosen, alternatives } = buildFutureRoutes(future, roadGraph, entryAnchorFromPast(past), maxAlternatives);
  return {
    completedRoute,
    chosenFutureRoute: chosen,
    alternativeRoutes: alternatives,
    chosenFutureRouteActivatedAt: future.length ? currentDayTime : null,
  };
}

export function rebuildRouteStateWithAttachedNode({ roadGraph, nodeAnchors, attachedNodeAnchor = null, currentDayTime, previousRouteState, completedRoute, attachedNodeID, maxAlternatives = 3 }) {
  const resolvedAttachedAnchor = resolveAttachableNodeAnchor({
    roadGraph,
    nodeAnchors,
    attachedNodeAnchor,
    previousRouteState,
  });

  const anchors = sortedAnchors(
    mergeRouteNodeAnchors(nodeAnchors, resolvedAttachedAnchor ?? attachedNodeAnchor),
  );
  const anchorByID = new Map(anchors.map((a) => [nodeID(a), a]));
  const attached = rawID(attachedNodeID);
  if (!attached || !anchorByID.has(attached)) {
    throw new GameError('validation_failed', 'The new node is not on or sufficiently near a routable road.');
  }

  if (attachedNodeAnchor && !resolvedAttachedAnchor) {
    throw new GameError('validation_failed', 'Backend could not find a route-compatible road anchor for the new stop.');
  }
  const now = Number(currentDayTime?.secondsFromMidnight ?? 0);
  if (seconds(anchorByID.get(attached)) <= now + EPSILON) {
    throw new GameError('validation_failed', 'Only a future stop can be attached to the current path.');
  }

  const previousStops = (previousRouteState?.chosenFutureRoute?.stopNodeIDs ?? []).map(rawID).filter(Boolean);
  const desiredIDs = previousStops.length ? [...previousStops, attached] : anchors.filter((a) => seconds(a) > now + EPSILON).map(nodeID);
  const unique = [...new Set(desiredIDs)];
  const desiredAnchors = unique.map((id) => anchorByID.get(id)).filter(Boolean).filter((a) => seconds(a) > now + EPSILON).sort((a, b) => seconds(a) - seconds(b));

  const preservedCompleted = completedRoute ?? previousRouteState?.completedRoute ?? emptyCompletedRoute();
  let entryAnchor = null;
  const reached = preservedCompleted?.reachedNodeIDs ?? [];
  if (reached.length) {
    const lastReached = anchorByID.get(rawID(reached[reached.length - 1]));
    if (lastReached) entryAnchor = { coordinate: lastReached.coordinate, roadLocation: preservedCompleted.boundary ?? lastReached.roadLocation };
  }

  const { chosen, alternatives } = buildFutureRoutes(desiredAnchors, roadGraph, entryAnchor, maxAlternatives);
  return {
    completedRoute: preservedCompleted,
    chosenFutureRoute: chosen,
    alternativeRoutes: alternatives,
    chosenFutureRouteActivatedAt: desiredAnchors.length ? currentDayTime : null,
  };
}

export function selectAlternativeRouteState({ previousRouteState, selectedRouteID, completedRoute, currentDayTime }) {
  if (!previousRouteState || typeof previousRouteState !== 'object') throw new GameError('not_found', 'No path exists for this Day Map.');
  const selected = rawID(selectedRouteID);
  const chosen = previousRouteState.chosenFutureRoute;
  if (rawID(chosen?.id) === selected) return { ...previousRouteState, completedRoute: completedRoute ?? previousRouteState.completedRoute };
  const alternatives = [...(previousRouteState.alternativeRoutes ?? [])];
  const index = alternatives.findIndex((route) => rawID(route?.id) === selected);
  if (index < 0) throw new GameError('not_found', 'The selected alternative path is no longer available.');
  const newChosen = alternatives.splice(index, 1)[0];
  if (chosen?.stopNodeIDs?.length && signature(chosen) !== signature(newChosen)) alternatives.push(chosen);
  const unique = [];
  const seen = new Set();
  for (const route of alternatives) {
    const sig = signature(route);
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(route);
  }
  unique.sort((a, b) => routeCost(a) - routeCost(b));
  return {
    completedRoute: completedRoute ?? previousRouteState.completedRoute ?? emptyCompletedRoute(),
    chosenFutureRoute: newChosen,
    alternativeRoutes: unique,
    chosenFutureRouteActivatedAt: currentDayTime,
  };
}
