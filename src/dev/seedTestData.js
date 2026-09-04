import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { hashPassword } from '../services/authService.js';
import { stableUUID } from '../lib/stableUUID.js';
import { generateDailyPathForUser } from '../services/dailyPathGenerator.js';
import { standardWeightLossDayRules } from '../rules/standardWeightLossDay.js';
import { dailyRulesNamed, clockSeconds, alternativeCount } from '../rules/ruleRegistry.js';
import { mealSeedInsertValues } from './seedValues.js';

const DEFAULT_ACCOUNT = Object.freeze({
  email: 'demo.weightloss@fifoo.local',
  username: 'weightloss_demo',
  password: 'FifooTest123!',
  firstName: 'Demo',
  lastName: 'User',
});

function argValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function localDateString(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function ensureTestUser(client, options) {
  const existing = await client.query(
    `SELECT user_id,username,first_name,last_name,email
       FROM users
      WHERE LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($2)
      ORDER BY CASE WHEN LOWER(email)=LOWER($1) THEN 0 ELSE 1 END
      LIMIT 1`,
    [options.email, options.username],
  );

  const passwordHash = await hashPassword(options.password);
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (options.resetPassword) {
      await client.query(
        `UPDATE users SET password=$2,last_active=NOW() WHERE user_id=$1`,
        [row.user_id, passwordHash],
      );
    }
    return row;
  }

  const result = await client.query(
    `INSERT INTO users(username,first_name,last_name,email,password,last_active)
     VALUES ($1,$2,$3,$4,$5,NOW())
     RETURNING user_id,username,first_name,last_name,email`,
    [options.username, options.firstName, options.lastName, options.email, passwordHash],
  );
  return result.rows[0];
}

async function seedExercises(client) {
  const exercises = [
    ['bodyweight-squat', 'Bodyweight Squat', 45, ['Strength', 'Lower Body'], 'Sit the hips back, keep the chest tall, and stand through the whole foot.', [], ['strength', 'beginner']],
    ['incline-pushup', 'Incline Push-Up', 45, ['Strength', 'Upper Body'], 'Use a sturdy elevated surface and keep the body in one straight line.', [], ['strength', 'beginner']],
    ['reverse-lunge', 'Reverse Lunge', 45, ['Strength', 'Lower Body'], 'Step backward under control and drive through the front foot.', [], ['strength', 'beginner']],
    ['glute-bridge', 'Glute Bridge', 45, ['Strength', 'Lower Body'], 'Brace the core and squeeze the glutes at the top.', [], ['strength', 'beginner']],
    ['plank', 'Plank', 30, ['Core'], 'Maintain a straight line from head to heels and breathe normally.', [], ['core', 'beginner']],
    ['brisk-walk', 'Brisk Walk', 1200, ['Walking', 'Cardio'], 'Walk at a pace that feels purposeful but sustainable.', [], ['walking', 'cardio', 'weight-loss']],
  ];

  const rows = [];
  for (const [key, title, duration, categories, description, equipment, tags] of exercises) {
    const id = stableUUID(`fifoo.test.catalog.exercise:${key}`);
    await client.query(
      `INSERT INTO exercises(
         exercise_id,title,duration_in_seconds,exercise_categories,description,
         exercise_status,equipment,created_by,exercise_image_urls,exercise_video_urls,tags
       ) VALUES ($1,$2,$3,$4,$5,'active',$6,NULL,'{}'::text[],'{}'::text[],$7)
       ON CONFLICT(exercise_id) DO UPDATE SET
         title=EXCLUDED.title,duration_in_seconds=EXCLUDED.duration_in_seconds,
         exercise_categories=EXCLUDED.exercise_categories,description=EXCLUDED.description,
         exercise_status='active',equipment=EXCLUDED.equipment,tags=EXCLUDED.tags`,
      [id, title, duration, categories, description, equipment, tags],
    );
    rows.push({ key, id, title });
  }
  return rows;
}

