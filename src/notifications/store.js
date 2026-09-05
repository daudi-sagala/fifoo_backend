import { randomUUID } from 'node:crypto';
import { DEFAULT_PREFERENCES, activityKey, localClock, plannedReminders, sanitizePreferences, stillRelevant } from './policy.js';
import { GameError } from '../lib/errors.js';
export async function preferencesFor(client,userID) {
 const r=await client.query('SELECT * FROM notification_preferences WHERE user_id=$1',[userID]);
 return {...DEFAULT_PREFERENCES,...r.rows[0]};
}
export async function updatePreferences(client,userID,payload) {
 let changes;try{changes=sanitizePreferences(payload);}catch(e){throw new GameError('invalid_payload',e.message);}
 await client.query('INSERT INTO notification_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userID]);
 const keys=Object.keys(changes);
 if(keys.length) await client.query(`UPDATE notification_preferences SET ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')},updated_at=NOW() WHERE user_id=$1`,[userID,...keys.map(k=>changes[k])]);
 return preferencesFor(client,userID);
}
export async function registerDevice(client,userID,deviceID,payload,topic) {
 const token=String(payload.token??'').toLowerCase();
 if(!/^[0-9a-f]{32,512}$/.test(token)||!['sandbox','production'].includes(payload.environment)||!topic)throw new GameError('invalid_payload','A device token, APNs environment and configured topic are required.');
 // Reassociation removes the previous account's association with this token.
 await client.query('DELETE FROM notification_devices WHERE token=$1 AND environment=$2 AND topic=$3 AND (user_id<>$4 OR device_id<>$5)',[token,payload.environment,topic,userID,deviceID]);
 await client.query(`INSERT INTO notification_devices(user_id,device_id,token,environment,topic)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,device_id,environment,topic)
  DO UPDATE SET token=EXCLUDED.token,enabled=TRUE,registered_at=NOW(),updated_at=NOW()`,[userID,deviceID,token,payload.environment,topic]);
}
export async function activePlan(client,dayMapID,userID) {
 return (await client.query(`SELECT p.*,dm.timezone,dm.map_date::text AS local_map_date
 FROM day_plan_versions p JOIN day_maps dm USING(day_map_id)
 WHERE p.day_map_id=$1 AND p.user_id=$2 AND p.plan_status='active' ORDER BY p.plan_revision DESC LIMIT 1`,[dayMapID,userID])).rows[0];
}
export async function intervalStatuses(client,planID) {
 const r=await client.query(`SELECT i.algorithm_interval_id,COALESCE(l.outcome_status,i.lifecycle_status) AS lifecycle_status
 FROM day_plan_intervals i LEFT JOIN LATERAL (SELECT outcome_status FROM progress_ledger_entries
 WHERE plan_interval_id=i.plan_interval_id ORDER BY recorded_at DESC,ledger_entry_id DESC LIMIT 1) l ON TRUE
 WHERE i.plan_id=$1`,[planID]);
 return new Map(r.rows.map(i=>[String(i.algorithm_interval_id),i.lifecycle_status]));
}
export async function reconcilePlan(client,plan) {
 const reminders=plannedReminders(plan.graph_data);
 const statuses=await intervalStatuses(client,plan.plan_id);
 const retained=[];
 for(const n of reminders) {
  if(!stillRelevant({plan_id:plan.plan_id,activity_key:n.activityKey,start_second:n.startSecond,kind:n.kind},plan,statuses))continue;
  retained.push(n.semanticKey);
  await client.query(`INSERT INTO scheduler_notifications(user_id,day_map_id,plan_id,plan_revision,semantic_key,activity_key,
   source_node_id,interval_id,kind,title,body,start_second,due_at,expires_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
   (($13::date + $14 * interval '1 second') AT TIME ZONE $15),
   (($13::date + $16 * interval '1 second') AT TIME ZONE $15))
  ON CONFLICT(user_id,day_map_id,semantic_key) DO UPDATE SET
   plan_id=EXCLUDED.plan_id,plan_revision=EXCLUDED.plan_revision,interval_id=EXCLUDED.interval_id,
   start_second=EXCLUDED.start_second,title=EXCLUDED.title,body=EXCLUDED.body,expires_at=EXCLUDED.expires_at,
   due_at=CASE WHEN scheduler_notifications.status='published' THEN scheduler_notifications.due_at ELSE EXCLUDED.due_at END,
   status=CASE WHEN scheduler_notifications.status IN ('cancelled','expired') AND EXCLUDED.expires_at>NOW() THEN 'queued' ELSE scheduler_notifications.status END`,
   [plan.user_id,plan.day_map_id,plan.plan_id,plan.plan_revision,n.semanticKey,n.activityKey,n.sourceNodeID,n.intervalID,
    n.kind,n.title,n.body,n.startSecond,plan.local_map_date,n.dueSecond,plan.timezone,n.expirySecond]);
 }
 await client.query(`UPDATE scheduler_notifications SET status='cancelled',push_state='suppressed'
  WHERE day_map_id=$1 AND NOT explicit_reminder AND kind<>'schedule_changed'
  AND NOT (semantic_key=ANY($2::text[])) AND status IN ('queued','published')`,[plan.day_map_id,retained]);
 // Explicit reminders survive a harmless revision, but never a moved/deleted activity.
 const explicit=await client.query(`SELECT * FROM scheduler_notifications WHERE day_map_id=$1 AND explicit_reminder AND status='queued'`,[plan.day_map_id]);
 for(const n of explicit.rows) {
  const valid=stillRelevant({...n,plan_id:plan.plan_id},plan,statuses);
  await client.query(`UPDATE scheduler_notifications SET plan_id=$2,plan_revision=$3,status=$4 WHERE notification_id=$1`,[n.notification_id,plan.plan_id,plan.plan_revision,valid?'queued':'cancelled']);
 }
 if(plan.parent_plan_id && plan.reroute_reason) await client.query(`INSERT INTO scheduler_notifications
  (user_id,day_map_id,plan_id,plan_revision,semantic_key,kind,title,body,due_at,expires_at,push_state)
  VALUES($1,$2,$3,$4,$5,'schedule_changed','Schedule updated','Open your schedule to review the next stops.',NOW(),NOW()+interval '1 day','suppressed')
  ON CONFLICT DO NOTHING`,[plan.user_id,plan.day_map_id,plan.plan_id,plan.plan_revision,`plan:${plan.plan_revision}`]);
}
export async function listInbox(client,userID) {
 const p=await preferencesFor(client,userID);
 const r=await client.query(`SELECT n.notification_id::text AS id,n.title,n.body,n.kind,n.read_at::text,n.published_at::text,
  n.source_node_id::text,n.interval_id::text,n.plan_revision,dm.map_date::text AS map_date,
  (n.status='published' AND n.expires_at>NOW() AND pv.plan_status='active') AS current
 FROM scheduler_notifications n JOIN day_maps dm USING(day_map_id) JOIN day_plan_versions pv ON pv.plan_id=n.plan_id
 WHERE n.user_id=$1 AND n.published_at IS NOT NULL ORDER BY n.published_at DESC LIMIT 60`,[userID]);
 return {preferences:p,items:r.rows};
}

export async function createExplicitReminder(client,userID,payload,now=new Date()) {
 const mapDate=String(payload.mapDate??'');
 const intervalID=String(payload.intervalID??'');
 const requestID=String(payload.requestID??'');
 const minutesBefore=Number(payload.minutesBefore);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(mapDate))throw new GameError('invalid_payload','A schedule date is required.');
 if(!/^[0-9a-f-]{36}$/i.test(intervalID))throw new GameError('invalid_payload','A valid route interval is required.');
 if(!/^[0-9a-f-]{36}$/i.test(requestID))throw new GameError('invalid_payload','A reminder request ID is required.');
 if(!Number.isInteger(minutesBefore)||minutesBefore<0||minutesBefore>1440)throw new GameError('invalid_payload','Reminder timing is invalid.');
 const plan=(await client.query(`SELECT p.*,dm.timezone,dm.map_date::text AS local_map_date
  FROM day_plan_versions p JOIN day_maps dm USING(day_map_id)
  WHERE p.user_id=$1 AND dm.map_date=$2::date AND p.plan_status='active'
  ORDER BY p.plan_revision DESC LIMIT 1`,[userID,mapDate])).rows[0];
 if(!plan)throw new GameError('not_found','This schedule is no longer available.');
 const interval=(plan.graph_data?.chosenPath?.intervals??[]).find(i=>String(i.intervalID)===intervalID);
 if(!interval)throw new GameError('conflict','This stop is no longer on the chosen schedule.');
 const status=(await intervalStatuses(client,plan.plan_id)).get(intervalID) ?? interval.lifecycleStatus;
 if(['completed','partiallyCompleted','skipped','superseded','cancelledByConstraint','cancelled'].includes(status))
  throw new GameError('conflict','This stop is already finished or no longer scheduled.');
 const clock=localClock(plan.timezone??'UTC',now);
 const dueSecond=Math.max(0,Number(interval.startSecond)-minutesBefore*60);
 if(clock.mapDate===mapDate && dueSecond<=clock.second)throw new GameError('conflict','Choose a reminder time that is still in the future.');
 if(mapDate<clock.mapDate)throw new GameError('conflict','This schedule is in the past.');
 const endSecond=Math.min(86400,Math.max(Number(interval.endSecond),Number(interval.startSecond)+1));
 const key=activityKey(interval);
 const title=String(interval.metadata?.displayTitle??interval.metadata?.title??({meal:'Meal',workout:'Workout',task:'Task',sleep:'Sleep',nap:'Nap',fasting:'Fasting'}[interval.intervalKind]??'Scheduled stop')).slice(0,120);
 const body='Open this stop.';
 await client.query(`INSERT INTO scheduler_notifications(notification_id,user_id,day_map_id,plan_id,plan_revision,semantic_key,
  activity_key,source_node_id,interval_id,kind,title,body,start_second,due_at,expires_at,explicit_reminder)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'activity',$10,$11,$12,
   (($13::date + $14 * interval '1 second') AT TIME ZONE $15),
   (($13::date + $16 * interval '1 second') AT TIME ZONE $15),TRUE)
  ON CONFLICT(user_id,day_map_id,semantic_key) DO NOTHING`,
  [randomUUID(),userID,plan.day_map_id,plan.plan_id,plan.plan_revision,`explicit:${requestID}`,key,interval.sourceNodeID??null,interval.intervalID,title,body,interval.startSecond,mapDate,dueSecond,plan.timezone,endSecond]);
 return {message:`Reminder added for ${minutesBefore===0?'the start time':`${minutesBefore} minutes before`}.`,current:true,
  sourceNodeID:interval.sourceNodeID??null,mapDate};
}

