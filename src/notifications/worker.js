import { pool, withTransaction } from '../db.js';
import { logger } from '../lib/logger.js';
import { createAPNsProvider } from './apns.js';
import { activePlan, reconcilePlan } from './store.js';
import { dispatchOne } from './dispatch.js';
export { dispatchOne } from './dispatch.js';
let timer=null,running=false,provider;
export async function notificationTick(push=provider,transaction=withTransaction) {
 if(running)return {skipped:true};running=true;
 let plans=0,events=0;
 try {
  // Work is bounded; transactions roll back and leave the job available on error.
  for(let i=0;i<30;i++) {
   const found=await transaction(async client=>{
    const job=(await client.query(`SELECT j.day_map_id,dm.user_id FROM notification_plan_jobs j
      JOIN day_maps dm USING(day_map_id) ORDER BY j.requested_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`)).rows[0];
    if(!job)return false;
    const plan=await activePlan(client,job.day_map_id,job.user_id);
    if(plan)await reconcilePlan(client,plan);
    await client.query('DELETE FROM notification_plan_jobs WHERE day_map_id=$1',[job.day_map_id]);return true;
   });
   if(!found)break;plans++;
  }
  for(let i=0;i<40;i++) {
   const found=await transaction(async client=>{
    const n=(await client.query(`SELECT * FROM scheduler_notifications
     WHERE due_at<=NOW() AND (status='queued' OR (status='published' AND push_state='pending'))
      AND (retry_at IS NULL OR retry_at<=NOW()) ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if(!n)return false;await dispatchOne(client,n,push);return true;
   });
   if(!found)break;events++;
  }
  return {plans,events};
 } finally {running=false;}
}
export function startNotificationWorker() {
 if(timer || process.env.NOTIFICATION_SCHEDULER_ENABLED==='false')return;
 try {provider=createAPNsProvider();}catch(error){logger.error('APNs configuration error',{message:error.message});provider={enabled:false};}
 const tick=()=>notificationTick().catch(error=>logger.error('notification worker failed',{message:error.message}));
 timer=setInterval(tick,Math.max(5000,Number(process.env.NOTIFICATION_TICK_MS)||15000));timer.unref?.();tick();
}
export function stopNotificationWorker(){if(timer)clearInterval(timer);timer=null;}