async function seedWorkouts(client, exercises) {
  const byKey = new Map(exercises.map((row) => [row.key, row]));
  const rules = standardWeightLossDayRules();
  const workouts = [
    {
      key: 'morning-walk',
      id: stableUUID(`${rules.name}:v${rules.version}:morning-walk:workout-template`),
      title: '20-Minute Brisk Walk',
      duration: 1200,
      categories: ['Walking', 'Cardio', 'Weight Loss'],
      description: 'A simple brisk walk that is easy to repeat consistently.',
      format: 'Independent',
      exercises: [{ key: 'brisk-walk', duration: 1200, minDuration: 600 }],
    },
    {
      key: 'strength-workout',
      id: stableUUID(`${rules.name}:v${rules.version}:strength-workout:workout-template`),
      title: '30-Minute Beginner Full-Body Strength',
      duration: 1800,
      categories: ['Strength', 'Full Body', 'Weight Loss'],
      description: 'A repeatable beginner strength workout designed around major movement patterns.',
      format: 'Independent',
      exercises: [
        { key: 'bodyweight-squat', sets: 3, reps: 10, duration: 180, minDuration: 90 },
        { key: 'incline-pushup', sets: 3, reps: 8, duration: 180, minDuration: 90 },
        { key: 'reverse-lunge', sets: 3, reps: 8, duration: 240, minDuration: 120 },
        { key: 'glute-bridge', sets: 3, reps: 12, duration: 180, minDuration: 90 },
        { key: 'plank', sets: 3, duration: 120, minDuration: 60 },
      ],
    },
  ];

  for (const workout of workouts) {
    await client.query(
      `INSERT INTO workouts(
         workout_id,title,duration_in_seconds,workout_categories,description,
         workout_status,workout_format,created_by,workout_image_urls,tags
       ) VALUES ($1,$2,$3,$4,$5,'active',$6,NULL,'{}'::text[],$4)
       ON CONFLICT(workout_id) DO UPDATE SET
         title=EXCLUDED.title,duration_in_seconds=EXCLUDED.duration_in_seconds,
         workout_categories=EXCLUDED.workout_categories,description=EXCLUDED.description,
         workout_status='active',workout_format=EXCLUDED.workout_format,tags=EXCLUDED.tags`,
      [workout.id, workout.title, workout.duration, workout.categories, workout.description, workout.format],
    );

    await client.query('DELETE FROM workouts_exercises WHERE workout_id=$1', [workout.id]);
    let order = 1;
    for (const assignment of workout.exercises) {
      const exercise = byKey.get(assignment.key);
      if (!exercise) continue;
      await client.query(
        `INSERT INTO workouts_exercises(
           workout_id,exercise_id,exercise_order,sets,reps,duration_in_seconds,
           min_duration_in_seconds,exercise_instructions,is_enabled,created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,TRUE,NULL)`,
        [
          workout.id,
          exercise.id,
          order,
          assignment.sets ?? null,
          assignment.reps ?? null,
          assignment.duration ?? null,
          assignment.minDuration ?? null,
          JSON.stringify({
            demoVideoUrl: null,
            steps: ['Move with control.', 'Stop if form breaks down.', 'Complete the planned reps or time.'],
          }),
        ],
      );
      order += 1;
    }
  }

  return workouts.map(({ key, id, title }) => ({ key, id, title }));
}

