import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCatalogSuggestion,
  normalizeCatalogKind,
  normalizeCatalogTitle,
  searchCatalogSuggestions,
} from '../src/services/catalogSuggestions.js';

const userID = '11111111-1111-4111-8111-111111111111';

test('catalog suggestion validation accepts only meal workout and task', () => {
  assert.equal(normalizeCatalogKind(' Meal '), 'meal');
  assert.equal(normalizeCatalogKind('WORKOUT'), 'workout');
  assert.equal(normalizeCatalogKind('task'), 'task');
  assert.throws(() => normalizeCatalogKind('post'), /meal, workout, or task/i);
  assert.equal(normalizeCatalogTitle('  Pack   lunch  '), 'Pack lunch');
  assert.throws(() => normalizeCatalogTitle('   '), /enter a name/i);
});

test('catalog search normalizes meal rows for the iOS response', async () => {
  const client = {
    async query(sql, params) {
      assert.match(sql, /FROM meals/);
      assert.equal(params[0], userID);
      assert.equal(params[1], 'oats');
      assert.equal(params[2], '%oats%');
      return { rows: [{
        id: 'meal-1', title: 'Protein Oats', subtitle: 'Breakfast', location: null,
        duration_seconds: null, image_url: 'https://example.test/oats.jpg', format: null,
        user_suggested: false,
      }] };
    },
  };
  const items = await searchCatalogSuggestions(client, { userID, kind: 'meal', query: 'oats' });
  assert.deepEqual(items, [{
    id: 'meal-1', kind: 'meal', title: 'Protein Oats', subtitle: 'Breakfast', location: null,
    durationSeconds: null, imageURL: 'https://example.test/oats.jpg', format: null, userSuggested: false,
  }]);
});

test('creating an exact existing suggestion reuses it instead of duplicating', async () => {
  let insertCount = 0;
  const client = {
    async query(sql) {
      if (/FROM tasks/.test(sql)) {
        return { rows: [{
          id: 'task-1', title: 'Pack lunch', subtitle: null, location: 'Home', duration_seconds: null,
          image_url: null, format: null, user_suggested: true,
        }] };
      }
      if (/INSERT INTO tasks/.test(sql)) insertCount += 1;
      return { rows: [] };
    },
  };
  const result = await createCatalogSuggestion(client, { userID, kind: 'task', title: 'Pack lunch' });
  assert.equal(result.created, false);
  assert.equal(result.item.id, 'task-1');
  assert.equal(insertCount, 0);
});

test('new workout suggestion is persisted as an independent reusable item', async () => {
  const statements = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (/FROM workouts/.test(sql)) return { rows: [] };
      if (/INSERT INTO workouts/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const result = await createCatalogSuggestion(client, { userID, kind: 'workout', title: 'Stair workout' });
  assert.equal(result.created, true);
  assert.equal(result.item.kind, 'workout');
  assert.equal(result.item.title, 'Stair workout');
  assert.equal(result.item.format, 'Independent');
  assert.equal(result.item.durationSeconds, 1800);
  const insert = statements.find((entry) => /INSERT INTO workouts/.test(entry.sql));
  assert.ok(insert);
  assert.equal(insert.params[1], 'Stair workout');
  assert.equal(insert.params[2], userID);
});
