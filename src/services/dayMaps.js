import { randomUUID } from 'node:crypto';
import { GameError } from '../lib/errors.js';
import {
  cloneNode,
  gameNodeID,
  hyperlinkContent,
  postContent,
  reconcileNodeMediaMetadata,
} from '../lib/nodeCodec.js';
import { optionalUUID } from '../lib/validation.js';

export function dayRoom(userID, mapDate) {
  return `game:day:${userID}:${mapDate}`;
}

export function userRoom(userID) {
  return `game:user:${userID}`;
}

export async function ensureDayMap(client, { userID, mapDate, timeZoneIdentifier }) {
  const insert = await client.query(
    `INSERT INTO day_maps (user_id,map_date,timezone,created_by)
     VALUES ($1,$2,$3,$1)
     ON CONFLICT (user_id,map_date)
     DO UPDATE SET timezone = EXCLUDED.timezone
     RETURNING day_map_id,user_id,map_date::text,timezone,revision,current_progress,current_time_seconds`,
    [userID, mapDate, timeZoneIdentifier],
  );
  return insert.rows[0];
}

export async function lockDayMap(client, dayMapID) {
  const result = await client.query(
    `SELECT day_map_id,user_id,map_date::text,timezone,revision,current_progress,current_time_seconds
       FROM day_maps WHERE day_map_id=$1 FOR UPDATE`,
    [dayMapID],
  );
  if (!result.rowCount) throw new GameError('not_found', 'Day Map does not exist.');
  return result.rows[0];
}

export async function bumpRevision(client, dayMapID) {
  const result = await client.query(
    `UPDATE day_maps SET revision=revision+1, updated_at=NOW()
       WHERE day_map_id=$1 RETURNING revision`,
    [dayMapID],
  );
  if (!result.rowCount) throw new GameError('not_found', 'Day Map does not exist.');
  return Number(result.rows[0].revision);
}

function emptyRouteState() {
  return {
    completedRoute: {
      segments: [],
      reachedNodeIDs: [],
      throughTime: null,
      boundary: null,
    },
    chosenFutureRoute: {
      id: { rawValue: randomUUID() },
      stopNodeIDs: [],
      entryLeg: null,
      legs: [],
    },
    alternativeRoutes: [],
    chosenFutureRouteActivatedAt: null,
  };
}

function dailyProgress(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  if (number >= 0 && number <= 1) return number;
  return Math.max(0, Math.min(1, number / 100));
}

function isoDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Merge user-specific social state into the exact Day Map node snapshots that
 * are sent to iOS. The canonical social rows remain relational in PostgreSQL;
 * this merely hydrates the read model so a relaunch restores what the user can
 * actually see in Post/Hyperlink detail views.
 */
export function applySocialStateToNodes(
  nodes,
  {
    userID,
    replyRows = [],
    savedPostIDs = [],
    voteRows = [],
  } = {},
) {
  const saved = new Set(savedPostIDs.map(String));
  const votes = new Map(voteRows.map((row) => [String(row.node_id), row.vote]));

  const repliesByPost = new Map();
  const replyChildCounts = new Map();
  const replyTotalCountsByPost = new Map();

  for (const row of replyRows) {
    const postID = String(row.post_id);
    replyTotalCountsByPost.set(
      postID,
      (replyTotalCountsByPost.get(postID) ?? 0) + 1,
    );

    const parentID = row.parent_id ? String(row.parent_id) : null;
    if (parentID) {
      replyChildCounts.set(parentID, (replyChildCounts.get(parentID) ?? 0) + 1);
    }
  }

  for (const row of replyRows) {
    if (row.parent_id) continue;
    const postID = String(row.post_id);
    const list = repliesByPost.get(postID) ?? [];
    list.push(row);
    repliesByPost.set(postID, list);
  }

  return nodes.map((node) => {
    const copy = cloneNode(node);

    const post = postContent(copy);
    if (post?.snapshot) {
      const postID = optionalUUID(post.postID);
      if (postID) {
        const existing = Array.isArray(post.snapshot.comments)
          ? post.snapshot.comments
          : [];
        const existingIDs = new Set(existing.map((comment) => String(comment.commentID)));

        const persisted = (repliesByPost.get(postID) ?? [])
          .filter((row) => !existingIDs.has(String(row.post_reply_id)))
          .map((row) => ({
            commentID: String(row.post_reply_id),
            userID: row.poster_id ? String(row.poster_id) : '',
            userName: String(row.poster_id) === String(userID) ? 'You' : 'Member',
            userImageURL: '',
            body: String(row.reply_text ?? ''),
            createdAt: isoDate(row.created_at),
            replyCount: replyChildCounts.get(String(row.post_reply_id)) ?? 0,
            likeCount: 0,
            isPinned: false,
          }));

        post.snapshot.comments = [...existing, ...persisted];

        // postResponseCount in older node_data can lag behind post_replies.
        // Reconcile the visible count from both the stored snapshot and the
        // authoritative relational rows. comments.length is included because
        // some imported Post snapshots may already contain comments that are
        // not represented in this Day Map's post_replies table.
        const storedResponseCount = Number(post.snapshot.postResponseCount ?? 0);
        const persistedReplyCount = replyTotalCountsByPost.get(postID) ?? 0;
        post.snapshot.postResponseCount = Math.max(
          Number.isFinite(storedResponseCount) ? storedResponseCount : 0,
          persistedReplyCount,
          post.snapshot.comments.length,
        );

        if (saved.has(postID)) {
          post.snapshot.savedPostStatus = 'Saved';
          const savedCount = Number(post.snapshot.postSavedCount ?? 0);
          post.snapshot.postSavedCount = Math.max(
            Number.isFinite(savedCount) ? savedCount : 0,
            1,
          );
        }
      }
    }

    const hyperlink = hyperlinkContent(copy);
    if (hyperlink) {
      const nodeID = gameNodeID(copy);
      hyperlink.userVote = nodeID ? (votes.get(nodeID) ?? null) : null;
    }

    return copy;
  });
}