async function seedMeals(client) {
  const meals = [
    ['protein-breakfast', 'Greek Yogurt, Berries & Oats', 390, ['breakfast'], 'Protein-rich breakfast with fruit and whole grains.', ['protein', 'fiber', 'weight-loss']],
    ['balanced-lunch', 'Chicken Grain Bowl', 510, ['lunch'], 'Lean protein, vegetables, and a measured whole-grain portion.', ['protein', 'vegetables', 'weight-loss']],
    ['planned-snack', 'Apple & Greek Yogurt', 190, ['snack'], 'A simple planned snack for the afternoon hunger window.', ['snack', 'protein', 'fruit']],
    ['balanced-dinner', 'Salmon, Potatoes & Vegetables', 560, ['dinner'], 'A filling dinner with protein, vegetables, and a measured starch.', ['protein', 'vegetables', 'weight-loss']],
  ];
  for (const [key, title, calories, mealTypes, description, tags] of meals) {
    const id = stableUUID(`fifoo.test.catalog.meal:${key}`);
    await client.query(
      `INSERT INTO meals(
         meal_id,title,calories_per_meal,created_by,status,description,meal_types,
         meal_image_urls,meal_video_urls,is_available,is_featured,tags
       ) VALUES ($1,$2,$3,NULL,'active',$4,$5::text[],'{}'::text[],'{}'::text[],TRUE,FALSE,$6::text[])
       ON CONFLICT(meal_id) DO UPDATE SET
         title=EXCLUDED.title,calories_per_meal=EXCLUDED.calories_per_meal,
         status='active',description=EXCLUDED.description,meal_types=EXCLUDED.meal_types,
         is_available=TRUE,tags=EXCLUDED.tags,updated_at=NOW()`,
      mealSeedInsertValues({ id, title, calories, description, mealTypes, tags }),
    );
  }
  return meals.length;
}

async function seedTaskCatalog(client) {
  const tasks = [
    ['morning-water', 'Drink water after waking', 'Home', 'Make hydration the first easy win of the day.'],
    ['meal-prep', 'Prep tomorrow\'s lunch', 'Home', 'Reduce tomorrow\'s decision load by preparing one meal in advance.'],
    ['sleep-window', 'Start wind-down routine', 'Home', 'Create a predictable transition toward adequate sleep.'],
  ];
  for (const [key, title, location, description] of tasks) {
    const id = stableUUID(`fifoo.test.catalog.task:${key}`);
    await client.query(
      `INSERT INTO tasks(task_id,title,location,status,tags,created_by,description)
       VALUES ($1,$2,$3,'active',$4,NULL,$5)
       ON CONFLICT(task_id) DO UPDATE SET
         title=EXCLUDED.title,location=EXCLUDED.location,status='active',
         tags=EXCLUDED.tags,description=EXCLUDED.description,updated_at=NOW()`,
      [id, title, location, ['weight-loss', 'routine'], description],
    );
  }
  return tasks.length;
}

async function seedPosts(client, userID) {
  const posts = [
    ['tip-protein', 'Tip', 'Make protein the anchor of each main meal', ['weight-loss', 'nutrition']],
    ['tip-walk', 'Tip', 'A ten-minute walk still counts', ['weight-loss', 'walking']],
    ['request-consistency', 'Request', 'What helps you stay consistent on busy days?', ['weight-loss', 'consistency']],
  ];
  for (const [key, type, subject, tags] of posts) {
    const id = stableUUID(`fifoo.test.catalog.post:${userID}:${key}`);
    await client.query(
      `INSERT INTO posts(
         post_id,post_type,subject,post_media_count,post_image_urls,post_video_urls,
         post_gif_media,poster_id,post_status,tags
       ) VALUES ($1,$2,$3,0,'{}'::text[],'{}'::text[],'{}'::jsonb,$4,'active',$5)
       ON CONFLICT(post_id) DO UPDATE SET
         post_type=EXCLUDED.post_type,subject=EXCLUDED.subject,post_status='active',tags=EXCLUDED.tags`,
      [id, type, subject, userID, tags],
    );
  }
  return posts.length;
}



