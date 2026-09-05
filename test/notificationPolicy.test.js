import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, activityKey, inWindow, localClock, quietNow, plannedReminders,
 stillRelevant, deliveryDecision, sanitizePreferences, classifyAPNs, retryDelaySeconds } from '../src/notifications/policy.js';
const now=new Date('2026-09-05T16:00:00Z');
const meal={intervalID:'meal',sourceNodeID:'node',candidateKey:'breakfast',intervalKind:'meal',startSecond:45000,endSecond:46800,lifecycleStatus:'planned'};
const graph={chosenPath:{intervals:[meal],systemStateIntervals:[]}};
const prefs={...DEFAULT_PREFERENCES,push_enabled:true};
const n={plan_id:'plan',activity_key:'node',kind:'activity',start_second:45000,expires_at:'2026-09-05T17:00:00Z',explicit_reminder:false};
const decision=(changes={})=>deliveryDecision({notification:n,preferences:prefs,graph,context:{},second:43200,now,...changes});
test('scheduler creates reminders for decision activities, not hourly Sleep/Fasting or alternate consequences',()=>{
 const g={chosenPath:{intervals:[meal,{intervalID:'s',intervalKind:'sleep',startSecond:0,endSecond:20000},
 {sourceNodeID:'fast-node',intervalKind:'fasting',startSecond:20000,endSecond:25000},
 {...meal,sourceNodeID:'skipped',lifecycleStatus:'skipped'}]},alternativeBranches:[{intervals:[{...meal,sourceNodeID:'alt'}]}]};
 assert.equal(plannedReminders(g).length,1);assert.equal(plannedReminders(g)[0].dueSecond,44400);
});
test('preparation has an actionable title and 15-minute lead time',()=>{
 const r=plannedReminders({chosenPath:{intervals:[{...meal,intervalKind:'task',metadata:{displayTitle:'Prepare lunch'}}]}})[0];
 assert.equal(r.kind,'preparation');assert.equal(r.dueSecond,44100);assert.match(r.body,/Open/);
});
test('reminder semantic key survives a plan revision',()=>{
 assert.equal(plannedReminders(graph)[0].semanticKey,plannedReminders({chosenPath:{intervals:[{...meal,intervalID:'new'}]}})[0].semanticKey);
});
test('policy defaults to push opt-out',()=>assert.equal(DEFAULT_PREFERENCES.push_enabled,false));
test('valid opted-in event is sent',()=>assert.equal(decision(),'send'));
test('no push when preferences are off',()=>assert.equal(decision({preferences:DEFAULT_PREFERENCES}),'disabled'));
test('quiet interval crosses midnight correctly',()=>{
 assert.equal(inWindow(23*3600,22*3600,7*3600),true);assert.equal(inWindow(6*3600,22*3600,7*3600),true);assert.equal(inWindow(12*3600,22*3600,7*3600),false);
});
test('custom quiet period suppresses delivery',()=>assert.equal(decision({preferences:{...prefs,quiet_start_minute:700,quiet_end_minute:800}}),'quiet'));
test('daytime sleep and naps suppress delivery',()=>{
 for(const kind of ['sleep','nap'])assert.equal(decision({graph:{chosenPath:{intervals:[{intervalKind:kind,startSecond:40000,endSecond:50000}]}}}),'quiet');
});
test('fasting does not make a user busy or silence normal reminders',()=>assert.equal(decision({graph:{chosenPath:{intervals:[{intervalKind:'fasting',startSecond:40000,endSecond:50000}]}}}),'send'));
test('foreground activity uses inbox, not duplicate push',()=>assert.equal(decision({foreground:true}),'foreground'));
test('budget counts automatic notifications',()=>assert.equal(decision({recentAccepted:[now,now,now]}),'budget'));
test('minimum spacing is enforced',()=>assert.equal(decision({recentAccepted:[new Date(now-600000)]}),'spacing'));
test('explicit reminder bypasses automatic budget but not sleep',()=>{
 assert.equal(decision({notification:{...n,explicit_reminder:true},recentAccepted:[now,now,now]}),'send');
 assert.equal(decision({notification:{...n,explicit_reminder:true},context:{sleepWindows:[{startSecond:40000,endSecond:50000}]}}),'quiet');
});
test('expired messages are not sent',()=>assert.equal(decision({notification:{...n,expires_at:'2026-09-04T00:00:00Z'}}),'expired'));
test('route changes are inbox-only',()=>assert.equal(decision({notification:{...n,kind:'schedule_changed'}}),'inbox_only'));
test('disabled categories are enforced separately',()=>assert.equal(decision({preferences:{...prefs,activity_reminders:false}}),'category_disabled'));
test('a superseded plan cannot validate a notification',()=>assert.equal(stillRelevant(n,{plan_id:'other',graph_data:graph}),false));
test('moved or completed activities invalidate their old reminder',()=>{
 assert.equal(stillRelevant({...n,start_second:40000},{plan_id:'plan',graph_data:graph}),false);
 assert.equal(stillRelevant(n,{plan_id:'plan',graph_data:graph},new Map([['meal','completed']])),false);
 assert.equal(stillRelevant(n,{plan_id:'plan',graph_data:graph}),true);
});
test('unknown and unsafe preference fields never reach SQL',()=>{
 assert.deepEqual(sanitizePreferences({user_id:'other',admin:true}),{});
 for(const patch of [{push_enabled:'yes'},{daily_limit:99},{min_spacing_minutes:0},{quiet_start_minute:600}])assert.throws(()=>sanitizePreferences(patch));
 assert.deepEqual(sanitizePreferences({quiet_start_minute:null,quiet_end_minute:null}),{quiet_start_minute:null,quiet_end_minute:null});
});
test('timezone mapping handles DST and third-shift dates',()=>{
 assert.deepEqual(localClock('America/New_York',new Date('2026-03-08T07:30:00Z')),{mapDate:'2026-03-08',second:12600});
 assert.deepEqual(localClock('America/New_York',new Date('2026-11-01T06:30:00Z')),{mapDate:'2026-11-01',second:5400});
 assert.equal(localClock('Pacific/Auckland',now).mapDate,'2026-09-06');
});
test('APNs failures have bounded retry/permanent/token classifications',()=>{
 assert.equal(classifyAPNs(200,''),'accepted');assert.equal(classifyAPNs(410,'Unregistered'),'invalid_token');
 assert.equal(classifyAPNs(400,'BadDeviceToken'),'invalid_token');assert.equal(classifyAPNs(403,'InvalidProviderToken'),'permanent_failure');
 assert.equal(classifyAPNs(429,''),'retry');assert.equal(classifyAPNs(503,''),'retry');assert.equal(classifyAPNs(0,''),'retry');
 assert.equal(retryDelaySeconds(100),900);
});

test('an actually active workout suppresses routine pushes, but a planned workout does not',()=>{
 assert.equal(decision({graph:{chosenPath:{intervals:[{...meal,intervalKind:'workout',lifecycleStatus:'active',startSecond:42000}]}}}),'active_workout');
 assert.equal(decision({graph:{chosenPath:{intervals:[{...meal,intervalKind:'workout',lifecycleStatus:'planned',startSecond:42000}]}}}),'send');
});
test('partial recorded activity outcomes invalidate upcoming reminders',()=>{
 assert.equal(stillRelevant(n,{plan_id:'plan',graph_data:graph},new Map([['meal','partiallyCompleted']])),false);
});