async function hydrateSocialNodeState(client, { dayMap, nodes }) {
  const postIDs = [...new Set(
    nodes
      .map((node) => optionalUUID(postContent(node)?.postID))
      .filter(Boolean),
  )];

  const hyperlinkNodeIDs = [...new Set(
    nodes
      .filter((node) => hyperlinkContent(node))
      .map(gameNodeID)
      .filter(Boolean),
  )];

  const [replies, saves, votes] = await Promise.all([
    postIDs.length
      ? client.query(
        `SELECT
           post_reply_id::text,
           parent_id::text,
           post_id::text,
           poster_id::text,
           reply_text,
           created_at
         FROM post_replies
         WHERE post_id = ANY($1::uuid[])
           AND COALESCE(post_status,'active') = 'active'
         ORDER BY created_at,post_reply_id`,
        [postIDs],
      )
      : Promise.resolve({ rows: [] }),
    postIDs.length
      ? client.query(
        `SELECT post_id::text
         FROM post_saves
         WHERE user_id=$1
           AND post_id = ANY($2::uuid[])`,
        [dayMap.user_id, postIDs],
      )
      : Promise.resolve({ rows: [] }),
    hyperlinkNodeIDs.length
      ? client.query(
        `SELECT node_id::text,vote
         FROM day_map_hyperlink_votes
         WHERE day_map_id=$1
           AND user_id=$2
           AND node_id = ANY($3::uuid[])`,
        [dayMap.day_map_id, dayMap.user_id, hyperlinkNodeIDs],
      )
      : Promise.resolve({ rows: [] }),
  ]);

  return applySocialStateToNodes(nodes, {
    userID: dayMap.user_id,
    replyRows: replies.rows,
    savedPostIDs: saves.rows.map((row) => row.post_id),
    voteRows: votes.rows,
  });
}

export async function loadSnapshot(client, dayMap) {
  const [nodes, route, reveals, suggestionDecisions, workout] = await Promise.all([
    client.query(
      `SELECT node_data FROM day_map_nodes
       WHERE day_map_id=$1 AND is_enabled=TRUE
       ORDER BY time_seconds,node_id`,
      [dayMap.day_map_id],
    ),
    client.query(
      `SELECT route_data FROM day_map_routes
       WHERE day_map_id=$1 AND route_type='state'
       ORDER BY updated_at DESC LIMIT 1`,
      [dayMap.day_map_id],
    ),
    client.query(
      `SELECT column_index,row_index FROM day_map_tile_reveals
       WHERE day_map_id=$1 AND is_revealed=TRUE
       ORDER BY row_index,column_index`,
      [dayMap.day_map_id],
    ),
    client.query(
      `SELECT column_index,row_index,decision FROM day_map_suggestion_decisions
       WHERE day_map_id=$1 AND user_id=$2
       ORDER BY row_index,column_index`,
      [dayMap.day_map_id, dayMap.user_id],
    ),
    client.query(
      `SELECT session_data FROM workout_sessions
       WHERE created_by=$1 AND session_data <> '{}'::jsonb
       ORDER BY updated_at DESC,created_at DESC LIMIT 1`,
      [dayMap.user_id],
    ),
  ]);

  const hydratedNodes = await hydrateSocialNodeState(client, {
    dayMap,
    nodes: nodes.rows.map((row) => reconcileNodeMediaMetadata(row.node_data)),
  });

  return {
    revision: Number(dayMap.revision),
    mapDate: dayMap.map_date instanceof Date ? dayMap.map_date.toISOString().slice(0,10) : String(dayMap.map_date ?? '').slice(0,10),
    nodes: hydratedNodes,
    routeState: route.rows[0]?.route_data ?? emptyRouteState(),
    revealedTiles: reveals.rows.map((row) => ({
      column: Number(row.column_index),
      row: Number(row.row_index),
    })),
    suggestionDecisions: suggestionDecisions.rows.map((row) => ({
      cell: {
        column: Number(row.column_index),
        row: Number(row.row_index),
      },
      decision: row.decision,
    })),
    workout: workout.rows[0]?.session_data ?? null,
    userDailyProgress: dailyProgress(dayMap.current_progress),
  };
}