async function seedSocialTestData(client, userID) {
  const friends = [
    ['maya', 'Maya', 'Chen', 'maya.friend@fifoo.local', '2 hours'],
    ['jordan', 'Jordan', 'Brooks', 'jordan.friend@fifoo.local', '1 day'],
    ['alex', 'Alex', 'Rivera', 'alex.friend@fifoo.local', '3 days'],
  ];

  const friendRows = [];
  for (const [key, firstName, lastName, email, age] of friends) {
    const friendID = stableUUID(`fifoo.test.social.friend:${key}`);
    await client.query(
      `INSERT INTO users(user_id,username,first_name,last_name,email,password,last_active,profile_image_url)
       VALUES ($1,$2,$3,$4,$5,'system-account-disabled',NOW() - $6::interval,NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
         last_active=EXCLUDED.last_active,profile_image_url=EXCLUDED.profile_image_url`,
      [friendID, `friend_${key}`, firstName, lastName, email, age],
    );
    await client.query(
      `INSERT INTO user_friends(user_id,friend_user_id,status)
       VALUES ($1,$2,'accepted')
       ON CONFLICT DO NOTHING`,
      [userID, friendID],
    );
    friendRows.push({ key, friendID, firstName, lastName });
  }

  const progresses = [48, 72, 31];
  for (let index = 0; index < friendRows.length; index += 1) {
    const friend = friendRows[index];
    await client.query(
      `INSERT INTO day_maps(user_id,map_date,timezone,current_progress,created_by)
       VALUES ($1,CURRENT_DATE,$2,$3,$1)
       ON CONFLICT(user_id,map_date) DO UPDATE SET current_progress=EXCLUDED.current_progress`,
      [friend.friendID, config.defaultTimeZone, progresses[index]],
    );
  }

  // Give the first two friends existing direct-message threads so ChatsView has
  // meaningful rows immediately after seed:dev.
  for (const friend of friendRows.slice(0, 2)) {
    const conversationID = stableUUID(`fifoo.test.social.conversation:${userID}:${friend.friendID}`);
    await client.query(
      `INSERT INTO conversations(conversation_id,conversation_member_ids,status,created_by)
       VALUES ($1,ARRAY[$2::uuid,$3::uuid],'active',$2)
       ON CONFLICT(conversation_id) DO NOTHING`,
      [conversationID, userID, friend.friendID],
    );
    const friendMessageID = stableUUID(`fifoo.test.social.message:${conversationID}:friend`);
    const userMessageID = stableUUID(`fifoo.test.social.message:${conversationID}:user`);
    await client.query(
      `INSERT INTO messages(message_id,conversation_id,subject,body,sender_id,created_at)
       VALUES ($1,$2,$3,$3,$4,NOW()-INTERVAL '35 minutes')
       ON CONFLICT(message_id) DO NOTHING`,
      [friendMessageID, conversationID, `How is your day going?`, friend.friendID],
    );
    await client.query(
      `INSERT INTO messages(message_id,conversation_id,subject,body,sender_id,created_at)
       VALUES ($1,$2,$3,$3,$4,NOW()-INTERVAL '30 minutes')
       ON CONFLICT(message_id) DO NOTHING`,
      [userMessageID, conversationID, `Going well — staying on plan.`, userID],
    );
    await client.query('UPDATE conversations SET updated_at=NOW()-INTERVAL \'30 minutes\' WHERE conversation_id=$1', [conversationID]);
  }

  // A few posts from friends make the general PostsView feel like a real feed.
  for (const friend of friendRows) {
    const postID = stableUUID(`fifoo.test.social.post:${friend.friendID}`);
    const subject = friend.key === 'maya'
      ? 'Meal prep made today much easier.'
      : friend.key === 'jordan'
        ? 'Got my walk in even though the day was busy.'
        : 'Small wins add up. Back on track today.';
    await client.query(
      `INSERT INTO posts(post_id,post_type,subject,poster_id,post_status,tags)
       VALUES ($1,'Tip',$2,$3,'active',ARRAY['community','weight-loss']::text[])
       ON CONFLICT(post_id) DO UPDATE SET subject=EXCLUDED.subject,post_status='active'`,
      [postID, subject, friend.friendID],
    );
  }

  return { friends: friendRows.length, conversations: 2, communityPosts: friendRows.length };
}


