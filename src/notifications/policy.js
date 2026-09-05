/** Pure scheduler policy. No health advice, notification-driven progress, or network calls. */
export const DEFAULT_PREFERENCES = Object.freeze({
 push_enabled: false, activity_reminders: true, preparation_reminders: true,
 discreet: true, sound_enabled: true, daily_limit: 3, min_spacing_minutes: 90,
 quiet_start_minute: null, quiet_end_minute: null,
});
const terminal = new Set(['completed','partiallyCompleted','skipped','superseded','cancelledByConstraint','cancelled']);
export function activityKey(interval) {
 return String(interval.sourceNodeID ?? interval.candidateKey ?? interval.key ?? interval.intervalID);
}
export function primaryIntervals(graph) {
 return [...(graph?.completedPath?.intervals ?? []), ...(graph?.chosenPath?.intervals ?? [])];
}
export function inWindow(second, start, end) {
 return start <= end ? second >= start && second < end : second >= start || second < end;
}
export function localClock(timeZone, now = new Date()) {
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
 }).formatToParts(now).map(p=>[p.type,p.value]));
 return { mapDate:`${parts.year}-${parts.month}-${parts.day}`,second:Number(parts.hour)%24*3600+Number(parts.minute)*60+Number(parts.second) };
}
export function quietNow({preferences, graph, context = {}, second}) {
 const {quiet_start_minute:a,quiet_end_minute:b}=preferences;
 if(a!=null && b!=null && a!==b && inWindow(second,a*60,b*60)) return true;
 const states = [...primaryIntervals(graph), ...(graph?.chosenPath?.systemStateIntervals ?? [])];
 if(states.some(i=>['sleep','nap'].includes(i.metadata?.presentationKind ?? i.intervalKind)
  && inWindow(second,i.startSecond,i.endSecond))) return true;
 // Respect explicit overrides and known sleep windows, not a guessed fixed night.
 return (context.sleepWindows ?? []).some(w=>inWindow(second,w.startSecond,w.endSecond));
}
export function plannedReminders(graph) {
 return (graph?.chosenPath?.intervals ?? []).filter(i=>i.sourceNodeID
  && !terminal.has(i.lifecycleStatus) && !['sleep','nap','fasting','freeTime'].includes(i.intervalKind))
 .map(i=>{
  const preparation = Boolean(i.metadata?.supportTask || i.metadata?.supportActivity || i.metadata?.prerequisiteFor)
   || /prep|grocery|shopping/i.test(i.metadata?.displayTitle ?? i.key ?? '');
  const title = String(i.metadata?.displayTitle ?? i.metadata?.title ?? ({meal:'Meal',workout:'Workout',task:'Task'}[i.intervalKind] ?? 'Activity')).slice(0,120);
  const key=activityKey(i);
  return {semanticKey:`${key}:upcoming`,activityKey:key,sourceNodeID:i.sourceNodeID,intervalID:i.intervalID,
   kind:preparation?'preparation':'activity',title,body:preparation?'Open the preparation steps.':'Open this stop or set a reminder.',
   startSecond:i.startSecond,dueSecond:Math.max(0,i.startSecond-(preparation?900:600)),
   expirySecond:Math.min(86400,i.endSecond)};
 });
}
export function stillRelevant(notification, plan, intervalStatuses = new Map()) {
 if(!plan || String(notification.plan_id)!==String(plan.plan_id)) return false;
 if(notification.kind==='schedule_changed') return true;
 const interval=(plan.graph_data?.chosenPath?.intervals ?? []).find(i=>activityKey(i)===notification.activity_key);
 return Boolean(interval && !terminal.has(intervalStatuses.get(interval.intervalID) ?? interval.lifecycleStatus)
   && Number(interval.startSecond)===Number(notification.start_second));
}
export function deliveryDecision({notification, preferences, graph, context, second, now, recentAccepted = [], foreground = false}) {
 if(new Date(notification.expires_at)<=now) return 'expired';
 if(!preferences.push_enabled) return 'disabled';
 if(notification.kind==='schedule_changed') return 'inbox_only';
 if(notification.kind==='preparation'?!preferences.preparation_reminders:!preferences.activity_reminders) return 'category_disabled';
 if(foreground) return 'foreground';
 if(primaryIntervals(graph).some(i=>i.intervalKind==='workout' && ['active','inProgress'].includes(i.lifecycleStatus)
  && inWindow(second,i.startSecond,i.endSecond))) return 'active_workout';
 if(quietNow({preferences,graph,context,second})) return 'quiet';
 if(!notification.explicit_reminder) {
  if(recentAccepted.length>=preferences.daily_limit) return 'budget';
  if(recentAccepted.some(d=>now-new Date(d)<preferences.min_spacing_minutes*60000)) return 'spacing';
 }
 return 'send';
}
export function sanitizePreferences(payload = {}) {
 const out={};
 for(const k of ['push_enabled','activity_reminders','preparation_reminders','discreet','sound_enabled']) {
  if(k in payload) { if(typeof payload[k]!=='boolean') throw new Error(`Invalid ${k}`); out[k]=payload[k]; }
 }
 for(const [k,min,max] of [['daily_limit',0,8],['min_spacing_minutes',15,720]]) {
  if(k in payload) { if(!Number.isInteger(payload[k])||payload[k]<min||payload[k]>max) throw new Error(`Invalid ${k}`);out[k]=payload[k]; }
 }
 if('quiet_start_minute' in payload || 'quiet_end_minute' in payload) {
  for(const k of ['quiet_start_minute','quiet_end_minute']) {
   const v=payload[k];if(v!==null && (!Number.isInteger(v)||v<0||v>1439))throw new Error('Both quiet times are required');out[k]=v;
  }
  if((out.quiet_start_minute===null)!==(out.quiet_end_minute===null)) throw new Error('Both quiet times are required');
 }
 return out;
}
export function retryDelaySeconds(attempt) { return Math.min(900,15*2**Math.min(attempt,6)); }
export function classifyAPNs(status, reason) {
 if(status===200)return 'accepted';
 if(status===410 || reason==='Unregistered' || reason==='BadDeviceToken' || reason==='DeviceTokenNotForTopic') return 'invalid_token';
 if(status===429 || status>=500 || status===0)return 'retry';
 return 'permanent_failure';
}
