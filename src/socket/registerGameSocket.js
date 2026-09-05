import { registerSchedulerSocket } from '../notifications/socket.js';
import { pool, withTransaction } from '../db.js';
import { createTokenWindow } from '../http/rateLimit.js';
import { config } from '../config.js';
import { authenticateGameSocket } from '../auth.js';
import { OUT, IN } from '../events.js';
import { GameError, failureAck, successAck } from '../lib/errors.js';
import { assertMapDate, assertObject, assertString, assertTimeZone, assertUUID, parseEnvelope } from '../lib/validation.js';
import { withActivityStatus } from '../lib/nodeCodec.js';
import { dayRoom, ensureDayMap, loadSnapshot, userRoom } from '../services/dayMaps.js';
import { runDayMutation } from '../services/mutations.js';
import {
  deleteNode,
  markActivityCheckIn,
  persistActivityNode,
  persistHyperlinkVote,
  persistNode,
  persistPostSave,
} from '../services/nodes.js';
import { createPostReply } from '../services/social.js';
import { persistReveal, persistSuggestionDecision } from '../services/reveals.js';
import {
  generateBackendRouteState,
  rebuildRouteWithAttachedNode,
  selectBackendAlternativeRoute,
} from '../services/routes.js';
import { searchDayMap } from '../services/search.js';
import { createCatalogSuggestion, searchCatalogSuggestions } from '../services/catalogSuggestions.js';
import {
  createLiveMessage,
  createLiveReaction,
  latestPlayState,
  listPlayableWorkoutTemplates,
  persistWorkoutSnapshot,
} from '../services/play.js';
import {
  createConversationMessage,
  ensureDirectConversation,
  ensureSupportConversation,
  listConversationMessages,
  listConversations,
  listFriends,
  listPostsFeed,
  listPostReplies,
  createFeedPostReply,
  setFeedPostSaved,
} from '../services/socialHub.js';
import { loadAuthoritativeDayPlanState, recordNodeProgressOutcome, rerouteFutureDayPlan } from '../services/dayPlanning.js';
import { recordActivitySupportOutcome, refreshActivitySupportPlanForUser } from '../services/activitySupportPlanner.js';
import { completeOnboarding, loadOnboardingState, previewOnboardingRoute, startOnboarding, updateOnboarding } from '../services/onboarding.js';
import { answerRouteKnowledgeEncounter, deferRouteKnowledgeEncounter, selectRouteKnowledgeEncounter } from '../services/routeKnowledge.js';


const mutationRateLimiter = createTokenWindow({
  name: 'socket-mutation',
  limit: config.socketMutationRateLimitPerMinute,
  windowMs: 60_000,
});

function ackOnce(callback) {
  let used = false;
  return (value) => {
    if (used || typeof callback !== 'function') return;
    used = true;
    callback(value);
  };
}

function requireAuth(socket) {
  if (!socket.data.authUserID) throw new GameError('unauthorized', 'Authenticate the socket first.');
  return socket.data.authUserID;
}

function emitSafeServerError(socket, error, requestID = null) {
  const ack = failureAck(error, requestID);
  socket.emit(IN.serverError, {
    message: ack.message,
    errorCode: ack.errorCode,
    requestID: ack.requestID,
  });
}

async function mutation(socket, io, event, envelope, callback, mutate, broadcast) {
  const ack = ackOnce(callback);
  if (config.rateLimitEnabled) {
    const subject = socket.data.authUserID ?? socket.handshake.address ?? socket.id;
    const rate = mutationRateLimiter.consume(subject);
    if (!rate.allowed) {
      ack(failureAck(new GameError('rate_limited', 'Too many realtime mutations. Try again shortly.')));
      return;
    }
  }
  const outcome = await runDayMutation({ socket, event, rawEnvelope: envelope, mutate });
  ack(outcome.ack);

  if (!outcome.ack.success) {
    console.warn('game mutation rejected', {
      event,
      userID: socket.data.authUserID,
      requestID: outcome.ack.requestID,
      errorCode: outcome.ack.errorCode,
      message: outcome.ack.message,
    });
    return;
  }

  if (outcome.replayed || !outcome.result || !broadcast) return;
  const room = dayRoom(socket.data.authUserID, outcome.result.mapDate);
  try {
    await broadcast({ io, socket, room, result: outcome.result, envelope });
  } catch (error) {
    // The mutation is already committed and acknowledged. A broadcast failure
    // must never turn into an unhandled rejection or cause the client to retry
    // an already-committed write with a new request ID.
    console.error('game mutation broadcast failed', {
      event,
      requestID: outcome.ack.requestID,
      error,
    });
  }
}

