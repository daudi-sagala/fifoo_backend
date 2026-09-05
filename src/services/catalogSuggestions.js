import crypto from 'node:crypto';

import { GameError } from '../lib/errors.js';

const KINDS = new Set(['meal', 'workout', 'task']);

export function normalizeCatalogKind(value) {
  const kind = String(value ?? '').trim().toLowerCase();
  if (!KINDS.has(kind)) {
    throw new GameError('invalid_payload', 'Catalog type must be meal, workout, or task.');
  }
  return kind;
}

export function normalizeCatalogTitle(value) {
  const title = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!title) throw new GameError('invalid_payload', 'Enter a name first.');
  if (title.length > 120) throw new GameError('invalid_payload', 'Name must be 120 characters or fewer.');
  return title;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 20;
  return Math.max(1, Math.min(40, Math.trunc(number)));
}

function rowToItem(kind, row) {
  return {
    id: String(row.id),
    kind,
    title: String(row.title ?? ''),
    subtitle: row.subtitle == null || String(row.subtitle).trim() === '' ? null : String(row.subtitle),
    location: row.location == null || String(row.location).trim() === '' ? null : String(row.location),
    durationSeconds: row.duration_seconds != null && Number.isFinite(Number(row.duration_seconds))
      ? Math.max(0, Math.trunc(Number(row.duration_seconds)))
      : null,
    imageURL: row.image_url == null || String(row.image_url).trim() === '' ? null : String(row.image_url),
    format: row.format == null || String(row.format).trim() === '' ? null : String(row.format),
    userSuggested: row.user_suggested === true,
  };
}

export async function searchCatalogSuggestions(client, {
  userID,
  kind: rawKind,
  query = '',
  limit = 20,
} = {}) {
  const kind = normalizeCatalogKind(rawKind);
  const cleanedQuery = String(query ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const like = `%${cleanedQuery}%`;
  const safeLimit = normalizeLimit(limit);

  let result;
  if (kind === 'meal') {
    result = await client.query(
      `SELECT meal_id::text AS id,
              title,
              description AS subtitle,
              NULL::text AS location,
              NULL::int AS duration_seconds,
              NULLIF(meal_image_urls[1], '') AS image_url,
              NULL::text AS format,
              (created_by=$1 AND 'user_suggested'=ANY(COALESCE(tags,'{}'::text[]))) AS user_suggested
         FROM meals
        WHERE (LOWER(COALESCE(status,'')) IN ('active','available') OR created_by=$1)
          AND ($2='' OR title ILIKE $3)
        ORDER BY CASE WHEN LOWER(title)=LOWER($2) THEN 0 WHEN created_by=$1 THEN 1 ELSE 2 END,
                 title
        LIMIT $4`,
      [userID, cleanedQuery, like, safeLimit],
    );
  } else if (kind === 'workout') {
    result = await client.query(
      `SELECT workout_id::text AS id,
              title,
              description AS subtitle,
              location,
              duration_in_seconds,
              NULLIF(workout_image_urls[1], '') AS image_url,
              workout_format AS format,
              (created_by=$1 AND 'user_suggested'=ANY(COALESCE(tags,'{}'::text[]))) AS user_suggested
         FROM workouts
        WHERE (LOWER(COALESCE(workout_status,'')) IN ('active','scheduled','available') OR created_by=$1)
          AND ($2='' OR title ILIKE $3 OR COALESCE(location,'') ILIKE $3)
        ORDER BY CASE WHEN LOWER(title)=LOWER($2) THEN 0 WHEN created_by=$1 THEN 1 ELSE 2 END,
                 title
        LIMIT $4`,
      [userID, cleanedQuery, like, safeLimit],
    );
  } else {
    result = await client.query(
      `SELECT task_id::text AS id,
              title,
              description AS subtitle,
              location,
              NULL::int AS duration_seconds,
              NULLIF(task_main_image_url, '') AS image_url,
              NULL::text AS format,
              (created_by=$1 AND 'user_suggested'=ANY(COALESCE(tags,'{}'::text[]))) AS user_suggested
         FROM tasks
        WHERE (LOWER(COALESCE(status,'')) IN ('active','scheduled','available') OR created_by=$1)
          AND ($2='' OR title ILIKE $3 OR COALESCE(location,'') ILIKE $3)
        ORDER BY CASE WHEN LOWER(title)=LOWER($2) THEN 0 WHEN created_by=$1 THEN 1 ELSE 2 END,
                 title
        LIMIT $4`,
      [userID, cleanedQuery, like, safeLimit],
    );
  }

  return (result.rows ?? []).map((row) => rowToItem(kind, row));
}

export async function createCatalogSuggestion(client, {
  userID,
  kind: rawKind,
  title: rawTitle,
} = {}) {
  const kind = normalizeCatalogKind(rawKind);
  const title = normalizeCatalogTitle(rawTitle);

  const existing = await searchCatalogSuggestions(client, { userID, kind, query: title, limit: 20 });
  const exact = existing.find((item) => item.title.localeCompare(title, undefined, { sensitivity: 'accent' }) === 0);
  if (exact) {
    return { item: exact, created: false };
  }

  const id = crypto.randomUUID();

  if (kind === 'meal') {
    await client.query(
      `INSERT INTO meals(
         meal_id,title,created_by,status,description,meal_types,meal_image_urls,meal_video_urls,is_available,tags
       ) VALUES ($1,$2,$3,'active',NULL,'{}'::text[],'{}'::text[],'{}'::text[],TRUE,ARRAY['user_suggested']::text[])`,
      [id, title, userID],
    );
  } else if (kind === 'workout') {
    await client.query(
      `INSERT INTO workouts(
         workout_id,title,location,duration_in_seconds,workout_categories,description,
         workout_status,workout_format,created_by,workout_image_urls,tags
       ) VALUES ($1,$2,'',1800,ARRAY['Suggested']::text[],NULL,
                 'active','Independent',$3,'{}'::text[],ARRAY['user_suggested']::text[])`,
      [id, title, userID],
    );
  } else {
    await client.query(
      `INSERT INTO tasks(
         task_id,title,location,status,tags,created_by,description
       ) VALUES ($1,$2,'','active',ARRAY['user_suggested']::text[],$3,NULL)`,
      [id, title, userID],
    );
  }

  return {
    created: true,
    item: {
      id,
      kind,
      title,
      subtitle: `Suggested ${kind}`,
      location: null,
      durationSeconds: kind === 'workout' ? 1800 : null,
      imageURL: null,
      format: kind === 'workout' ? 'Independent' : null,
      userSuggested: true,
    },
  };
}
