import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePreferences, registerDevice, notificationAction, reconcilePlan } from '../src/notifications/store.js';
import { dispatchOne } from '../src/notifications/dispatch.js';
const user='11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
const interval={sourceNodeID:'33333333-3333-4333-8333-333333333333',intervalID:id,intervalKind:'meal',startSecond:45000,endSecond:48000,lifecycleStatus:'planned'};
const plan={plan_id:'plan',day_map_id:'map',user_id:user,plan_revision:2,timezone:'America/New_York',local_map_date:'2026-09-05',graph_data:{chosenPath:{intervals:[interval]}}};
function fake(overrides={}) {
 const calls=[];
 return {calls,async query(sql,args=[]) {
  calls.push({sql,args});
  for(const [fragment,result] of Object.entries(overrides))if(sql.includes(fragment))return typeof result==='function'?result(sql,args):result;
  return {rowCount:0,rows:[]};
 }};
}
const row=(value)=>({rowCount:1,rows:[value]});
test('preference update uses only whitelisted bound keys and authenticated user',async()=>{
 const db=fake();await updatePreferences(db,user,{push_enabled:true,user_id:'attacker'});
 const update=db.calls.find(c=>c.sql.startsWith('UPDATE'));assert.equal(update.args[0],user);assert.equal(update.sql.includes('attacker'),false);assert.equal(update.args[1],true);
});
test('device registration binds installation to authenticated identity, not payload user',async()=>{
 const db=fake();await registerDevice(db,user,'installation',{token:'ab'.repeat(32),environment:'production',userID:'attacker'},'topic');
 const insert=db.calls.find(c=>c.sql.includes('INSERT INTO notification_devices'));assert.deepEqual(insert.args.slice(0,2),[user,'installation']);
 assert.ok(db.calls.some(c=>c.sql.includes('DELETE FROM notification_devices')));
});
test('malformed token and unconfigured topic are rejected',async()=>{
 const db=fake();await assert.rejects(registerDevice(db,user,'device',{token:'invalid',environment:'production'},'topic'));
 await assert.rejects(registerDevice(db,user,'device',{token:'ab'.repeat(32),environment:'production'},''));assert.equal(db.calls.length,0);
});
test('inbox action cannot read another account notification',async()=>{
 const db=fake();await assert.rejects(notificationAction(db,user,{id,action:'open'}),/not available/);
 assert.equal(db.calls[0].args[1],user);assert.match(db.calls[0].sql,/user_id=\$2/);
});
test('snooze preserves schedule and expiry and is idempotent by request ID',async()=>{
 const now=Date.parse('2026-09-05T16:00:00Z');const n={notification_id:id,user_id:user,day_map_id:'map',plan_id:'plan',plan_revision:2,
  activity_key:interval.sourceNodeID,start_second:45000,kind:'activity',expires_at:new Date(now+3600000),title:'Meal',body:'Open',source_node_id:interval.sourceNodeID,interval_id:id};
 const db=fake({'SELECT * FROM scheduler_notifications':row(n),'SELECT p.*':row(plan)});
 const requestID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 await notificationAction(db,user,{id,action:'snooze',requestID},new Date(now));
 const insert=db.calls.find(c=>c.sql.includes('INSERT INTO scheduler_notifications'));assert.ok(insert);assert.match(insert.sql,/ON CONFLICT DO NOTHING/);
 assert.equal(insert.args[5],`snooze:${requestID}`);assert.equal(insert.args[14],n.expires_at);
 assert.equal(db.calls.some(c=>/UPDATE day_|INSERT INTO day_/.test(c.sql)),false);
});
test('stale push action returns current schedule instead of an obsolete activity',async()=>{
 const n={notification_id:id,day_map_id:'map',plan_id:'old',kind:'activity',expires_at:new Date(Date.now()+60000)};
 const db=fake({'SELECT * FROM scheduler_notifications':row(n),'SELECT p.*':row(plan)});
 const result=await notificationAction(db,user,{id,action:'open'});assert.equal(result.current,false);assert.equal(result.sourceNodeID,null);
});
test('planner reschedules queued intents with timezone-aware SQL in the caller transaction',async()=>{
 const db=fake();await reconcilePlan(db,plan);
 const call=db.calls.find(c=>c.sql.includes('INSERT INTO scheduler_notifications'));
 assert.match(call.sql,/AT TIME ZONE/);assert.equal(call.args[14],'America/New_York');assert.match(call.sql,/ON CONFLICT/);
 assert.equal(db.calls.some(c=>/^(BEGIN|COMMIT)/.test(c.sql)),false);
});
test('superseded notification is cancelled before invoking APNs',async()=>{
 const db=fake({'SELECT p.*':row(plan)});let called=false;
 await dispatchOne(db,{notification_id:id,user_id:user,day_map_id:'map',plan_id:'old',expires_at:new Date(Date.now()+60000)}, {enabled:true,send(){called=true;}});
 assert.equal(called,false);assert.ok(db.calls.some(c=>c.args.includes('cancelled')));
});
test('accepted delivery is recorded separately from notification read status',async()=>{
 const n={notification_id:id,user_id:user,day_map_id:'map',plan_id:'plan',activity_key:interval.sourceNodeID,kind:'activity',
 start_second:45000,expires_at:'2026-09-05T20:00:00Z',push_state:'pending',attempt_count:0};
 const db=fake({'SELECT p.*':row(plan),'SELECT * FROM notification_preferences':row({push_enabled:true}),
  'SELECT d.*':row({registration_id:'device',topic:'topic',registration_version:'2026-09-01'})});
 await dispatchOne(db,n,{enabled:true,async send(){return {outcome:'accepted',status:200,reason:''};}},new Date('2026-09-05T16:00:00Z'));
 assert.ok(db.calls.some(c=>c.sql.includes('pg_advisory_xact_lock')));
 assert.ok(db.calls.some(c=>c.sql.includes('INSERT INTO notification_delivery_attempts')&&c.args[2]==='accepted'));
 assert.equal(db.calls.some(c=>c.sql.includes('read_at=')),false);
});
