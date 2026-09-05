import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_KNOWLEDGE_QUESTIONS, encounterCooldownSeconds, rankRouteKnowledgeQuestions } from '../src/services/routeKnowledge.js';
import { compileContinuousDay } from '../src/algorithms/dayGraph.js';

test('planning questions retain all three internal presentation styles', () => {
  const styles = new Set(ROUTE_KNOWLEDGE_QUESTIONS.map((question) => question.style));
  assert.deepEqual(styles, new Set(['road_encounter', 'scout_report', 'quick_duel']));
  assert.ok(ROUTE_KNOWLEDGE_QUESTIONS.length >= 10);
});

test('new players are asked about work structure before lower-value gaps', () => {
  const ranked = rankRouteKnowledgeQuestions({ knownKeys: [], answeredCount: 0 });
  assert.equal(ranked[0].key, 'work_structure');
  assert.equal(ranked[1].key, 'sleep_pattern');
});

test('known route knowledge is removed from the question queue', () => {
  const ranked = rankRouteKnowledgeQuestions({ knownKeys: ['work_structure', 'sleep_pattern'], answeredCount: 2 });
  assert.equal(ranked.some((question) => question.knowledgeKey === 'work_structure'), false);
  assert.equal(ranked.some((question) => question.knowledgeKey === 'sleep_pattern'), false);
  assert.equal(ranked[0].key, 'food_allergies');
});

test('encounter cadence decays as Fifoo learns the player', () => {
  assert.equal(encounterCooldownSeconds(0), 0);
  assert.equal(encounterCooldownSeconds(1), 2 * 3600);
  assert.equal(encounterCooldownSeconds(4), 12 * 3600);
  assert.equal(encounterCooldownSeconds(7), 24 * 3600);
  assert.equal(encounterCooldownSeconds(10), 72 * 3600);
});

test('third-shift sleep window can be represented as protected daytime sleep', () => {
  const path = compileContinuousDay({
    scheduledIntervals: [],
    idSeed: 'third-shift',
    context: {
      wakeSecond: 16 * 3600,
      sleepSecond: 8 * 3600,
      sleepWindows: [{ startSecond: 8 * 3600, endSecond: 16 * 3600 }],
    },
  });
  const sleep = path.intervals.filter((interval) => interval.intervalKind === 'sleep');
  assert.ok(sleep.length >= 8);
  assert.equal(sleep[0].metadata.displayTitle, 'Sleep hour');
  assert.equal(sleep.at(-1).metadata.displayTitle, 'Sleep hour');
  assert.equal(path.intervals.find((interval) => interval.startSecond === 0)?.intervalKind, 'fasting');
});


test('planning question copy is direct and avoids game-style terminology', () => {
  const visible = ROUTE_KNOWLEDGE_QUESTIONS.flatMap((question) => [
    question.title, question.prompt, question.helperText,
    ...question.options.flatMap((option) => [option.title, option.subtitle]),
  ]).filter(Boolean).join(' ').toLowerCase();
  for (const word of ['scout', 'duel', 'march', 'open road', 'moving camp', 'wild card']) {
    assert.equal(visible.includes(word), false, `unexpected game-style term: ${word}`);
  }
  assert.match(ROUTE_KNOWLEDGE_QUESTIONS.find((q) => q.key === 'work_structure').prompt, /work hours/i);
  assert.match(ROUTE_KNOWLEDGE_QUESTIONS.find((q) => q.key === 'sleep_pattern').prompt, /sleep schedule/i);
});
