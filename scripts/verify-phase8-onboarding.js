import { pool } from '../src/db.js';

const expected = [
  'user_game_profiles', 'onboarding_sessions', 'user_game_obstacles',
  'user_game_powerups', 'user_schedule_preferences', 'user_game_progress', 'game_xp_ledger',
];
try {
  for (const relation of expected) {
    const result = await pool.query('SELECT to_regclass($1) AS relation', [`public.${relation}`]);
    if (!result.rows[0]?.relation) throw new Error(`Missing Phase 8 relation: ${relation}`);
  }
  console.log('Phase 8 onboarding schema verification: PASS');
} finally {
  await pool.end();
}
