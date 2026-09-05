import { config } from '../src/config.js';
import { pool, withTransaction } from '../src/db.js';
import { hashPassword } from '../src/services/authService.js';
import { stableUUID } from '../src/lib/stableUUID.js';
import { generateDailyPathForUser } from '../src/services/dailyPathGenerator.js';
import { recordProgressOutcome } from '../src/services/dayPlanning.js';
import { standardWeightLossDayRules } from '../src/rules/standardWeightLossDay.js';

const BATCH = 'temporary-production-seed-v2026-09-03';
const CONFIRM_FLAG = '--confirm-temporary-production-seed';
const CLEANUP_FLAG = '--cleanup';
const DEFAULT_PASSWORD = process.env.SEED_TEST_PASSWORD || 'FifooProdTest123!';
const SUPPORT_USER_ID = '00000000-0000-4000-8000-00000000f100';

function requireProductionConfirmation() {
  if (config.nodeEnv !== 'production' && process.env.ALLOW_TEMP_PRODUCTION_SEED_NONPROD !== 'YES') {
    throw new Error('This seed is intended for production test data. Set NODE_ENV=production (or ALLOW_TEMP_PRODUCTION_SEED_NONPROD=YES for local validation).');
  }
  if (process.env.ALLOW_TEMP_PRODUCTION_SEED !== 'YES') {
    throw new Error('Refusing to modify data. Set ALLOW_TEMP_PRODUCTION_SEED=YES explicitly.');
  }
  if (!process.argv.includes(CONFIRM_FLAG)) {
    throw new Error(`Refusing to modify data. Pass ${CONFIRM_FLAG}.`);
  }
}

