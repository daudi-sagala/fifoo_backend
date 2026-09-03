import test from 'node:test';
import assert from 'node:assert/strict';
import { OUT, IN } from '../src/events.js';

const expectedOutgoing = [
  'game:auth','game:sync:request','game:application:action',
  'game:onboarding:state:request','game:onboarding:start','game:onboarding:update','game:onboarding:preview','game:onboarding:complete',
  'game:route-knowledge:encounter:request','game:route-knowledge:encounter:answer','game:route-knowledge:encounter:defer',
  'game:node:add','game:node:update','game:node:delete',
  'game:activity:join','game:activity:skip','game:activity:complete',
  'game:activity:task:update','game:activity:task:reschedule','game:activity:task:skip','game:activity:task:complete',
  'game:activity:meal:update','game:activity:meal:skip','game:activity:meal:complete',
  'game:activity:workout:update','game:activity:workout:select','game:activity:workout:reschedule','game:activity:workout:check-in',
  'game:tile:reveal','game:suggested-stop:decision',
  'game:post:reply:create','game:post:save','game:hyperlink:vote',
  'game:social:conversations:request','game:social:conversation:open','game:social:support:open',
  'game:social:conversation:messages:request','game:social:conversation:message:send','game:social:friends:request',
  'game:social:posts:request','game:social:post:save','game:social:post:replies:request','game:social:post:reply:send',
  'game:route:select','game:route:build','game:route:reroute','game:support-plan:refresh','game:route:attach-node','game:route:draft:update','game:route:preview:update','game:route:preview:commit',
  'game:road:interaction','game:search:query',
  'game:play:workouts:request','game:play:request','game:play:workout:start','game:play:workout:pause','game:play:workout:resume','game:play:workout:end','game:play:workout:complete',
  'game:play:exercise:select','game:play:exercise:start','game:play:exercise:pause','game:play:exercise:resume','game:play:exercise:complete','game:play:exercise:skip',
  'game:play:message:send','game:play:reaction:send',
].sort();

const expectedIncoming = [
  'game:sync:snapshot','game:node:upserted','game:node:deleted','game:tile:reveal:state','game:route:state','game:day-plan:state','game:support-plan:state',
  'game:onboarding:state','game:onboarding:preview:state','game:onboarding:completed',
  'game:route-knowledge:encounter','game:route-knowledge:result',
  'game:search:results','game:play:workouts','game:play:workout','game:play:message','game:play:messages','game:play:reaction',
  'game:social:conversations','game:social:conversation:opened','game:social:conversation:messages','game:social:conversation:message',
  'game:social:friends','game:social:posts','game:social:post:saved','game:social:post:replies','game:social:post:reply','game:error',
].sort();

test('server exposes every supported outgoing event exactly once', () => {
  const actual = Object.values(OUT).sort();
  assert.deepEqual(actual, expectedOutgoing);
  assert.equal(new Set(actual).size, actual.length);
});

test('server exposes every supported incoming event exactly once', () => {
  const actual = Object.values(IN).sort();
  assert.deepEqual(actual, expectedIncoming);
  assert.equal(new Set(actual).size, actual.length);
});
