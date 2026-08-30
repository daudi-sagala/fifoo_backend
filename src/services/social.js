import { randomUUID } from 'node:crypto';
import { GameError } from '../lib/errors.js';
import { assertString, assertUUID, optionalUUID } from '../lib/validation.js';
import { cloneNode, postContent } from '../lib/nodeCodec.js';
import { loadOwnedNode, persistNode } from './nodes.js';

export async function createPostReply(client, { dayMap, userID, context, payload }) {
  const nodeID = assertUUID(payload.nodeID, 'payload.nodeID');
  const postID = assertUUID(payload.postID, 'payload.postID');
  const text = assertString(payload.text, 'payload.text').trim();
  if (text.length > 10_000) throw new GameError('validation_failed', 'Reply text is too long.');

  const owned = await loadOwnedNode(client, { dayMapID: dayMap.day_map_id, nodeID });
  const nodePostID = optionalUUID(postContent(owned.node)?.postID);
  if (owned.kind !== 'post' || nodePostID !== postID) {
    throw new GameError('validation_failed', 'Post reply target does not match the Day Map post node.');
  }

  const postResult = await client.query(`SELECT * FROM posts WHERE post_id=$1`, [postID]);
  if (!postResult.rowCount) throw new GameError('not_found', 'Post does not exist.');
  const post = postResult.rows[0];

  const parentReplyID = optionalUUID(payload.parentReplyID);
  if (parentReplyID) {
    const parent = await client.query(
      `SELECT 1 FROM post_replies WHERE post_reply_id=$1 AND post_id=$2`,
      [parentReplyID, postID],
    );
    if (!parent.rowCount) throw new GameError('not_found', 'Parent reply does not exist for this post.');
  }

  const replyID = randomUUID();
  await client.query(
    `INSERT INTO post_replies
      (post_reply_id,parent_id,post_id,post_type,subject,reply_text,post_main_media_url,
       post_main_media_type,post_media_count,post_image_urls,post_video_urls,post_gif_media,
       poster_id,created_at,post_status,tags)
     VALUES ($1,$2,$3,'Reply',$4,$4,NULL,NULL,0,'{}'::text[],'{}'::text[],'{}'::jsonb,$5,COALESCE($6::timestamptz,NOW()),'active','{}'::text[])`,
    [replyID, parentReplyID, postID, text, userID, payload.createdAt ?? null],
  );

  // Keep the Day Map Post read-model synchronized with the relational reply
  // row in the same authoritative mutation. This makes the reply visible on
  // the immediate node-upsert event and ensures it is already present in
  // day_map_nodes.node_data on the next snapshot. The relational
  // post_replies table remains authoritative; snapshot hydration still
  // reconciles older nodes that do not yet contain their reply bodies.
  const updatedNode = cloneNode(owned.node);
  const postContentValue = postContent(updatedNode);

  if (postContentValue?.snapshot) {
    const existingComments = Array.isArray(postContentValue.snapshot.comments)
      ? postContentValue.snapshot.comments
      : [];

    postContentValue.snapshot.comments = [
      ...existingComments,
      {
        commentID: replyID,
        userID: String(userID),
        userName: 'You',
        userImageURL: '',
        body: text,
        createdAt: new Date(payload.createdAt ?? Date.now()).toISOString(),
        replyCount: 0,
        likeCount: 0,
        isPinned: false,
      },
    ];

    const oldCount = Number(postContentValue.snapshot.postResponseCount ?? 0);
    postContentValue.snapshot.postResponseCount =
      (Number.isFinite(oldCount) ? oldCount : 0) + 1;
  }

  await persistNode(client, { dayMap, userID, context, node: updatedNode });
  return { node: updatedNode, replyID };
}