function registerMutation(socket, io, event, mutate, broadcast) {
  socket.on(event, async (envelope, callback) => {
    await mutation(socket, io, event, envelope, callback, mutate, broadcast);
  });
}

async function emitNode(io, room, result) {
  io.to(room).emit(IN.nodeUpserted, { node: result.node, revision: result.revision, mapDate: result.mapDate });
}

async function refreshAndBroadcastActivitySupport(io, {
  userID,
  timeZoneIdentifier,
} = {}) {
  if (!config.activitySupportPlannerEnabled || !userID || !timeZoneIdentifier) return null;
  try {
    const result = await refreshActivitySupportPlanForUser({ userID, timeZoneIdentifier });
    for (const change of result.changes ?? []) {
      const room = dayRoom(userID, change.mapDate);
      for (const node of change.upsertedNodes ?? []) {
        io.to(room).emit(IN.nodeUpserted, { node, revision: change.revision });
      }
      for (const nodeID of change.deletedNodeIDs ?? []) {
        io.to(room).emit(IN.nodeDeleted, { nodeID: { rawValue: nodeID }, revision: change.revision });
      }
      if (change.dayPlanState) {
        io.to(room).emit(IN.dayPlanState, change.dayPlanState);
      }
    }
    io.to(userRoom(userID)).emit(IN.supportPlanState, result.state);
    return result;
  } catch (error) {
    // Support planning is additive. A planner failure must never invalidate a
    // successfully committed user mutation or the existing authoritative route.
    console.error('activity support planner refresh failed', { userID, error });
    return null;
  }
}

async function emitNodeAndRefreshSupport({ io, socket, room, result, envelope }) {
  await emitNode(io, room, result);
  await refreshAndBroadcastActivitySupport(io, {
    userID: socket.data.authUserID,
    timeZoneIdentifier: envelope?.context?.timeZoneIdentifier,
  });
}

async function emitDeleteAndRefreshSupport({ io, socket, room, result, envelope }) {
  io.to(room).emit(IN.nodeDeleted, { nodeID: { rawValue: result.nodeID }, revision: result.revision, mapDate: result.mapDate });
  await refreshAndBroadcastActivitySupport(io, {
    userID: socket.data.authUserID,
    timeZoneIdentifier: envelope?.context?.timeZoneIdentifier,
  });
}

async function persistActivityMutationWithProgress({
  client,
  dayMap,
  userID,
  context,
  payload,
}) {
  const action = payload.action;
  const node = withActivityStatus(payload.node, action);
  const result = await persistActivityNode(client, { dayMap, userID, context, node });
  const progress = await recordNodeProgressOutcome(client, {
    dayMap,
    userID,
    nodeID: result.nodeID,
    action,
    nowSecond: Number(dayMap.current_time_seconds ?? 0),
    evidence: { source: 'socket-activity-mutation' },
  });
  await recordActivitySupportOutcome(client, { nodeID: result.nodeID, action });
  return { ...result, progressSnapshot: progress?.progressSnapshot ?? null };
}

