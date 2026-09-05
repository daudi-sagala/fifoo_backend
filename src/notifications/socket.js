import { withTransaction } from '../db.js';
import { GameError, failureAck } from '../lib/errors.js';
import { createTokenWindow } from '../http/rateLimit.js';
import { listInbox, notificationAction, registerDevice, updatePreferences } from './store.js';
export const SCHEDULER_EVENTS=Object.freeze({state:'game:scheduler:state',preferences:'game:scheduler:preferences',
 device:'game:scheduler:device',presence:'game:scheduler:presence',unregister:'game:scheduler:unregister',action:'game:scheduler:action'});
const limiter=createTokenWindow({name:'scheduler-socket',limit:120,windowMs:60000});
export function registerSchedulerSocket(socket) {
 const handle=(event,work)=>socket.on(event,async(payload={},ack)=>{
  if(typeof ack!=='function')return;
  try {
   const userID=socket.data.authUserID,deviceID=socket.data.deviceID;
   if(!userID || !deviceID)throw new GameError('unauthorized','Sign in to use your schedule.');
   if(!limiter.consume(userID).allowed)throw new GameError('rate_limited','Too many requests.');
   if(!payload || typeof payload!=='object' || Array.isArray(payload)||JSON.stringify(payload).length>8192)throw new GameError('invalid_payload','Invalid scheduler request.');
   const value=await withTransaction(c=>work(c,userID,deviceID,payload));ack({success:true,...value});
  }catch(error){ack(failureAck(error));}
 });
 handle(SCHEDULER_EVENTS.state,async(c,u)=>listInbox(c,u));
 handle(SCHEDULER_EVENTS.preferences,async(c,u,_d,p)=>({preferences:await updatePreferences(c,u,p)}));
 handle(SCHEDULER_EVENTS.device,async(c,u,d,p)=>{await registerDevice(c,u,d,p,process.env.APNS_TOPIC??'');return {};});
 handle(SCHEDULER_EVENTS.presence,async(c,u,d,p)=>{
  await c.query(`UPDATE notification_devices SET foreground_until=CASE WHEN $3::boolean THEN NOW()+interval '75 seconds' ELSE NULL END,
   updated_at=NOW() WHERE user_id=$1 AND device_id=$2`,[u,d,p.active===true]);return {};
 });
 handle(SCHEDULER_EVENTS.unregister,async(c,u,d)=>{await c.query('DELETE FROM notification_devices WHERE user_id=$1 AND device_id=$2',[u,d]);return {};});
 handle(SCHEDULER_EVENTS.action,async(c,u,_d,p)=>notificationAction(c,u,p));
}
