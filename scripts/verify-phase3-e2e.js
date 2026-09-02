#!/usr/bin/env node
import { io } from 'socket.io-client';
import crypto from 'node:crypto';

const baseURL = process.env.PHASE3_E2E_URL;
const userID = process.env.PHASE3_E2E_USER_ID;
const authToken = process.env.PHASE3_E2E_AUTH_TOKEN;
const mapDate = process.env.PHASE3_E2E_MAP_DATE;
const timeZoneIdentifier = process.env.PHASE3_E2E_TIME_ZONE ?? 'America/New_York';
const deviceID = process.env.PHASE3_E2E_DEVICE_ID ?? `phase3-e2e-${crypto.randomUUID()}`;

if (!baseURL || !userID || !authToken || !mapDate) {
  console.error('Required: PHASE3_E2E_URL, PHASE3_E2E_USER_ID, PHASE3_E2E_AUTH_TOKEN, PHASE3_E2E_MAP_DATE');
  process.exit(2);
}

function secondsNow(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour) % 24;
  return hour * 3600 + Number(values.minute) * 60 + Number(values.second);
}

function once(socket, event, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (value) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

function ack(socket, event, payload, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function envelope(payload, revision) {
  return {
    context: {
      requestID: crypto.randomUUID(),
      userID,
      deviceID,
      mapDate,
      timeZoneIdentifier,
      clientRevision: revision,
      sentAt: new Date().toISOString(),
    },
    payload,
  };
}

function candidatesFrom(plan, decisionSecond, excludedNodeID) {
  const seen = new Set();
  const candidates = plan.chosenPath.intervals
    .filter((interval) => interval.endSecond > decisionSecond)
    .filter((interval) => interval.sourceNodeID && interval.sourceNodeID !== excludedNodeID)
    .filter((interval) => !['completed', 'skipped', 'superseded', 'cancelledByConstraint'].includes(interval.lifecycleStatus))
    .filter((interval) => {
      if (seen.has(interval.sourceNodeID)) return false;
      seen.add(interval.sourceNodeID);
      return true;
    })
    .map((interval) => ({
      key: interval.key,
      candidateKey: interval.candidateKey ?? interval.key,
      decisionGroup: interval.candidateKey ?? interval.key,
      kind: interval.intervalKind,
      sourceNodeID: interval.sourceNodeID,
      required: true,
      fixedStartSecond: null,
      earliestStartSecond: Math.max(decisionSecond, interval.startSecond),
      latestEndSecond: 86_400,
      durationSeconds: Math.max(1, interval.endSecond - interval.startSecond),
      progressCategory: interval.progressCategory,
      progressWeightHint: Math.max(0.0001, Number(interval.progressWeightHint ?? interval.potentialPoints ?? 1)),
      goalImpact: Math.min(1, Number(interval.potentialPoints ?? 0) / 100),
      preferenceFit: 0.5,
      priority: 0.5,
      urgency: 0.5,
      hardExcluded: false,
    }));

  if (candidates.length) return candidates;
  return [{
    key: 'phase3-open-future', candidateKey: 'phase3-open-future', decisionGroup: 'phase3-open-future',
    kind: 'freeTime', sourceNodeID: null, required: true, fixedStartSecond: decisionSecond,
    earliestStartSecond: decisionSecond, latestEndSecond: 86_400,
    durationSeconds: Math.max(1, 86_400 - decisionSecond), progressCategory: 'other',
    progressWeightHint: 0.0001, goalImpact: 0, preferenceFit: 1, priority: 0, urgency: 0, hardExcluded: false,
  }];
}

const socket = io(baseURL, { transports: ['websocket'], reconnection: false });
try {
  await once(socket, 'connect');
  const auth = await ack(socket, 'game:auth', { userID, authToken, deviceID });
  if (!auth?.success) throw new Error(`Authentication failed: ${JSON.stringify(auth)}`);

  const snapshotPromise = once(socket, 'game:sync:snapshot');
  const planPromise = once(socket, 'game:day-plan:state');
  socket.emit('game:sync:request', envelope({
    knownRevision: 0,
    mapDate,
    timeZoneIdentifier,
  }, 0));

  const [snapshot, before] = await Promise.all([snapshotPromise, planPromise]);
  const decisionSecond = Number(process.env.PHASE3_E2E_DECISION_SECOND ?? secondsNow(timeZoneIdentifier));
  const futureInterval = before.dayPlan.chosenPath.intervals.find((interval) => (
    interval.sourceNodeID && interval.startSecond >= decisionSecond && interval.lifecycleStatus === 'planned'
  ));
  if (!futureInterval) throw new Error('Seeded day has no future planned source-node interval to skip.');

  const node = snapshot.nodes.find((candidate) => {
    const raw = candidate?.id?.rawValue ?? candidate?.id;
    return String(raw) === String(futureInterval.sourceNodeID);
  });
  if (!node) throw new Error(`Snapshot does not contain seeded future node ${futureInterval.sourceNodeID}.`);

  const beforeCompletedIntervals = before.dayPlan.completedPath?.intervals ?? [];
  const beforeEarned = Number(before.progressSnapshot?.earnedPoints ?? 0);
  let revision = Number(before.revision ?? snapshot.revision ?? 0);

  const skipAck = await ack(socket, 'game:activity:skip', envelope({ action: 'skip', node }, revision));
  if (!skipAck?.success) throw new Error(`Skip failed: ${JSON.stringify(skipAck)}`);
  revision = Number(skipAck.revision ?? revision);

  const reroutedPromise = once(socket, 'game:day-plan:state');
  const rerouteAck = await ack(socket, 'game:route:reroute', envelope({
    currentDayTime: { secondsFromMidnight: decisionSecond },
    decisionSecond,
    reason: 'skip',
    maxAlternatives: 3,
    candidates: candidatesFrom(before.dayPlan, decisionSecond, futureInterval.sourceNodeID),
    boundaryOutcome: null,
  }, revision));
  if (!rerouteAck?.success) throw new Error(`Reroute failed: ${JSON.stringify(rerouteAck)}`);

  const after = await reroutedPromise;
  const afterCompletedIntervals = after.dayPlan.completedPath?.intervals ?? [];
  const afterEarned = Number(after.progressSnapshot?.earnedPoints ?? 0);

  for (let index = 0; index < beforeCompletedIntervals.length; index += 1) {
    if (JSON.stringify(beforeCompletedIntervals[index]) !== JSON.stringify(afterCompletedIntervals[index])) {
      throw new Error(`Completed Day Graph history changed at immutable interval ${index}.`);
    }
  }
  if (afterEarned !== beforeEarned) {
    throw new Error(`Earned progress changed across reroute (${beforeEarned} -> ${afterEarned}).`);
  }
  if (after.dayPlan.completedPath?.intervals?.at(-1)?.endSecond !== decisionSecond) {
    throw new Error('Rerouted completed path does not terminate at the exact decision boundary.');
  }
  if (after.dayPlan.chosenPath?.intervals?.[0]?.startSecond !== decisionSecond) {
    throw new Error('Rerouted chosen future does not start at the exact decision boundary.');
  }

  console.log(JSON.stringify({
    success: true,
    skippedNodeID: futureInterval.sourceNodeID,
    planRevisionBefore: before.planRevision,
    planRevisionAfter: after.planRevision,
    earnedProgressBefore: beforeEarned,
    earnedProgressAfter: afterEarned,
    decisionSecond,
  }, null, 2));
} finally {
  socket.disconnect();
}
