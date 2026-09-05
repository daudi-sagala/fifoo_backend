import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { providerJWT, notificationPayload, createAPNsProvider, apnsConfiguration } from '../src/notifications/apns.js';
const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const config={enabled:true,topic:'ai.fifoo.test',teamID:'TESTTEAM01',keyID:'TESTKEY001',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),timeoutMs:50};
const n={notification_id:'f1234567-1234-4123-8123-123456789abc',title:'Lunch',body:'Open this stop.',plan_revision:3,map_date:'2026-09-05',expires_at:'2026-09-05T18:00:00Z'};
const device={topic:config.topic,environment:'sandbox',token:'ab'.repeat(32)};
test('provider signs an ES256 JWT with real native crypto',()=>{
 const jwt=providerJWT(config,1234567890),[head,payload,sig]=jwt.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(head,'base64url')),{alg:'ES256',kid:config.keyID});
 assert.equal(JSON.parse(Buffer.from(payload,'base64url')).iat,1234567890);
 assert.equal(verify('sha256',Buffer.from(`${head}.${payload}`),{key:keys.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')),true);
});
test('private payload excludes activity details and contains no progress reward',()=>{
 const payload=notificationPayload(n,{discreet:true,sound_enabled:false});
 assert.equal(JSON.stringify(payload).includes('Lunch'),false);assert.equal(payload.aps.sound,undefined);
 assert.equal(payload.notificationID,n.notification_id);assert.equal(payload.aps['interruption-level'],undefined);
});
test('disclosed activity details are explicit preference and sound uses standard alert',()=>{
 const p=notificationPayload(n,{discreet:false,sound_enabled:true});assert.equal(p.aps.alert.title,'Lunch');assert.equal(p.aps.sound,'default');
});
test('disabled provider never opens a network connection',async()=>{
 let called=false;const p=createAPNsProvider({...config,enabled:false},()=>{called=true;});
 assert.equal((await p.send(n,device,{})).outcome,'disabled');assert.equal(called,false);
});
test('provider rejects a topic mismatch before connecting',async()=>{
 const p=createAPNsProvider(config,()=>{throw new Error('should not connect');});
 assert.equal((await p.send(n,{...device,topic:'other'},{})).outcome,'permanent_failure');
});
test('HTTP/2 transport constructs the expected sandbox headers and payload',async()=>{
 let headers,body,host,closed=false;
 const connect=h=>{host=h;const session=new EventEmitter();session.close=()=>{closed=true;};session.destroy=()=>{};
  session.request=value=>{headers=value;const req=new EventEmitter();req.setEncoding=()=>{};req.close=()=>{};
   req.end=value=>{body=value;queueMicrotask(()=>{req.emit('response',{':status':200});req.emit('end');});};return req;};return session;};
 const result=await createAPNsProvider(config,connect).send(n,device,{discreet:true});
 assert.equal(result.outcome,'accepted');assert.equal(host,'https://api.sandbox.push.apple.com');
 assert.equal(headers['apns-push-type'],'alert');assert.equal(headers['apns-topic'],config.topic);
 assert.equal(headers['apns-collapse-id'],n.notification_id);assert.equal(JSON.parse(body).notificationID,n.notification_id);assert.equal(closed,true);
});
test('transport timeout is recoverable and closes the session',async()=>{
 let destroyed=false;const connect=()=>{const s=new EventEmitter();s.close=()=>{};s.destroy=()=>{destroyed=true;};s.request=()=>Object.assign(new EventEmitter(),{setEncoding(){},close(){},end(){}});return s;};
 const r=await createAPNsProvider({...config,timeoutMs:10},connect).send(n,device,{});assert.equal(r.outcome,'retry');assert.equal(destroyed,true);
});
test('multiline APNs key environment value normalizes safely',()=>{
 assert.equal(apnsConfiguration({APNS_PRIVATE_KEY:'a\\nb'}).privateKey,'a\nb');
});