async function upsertSleepSchedule(client, userID, { wake, bed }) {
  for (const [scheduleKey, clockTime] of [['wake', wake], ['bed', bed]]) {
    await client.query(
      `INSERT INTO user_schedule_preferences(
         user_id,schedule_key,clock_time,flexibility_minutes,is_fixed,source,preference_data
       ) VALUES ($1,$2,$3::time,30,FALSE,'dev_ui_fix_seed',$4::jsonb)
       ON CONFLICT(user_id,schedule_key) DO UPDATE SET
         clock_time=EXCLUDED.clock_time,
         source=EXCLUDED.source,
         preference_data=EXCLUDED.preference_data,
         updated_at=NOW()`,
      [userID, scheduleKey, clockTime, JSON.stringify({ uiFixSeed: true })],
    );
  }
}

async function seedUIFixScenarios(client, {
  mapDate,
  timeZone,
  rules,
  password,
}) {
  const profiles = [
    {
      key: 'standard',
      email: 'ui.standard@fifoo.local',
      username: 'ui_standard',
      firstName: 'UI',
      lastName: 'Standard',
      wake: '07:00:00',
      bed: '23:00:00',
      currentTime: '09:55:00',
      note: 'Five minutes before the morning workout: tests NEXT countdown, fasting tile, positive progress badges.',
    },
    {
      key: 'active-workout',
      email: 'ui.workout@fifoo.local',
      username: 'ui_workout',
      firstName: 'UI',
      lastName: 'Workout',
      wake: '06:30:00',
      bed: '22:30:00',
      currentTime: '10:08:00',
      note: 'Inside the morning workout: tests current-tile halo, active countdown and completion transition.',
    },
    {
      key: 'third-shift',
      email: 'ui.thirdshift@fifoo.local',
      username: 'ui_thirdshift',
      firstName: 'UI',
      lastName: 'ThirdShift',
      wake: '16:00:00',
      bed: '08:00:00',
      currentTime: '14:00:00',
      note: 'User day starts at 4 PM and ends at 8 AM: tests daytime Sleep hour tiles inside the personal 24-hour rhythm.',
    },
    {
      key: 'dinner-transition',
      email: 'ui.dinner@fifoo.local',
      username: 'ui_dinner',
      firstName: 'UI',
      lastName: 'Dinner',
      wake: '07:00:00',
      bed: '23:30:00',
      currentTime: '18:55:00',
      note: 'Five minutes before dinner: tests high-priority meal countdown and positive/negative empty-tile opportunity badges.',
    },
  ];

  const results = [];
  for (const profile of profiles) {
    const user = await ensureTestUser(client, {
      email: profile.email,
      username: profile.username,
      password,
      firstName: profile.firstName,
      lastName: profile.lastName,
      resetPassword: true,
    });
    await upsertSleepSchedule(client, user.user_id, profile);
    const day = await generateDailyPathForUser(client, {
      userID: user.user_id,
      mapDate,
      timeZoneIdentifier: timeZone,
      force: true,
      rules,
      currentDayTimeSeconds: clockSeconds(profile.currentTime, timeZone),
      maxAlternatives: 2,
    });
    results.push({
      key: profile.key,
      email: profile.email,
      username: profile.username,
      password,
      wake: profile.wake,
      bed: profile.bed,
      currentTime: profile.currentTime,
      note: profile.note,
      userID: user.user_id,
      dayMapID: day.dayMapID,
    });
  }
  return results;
}

async function seedCatalog(client, userID) {
  const exercises = await seedExercises(client);
  const workouts = await seedWorkouts(client, exercises);
  const mealCount = await seedMeals(client);
  const taskCount = await seedTaskCatalog(client);
  const postCount = await seedPosts(client, userID);
  const social = await seedSocialTestData(client, userID);
  return {
    exercises: exercises.length,
    workouts: workouts.length,
    meals: mealCount,
    tasks: taskCount,
    posts: postCount,
    social,
  };
}

