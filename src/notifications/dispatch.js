import { activePlan, intervalStatuses, preferencesFor } from './store.js';
import { deliveryDecision, localClock, retryDelaySeconds, stillRelevant } from './policy.js';
export async function dispatchOne(client,n,push,now=new Date()) {
 // Serialize per-user budget decisions across backend replicas. The row lock
 // protects this event; this lock additionally protects distinct user events.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7319))',[String(n.user_id)]);
 const plan=await activePlan(client,n.day_map_id,n.user_id);
 const valid=stillRelevant(n,plan,plan?await intervalStatuses(client,plan.plan_id):new Map());
 if(!valid || new Date(n.expires_at)<=now) {
  await client.query(`UPDATE scheduler_notifications SET status=$2,push_state='suppressed' WHERE notification_id=$1`,[n.notification_id,valid?'expired':'cancelled']);return;
 }
 const prefs=await preferencesFor(client,n.user_id);
 const categoryEnabled=n.kind==='schedule_changed'||(n.kind==='preparation'?prefs.preparation_reminders:prefs.activity_reminders);
 if(!categoryEnabled) {await client.query(`UPDATE scheduler_notifications SET status='cancelled',push_state='suppressed' WHERE notification_id=$1`,[n.notification_id]);return;}
 await client.query(`UPDATE scheduler_notifications SET status='published',published_at=COALESCE(published_at,NOW()) WHERE notification_id=$1`,[n.notification_id]);
 if(n.push_state!=='pending')return;
 // Send to one current installation: the most recently active eligible device.
 // Never use a token whose account/device no longer has a valid login session.
 const devices=await client.query(`SELECT d.*, d.registered_at::text AS registration_version FROM notification_devices d
 WHERE d.user_id=$1 AND d.enabled AND EXISTS(SELECT 1 FROM auth_sessions a
  WHERE a.user_id=d.user_id AND a.device_id=d.device_id AND a.revoked_at IS NULL AND a.refresh_expires_at>NOW())
 ORDER BY d.updated_at DESC LIMIT 1`,[n.user_id]);
 const device=devices.rows[0];
 const foreground=await client.query(`SELECT 1 FROM notification_devices WHERE user_id=$1 AND foreground_until>NOW() LIMIT 1`,[n.user_id]);
 const recent=await client.query(`SELECT MAX(a.attempted_at) AS accepted_at FROM notification_delivery_attempts a
 JOIN scheduler_notifications n ON n.notification_id=a.notification_id
 WHERE n.user_id=$1 AND a.outcome='accepted' AND NOT n.explicit_reminder AND a.attempted_at>NOW()-interval '24 hours'
 GROUP BY a.notification_id`,[n.user_id]);
 const clock=localClock(plan.timezone,now);
 const decision=deliveryDecision({notification:n,preferences:prefs,graph:plan.graph_data,context:plan.routing_context,
  second:clock.second,now,recentAccepted:recent.rows.map(r=>r.accepted_at),foreground:foreground.rowCount>0});
 if(decision!=='send' || !device || !push.enabled) {
  // Quiet/coalesced events stay in the inbox rather than forming a wake-up backlog.
  await client.query(`UPDATE scheduler_notifications SET push_state='suppressed' WHERE notification_id=$1`,[n.notification_id]);
  return;
 }
 let result;
 try {result=await push.send({...n,map_date:plan.local_map_date},device,prefs);}
 catch {result={outcome:'permanent_failure',status:0,reason:'ProviderConfigurationError'};}
 await client.query(`INSERT INTO notification_delivery_attempts(notification_id,registration_id,outcome,provider_status,provider_reason)
 VALUES($1,$2,$3,$4,$5)`,[n.notification_id,device.registration_id,result.outcome,result.status,String(result.reason??'').slice(0,120)]);
 if(result.outcome==='invalid_token') await client.query(`UPDATE notification_devices SET enabled=FALSE
 WHERE registration_id=$1 AND registered_at=$2`,[device.registration_id,device.registration_version]);
 const retry=result.outcome==='retry' && n.attempt_count<5;
 await client.query(`UPDATE scheduler_notifications SET attempt_count=attempt_count+1,push_state=$2,
 retry_at=CASE WHEN $3::boolean THEN NOW()+$4*interval '1 second' ELSE NULL END WHERE notification_id=$1`,
 [n.notification_id,result.outcome==='accepted'?'accepted':retry?'pending':'failed',retry,retryDelaySeconds(n.attempt_count)]);
}