export function registerGameSocket(io) {
  io.on('connection', (socket) => {
    socket.data.authUserID = null;
    socket.data.deviceID = null;
    socket.data.dayRoom = null;
    registerSchedulerSocket(socket);

    const authenticationDeadline = setTimeout(() => {
      if (!socket.data.authUserID) {
        socket.disconnect(true);
      }
    }, config.socketAuthTimeoutMs);
    authenticationDeadline.unref?.();

    socket.once('disconnect', () => {
      clearTimeout(authenticationDeadline);
    });

    socket.on(OUT.authenticate, async (payload, callback) => {
      const ack = ackOnce(callback);
      let client;
      try {
        client = await pool.connect();
        const auth = await authenticateGameSocket(client, payload);

        const previousUserID = socket.data.authUserID;
        if (previousUserID && previousUserID !== auth.userID) {
          await socket.leave(userRoom(previousUserID));
          if (socket.data.dayRoom) await socket.leave(socket.data.dayRoom);
          socket.data.dayRoom = null;
        }

        socket.data.authUserID = auth.userID;
        socket.data.deviceID = auth.deviceID;
        await socket.join(userRoom(auth.userID));
        clearTimeout(authenticationDeadline);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      } finally {
        client?.release();
      }
    });

    // Phase 8 — gamified onboarding. These events are authenticated but do not
    // require an existing Day Map snapshot; onboarding is what creates the
    // first personalized route for a new player.
    socket.on(OUT.onboardingStateRequest, async (_rawPayload, callback) => {
      const ack = ackOnce(callback);
      let client;
      try {
        const userID = requireAuth(socket);
        client = await pool.connect();
        const state = await loadOnboardingState(client, userID);
        socket.emit(IN.onboardingState, state);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      } finally {
        client?.release();
      }
    });

    socket.on(OUT.onboardingStart, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'onboarding start payload');
        const state = await withTransaction((client) => startOnboarding(client, { userID, payload }));
        io.to(userRoom(userID)).emit(IN.onboardingState, state);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      }
    });

    socket.on(OUT.onboardingUpdate, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'onboarding update payload');
        const state = await withTransaction((client) => updateOnboarding(client, {
          userID,
          stage: payload.stage,
          payload: payload.payload ?? {},
        }));
        io.to(userRoom(userID)).emit(IN.onboardingState, state);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      }
    });

    socket.on(OUT.onboardingPreview, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'onboarding preview payload');
        const mapDate = assertMapDate(payload.mapDate);
        const timeZoneIdentifier = assertTimeZone(payload.timeZoneIdentifier, 'timeZoneIdentifier');
        const result = await withTransaction(async (client) => {
          const preview = await previewOnboardingRoute(client, { userID, mapDate, timeZoneIdentifier });
          const state = await loadOnboardingState(client, userID);
          return { preview, state };
        });
        socket.emit(IN.onboardingPreviewState, result.preview);
        socket.emit(IN.onboardingState, result.state);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      }
    });

    socket.on(OUT.onboardingComplete, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'onboarding complete payload');
        const mapDate = assertMapDate(payload.mapDate);
        const timeZoneIdentifier = assertTimeZone(payload.timeZoneIdentifier, 'timeZoneIdentifier');
        const currentDayTimeSeconds = Number(payload.currentDayTimeSeconds ?? 0);

        const result = await withTransaction((client) => completeOnboarding(client, {
          userID,
          mapDate,
          timeZoneIdentifier,
          currentDayTimeSeconds,
          predictionRuntimeMode: config.predictionRuntimeMode,
        }));

        io.to(userRoom(userID)).emit(IN.onboardingState, result.state);
        socket.emit(IN.snapshot, result.snapshot);
        if (result.dayPlanState) socket.emit(IN.dayPlanState, result.dayPlanState);
        io.to(userRoom(userID)).emit(IN.onboardingCompleted, result.completion);

        // Phase 7 remains the prerequisite authority. This second transaction
        // can add grocery/prep support nodes and future-only reroute state.
        await refreshAndBroadcastActivitySupport(io, { userID, timeZoneIdentifier });
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      }
    });

    // Progressive route-knowledge encounters. These are intentionally separate
    // from signup onboarding: Fifoo asks one high-value question at a good
    // moment, then reduces frequency as the player's route profile fills in.
    socket.on(OUT.routeKnowledgeEncounterRequest, async (rawEnvelope, callback) => {
      const ack = ackOnce(callback);
      if (!config.routeKnowledgeEncountersEnabled) {
        ack(successAck(null, null, 'Route knowledge encounters are disabled.'));
        return;
      }
      let client;
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        const payload = assertObject(envelope.payload ?? {}, 'route knowledge request payload');
        const mapDate = assertMapDate(payload.mapDate ?? envelope.context.mapDate);
        const nowSecond = Math.max(0, Math.min(86_399, Number(payload.currentDayTimeSeconds ?? 0) || 0));
        client = await pool.connect();
        const encounter = await selectRouteKnowledgeEncounter(client, { userID, mapDate, nowSecond });
        if (encounter) socket.emit(IN.routeKnowledgeEncounter, encounter);
        ack(successAck(envelope.context.requestID ?? null, null, encounter ? 'Encounter ready.' : 'No encounter is due.'));
      } catch (error) {
        ack(failureAck(error));
      } finally {
        client?.release();
      }
    });

    socket.on(OUT.routeKnowledgeEncounterAnswer, async (rawEnvelope, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        const payload = assertObject(envelope.payload ?? {}, 'route knowledge answer payload');
        const mapDate = assertMapDate(payload.mapDate ?? envelope.context.mapDate);
        const timeZoneIdentifier = assertTimeZone(
          payload.timeZoneIdentifier ?? envelope.context.timeZoneIdentifier,
          'timeZoneIdentifier',
        );
        const encounterID = assertUUID(payload.encounterID, 'encounterID');
        const optionIDs = Array.isArray(payload.optionIDs) ? payload.optionIDs.map(String) : [];
        const decisionSecond = Math.max(0, Math.min(86_399, Number(payload.currentDayTimeSeconds ?? 0) || 0));

        const outcome = await withTransaction((client) => answerRouteKnowledgeEncounter(client, {
          userID,
          encounterID,
          optionIDs,
          mapDate,
          timeZoneIdentifier,
          decisionSecond,
          predictionRuntimeMode: config.predictionRuntimeMode,
        }));

        if (outcome.result) io.to(userRoom(userID)).emit(IN.routeKnowledgeResult, outcome.result);
        if (outcome.dayPlanState) {
          io.to(dayRoom(userID, mapDate)).emit(IN.dayPlanState, outcome.dayPlanState);
        }
        if (outcome.result?.routeImpact === 'support_planning') {
          await refreshAndBroadcastActivitySupport(io, { userID, timeZoneIdentifier });
        }
        ack(successAck(envelope.context.requestID ?? null, outcome.revision ?? null));
      } catch (error) {
        ack(failureAck(error));
      }
    });

    socket.on(OUT.routeKnowledgeEncounterDefer, async (rawEnvelope, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        const payload = assertObject(envelope.payload ?? {}, 'route knowledge defer payload');
        const encounterID = assertUUID(payload.encounterID, 'encounterID');
        await withTransaction((client) => deferRouteKnowledgeEncounter(client, {
          userID, encounterID, hours: payload.hours ?? 6,
        }));
        ack(successAck(envelope.context.requestID ?? null, null));
      } catch (error) {
        ack(failureAck(error));
      }
    });

    socket.on(OUT.requestSnapshot, async (rawEnvelope) => {
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        const payload = assertObject(envelope.payload, 'payload');
        const mapDate = assertMapDate(payload.mapDate ?? envelope.context.mapDate);
        const timeZoneIdentifier = assertTimeZone(payload.timeZoneIdentifier ?? envelope.context.timeZoneIdentifier, 'timeZoneIdentifier');
        if (config.activitySupportPlannerEnabled) {
          const support = await refreshActivitySupportPlanForUser({ userID, timeZoneIdentifier });
          socket.emit(IN.supportPlanState, support.state);
        }
        const client = await pool.connect();
        try {
          const dayMap = await ensureDayMap(client, { userID, mapDate, timeZoneIdentifier });
          const room = dayRoom(userID, mapDate);
          if (socket.data.dayRoom && socket.data.dayRoom !== room) await socket.leave(socket.data.dayRoom);
          socket.data.dayRoom = room;
          await socket.join(room);
          const snapshot = await loadSnapshot(client, dayMap);
          socket.emit(IN.snapshot, snapshot);

          // Phase 3 recovery contract: every explicit day refresh/reconnect
          // follows the legacy snapshot with the active authoritative Day Graph.
          // The client applies this future state atomically after preserving its
          // already-rendered completed route history.
          const dayPlanState = await loadAuthoritativeDayPlanState(client, {
            dayMap,
            nowSecond: Number(dayMap.current_time_seconds ?? 0),
          });
          if (dayPlanState) {
            socket.emit(IN.dayPlanState, {
              ...dayPlanState,
              revision: Number(dayMap.revision ?? snapshot.revision ?? 0),
            });
          }
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.applicationAction, async (rawEnvelope) => {
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        if (config.logApplicationActions) {
          console.info('game action', { userID, mapDate: envelope.context.mapDate, ...envelope.payload });
        }
        if (config.persistApplicationActions) {
          const client = await pool.connect();
          try {
            const dayMap = await ensureDayMap(client, { userID, mapDate: envelope.context.mapDate, timeZoneIdentifier: envelope.context.timeZoneIdentifier });
            await client.query(
              `INSERT INTO day_map_application_actions(day_map_id,user_id,device_id,action,metadata,occurred_at)
               VALUES ($1,$2,$3,$4,$5::jsonb,COALESCE($6::timestamptz,NOW()))`,
              [dayMap.day_map_id, userID, envelope.context.deviceID, String(envelope.payload.action ?? 'unknown'), JSON.stringify(envelope.payload.metadata ?? {}), envelope.payload.occurredAt ?? null],
            );
          } finally {
            client.release();
          }
        }
      } catch (error) {
        console.warn('application action rejected', error.message);
      }
    });

    registerMutation(socket, io, OUT.nodeAdd,
      ({ client, dayMap, userID, context, payload }) => persistNode(client, { dayMap, userID, context, node: payload.node }),
      emitNodeAndRefreshSupport);

    registerMutation(socket, io, OUT.nodeUpdate,
      ({ client, dayMap, userID, context, payload }) => persistNode(client, { dayMap, userID, context, node: payload.node }),
      emitNodeAndRefreshSupport);

    registerMutation(socket, io, OUT.nodeDelete,
      ({ client, dayMap, payload }) => deleteNode(client, { dayMap, nodeID: payload.nodeID }),
      emitDeleteAndRefreshSupport);

    for (const event of [OUT.activityJoin, OUT.activitySkip, OUT.activityComplete]) {
      registerMutation(socket, io, event,
        persistActivityMutationWithProgress,
        emitNodeAndRefreshSupport);
    }

    for (const event of [OUT.activityTaskUpdate, OUT.activityTaskReschedule]) {
      registerMutation(socket, io, event,
        ({ client, dayMap, userID, context, payload }) => persistActivityNode(client, { dayMap, userID, context, node: payload.node }),
        emitNodeAndRefreshSupport);
    }

    for (const event of [OUT.activityTaskSkip, OUT.activityTaskComplete]) {
      registerMutation(socket, io, event,
        persistActivityMutationWithProgress,
        emitNodeAndRefreshSupport);
    }

    registerMutation(socket, io, OUT.activityMealUpdate,
      ({ client, dayMap, userID, context, payload }) => persistActivityNode(client, { dayMap, userID, context, node: payload.node }),
      emitNodeAndRefreshSupport);

    registerMutation(socket, io, OUT.activityMealComplete,
      persistActivityMutationWithProgress,
      emitNodeAndRefreshSupport);

    registerMutation(socket, io, OUT.activityMealSkip,
      async ({ client, dayMap, userID, context, payload }) => {
        const skippedNode = withActivityStatus(payload.node, payload.action ?? 'skip');
        const persisted = await persistActivityNode(client, { dayMap, userID, context, node: skippedNode });
        const progress = await recordNodeProgressOutcome(client, {
          dayMap,
          userID,
          nodeID: persisted.nodeID,
          action: payload.action ?? 'skip',
          nowSecond: Number(dayMap.current_time_seconds ?? 0),
          evidence: { source: 'socket-activity-meal-skip' },
        });
        await recordActivitySupportOutcome(client, {
          nodeID: persisted.nodeID,
          action: payload.action ?? 'skip',
        });
        const deleted = await deleteNode(client, { dayMap, nodeID: skippedNode?.id });
        return { ...deleted, progressSnapshot: progress?.progressSnapshot ?? null };
      },
      emitDeleteAndRefreshSupport);

    for (const event of [OUT.activityWorkoutUpdate, OUT.activityWorkoutSelect, OUT.activityWorkoutReschedule]) {
      registerMutation(socket, io, event,
        ({ client, dayMap, userID, context, payload }) => persistActivityNode(client, { dayMap, userID, context, node: payload.node }),
        emitNodeAndRefreshSupport);
    }

    registerMutation(socket, io, OUT.activityWorkoutCheckIn,
      async ({ client, dayMap, userID, context, payload }) => {
        const result = await persistActivityNode(client, { dayMap, userID, context, node: payload.node });
        await markActivityCheckIn(client, { node: payload.node, userID });
        return result;
      },
      ({ io, room, result }) => emitNode(io, room, result));

    registerMutation(socket, io, OUT.tileReveal,
      ({ client, dayMap, payload }) => persistReveal(client, { dayMap, payload }),
      async ({ io, room, result }) => io.to(room).emit(IN.tileRevealState, { cell: result.cell, isRevealed: result.isRevealed, revision: result.revision }));

    registerMutation(socket, io, OUT.suggestedStopDecision,
      ({ client, dayMap, userID, payload }) => persistSuggestionDecision(client, { dayMap, userID, payload }),
      null);

    registerMutation(socket, io, OUT.postReplyCreate,
      ({ client, dayMap, userID, context, payload }) => createPostReply(client, { dayMap, userID, context, payload }),
      ({ io, room, result }) => emitNode(io, room, result));

    registerMutation(socket, io, OUT.postSave,
      ({ client, dayMap, userID, context, payload }) => persistPostSave(client, { dayMap, userID, context, node: payload.node }),
      ({ io, room, result }) => emitNode(io, room, result));

    registerMutation(socket, io, OUT.hyperlinkVote,
      ({ client, dayMap, userID, payload }) => persistHyperlinkVote(client, { dayMap, userID, nodeID: payload.nodeID, vote: payload.vote }),
      null);

    socket.on(OUT.supportPlanRefresh, async (rawEnvelope, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        const timeZoneIdentifier = assertTimeZone(envelope.context.timeZoneIdentifier, 'timeZoneIdentifier');
        const result = await refreshActivitySupportPlanForUser({
          userID,
          timeZoneIdentifier,
          horizonHours: envelope.payload?.horizonHours ?? config.activitySupportHorizonHours,
        });
        for (const change of result.changes ?? []) {
          const room = dayRoom(userID, change.mapDate);
          for (const node of change.upsertedNodes ?? []) {
            io.to(room).emit(IN.nodeUpserted, { node, revision: change.revision });
          }
          for (const nodeID of change.deletedNodeIDs ?? []) {
            io.to(room).emit(IN.nodeDeleted, { nodeID: { rawValue: nodeID }, revision: change.revision });
          }
          if (change.dayPlanState) io.to(room).emit(IN.dayPlanState, change.dayPlanState);
        }
        io.to(userRoom(userID)).emit(IN.supportPlanState, result.state);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      }
    });

    // Pass 5.43: route geometry is now constructed on the backend. The iOS
    // client can request an automatic build, attach a newly-created stop, or
    // choose one of the server-generated alternatives. It no longer submits
    // completed/chosen/alternate route geometry as the source of truth.
    registerMutation(socket, io, OUT.routeBuild,
      ({ client, dayMap, payload }) => generateBackendRouteState(client, { dayMap, payload }),
      async ({ io, room, result }) => io.to(room).emit(IN.routeState, { routeState: result.routeState, revision: result.revision, mapDate: result.mapDate }));

    // Opt-in v2 planning event. It publishes the richer Day Graph separately;
    // the established game:route:state payload remains byte-for-byte compatible.
    registerMutation(socket, io, OUT.routeReroute,
      ({ client, dayMap, userID, context, payload }) => rerouteFutureDayPlan(client, {
        dayMap,
        userID,
        mapDate: context.mapDate,
        decisionSecond: Number(
          payload.currentDayTime?.secondsFromMidnight
            ?? payload.decisionSecond
            ?? dayMap.current_time_seconds,
        ),
        candidates: payload.candidates,
        boundaryOutcome: payload.boundaryOutcome ?? null,
        systemAction: payload.systemAction ?? null,
        rerouteReason: payload.reason ?? 'context_changed',
        routingContext: payload.routingContext ?? {},
        alternativeCount: payload.maxAlternatives ?? 2,
        timeZoneIdentifier: context.timeZoneIdentifier,
        requestID: context.requestID,
        occurredAt: context.sentAt ?? new Date().toISOString(),
        predictionRuntimeMode: config.predictionRuntimeMode,
      }),
      async ({ io, room, result }) => io.to(room).emit(IN.dayPlanState, {
        dayPlan: result.dayPlan,
        mapDate: result.mapDate,
        progressSnapshot: result.progressSnapshot,
        planRevision: result.planRevision,
        revision: result.revision,
        rerouteReason: result.rerouteReason,
        effectiveAt: result.effectiveAt,
        decisionSecond: result.decisionSecond,
      }));

    registerMutation(socket, io, OUT.routeAttachNode,
      async ({ client, dayMap, userID, context, payload }) => {
        const nodeResult = await persistNode(client, { dayMap, userID, context, node: payload.node });
        const routeResult = await rebuildRouteWithAttachedNode(client, { dayMap, payload });
        return {
          node: nodeResult.node,
          routeState: routeResult.routeState,
          routeAttachmentError: routeResult.routeAttachmentError ?? null,
          routeAttachmentReanchored: routeResult.routeAttachmentReanchored ?? false,
          routeAttachmentRecovered: routeResult.routeAttachmentRecovered ?? false,
        };
      },
      async ({ io, socket, room, result, envelope }) => {
        await emitNode(io, room, result);

        if (result.routeState) {
          io.to(room).emit(IN.routeState, {
            routeState: result.routeState,
            revision: result.revision,
          });
        }

        if (result.routeAttachmentReanchored || result.routeAttachmentRecovered) {
          console.info('route attachment resolved', {
            requestID: envelope?.context?.requestID ?? null,
            nodeID: result.node?.id?.rawValue ?? result.node?.id ?? null,
            reanchored: result.routeAttachmentReanchored,
            rebuiltFromCurrentAnchors: result.routeAttachmentRecovered,
          });
        }

        if (result.routeAttachmentError) {
          console.warn('route attachment fallback', {
            requestID: envelope?.context?.requestID ?? null,
            message: result.routeAttachmentError,
          });

          io.to(room).emit(IN.serverError, {
            message: result.routeAttachmentError,
            errorCode: 'route_attachment_failed',
            requestID: envelope?.context?.requestID ?? null,
          });
        }

        // Add Stop can persist a future meal through routeAttachNode rather than
        // nodeAdd. Refresh support planning here too so both creation paths
        // produce the same preparation chain.
        await refreshAndBroadcastActivitySupport(io, {
          userID: socket.data.authUserID,
          timeZoneIdentifier: envelope?.context?.timeZoneIdentifier,
        });
      });

    registerMutation(socket, io, OUT.routeSelect,
      ({ client, dayMap, payload }) => selectBackendAlternativeRoute(client, { dayMap, payload }),
      async ({ io, room, result }) => io.to(room).emit(IN.routeState, { routeState: result.routeState, revision: result.revision, mapDate: result.mapDate }));

    // Client-authored route geometry is intentionally disabled. Keep the event
    // name only so older clients receive a typed terminal error rather than
    // silently bypassing backend route authority.
    registerMutation(socket, io, OUT.routePreviewCommit,
      async () => {
        throw new GameError(
          'unsupported_operation',
          'Client-authored route commits are disabled. Select a server-generated path instead.',
        );
      });

    // Legacy route draft/preview telemetry is intentionally ignored.
    socket.on(OUT.routeDraftUpdate, () => {});
    socket.on(OUT.routePreviewUpdate, () => {});
    socket.on(OUT.roadInteraction, () => {});

    socket.on(OUT.searchQuery, async (rawEnvelope) => {
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        const client = await pool.connect();
        try {
          const dayMap = await ensureDayMap(client, { userID, mapDate: envelope.context.mapDate, timeZoneIdentifier: envelope.context.timeZoneIdentifier });
          const nodes = await searchDayMap(client, { dayMapID: dayMap.day_map_id, query: envelope.payload.query });
          socket.emit(IN.searchResults, { nodes, revision: Number(dayMap.revision) });
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });



    socket.on(OUT.catalogSearch, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'catalog search payload');
        const client = await pool.connect();
        try {
          const items = await searchCatalogSuggestions(client, {
            userID,
            kind: payload.kind,
            query: payload.query ?? '',
            limit: payload.limit ?? 20,
          });
          ack({ ...successAck(), items });
        } finally {
          client.release();
        }
      } catch (error) {
        ack(failureAck(error));
      }
    });

    socket.on(OUT.catalogSuggestionCreate, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'catalog suggestion payload');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await createCatalogSuggestion(client, {
            userID,
            kind: payload.kind,
            title: payload.title,
          });
          await client.query('COMMIT');
          ack({ ...successAck(), ...result });
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch {}
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        ack(failureAck(error));
      }
    });


    // Generic account/social surfaces. These are authenticated user data, but
    // they are not Day Map mutations and therefore intentionally do not share
    // the Day Map revision/outbox protocol.
    socket.on(OUT.conversationsRequest, async () => {
      try {
        const userID = requireAuth(socket);
        const client = await pool.connect();
        try {
          socket.emit(IN.conversations, await listConversations(client, { userID }));
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.conversationOpen, async (rawPayload) => {
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload, 'conversation payload');
        const partnerUserID = assertUUID(payload.partnerUserID, 'partnerUserID');
        const client = await pool.connect();
        try {
          const conversationID = await ensureDirectConversation(client, { userID, partnerUserID });
          const messages = await listConversationMessages(client, { userID, conversationID });
          socket.emit(IN.conversationOpened, { conversationID, partnerUserID, isSupport: false });
          socket.emit(IN.conversationMessages, { conversationID, messages });
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.supportConversationOpen, async () => {
      try {
        const userID = requireAuth(socket);
        const client = await pool.connect();
        try {
          const conversationID = await ensureSupportConversation(client, { userID });
          const messages = await listConversationMessages(client, { userID, conversationID });
          socket.emit(IN.conversationOpened, { conversationID, partnerUserID: null, isSupport: true });
          socket.emit(IN.conversationMessages, { conversationID, messages });
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.conversationMessagesRequest, async (rawPayload) => {
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload, 'conversation payload');
        const conversationID = assertUUID(payload.conversationID, 'conversationID');
        const client = await pool.connect();
        try {
          const messages = await listConversationMessages(client, { userID, conversationID });
          socket.emit(IN.conversationMessages, { conversationID, messages });
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.conversationMessageSend, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      let client;
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload, 'message payload');
        const conversationID = assertUUID(payload.conversationID, 'conversationID');
        const body = assertString(payload.body, 'body');
        client = await pool.connect();
        const result = await createConversationMessage(client, { userID, conversationID, body });
        for (const memberID of result.memberIDs) {
          io.to(userRoom(memberID)).emit(IN.conversationMessage, result.message);
        }
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      } finally {
        client?.release();
      }
    });

    socket.on(OUT.friendsRequest, async (rawPayload) => {
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'friends payload');
        const mapDate = assertMapDate(payload.mapDate);
        const client = await pool.connect();
        try {
          socket.emit(IN.friends, await listFriends(client, { userID, mapDate }));
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.postsRequest, async (rawPayload) => {
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload ?? {}, 'posts payload');
        const client = await pool.connect();
        try {
          socket.emit(IN.posts, await listPostsFeed(client, {
            userID,
            limit: payload.limit,
            offset: payload.offset,
          }));
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.postRepliesRequest, async (rawPayload) => {
      try {
        requireAuth(socket);
        const payload = assertObject(rawPayload, 'post replies payload');
        const postID = assertUUID(payload.postID, 'postID');
        const client = await pool.connect();
        try {
          socket.emit(IN.postReplies, { postID, replies: await listPostReplies(client, { postID }) });
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    socket.on(OUT.postReplySend, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      let client;
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload, 'post reply payload');
        const postID = assertUUID(payload.postID, 'postID');
        const body = assertString(payload.body, 'body');
        client = await pool.connect();
        const reply = await createFeedPostReply(client, { userID, postID, body });
        io.emit(IN.postReply, reply);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      } finally {
        client?.release();
      }
    });

    socket.on(OUT.postFeedSave, async (rawPayload, callback) => {
      const ack = ackOnce(callback);
      let client;
      try {
        const userID = requireAuth(socket);
        const payload = assertObject(rawPayload, 'post save payload');
        const postID = assertUUID(payload.postID, 'postID');
        client = await pool.connect();
        const saved = await setFeedPostSaved(client, { userID, postID, isSaved: Boolean(payload.isSaved) });
        io.to(userRoom(userID)).emit(IN.postFeedSaved, saved);
        ack(successAck(null, null));
      } catch (error) {
        ack(failureAck(error));
      } finally {
        client?.release();
      }
    });

    socket.on(OUT.workoutCatalogRequest, async () => {
      let client;
      try {
        const userID = requireAuth(socket);
        client = await pool.connect();
        const workouts = await listPlayableWorkoutTemplates(client, { userID });
        socket.emit(IN.workoutCatalog, workouts);
      } catch (error) {
        emitSafeServerError(socket, error);
      } finally {
        client?.release();
      }
    });

    socket.on(OUT.requestPlayData, async (rawEnvelope) => {
      try {
        const userID = requireAuth(socket);
        const envelope = parseEnvelope(rawEnvelope);
        const requestedWorkoutID = envelope.payload?.workoutID == null
          ? null
          : assertUUID(envelope.payload.workoutID, 'payload.workoutID');
        const sourceWorkoutID = envelope.payload?.sourceWorkoutID == null
          ? null
          : assertString(envelope.payload.sourceWorkoutID, 'payload.sourceWorkoutID').trim();
        const client = await pool.connect();
        try {
          const state = await latestPlayState(client, {
            userID,
            maxHistory: config.maxLiveHistory,
            workoutID: requestedWorkoutID,
            sourceWorkoutID,
          });
          if (state.workout) socket.emit(IN.workout, { workout: state.workout, revision: null });
          socket.emit(IN.liveMessages, state.messages);
        } finally {
          client.release();
        }
      } catch (error) {
        emitSafeServerError(socket, error);
      }
    });

    for (const event of [
      OUT.workoutStart, OUT.workoutPause, OUT.workoutResume, OUT.workoutEnd, OUT.workoutComplete,
      OUT.exerciseSelect, OUT.exerciseStart, OUT.exercisePause, OUT.exerciseResume, OUT.exerciseComplete, OUT.exerciseSkip,
    ]) {
      registerMutation(socket, io, event,
        ({ client, userID, payload }) => persistWorkoutSnapshot(client, { userID, workout: payload.workout }),
        async ({ io, socket, result }) => io.to(userRoom(socket.data.authUserID)).emit(IN.workout, { workout: result.workout, revision: result.revision }));
    }

    registerMutation(socket, io, OUT.liveMessageSend,
      ({ client, userID, payload }) => createLiveMessage(client, { userID, payload }),
      async ({ io, socket, result }) => io.to(userRoom(socket.data.authUserID)).emit(IN.liveMessage, result));

    registerMutation(socket, io, OUT.liveReactionSend,
      ({ client, userID, payload }) => createLiveReaction(client, { userID, payload }),
      async ({ io, socket, result }) => io.to(userRoom(socket.data.authUserID)).emit(IN.liveReaction, result));
  });
}