function localDateString(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localClockSeconds(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return (Number(values.hour) * 3600) + (Number(values.minute) * 60) + Number(values.second);
}

function addDays(mapDate, delta) {
  const [year, month, day] = mapDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function assetURL(kind, index) {
  return `https://picsum.photos/seed/fifoo-${BATCH}-${kind}-${String(index).padStart(2, '0')}/1200/800`;
}

function avatarURL(index) {
  return `https://i.pravatar.cc/300?u=fifoo-${BATCH}-${String(index).padStart(2, '0')}`;
}

const USER_SPECS = [
  ['maya_march', 'Maya', 'Chen', '07:00:00', '23:00:00', '09:00', '17:00', 198, 165, 'balanced', 'Consistency'],
  ['jordan_route', 'Jordan', 'Brooks', '06:00:00', '22:00:00', '08:00', '16:00', 224, 190, 'competitive', 'Energy'],
  ['alex_stride', 'Alex', 'Rivera', '05:30:00', '21:30:00', '07:30', '15:30', 187, 160, 'structured', 'Fitness'],
  ['nia_night', 'Nia', 'Thompson', '09:30:00', '01:30:00', '11:00', '19:00', 176, 145, 'flexible', 'Confidence'],
  ['omar_shift', 'Omar', 'Hassan', '16:00:00', '08:00:00', '18:00', '02:00', 246, 205, 'night_shift', 'Health'],
  ['sophia_steps', 'Sophia', 'Martinez', '07:30:00', '23:30:00', '09:30', '17:30', 169, 140, 'social', 'Consistency'],
  ['liam_lift', 'Liam', 'OConnor', '06:30:00', '22:30:00', '08:30', '16:30', 231, 195, 'competitive', 'Strength'],
  ['ava_arc', 'Ava', 'Patel', '08:00:00', '00:00:00', '10:00', '18:00', 183, 150, 'balanced', 'Energy'],
  ['noah_move', 'Noah', 'Kim', '04:30:00', '20:30:00', '06:00', '14:00', 214, 180, 'structured', 'Health'],
  ['zoe_afterdark', 'Zoe', 'Williams', '12:00:00', '04:00:00', '14:00', '22:00', 172, 142, 'night_shift', 'Confidence'],
  ['ethan_march', 'Ethan', 'Davis', '07:00:00', '23:00:00', '08:00', '17:00', 205, 175, 'flexible', 'Fitness'],
  ['grace_goal', 'Grace', 'Lee', '06:45:00', '22:45:00', '08:30', '16:30', 191, 158, 'balanced', 'Health'],
  ['lucas_lane', 'Lucas', 'Brown', '08:30:00', '00:30:00', '10:30', '18:30', 238, 200, 'social', 'Energy'],
  ['ella_effort', 'Ella', 'Wilson', '05:45:00', '21:45:00', '07:00', '15:00', 164, 135, 'structured', 'Confidence'],
  ['marcus_momentum', 'Marcus', 'Jones', '07:15:00', '23:15:00', '09:00', '17:00', 252, 210, 'competitive', 'Consistency'],
];

function seedUserID(index) {
  return stableUUID(`${BATCH}:user:${index + 1}`);
}

const USER_IDS = USER_SPECS.map((_, index) => seedUserID(index));
const MEAL_IDS = Array.from({ length: 20 }, (_, i) => stableUUID(`${BATCH}:meal:${i + 1}`));
const EXERCISE_IDS = Array.from({ length: 24 }, (_, i) => stableUUID(`${BATCH}:exercise:${i + 1}`));
const WORKOUT_IDS = Array.from({ length: 15 }, (_, i) => stableUUID(`${BATCH}:workout:${i + 1}`));
const TASK_IDS = Array.from({ length: 12 }, (_, i) => stableUUID(`${BATCH}:task:${i + 1}`));
const SUGGESTED_MEAL_IDS = Array.from({ length: 12 }, (_, i) => stableUUID(`${BATCH}:suggested-meal:${i + 1}`));
const POST_IDS = Array.from({ length: 38 }, (_, i) => stableUUID(`${BATCH}:post:${i + 1}`));

async function seedUsers(client) {
  const passwordHash = await hashPassword(DEFAULT_PASSWORD);
  const users = [];
  for (let index = 0; index < USER_SPECS.length; index += 1) {
    const [username, firstName, lastName, wake, bed, workStart, workEnd, currentWeight, goalWeight, playerStyle, motivation] = USER_SPECS[index];
    const userID = USER_IDS[index];
    const email = `${username}@seed.fifoo.ai`;
    await client.query(
      `INSERT INTO users(user_id,username,first_name,last_name,email,password,last_active,profile_image_url)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()-($7::text || ' minutes')::interval,$8)
       ON CONFLICT(user_id) DO UPDATE SET
         username=EXCLUDED.username,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
         email=EXCLUDED.email,password=EXCLUDED.password,last_active=EXCLUDED.last_active,
         profile_image_url=EXCLUDED.profile_image_url`,
      [userID, username, firstName, lastName, email, passwordHash, String(index * 13), avatarURL(index + 1)],
    );

    await client.query(
      `INSERT INTO user_game_profiles(
         user_id,onboarding_status,onboarding_version,main_quest,player_style,difficulty,
         current_weight_lb,goal_weight_lb,target_pace_lb_per_week,primary_motivation,
         preferred_intervention_intensity,onboarding_completed_at
       ) VALUES ($1,'completed',1,'Lose weight',$2,$3,$4,$5,$6,$7,$8,NOW()-INTERVAL '14 days')
       ON CONFLICT(user_id) DO UPDATE SET
         onboarding_status='completed',main_quest=EXCLUDED.main_quest,player_style=EXCLUDED.player_style,
         difficulty=EXCLUDED.difficulty,current_weight_lb=EXCLUDED.current_weight_lb,
         goal_weight_lb=EXCLUDED.goal_weight_lb,target_pace_lb_per_week=EXCLUDED.target_pace_lb_per_week,
         primary_motivation=EXCLUDED.primary_motivation,
         preferred_intervention_intensity=EXCLUDED.preferred_intervention_intensity,
         onboarding_completed_at=EXCLUDED.onboarding_completed_at,updated_at=NOW()`,
      [userID, playerStyle, index % 3 === 0 ? 'hard' : index % 3 === 1 ? 'normal' : 'easy', currentWeight, goalWeight, 1 + ((index % 3) * 0.25), motivation, index % 2 ? 'moderate' : 'high'],
    );

    await client.query(
      `INSERT INTO user_game_progress(user_id,total_xp,level,current_streak,best_streak)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(user_id) DO UPDATE SET total_xp=EXCLUDED.total_xp,level=EXCLUDED.level,
         current_streak=EXCLUDED.current_streak,best_streak=EXCLUDED.best_streak,updated_at=NOW()`,
      [userID, 250 + (index * 175), 2 + Math.floor(index / 3), index % 8, 4 + (index % 12)],
    );

    for (const [key, clock, preferenceData] of [
      ['wake', wake, { seedBatch: BATCH, label: 'Personal day start' }],
      ['bed', bed, { seedBatch: BATCH, label: 'Personal day end' }],
      ['work', null, { seedBatch: BATCH, type: 'fixed', startTime: workStart, endTime: workEnd }],
    ]) {
      await client.query(
        `INSERT INTO user_schedule_preferences(
           user_id,schedule_key,clock_time,flexibility_minutes,is_fixed,source,preference_data
         ) VALUES ($1,$2,$3::time,30,$4,$5,$6::jsonb)
         ON CONFLICT(user_id,schedule_key) DO UPDATE SET
           clock_time=EXCLUDED.clock_time,flexibility_minutes=EXCLUDED.flexibility_minutes,
           is_fixed=EXCLUDED.is_fixed,source=EXCLUDED.source,preference_data=EXCLUDED.preference_data,
           updated_at=NOW()`,
        [userID, key, clock, key === 'work', BATCH, JSON.stringify(preferenceData)],
      );
    }

    const obstacles = index % 2 === 0 ? ['busy_schedule', 'evening_hunger'] : ['consistency', 'meal_planning'];
    for (let rank = 0; rank < obstacles.length; rank += 1) {
      await client.query(
        `INSERT INTO user_game_obstacles(user_id,obstacle_key,priority,confidence,source)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(user_id,obstacle_key) DO UPDATE SET priority=EXCLUDED.priority,
           confidence=EXCLUDED.confidence,source=EXCLUDED.source,updated_at=NOW()`,
        [userID, obstacles[rank], rank + 1, 0.78 - (rank * 0.08), BATCH],
      );
    }
    const powerups = index % 3 === 0 ? ['walking', 'meal_prep'] : index % 3 === 1 ? ['strength', 'accountability'] : ['routine', 'quick_wins'];
    for (const powerup of powerups) {
      await client.query(
        `INSERT INTO user_game_powerups(user_id,powerup_key,preference_strength,source)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT(user_id,powerup_key) DO UPDATE SET preference_strength=EXCLUDED.preference_strength,
           source=EXCLUDED.source,updated_at=NOW()`,
        [userID, powerup, 0.75, BATCH],
      );
    }

    const dietKeys = ['omnivore', 'vegetarian', 'low_carb', 'omnivore', 'vegetarian'];
    const dietKey = dietKeys[index % dietKeys.length];
    const knowledge = [
      ['diet_style', { key: dietKey }],
      ['gym_access', { available: index % 4 !== 0 }],
      ['cooking_frequency', { frequency: index % 3 === 0 ? 'most_days' : 'sometimes' }],
      ['groceries_readiness', { key: index % 5 === 0 ? 'rarely' : 'usually' }],
      ['food_allergies', { selections: index === 5 ? [{ key: 'peanuts' }] : [{ key: 'none' }] }],
    ];
    for (const [key, value] of knowledge) {
      await client.query(
        `INSERT INTO user_route_knowledge(user_id,knowledge_key,knowledge_value,confidence,source)
         VALUES ($1,$2,$3::jsonb,0.95,$4)
         ON CONFLICT(user_id,knowledge_key) DO UPDATE SET knowledge_value=EXCLUDED.knowledge_value,
           confidence=EXCLUDED.confidence,source=EXCLUDED.source,observed_at=NOW(),updated_at=NOW()`,
        [userID, key, JSON.stringify(value), BATCH],
      );
    }

    users.push({ userID, username, email, password: DEFAULT_PASSWORD, wake, bed, workStart, workEnd });
  }
  return users;
}

async function seedCatalog(client) {
  const mealNames = [
    'Greek Yogurt Berry Oats', 'Egg & Avocado Toast', 'Protein Overnight Oats', 'Turkey Breakfast Wrap',
    'Chicken Grain Bowl', 'Mediterranean Chickpea Bowl', 'Turkey Avocado Sandwich', 'Tuna Crunch Salad',
    'Apple & Greek Yogurt', 'Cottage Cheese & Berries', 'Hummus & Vegetables', 'Protein Smoothie',
    'Salmon Potato Plate', 'Chicken Fajita Bowl', 'Turkey Chili', 'Tofu Vegetable Stir Fry',
    'Lean Beef Taco Bowl', 'Shrimp Quinoa Bowl', 'Lentil Curry', 'Chicken Vegetable Pasta',
  ];
  for (let index = 0; index < mealNames.length; index += 1) {
    const mealType = index < 4 ? 'breakfast' : index < 8 ? 'lunch' : index < 12 ? 'snack' : 'dinner';
    await client.query(
      `INSERT INTO meals(
         meal_id,title,calories_per_meal,created_by,status,description,
         meal_types,meal_image_urls,meal_video_urls,is_available,is_featured,tags
       ) VALUES ($1,$2,$4,NULL,'active',$5,$6::text[],ARRAY[$3]::text[],'{}'::text[],TRUE,$7,$8::text[])
       ON CONFLICT(meal_id) DO UPDATE SET
         title=EXCLUDED.title,
         calories_per_meal=EXCLUDED.calories_per_meal,status='active',description=EXCLUDED.description,
         meal_types=EXCLUDED.meal_types,meal_image_urls=EXCLUDED.meal_image_urls,
         is_available=TRUE,is_featured=EXCLUDED.is_featured,tags=EXCLUDED.tags,updated_at=NOW()`,
      [MEAL_IDS[index], mealNames[index], assetURL('meal', index + 1), 180 + ((index * 37) % 430), `Temporary production seed ${mealType} meal for app testing.`, [mealType], index < 6, ['seed_prod_temp', mealType, 'weight-loss']],
    );
  }

  const exerciseNames = [
    'Bodyweight Squat', 'Incline Push-Up', 'Reverse Lunge', 'Glute Bridge', 'Plank', 'Brisk Walk',
    'Dumbbell Romanian Deadlift', 'Dumbbell Shoulder Press', 'Step-Up', 'Dead Bug', 'Dumbbell Row', 'Goblet Squat',
    'March in Place', 'Bicycle Crunch', 'Side Plank', 'Bird Dog', 'Kettlebell Swing', 'Jump Rope',
    'Mountain Climber', 'Wall Sit', 'Hip Hinge', 'Calf Raise', 'Standing Knee Drive', 'Mobility Flow',
  ];
  for (let index = 0; index < exerciseNames.length; index += 1) {
    const duration = index === 5 ? 1200 : 30 + ((index % 5) * 15);
    const categories = index === 5 ? ['Walking', 'Cardio'] : index >= 23 ? ['Mobility', 'Recovery'] : ['Strength', index % 2 ? 'Upper Body' : 'Lower Body'];
    await client.query(
      `INSERT INTO exercises(
         exercise_id,title,exercise_main_image_url,duration_in_seconds,exercise_categories,description,
         exercise_status,equipment,created_by,exercise_image_urls,exercise_video_urls,tags
       ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,NULL,ARRAY[$3]::text[],'{}'::text[],$8)
       ON CONFLICT(exercise_id) DO UPDATE SET
         title=EXCLUDED.title,exercise_main_image_url=EXCLUDED.exercise_main_image_url,
         duration_in_seconds=EXCLUDED.duration_in_seconds,exercise_categories=EXCLUDED.exercise_categories,
         description=EXCLUDED.description,exercise_status='active',equipment=EXCLUDED.equipment,
         exercise_image_urls=EXCLUDED.exercise_image_urls,tags=EXCLUDED.tags`,
      [EXERCISE_IDS[index], exerciseNames[index], assetURL('exercise', index + 1), duration, categories, `Temporary production seed exercise: ${exerciseNames[index]}.`, index % 4 === 0 ? ['Dumbbells'] : [], ['seed_prod_temp', 'weight-loss', ...categories.map((v) => v.toLowerCase())]],
    );
  }

  const workoutNames = [
    '20-Minute Brisk Walk', '30-Minute Beginner Full Body', 'Quick Dumbbell Circuit', 'Lower Body Strength', 'Upper Body Strength',
    'Core Stability Session', 'Low Impact Cardio', 'At-Home Bodyweight', 'Morning Mobility', 'Lunch Break Walk',
    'Kettlebell Conditioning', 'Beginner HIIT', 'Recovery Walk & Mobility', 'Full Body Express', 'Evening Strength Reset',
  ];
  for (let index = 0; index < workoutNames.length; index += 1) {
    const duration = 900 + ((index % 5) * 300);
    const categories = index === 0 || index === 9 || index === 12 ? ['Walking', 'Cardio', 'Weight Loss'] : index === 8 ? ['Mobility', 'Recovery'] : ['Strength', 'Full Body', 'Weight Loss'];
    await client.query(
      `INSERT INTO workouts(
         workout_id,title,workout_main_image_url,location,duration_in_seconds,workout_categories,
         description,distance_in_miles,workout_status,workout_format,created_by,workout_image_urls,tags
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'active','Independent',NULL,ARRAY[$3]::text[],$8)
       ON CONFLICT(workout_id) DO UPDATE SET
         title=EXCLUDED.title,workout_main_image_url=EXCLUDED.workout_main_image_url,
         location=EXCLUDED.location,duration_in_seconds=EXCLUDED.duration_in_seconds,
         workout_categories=EXCLUDED.workout_categories,description=EXCLUDED.description,
         workout_status='active',workout_format='Independent',workout_image_urls=EXCLUDED.workout_image_urls,
         tags=EXCLUDED.tags`,
      [WORKOUT_IDS[index], workoutNames[index], assetURL('workout', index + 1), index % 3 === 0 ? 'Home' : 'Gym', duration, categories, `Temporary production seed workout: ${workoutNames[index]}.`, ['seed_prod_temp', ...categories.map((v) => v.toLowerCase())]],
    );
    await client.query('DELETE FROM workouts_exercises WHERE workout_id=$1', [WORKOUT_IDS[index]]);
    for (let order = 0; order < 5; order += 1) {
      const exerciseIndex = (index * 3 + order) % EXERCISE_IDS.length;
      await client.query(
        `INSERT INTO workouts_exercises(
           workout_id,exercise_id,exercise_order,sets,reps,duration_in_seconds,min_duration_in_seconds,
           exercise_instructions,is_enabled,created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,TRUE,NULL)`,
        [WORKOUT_IDS[index], EXERCISE_IDS[exerciseIndex], order + 1, order < 3 ? 3 : null, order < 3 ? 10 + order * 2 : null, order >= 3 ? 60 : null, order >= 3 ? 30 : null, JSON.stringify({ seedBatch: BATCH, steps: ['Move with control.', 'Keep breathing.', 'Stop if form breaks down.'] })],
      );
    }
  }

  const taskNames = ['Morning water', 'Planning check-in', 'Pack lunch', 'Grocery check', 'Prep tomorrow lunch', 'Midday walk', 'Hydration reset', 'Evening reflection', 'Wind-down routine', 'Set workout clothes out', 'Kitchen close', 'Weekly weigh-in'];
  for (let index = 0; index < taskNames.length; index += 1) {
    await client.query(
      `INSERT INTO tasks(task_id,title,task_main_image_url,location,status,tags,created_by,description)
       VALUES ($1,$2,$3,$4,'active',$5,NULL,$6)
       ON CONFLICT(task_id) DO UPDATE SET title=EXCLUDED.title,task_main_image_url=EXCLUDED.task_main_image_url,
         location=EXCLUDED.location,status='active',tags=EXCLUDED.tags,description=EXCLUDED.description,updated_at=NOW()`,
      [TASK_IDS[index], taskNames[index], assetURL('task', index + 1), index % 2 ? 'Anywhere' : 'Home', ['seed_prod_temp', 'routine', 'weight-loss'], `Temporary production seed task: ${taskNames[index]}.`],
    );
  }

  return { meals: MEAL_IDS.length, exercises: EXERCISE_IDS.length, workouts: WORKOUT_IDS.length, tasks: TASK_IDS.length };
}

async function seedSuggestedMeals(client, users) {
  for (let index = 0; index < SUGGESTED_MEAL_IDS.length; index += 1) {
    const mealA = index % MEAL_IDS.length;
    const mealB = (index + 7) % MEAL_IDS.length;
    const meals = [
      { mealID: MEAL_IDS[mealA], title: `Seed meal option ${mealA + 1}`, imageURL: assetURL('meal', mealA + 1), estimatedTimeMinutes: 20, priceRange: '$$', recipeCount: 1, ingredientCount: 6, sourceCount: 1 },
      { mealID: MEAL_IDS[mealB], title: `Seed meal option ${mealB + 1}`, imageURL: assetURL('meal', mealB + 1), estimatedTimeMinutes: 25, priceRange: '$$', recipeCount: 1, ingredientCount: 7, sourceCount: 1 },
    ];
    await client.query(
      `INSERT INTO suggested_meals(suggested_meal_id,user_id,suggested_by,status,meals,execution_state)
       VALUES ($1,$2,$3,'pending',$4::jsonb,$5::jsonb)
       ON CONFLICT(suggested_meal_id) DO UPDATE SET user_id=EXCLUDED.user_id,suggested_by=EXCLUDED.suggested_by,
         status=EXCLUDED.status,meals=EXCLUDED.meals,execution_state=EXCLUDED.execution_state,updated_at=NOW()`,
      [SUGGESTED_MEAL_IDS[index], users[index].userID, users[(index + 1) % users.length].userID, JSON.stringify(meals), JSON.stringify({ seedBatch: BATCH, source: index % 2 ? 'restaurant' : 'homeMade', groceriesNeeded: index % 3 === 0 })],
    );
  }
  return SUGGESTED_MEAL_IDS.length;
}

async function seedFriendshipsAndChats(client, users) {
  let friendshipCount = 0;
  for (let index = 0; index < users.length; index += 1) {
    for (let offset = 1; offset <= 3; offset += 1) {
      const a = users[index].userID;
      const b = users[(index + offset) % users.length].userID;
      const friendshipID = stableUUID(`${BATCH}:friendship:${[a, b].sort().join(':')}`);
      await client.query(
        `INSERT INTO user_friends(friendship_id,user_id,friend_user_id,status)
         VALUES ($1,$2,$3,'accepted') ON CONFLICT DO NOTHING`,
        [friendshipID, a, b],
      );
      friendshipCount += 1;
    }
  }

  let conversationCount = 0;
  const focal = users[0];
  for (let offset = 1; offset <= 6; offset += 1) {
    const friend = users[offset];
    const conversationID = stableUUID(`${BATCH}:conversation:${focal.userID}:${friend.userID}`);
    await client.query(
      `INSERT INTO conversations(conversation_id,conversation_member_ids,status,created_by)
       VALUES ($1,ARRAY[$2::uuid,$3::uuid],'active',$2)
       ON CONFLICT(conversation_id) DO NOTHING`,
      [conversationID, focal.userID, friend.userID],
    );
    for (let messageIndex = 0; messageIndex < 3; messageIndex += 1) {
      const sender = messageIndex % 2 === 0 ? friend.userID : focal.userID;
      const body = messageIndex === 0 ? `Hey ${focal.username}, how is your march going?` : messageIndex === 1 ? 'Good — staying close to the route today.' : 'Nice. Keep stacking the small wins.';
      await client.query(
        `INSERT INTO messages(message_id,conversation_id,subject,body,sender_id,created_at)
         VALUES ($1,$2,$3,$3,$4,NOW()-($5::text || ' minutes')::interval)
         ON CONFLICT(message_id) DO UPDATE SET subject=EXCLUDED.subject,body=EXCLUDED.body,created_at=EXCLUDED.created_at`,
        [stableUUID(`${BATCH}:message:${conversationID}:${messageIndex}`), conversationID, body, sender, String((offset * 15) + ((3 - messageIndex) * 4))],
      );
    }
    await client.query('UPDATE conversations SET updated_at=NOW()-($2::text || \' minutes\')::interval WHERE conversation_id=$1', [conversationID, String(offset * 9)]);
    conversationCount += 1;
  }

  // Support thread for the focal test account; the support system user is migration-owned and never removed.
  const supportExists = await client.query('SELECT user_id FROM users WHERE user_id=$1', [SUPPORT_USER_ID]);
  if (supportExists.rowCount) {
    const conversationID = stableUUID(`${BATCH}:support-conversation:${focal.userID}`);
    await client.query(
      `INSERT INTO conversations(conversation_id,conversation_member_ids,status,created_by)
       VALUES ($1,ARRAY[$2::uuid,$3::uuid],'active',$2)
       ON CONFLICT(conversation_id) DO NOTHING`,
      [conversationID, focal.userID, SUPPORT_USER_ID],
    );
    await client.query(
      `INSERT INTO messages(message_id,conversation_id,subject,body,sender_id,created_at)
       VALUES ($1,$2,$3,$3,$4,NOW()-INTERVAL '3 hours')
       ON CONFLICT(message_id) DO UPDATE SET subject=EXCLUDED.subject,body=EXCLUDED.body`,
      [stableUUID(`${BATCH}:support-message:${focal.userID}`), conversationID, 'Welcome to Fifoo Support. This temporary thread is here for production testing.', SUPPORT_USER_ID],
    );
    conversationCount += 1;
  }

  return { friendships: friendshipCount, conversations: conversationCount };
}

async function seedPostsAndReplies(client, users) {
  const subjects = [
    'First week back lifting and feeling good.', 'This breakfast kept me full all morning.', 'Sunrise walk before work — worth it.',
    'Trying to improve my squat depth.', 'Meal prep for the next three lunches is done.', 'Hit a new plank best today.',
    'Quick dumbbell circuit on a busy day.', 'Salmon bowl tonight was exactly what I needed.', 'Weekend trail walk with hills.',
    'Working on consistency more than intensity.', 'Mobility plus an easy walk for recovery.', 'Black bean bowl turned out great.',
    'Jump rope intervals are humbling.', 'What is your go-to high-protein snack?', 'Lower-body day done.',
    'Reminder to drink water before the slump.', 'Romanian deadlifts are starting to click.', 'Anyone else split workouts into shorter sessions?',
    'Greek yogurt plus berries is still undefeated.', 'Ten minutes of movement beat skipping.', 'Core work is helping my other lifts.',
    'Trying a recovery day instead of pushing fatigue.', 'What music gets you through cardio?', 'Made turkey chili for the week.',
    'Morning mobility made a big difference.', 'Finished the full-body circuit without rushing.', 'Small win: took the stairs every chance I got.',
    'Protein smoothie saved a chaotic morning.', 'Evening walk helped me reset.', 'Meal planning before hunger is a cheat code.',
    'Today was messy but I stayed in the game.', 'Strength session felt easier than last week.', 'Packed lunch before bed and thanked myself today.',
    'Trying to get more sleep this week.', 'Skipped one thing, rerouted, and kept going.', 'Workout complete. Energy is way better.',
    'Fasting window felt easy today.', 'What is everyone doing for weekend movement?',
  ];
  for (let index = 0; index < POST_IDS.length; index += 1) {
    const hasImage = index < 13;
    const poster = users[index % users.length];
    const postType = index % 5 === 0 ? 'Tip' : index % 5 === 1 ? 'Progress' : index % 5 === 2 ? 'Meal' : index % 5 === 3 ? 'Workout' : 'Request';
    const image = hasImage ? assetURL('post', index + 1) : null;
    await client.query(
      `INSERT INTO posts(
         post_id,post_type,subject,post_main_media_url,post_main_media_type,post_media_count,
         post_image_urls,post_video_urls,post_gif_media,poster_id,created_at,post_status,tags
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],'{}'::text[],'{}'::jsonb,$8,NOW()-($9::text || ' hours')::interval,'active',$10::text[])
       ON CONFLICT(post_id) DO UPDATE SET post_type=EXCLUDED.post_type,subject=EXCLUDED.subject,
         post_main_media_url=EXCLUDED.post_main_media_url,post_main_media_type=EXCLUDED.post_main_media_type,
         post_media_count=EXCLUDED.post_media_count,post_image_urls=EXCLUDED.post_image_urls,
         poster_id=EXCLUDED.poster_id,created_at=EXCLUDED.created_at,post_status='active',tags=EXCLUDED.tags`,
      [POST_IDS[index], postType, subjects[index], image, hasImage ? 'image' : null, hasImage ? 1 : 0, hasImage ? [image] : [], poster.userID, String(index + 1), ['seed_prod_temp', 'community', 'weight-loss']],
    );
  }

  let replyCount = 0;
  for (let postIndex = 0; postIndex < 15; postIndex += 1) {
    const count = 2 + (postIndex % 4); // 2...5
    for (let replyIndex = 0; replyIndex < count; replyIndex += 1) {
      const poster = users[(postIndex + replyIndex + 2) % users.length];
      const replyID = stableUUID(`${BATCH}:post-reply:${postIndex + 1}:${replyIndex + 1}`);
      const text = ['Nice work — keep marching.', 'That is a good reminder.', 'I am trying this too.', 'Small wins really add up.', 'This helped me today.'][replyIndex];
      await client.query(
        `INSERT INTO post_replies(
           post_reply_id,parent_id,post_id,post_type,subject,post_media_count,
           post_image_urls,post_video_urls,post_gif_media,poster_id,created_at,post_status,tags,reply_text
         ) VALUES ($1,NULL,$2,'Reply',$3,0,'{}'::text[],'{}'::text[],'{}'::jsonb,$4,
                   NOW()-($5::text || ' minutes')::interval,'active',$6::text[],$3)
         ON CONFLICT(post_reply_id) DO UPDATE SET subject=EXCLUDED.subject,poster_id=EXCLUDED.poster_id,
           post_status='active',tags=EXCLUDED.tags,reply_text=EXCLUDED.reply_text`,
        [replyID, POST_IDS[postIndex], text, poster.userID, String((postIndex * 7) + replyIndex + 10), ['seed_prod_temp', 'reply']],
      );
      replyCount += 1;
    }
  }
  return { posts: POST_IDS.length, replies: replyCount };
}

async function seedEncountersAndResources(client, users, mapDate) {
  const focalUsers = users.slice(0, 6);
  const styles = ['road_encounter', 'scout_report', 'quick_duel'];
  let encounterCount = 0;
  for (let userIndex = 0; userIndex < focalUsers.length; userIndex += 1) {
    const user = focalUsers[userIndex];
    await client.query(
      `INSERT INTO user_resource_state(user_id,resource_key,resource_state,confidence,value,source)
       VALUES ($1,'groceries',$2,0.95,$3::jsonb,$4)
       ON CONFLICT(user_id,resource_key) DO UPDATE SET resource_state=EXCLUDED.resource_state,
         confidence=EXCLUDED.confidence,value=EXCLUDED.value,source=EXCLUDED.source,observed_at=NOW(),updated_at=NOW()`,
      [user.userID, userIndex % 3 === 0 ? 'unavailable' : 'available', JSON.stringify({ seedBatch: BATCH, note: 'Temporary seed resource state' }), BATCH],
    );
    for (let styleIndex = 0; styleIndex < styles.length; styleIndex += 1) {
      const encounterID = stableUUID(`${BATCH}:encounter:${user.userID}:${styles[styleIndex]}`);
      const answered = styleIndex === 2 && userIndex % 2 === 1;
      await client.query(
        `INSERT INTO route_knowledge_encounters(
           encounter_id,user_id,map_date,question_key,question_version,encounter_style,status,
           question_snapshot,trigger_context,answer_data,reward_xp,presented_at,answered_at
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,
                   NOW()-($11::text || ' minutes')::interval,$12)
         ON CONFLICT(encounter_id) DO UPDATE SET status=EXCLUDED.status,question_snapshot=EXCLUDED.question_snapshot,
           trigger_context=EXCLUDED.trigger_context,answer_data=EXCLUDED.answer_data,reward_xp=EXCLUDED.reward_xp,
           presented_at=EXCLUDED.presented_at,answered_at=EXCLUDED.answered_at,updated_at=NOW()`,
        [
          encounterID,
          user.userID,
          mapDate,
          `seed_${styles[styleIndex]}_${userIndex + 1}`,
          styles[styleIndex],
          answered ? 'answered' : 'offered',
          JSON.stringify({ seedBatch: BATCH, title: styleIndex === 0 ? 'Road Encounter' : styleIndex === 1 ? 'Scout Report' : 'Quick Duel', prompt: styleIndex === 0 ? 'Which lunch strategy is more realistic today?' : styleIndex === 1 ? 'Scout reports a busy evening. Prep dinner earlier?' : 'Walk now or after dinner?' }),
          JSON.stringify({ seedBatch: BATCH, source: 'temporary_production_seed', priority: styleIndex + 1 }),
          answered ? JSON.stringify({ choice: 'seed_choice_a' }) : null,
          10 + (styleIndex * 5),
          String((userIndex * 17) + styleIndex + 5),
          answered ? new Date().toISOString() : null,
        ],
      );
      encounterCount += 1;
    }
  }
  return { encounters: encounterCount, resources: focalUsers.length };
}

async function seedDayMaps(client, users, { timeZone, today }) {
  const rules = standardWeightLossDayRules();
  const nowSecond = localClockSeconds(timeZone);
  const dates = [addDays(today, -1), today, addDays(today, 1)];
  const results = [];

  for (let userIndex = 0; userIndex < users.length; userIndex += 1) {
    const user = users[userIndex];
    for (const mapDate of dates) {
      const currentDayTimeSeconds = mapDate < today ? 86_399 : mapDate > today ? 0 : nowSecond;
      const generated = await generateDailyPathForUser(client, {
        userID: user.userID,
        mapDate,
        timeZoneIdentifier: timeZone,
        force: true,
        rules,
        currentDayTimeSeconds,
        maxAlternatives: 2,
      });
      results.push({ username: user.username, mapDate, dayMapID: generated.dayMapID });

      if (mapDate !== today) continue;
      const dayMap = { day_map_id: generated.dayMapID };
      const intervals = await client.query(
        `SELECT i.algorithm_interval_id,i.start_second,i.end_second,i.interval_kind
           FROM day_plan_versions v
           JOIN day_plan_paths p ON p.plan_id=v.plan_id AND p.path_kind='chosen'
           JOIN day_plan_intervals i ON i.plan_path_id=p.plan_path_id
          WHERE v.day_map_id=$1 AND v.plan_status='active'
            AND i.end_second <= $2
            AND i.source_node_id IS NOT NULL
          ORDER BY i.start_second`,
        [generated.dayMapID, nowSecond],
      );

      for (let intervalIndex = 0; intervalIndex < intervals.rows.length; intervalIndex += 1) {
        const row = intervals.rows[intervalIndex];
        // Intentional variation creates green/orange progress outcomes and distinct friend progress values.
        const shouldSkip = (userIndex + intervalIndex) % 5 === 0;
        const partialWorkout = row.interval_kind === 'workout' && (userIndex + intervalIndex) % 4 === 0;
        const actual = shouldSkip
          ? { status: 'skipped', reasonCode: 'temporary_seed_skip', evidence: { seedBatch: BATCH } }
          : partialWorkout
            ? { completedSeconds: Math.max(1, Math.floor((Number(row.end_second) - Number(row.start_second)) * 0.65)), durationSeconds: Number(row.end_second) - Number(row.start_second), status: 'partiallyCompleted', reasonCode: 'temporary_seed_partial', evidence: { seedBatch: BATCH } }
            : { completed: true, status: 'completed', evidence: { seedBatch: BATCH } };
        await recordProgressOutcome(client, {
          dayMap,
          userID: user.userID,
          intervalID: row.algorithm_interval_id,
          actual,
          nowSecond,
          observedAt: new Date().toISOString(),
        });
      }
    }
  }
  return { maps: results.length, dates };
}

async function cleanup(client) {
  // Remove runtime state owned by the deterministic seed accounts first. This
  // avoids relying on the original base schema's created_by FK delete policy.
  await client.query('DELETE FROM day_maps WHERE user_id = ANY($1::uuid[])', [USER_IDS]);
  await client.query('DELETE FROM route_knowledge_encounters WHERE user_id = ANY($1::uuid[])', [USER_IDS]);
  await client.query('DELETE FROM user_resource_state WHERE user_id = ANY($1::uuid[])', [USER_IDS]);

  // Catalog/community rows are removed explicitly; remaining user-owned profile
  // and social rows then disappear through their normal FK cascades.
  const replyIDs = [];
  for (let post = 0; post < 15; post += 1) {
    const count = 2 + (post % 4);
    for (let reply = 0; reply < count; reply += 1) {
      replyIDs.push(stableUUID(`${BATCH}:post-reply:${post + 1}:${reply + 1}`));
    }
  }
  await client.query('DELETE FROM post_replies WHERE post_reply_id = ANY($1::uuid[])', [replyIDs]);
  await client.query('DELETE FROM posts WHERE post_id = ANY($1::uuid[])', [POST_IDS]);
  await client.query('DELETE FROM suggested_meals WHERE suggested_meal_id = ANY($1::uuid[])', [SUGGESTED_MEAL_IDS]);
  await client.query('DELETE FROM tasks WHERE task_id = ANY($1::uuid[])', [TASK_IDS]);
  await client.query('DELETE FROM workouts_exercises WHERE workout_id = ANY($1::uuid[])', [WORKOUT_IDS]);
  await client.query('DELETE FROM workouts WHERE workout_id = ANY($1::uuid[])', [WORKOUT_IDS]);
  await client.query('DELETE FROM exercises WHERE exercise_id = ANY($1::uuid[])', [EXERCISE_IDS]);
  await client.query('DELETE FROM meals WHERE meal_id = ANY($1::uuid[])', [MEAL_IDS]);

  const conversationIDs = [
    ...Array.from({ length: 6 }, (_, index) => stableUUID(`${BATCH}:conversation:${USER_IDS[0]}:${USER_IDS[index + 1]}`)),
    stableUUID(`${BATCH}:support-conversation:${USER_IDS[0]}`),
  ];
  await client.query('DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])', [conversationIDs]);
  await client.query('DELETE FROM conversations WHERE conversation_id = ANY($1::uuid[])', [conversationIDs]);

  // Generated Day Map normalization can create activities/catalog objects owned
  // by the test accounts. Delete or detach those before deleting the accounts.
  await client.query('DELETE FROM activities WHERE created_by = ANY($1::uuid[])', [USER_IDS]);
  await client.query('DELETE FROM suggested_meals WHERE user_id = ANY($1::uuid[])', [USER_IDS]);
  await client.query('DELETE FROM tasks WHERE created_by = ANY($1::uuid[])', [USER_IDS]);
  await client.query('UPDATE workouts SET created_by=NULL WHERE created_by = ANY($1::uuid[])', [USER_IDS]);
  await client.query('UPDATE meals SET created_by=NULL WHERE created_by = ANY($1::uuid[])', [USER_IDS]);
  await client.query('UPDATE exercises SET created_by=NULL WHERE created_by = ANY($1::uuid[])', [USER_IDS]);
  await client.query('DELETE FROM users WHERE user_id = ANY($1::uuid[])', [USER_IDS]);

  return {
    removedSeedUsers: USER_IDS.length,
    preservedNonSeedUsers: true,
    batch: BATCH,
  };
}

async function main() {
  requireProductionConfirmation();
  const cleanupMode = process.argv.includes(CLEANUP_FLAG);
  const timeZone = process.env.SEED_TEST_TIME_ZONE || config.defaultTimeZone || 'America/New_York';
  const today = localDateString(timeZone);

  if (cleanupMode) {
    const result = await withTransaction((client) => cleanup(client));
    console.log('\nTemporary Fifoo production test data removed.');
    console.log(JSON.stringify(result, null, 2));
    console.log('Existing users not belonging to this deterministic seed batch were not deleted.\n');
    return;
  }

  const result = await withTransaction(async (client) => {
    const users = await seedUsers(client);
    // Seed accounts are disposable. A re-seed replaces their runtime Day Maps
    // so yesterday/today/tomorrow always track the execution date cleanly.
    await client.query('DELETE FROM day_maps WHERE user_id = ANY($1::uuid[])', [USER_IDS]);
    const catalog = await seedCatalog(client);
    const suggestedMeals = await seedSuggestedMeals(client, users);
    const social = await seedFriendshipsAndChats(client, users);
    const community = await seedPostsAndReplies(client, users);
    const encounters = await seedEncountersAndResources(client, users, today);
    const dayMaps = await seedDayMaps(client, users, { timeZone, today });
    return { users, catalog, suggestedMeals, social, community, encounters, dayMaps };
  });

  console.log('\nTemporary Fifoo PRODUCTION test seed complete.');
  console.log(`Batch:          ${BATCH}`);
  console.log(`Timezone:       ${timeZone}`);
  console.log(`Seed dates:     ${result.dayMaps.dates.join(', ')}`);
  console.log(`Common password:${DEFAULT_PASSWORD}`);
  console.log(`Counts:         ${JSON.stringify({
    users: result.users.length,
    ...result.catalog,
    suggestedMeals: result.suggestedMeals,
    ...result.social,
    ...result.community,
    ...result.encounters,
    dayMaps: result.dayMaps.maps,
  })}`);
  console.log('\nLogin accounts:');
  for (const user of result.users) {
    console.log(`- ${user.username.padEnd(16)} ${user.email.padEnd(38)} ${DEFAULT_PASSWORD}  wake=${user.wake} bed=${user.bed}`);
  }
  console.log('\nThis data is temporary. Run npm run cleanup:production-test before launch.\n');
}

try {
  await main();
} catch (error) {
  console.error('Temporary production seed failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
