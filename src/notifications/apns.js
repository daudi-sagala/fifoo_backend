import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { classifyAPNs } from './policy.js';
export function apnsConfiguration(env=process.env) {
 return {enabled:env.APNS_ENABLED==='true',topic:env.APNS_TOPIC ?? '',teamID:env.APNS_TEAM_ID ?? '',keyID:env.APNS_KEY_ID ?? '',
  privateKey:env.APNS_PRIVATE_KEY?.replace(/\\n/g,'\n') ?? (env.APNS_KEY_PATH?readFileSync(env.APNS_KEY_PATH,'utf8'):''),
  timeoutMs:10000};
}
export function providerJWT(config, nowSeconds=Math.floor(Date.now()/1000)) {
 const header=Buffer.from(JSON.stringify({alg:'ES256',kid:config.keyID})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({iss:config.teamID,iat:nowSeconds})).toString('base64url');
 const input=`${header}.${payload}`;
 const signature=sign('sha256',Buffer.from(input),{key:createPrivateKey(config.privateKey),dsaEncoding:'ieee-p1363'}).toString('base64url');
 return `${input}.${signature}`;
}
export function notificationPayload(n, prefs) {
 return {aps:{alert:{title:prefs.discreet?'Scheduled activity':n.title,
  body:prefs.discreet?'Open Fifoo to view your next stop.':n.body},
  ...(prefs.sound_enabled?{sound:'default'}:{}),category:'FIFOO_ACTIVITY','thread-id':'fifoo-schedule'},
  notificationID:n.notification_id,mapDate:n.map_date,planRevision:n.plan_revision};
}
export function createAPNsProvider(config=apnsConfiguration(), connect=http2.connect) {
 let cachedToken=null,issuedAt=0;
 return {enabled:config.enabled, async send(notification,device,preferences) {
  if(!config.enabled)return {outcome:'disabled',status:0,reason:'ProviderDisabled'};
  if(!config.topic || !config.teamID || !config.keyID || !config.privateKey) throw new Error('APNs credentials are incomplete');
  if(device.topic!==config.topic || !['sandbox','production'].includes(device.environment)) return {outcome:'permanent_failure',status:400,reason:'ConfigurationMismatch'};
  const now=Math.floor(Date.now()/1000);
  if(!cachedToken || now-issuedAt>2700) { cachedToken=providerJWT(config,now);issuedAt=now; }
  const data=JSON.stringify(notificationPayload(notification,preferences));
  if(Buffer.byteLength(data)>4096)return {outcome:'permanent_failure',status:413,reason:'PayloadTooLarge'};
  return new Promise(resolve=>{
   let settled=false,session,request,timer;
   const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);request?.close();session?.close();session?.destroy();resolve(result);};
   timer=setTimeout(()=>finish({outcome:'retry',status:0,reason:'Timeout'}),config.timeoutMs);
   try {
    session=connect(device.environment==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com');
    session.on('error',()=>finish({outcome:'retry',status:0,reason:'TransportError'}));
    request=session.request({':method':'POST',':path':`/3/device/${device.token}`,
     authorization:`bearer ${cachedToken}`,'apns-topic':config.topic,'apns-push-type':'alert','apns-priority':'10',
     'apns-expiration':String(Math.floor(new Date(notification.expires_at).getTime()/1000)),
     'apns-collapse-id':notification.notification_id,'apns-id':notification.notification_id});
    let status=0,body='';
    request.setEncoding('utf8');request.on('response',h=>{status=Number(h[':status']);});
    request.on('data',chunk=>{body=(body+chunk).slice(0,8192);});
    request.on('error',()=>finish({outcome:'retry',status:0,reason:'StreamError'}));
    request.on('end',()=>{let reason='';try{reason=JSON.parse(body).reason??'';}catch{}finish({outcome:classifyAPNs(status,reason),status,reason});});
    request.end(data);
   } catch {finish({outcome:'retry',status:0,reason:'TransportError'});}
  });
 }};
}