export async function notificationAction(client,userID,payload,now=new Date()) {
 if(!/^[0-9a-f-]{36}$/i.test(String(payload.id??'')))throw new GameError('invalid_payload','Invalid notification ID.');
 const n=(await client.query('SELECT * FROM scheduler_notifications WHERE notification_id=$1 AND user_id=$2 FOR UPDATE',[payload.id,userID])).rows[0];
 if(!n)throw new GameError('not_found','Notification is not available.');
 const plan=await activePlan(client,n.day_map_id,userID);
 const today=localClock(plan?.timezone ?? 'UTC',now).mapDate;
 const current=Boolean(plan && plan.local_map_date===today && ['queued','published'].includes(n.status ?? 'published')
  && stillRelevant(n,plan,await intervalStatuses(client,plan.plan_id)) && new Date(n.expires_at)>now);
 if(payload.action==='snooze') {
  if(!current || n.kind==='schedule_changed')throw new GameError('conflict','This stop has changed. Open your current schedule.');
  if(!/^[0-9a-f-]{36}$/i.test(String(payload.requestID??''))) throw new GameError('invalid_payload','A reminder request ID is required.');
  // Fixed ten-minute reminder. It never edits the route or extends activity expiry.
  const due=new Date(now.getTime()+600000);
  if(due>=new Date(n.expires_at))throw new GameError('conflict','This stop ends before that reminder. Open your schedule.');
  await client.query(`INSERT INTO scheduler_notifications(notification_id,user_id,day_map_id,plan_id,plan_revision,semantic_key,
   activity_key,source_node_id,interval_id,kind,title,body,start_second,due_at,expires_at,explicit_reminder)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE) ON CONFLICT DO NOTHING`,
   [randomUUID(),userID,n.day_map_id,n.plan_id,n.plan_revision,`snooze:${payload.requestID}`,n.activity_key,n.source_node_id,n.interval_id,n.kind,n.title,n.body,n.start_second,due,n.expires_at]);
 } else if(!['read','open'].includes(payload.action))throw new GameError('invalid_payload','Unsupported notification action.');
 await client.query('UPDATE scheduler_notifications SET read_at=COALESCE(read_at,NOW()) WHERE notification_id=$1 AND user_id=$2',[n.notification_id,userID]);
 return {current,sourceNodeID:current?n.source_node_id:null,mapDate:current?plan.local_map_date:today,
  message:current?'Open the scheduled stop.':'This activity has changed. Open your current schedule.'};
}
