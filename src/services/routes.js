import { GameError } from '../lib/errors.js';
import { assertObject } from '../lib/validation.js';
import {
  buildInitialRouteState,
  mergeRouteNodeAnchors,
  rebuildRouteStateWithAttachedNode,
  resolveAttachableNodeAnchor,
  selectAlternativeRouteState,
} from './routeBuilder.js';


function rawRouteID(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.rawValue === 'string') return value.rawValue;
  return null;
}

function assertAttachedNodeIsInFutureRoute(routeState, nodeValue) {
  const attached = rawRouteID(nodeValue);
  if (!attached) throw new GameError('validation_failed', 'payload.node.id is required for route attachment.');
  const stops = (routeState?.chosenFutureRoute?.stopNodeIDs ?? []).map(rawRouteID);
  if (!stops.includes(attached)) {
    throw new GameError('validation_failed', 'Backend rebuilt the path but could not place the new stop on it.');
  }
}

async function writeRouteState(client, dayMapID, routeState) {
  await client.query(
    `INSERT INTO day_map_routes(day_map_id,route_type,route_data)
     VALUES ($1,'state',$2::jsonb)
     ON CONFLICT(day_map_id) WHERE route_type='state'
     DO UPDATE SET route_data=EXCLUDED.route_data,updated_at=NOW()`,
    [dayMapID, JSON.stringify(routeState)],
  );
  return { routeState };
}

// Legacy compatibility for older clients. Pass 5.43 no longer constructs
// route state on iOS, but keeping this handler lets an older build finish an
// in-flight mutation without corrupting the current server.
export async function persistRouteState(client, { dayMap, payload, field = 'routeState' }) {
  const routeState = assertObject(payload[field], `payload.${field}`);
  return writeRouteState(client, dayMap.day_map_id, routeState);
}

export async function generateBackendRouteState(client, { dayMap, payload }) {
  const roadGraph = assertObject(payload.roadGraph, 'payload.roadGraph');
  const nodeAnchors = Array.isArray(payload.nodeAnchors) ? payload.nodeAnchors : [];
  const currentDayTime = assertObject(payload.currentDayTime, 'payload.currentDayTime');
  const maxAlternatives = Math.max(0, Math.min(5, Math.trunc(Number(payload.maxAlternatives ?? 3))));
  const routeState = buildInitialRouteState({ roadGraph, nodeAnchors, currentDayTime, maxAlternatives });
  return writeRouteState(client, dayMap.day_map_id, routeState);
}

export async function rebuildRouteWithAttachedNode(client, { dayMap, payload }) {
  const roadGraph = assertObject(payload.roadGraph, 'payload.roadGraph');
  const nodeAnchors = Array.isArray(payload.nodeAnchors) ? payload.nodeAnchors : [];
  const attachedNodeAnchor = payload.attachedNodeAnchor ?? null;
  const currentDayTime = assertObject(payload.currentDayTime, 'payload.currentDayTime');
  const previousRouteState = await readRouteStateOrNull(client, dayMap.day_map_id);
  const maxAlternatives = Math.max(0, Math.min(5, Math.trunc(Number(payload.maxAlternatives ?? 3))));

  let resolvedAttachedNodeAnchor = attachedNodeAnchor;
  try {
    if (previousRouteState && attachedNodeAnchor) {
      resolvedAttachedNodeAnchor = resolveAttachableNodeAnchor({
        roadGraph,
        nodeAnchors,
        attachedNodeAnchor,
        previousRouteState,
      }) ?? attachedNodeAnchor;
    }

    const mergedNodeAnchors = mergeRouteNodeAnchors(
      nodeAnchors,
      resolvedAttachedNodeAnchor,
    );

    const routeState = previousRouteState
      ? rebuildRouteStateWithAttachedNode({
          roadGraph,
          nodeAnchors: mergedNodeAnchors,
          attachedNodeAnchor: resolvedAttachedNodeAnchor,
          currentDayTime,
          previousRouteState,
          completedRoute: payload.completedRoute ?? previousRouteState.completedRoute,
          attachedNodeID: payload.node?.id,
          maxAlternatives,
        })
      : buildInitialRouteState({
          roadGraph,
          nodeAnchors: mergedNodeAnchors,
          currentDayTime,
          maxAlternatives,
        });

    assertAttachedNodeIsInFutureRoute(routeState, payload.node?.id);

    return {
      ...(await writeRouteState(client, dayMap.day_map_id, routeState)),
      routeAttachmentReanchored:
        Boolean(attachedNodeAnchor)
        && JSON.stringify(resolvedAttachedNodeAnchor?.roadLocation)
          !== JSON.stringify(attachedNodeAnchor?.roadLocation),
    };
  } catch (primaryError) {
    if (!(primaryError instanceof GameError)) throw primaryError;

    // A stale completion boundary or an incompatible first-choice anchor must
    // never roll back a successfully persisted node. Retry from the current
    // authoritative anchors, using the route-compatible anchor when one was
    // found.
    try {
      const rebuiltFromCurrentAnchors = buildInitialRouteState({
        roadGraph,
        nodeAnchors: mergeRouteNodeAnchors(
          nodeAnchors,
          resolvedAttachedNodeAnchor ?? attachedNodeAnchor,
        ),
        currentDayTime,
        maxAlternatives,
      });

      assertAttachedNodeIsInFutureRoute(rebuiltFromCurrentAnchors, payload.node?.id);

      return {
        ...(await writeRouteState(client, dayMap.day_map_id, rebuiltFromCurrentAnchors)),
        routeAttachmentRecovered: true,
      };
    } catch (fallbackError) {
      if (!(fallbackError instanceof GameError)) throw fallbackError;

      return {
        routeState: previousRouteState,
        routeAttachmentError:
          `Stop was saved, but the backend could not attach it to the current path: ${fallbackError.message}`,
      };
    }
  }
}

export async function selectBackendAlternativeRoute(client, { dayMap, payload }) {
  const previousRouteState = await readRouteState(client, dayMap.day_map_id);
  const routeState = selectAlternativeRouteState({
    previousRouteState,
    selectedRouteID: payload.selectedRouteID,
    completedRoute: payload.completedRoute,
    currentDayTime: payload.currentDayTime,
  });
  return writeRouteState(client, dayMap.day_map_id, routeState);
}

export async function readRouteStateOrNull(client, dayMapID) {
  const result = await client.query(
    `SELECT route_data FROM day_map_routes WHERE day_map_id=$1 AND route_type='state' ORDER BY updated_at DESC LIMIT 1`,
    [dayMapID],
  );
  return result.rows[0]?.route_data ?? null;
}

export async function readRouteState(client, dayMapID) {
  const routeState = await readRouteStateOrNull(client, dayMapID);
  if (!routeState) throw new GameError('not_found', 'No route state exists.');
  return routeState;
}