async function main() {
  if (config.nodeEnv === 'production') {
    throw new Error('seed:dev is disabled when NODE_ENV=production.');
  }

  if (hasFlag('help')) {
    console.log(`\nFifoo development seed\n\n` +
      `npm run seed:dev -- [options]\n\n` +
      `--email <email>            test login email\n` +
      `--username <username>      test login username\n` +
      `--password <password>      test login password\n` +
      `--date YYYY-MM-DD          Day Map date (defaults to today)\n` +
      `--timezone IANA            defaults to DEFAULT_TIME_ZONE\n` +
      `--force-day                regenerate generated nodes/path\n` +
      `--rules <name>             standard | demo-aug29\n` +
      `--current-time <clock>     HH:MM[:SS] or now; splits Completed/Future\n` +
      `--alternatives <0...5>     future route alternatives (default 3)\n` +
      `--no-day                   seed account/catalog only\n` +
      `--ui-fixes                 add four UI/routing regression accounts\n` +
      `--reset-password           replace password on an existing custom account\n`);
    return;
  }

  const email = argValue('email') ?? DEFAULT_ACCOUNT.email;
  const username = argValue('username') ?? DEFAULT_ACCOUNT.username;
  const password = argValue('password') ?? DEFAULT_ACCOUNT.password;
  const timeZone = argValue('timezone') ?? config.defaultTimeZone;
  const mapDate = argValue('date') ?? localDateString(timeZone);
  const usingDefaultAccount = email === DEFAULT_ACCOUNT.email && username === DEFAULT_ACCOUNT.username;
  const dayRules = dailyRulesNamed(argValue('rules') ?? 'standard');
  const currentDayTimeSeconds = clockSeconds(argValue('current-time') ?? '', timeZone);
  const maxAlternatives = alternativeCount(argValue('alternatives'), 3);

  const result = await withTransaction(async (client) => {
    const user = await ensureTestUser(client, {
      email,
      username,
      password,
      firstName: DEFAULT_ACCOUNT.firstName,
      lastName: DEFAULT_ACCOUNT.lastName,
      resetPassword: hasFlag('reset-password') || usingDefaultAccount,
    });
    const catalog = await seedCatalog(client, user.user_id);
    const day = hasFlag('no-day')
      ? null
      : await generateDailyPathForUser(client, {
        userID: user.user_id,
        mapDate,
        timeZoneIdentifier: timeZone,
        force: hasFlag('force-day'),
        rules: dayRules,
        currentDayTimeSeconds,
        maxAlternatives,
      });
    const uiFixes = hasFlag('ui-fixes')
      ? await seedUIFixScenarios(client, {
        mapDate,
        timeZone,
        rules: dayRules,
        password,
      })
      : [];
    return { user, catalog, day, uiFixes };
  });

  console.log('\nFifoo development data seeded.');
  console.log(`Login email:    ${email}`);
  console.log(`Login username: ${username}`);
  console.log(`Login password: ${password}`);
  console.log(`User ID:        ${result.user.user_id}`);
  console.log(`Catalog:        ${JSON.stringify(result.catalog)}`);
  if (result.day) {
    console.log(`Day Map:        ${result.day.mapDate} (${result.day.generated ? 'generated' : result.day.reason})`);
    console.log(`Generated stops:${result.day.generatedNodeIDs.length}`);
    console.log(`Rules:          ${dayRules.name} v${dayRules.version}`);
    console.log(`Alternatives:   ${result.day.routeState?.alternativeRoutes?.length ?? 0}`);
  }
  if (result.uiFixes?.length) {
    console.log('\nUI-fix regression accounts:');
    for (const profile of result.uiFixes) {
      console.log(`- ${profile.username} / ${profile.password} — ${profile.note}`);
      console.log(`  wake=${profile.wake} bed=${profile.bed} simulatedNow=${profile.currentTime}`);
    }
  }
  console.log('');
}

try {
  await main();
} catch (error) {
  console.error('Development seed failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
