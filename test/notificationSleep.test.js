import test from 'node:test';
import assert from 'node:assert/strict';
import { dayPlanningInternals } from '../src/services/dayPlanning.js';
import { optimizeDayRoutes } from '../src/algorithms/routingEngine.js';
const {normalizeSystemAction,contextAfterSystemAction,candidatesAfterSystemAction}=dayPlanningInternals;
test('Go To Sleep is an explicit schedule decision with a bounded sleep window',()=>{
 const action=normalizeSystemAction({action:'goToSleep',intervalID:'current',stateKind:'sleep'},22*3600);
 const context=contextAfterSystemAction({wakeSecond:7*3600,sleepSecond:23*3600},action);
 assert.deepEqual(context.sleepWindows,[{startSecond:22*3600,endSecond:86400}]);assert.equal(context.hardBusyIntervals[0].systemSleepDecision,true);
});
test('Go To Sleep removes conflicting future candidates, not past history',()=>{
 const action=normalizeSystemAction({action:'goToSleep'},6*3600);
 const context=contextAfterSystemAction({wakeSecond:8*3600},action);
 const candidates=candidatesAfterSystemAction([{key:'too-early',fixedStartSecond:7*3600,durationSeconds:600},{key:'after',fixedStartSecond:9*3600,durationSeconds:600}],action,context);
 assert.deepEqual(candidates.map(c=>c.key),['after']);
});
test('coverage-only sleep does not become a selectable decision candidate',()=>{
 const action=normalizeSystemAction({action:'goToSleep'},22*3600);
 const context=contextAfterSystemAction({wakeSecond:7*3600,sleepSecond:23*3600},action);
 const candidates=candidatesAfterSystemAction([],action,context);
 assert.equal(candidates[0].hardExcluded,true);
 const result=optimizeDayRoutes({candidates,context,alternativeCount:0});
 assert.ok(result.chosenPath.intervals.some(i=>i.intervalKind==='sleep'));assert.deepEqual(result.chosenPath.selectedCandidateKeys,[]);
});
test('waking removes only the explicit sleep busy restriction',()=>{
 const asleep=contextAfterSystemAction({wakeSecond:8*3600,hardBusyIntervals:[{startSecond:9*3600,endSecond:10*3600}]},normalizeSystemAction({action:'goToSleep'},5*3600));
 const awake=contextAfterSystemAction(asleep,normalizeSystemAction({action:'iAmAwake'},6*3600));
 assert.equal(awake.hardBusyIntervals[0].startSecond,9*3600);assert.equal(awake.hardBusyIntervals[1].endSecond,6*3600);
});
