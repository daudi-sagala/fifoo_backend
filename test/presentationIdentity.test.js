import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationIdentity} from '../src/algorithms/presentationIdentity.js';
const context={mapDate:'2026-09-05'};
const fasting={intervalID:'v1',startSecond:36000,intervalKind:'fasting',metadata:{cycleStartSecond:28800}};
test('state card keeps its visual identity when the active hour is clipped by a reroute',()=>{
 assert.equal(presentationIdentity(fasting,context),presentationIdentity({...fasting,intervalID:'v2',startSecond:36720},context));
});
test('distinct state cycles, hours and days cannot share a visual key',()=>{
 const key=presentationIdentity(fasting,context);
 assert.notEqual(key,presentationIdentity({...fasting,startSecond:39600},context));
 assert.notEqual(key,presentationIdentity({...fasting,metadata:{cycleStartSecond:30000}},context));
 assert.notEqual(key,presentationIdentity(fasting,{mapDate:'2026-09-06'}));
});
test('source activity visual identity survives schedule moves without changing the ledger identifier',()=>{
 const i={...fasting,sourceNodeID:'meal'};const moved={...i,intervalID:'other',startSecond:40000};
 assert.equal(presentationIdentity(i,context),presentationIdentity(moved,context));assert.equal(moved.intervalID,'other');
});
test('unselected system consequences stay distinct from primary visuals',()=>{
 assert.notEqual(presentationIdentity(fasting,context),presentationIdentity(fasting,{...context,scope:'alternate:later-meal'}));
});
