import test from 'node:test';
import assert from 'node:assert/strict';
import { mealSeedInsertValues } from '../src/dev/seedValues.js';

test('meal seed parameters match SQL placeholder order and preserve PostgreSQL arrays', () => {
  const values = mealSeedInsertValues({
    id: 'meal-id',
    title: 'Breakfast',
    calories: 390,
    description: 'Protein-rich breakfast with fruit and whole grains.',
    mealTypes: ['breakfast'],
    tags: ['protein', 'fiber', 'weight-loss'],
  });

  assert.deepEqual(values, [
    'meal-id',
    'Breakfast',
    390,
    'Protein-rich breakfast with fruit and whole grains.',
    ['breakfast'],
    ['protein', 'fiber', 'weight-loss'],
  ]);
  assert.equal(typeof values[3], 'string');
  assert.ok(Array.isArray(values[4]));
  assert.ok(Array.isArray(values[5]));
});

test('meal seed rejects scalar values for PostgreSQL text array fields', () => {
  assert.throws(
    () => mealSeedInsertValues({
      id: 'meal-id',
      title: 'Breakfast',
      calories: 390,
      description: 'Description',
      mealTypes: 'breakfast',
      tags: ['weight-loss'],
    }),
    /mealTypes must be an array of strings/,
  );
});
