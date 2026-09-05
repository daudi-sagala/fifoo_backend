/** Stable visual identities only. Never use these keys as progress/ledger IDs. */
export function presentationIdentity(interval, {mapDate, scope='primary'}={}) {
  if(interval.sourceNodeID) return `${mapDate}:${scope}:node:${interval.sourceNodeID}`;
  const kind=interval.metadata?.presentationKind ?? interval.intervalKind;
  const cycle=Number(interval.metadata?.cycleStartSecond ?? 0);
  // Clipping a current interval at now must not create a new visual activity.
  const hour=Math.floor((Number(interval.startSecond)-cycle)/3600);
  return `${mapDate}:${scope}:system:${kind}:${cycle}:${hour}`;
}
