import { randomUUID } from 'node:crypto';
import { GameError } from '../lib/errors.js';
import { assertString, assertUUID } from '../lib/validation.js';

export const FIFOO_SUPPORT_USER_ID = '00000000-0000-4000-8000-00000000f100';

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function displayName(row) {
  const full = [row.first_name, row.last_name]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return full || String(row.username ?? 'Member');
}

function percentage(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  if (number >= 0 && number <= 1) return number * 100;
  return number;
}

async function loadUsersByIDs(client, ids) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (!unique.length) return new Map();
  const result = await client.query(
    `SELECT user_id::text,username,first_name,last_name,profile_image_url,last_active
       FROM users
      WHERE user_id = ANY($1::uuid[])`,
    [unique],
  );
  return new Map(result.rows.map((row) => [String(row.user_id), row]));
}

async function assertConversationMember(client, { conversationID, userID }) {
  const result = await client.query(
    `SELECT conversation_id::text,conversation_member_ids,created_at,updated_at,status
       FROM conversations
      WHERE conversation_id=$1
        AND $2::uuid = ANY(conversation_member_ids)
        AND status='active'`,
    [conversationID, userID],
  );
  if (!result.rowCount) {
    throw new GameError('not_found', 'Conversation does not exist or is not available to this user.');
  }
  return result.rows[0];
}

function participantDTO(row) {
  return {
    userID: String(row.user_id),
    username: String(row.username ?? ''),
    displayName: displayName(row),
    imageURL: row.profile_image_url ?? null,
    lastActive: iso(row.last_active),
  };
}

function messageDTO(row) {
  return {
    messageID: String(row.message_id),
    conversationID: String(row.conversation_id),
    body: String(row.body || row.subject || ''),
    imageURLs: Array.isArray(row.image_urls) ? row.image_urls : [],
    videoURLs: Array.isArray(row.video_urls) ? row.video_urls : [],
    senderID: row.sender_id ? String(row.sender_id) : null,
    senderName: row.sender_name ?? 'Member',
    senderImageURL: row.sender_image_url ?? null,
    createdAt: iso(row.created_at),
  };
}

export async function listConversations(client, { userID }) {
  const result = await client.query(
    `SELECT
       c.conversation_id::text,
       c.conversation_member_ids,
       c.created_at,
       c.updated_at,
       lm.message_id::text AS last_message_id,
       COALESCE(lm.body,lm.subject,'') AS last_message_body,
       lm.created_at AS last_message_created_at,
       lm.sender_id::text AS last_message_sender_id
     FROM conversations c
     LEFT JOIN LATERAL (
       SELECT message_id,body,subject,created_at,sender_id
         FROM messages
        WHERE conversation_id=c.conversation_id
        ORDER BY created_at DESC,message_id DESC
        LIMIT 1
     ) lm ON TRUE
     WHERE $1::uuid = ANY(c.conversation_member_ids)
       AND c.status='active'
     ORDER BY COALESCE(lm.created_at,c.updated_at) DESC,c.conversation_id`,
    [userID],
  );

  const allMemberIDs = result.rows.flatMap((row) => row.conversation_member_ids ?? []);
  const users = await loadUsersByIDs(client, allMemberIDs);

  return result.rows.map((row) => {
    const participants = (row.conversation_member_ids ?? [])
      .map((id) => users.get(String(id)))
      .filter(Boolean)
      .map(participantDTO);
    const others = participants.filter((participant) => participant.userID !== String(userID));
    const title = others.length === 1
      ? others[0].displayName
      : (others.map((participant) => participant.displayName).join(', ') || 'Conversation');
    return {
      conversationID: String(row.conversation_id),
      title,
      participants,
      lastMessage: row.last_message_id ? {
        messageID: String(row.last_message_id),
        body: String(row.last_message_body ?? ''),
        senderID: row.last_message_sender_id ? String(row.last_message_sender_id) : null,
        createdAt: iso(row.last_message_created_at),
      } : null,
      updatedAt: iso(row.last_message_created_at ?? row.updated_at ?? row.created_at),
      isSupport: (row.conversation_member_ids ?? []).map(String).includes(FIFOO_SUPPORT_USER_ID),
    };
  });
}

export async function ensureDirectConversation(client, { userID, partnerUserID }) {
  assertUUID(partnerUserID, 'partnerUserID');
  if (String(userID) === String(partnerUserID)) {
    throw new GameError('invalid_payload', 'A direct conversation requires another user.');
  }

  const partner = await client.query(
    `SELECT user_id FROM users WHERE user_id=$1`,
    [partnerUserID],
  );
  if (!partner.rowCount) throw new GameError('not_found', 'Conversation partner does not exist.');

  const existing = await client.query(
    `SELECT conversation_id::text
       FROM conversations
      WHERE status='active'
        AND cardinality(conversation_member_ids)=2
        AND conversation_member_ids @> ARRAY[$1::uuid,$2::uuid]
      ORDER BY created_at
      LIMIT 1`,
    [userID, partnerUserID],
  );
  if (existing.rowCount) return existing.rows[0].conversation_id;

  const inserted = await client.query(
    `INSERT INTO conversations(conversation_member_ids,status,created_by)
     VALUES (ARRAY[$1::uuid,$2::uuid],'active',$1)
     RETURNING conversation_id::text`,
    [userID, partnerUserID],
  );
  return inserted.rows[0].conversation_id;
}

export async function ensureSupportConversation(client, { userID }) {
  const conversationID = await ensureDirectConversation(client, {
    userID,
    partnerUserID: FIFOO_SUPPORT_USER_ID,
  });

  const count = await client.query(
    `SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id=$1`,
    [conversationID],
  );
  if (Number(count.rows[0]?.count ?? 0) === 0) {
    await client.query(
      `INSERT INTO messages(message_id,conversation_id,subject,body,sender_id)
       VALUES ($1,$2,$3,$3,$4)`,
      [
        randomUUID(),
        conversationID,
        'Hi — this is Fifoo Support. Send us a message and we’ll help you with your account or experience.',
        FIFOO_SUPPORT_USER_ID,
      ],
    );
    await client.query('UPDATE conversations SET updated_at=NOW() WHERE conversation_id=$1', [conversationID]);
  }
  return conversationID;
}

export async function listConversationMessages(client, { userID, conversationID }) {
  assertUUID(conversationID, 'conversationID');
  await assertConversationMember(client, { conversationID, userID });
  const result = await client.query(
    `SELECT
       m.message_id::text,
       m.conversation_id::text,
       m.body,m.subject,m.image_urls,m.video_urls,m.sender_id::text,m.created_at,
       COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),u.username,'Member') AS sender_name,
       u.profile_image_url AS sender_image_url
     FROM messages m
     LEFT JOIN users u ON u.user_id=m.sender_id
     WHERE m.conversation_id=$1
     ORDER BY m.created_at,m.message_id`,
    [conversationID],
  );
  return result.rows.map(messageDTO);
}

export async function createConversationMessage(client, { userID, conversationID, body }) {
  assertUUID(conversationID, 'conversationID');
  const text = assertString(body, 'body').trim();
  if (!text) throw new GameError('invalid_payload', 'Message cannot be empty.');
  if (text.length > 4000) throw new GameError('invalid_payload', 'Message is too long.');
  const conversation = await assertConversationMember(client, { conversationID, userID });
  const result = await client.query(
    `INSERT INTO messages(conversation_id,subject,body,sender_id)
     VALUES ($1,$2,$2,$3)
     RETURNING message_id::text,conversation_id::text,body,subject,image_urls,video_urls,sender_id::text,created_at`,
    [conversationID, text, userID],
  );
  await client.query('UPDATE conversations SET updated_at=NOW() WHERE conversation_id=$1', [conversationID]);
  const sender = await client.query(
    `SELECT username,first_name,last_name,profile_image_url FROM users WHERE user_id=$1`,
    [userID],
  );
  const row = result.rows[0];
  row.sender_name = sender.rowCount ? displayName(sender.rows[0]) : 'Member';
  row.sender_image_url = sender.rows[0]?.profile_image_url ?? null;
  return {
    message: messageDTO(row),
    memberIDs: (conversation.conversation_member_ids ?? []).map(String),
  };
}

export async function listFriends(client, { userID, mapDate }) {
  const result = await client.query(
    `SELECT
       u.user_id::text,u.username,u.first_name,u.last_name,u.profile_image_url,u.last_active,
       dm.map_date::text,dm.current_progress
     FROM user_friends f
     JOIN users u
       ON u.user_id = CASE WHEN f.user_id=$1 THEN f.friend_user_id ELSE f.user_id END
     LEFT JOIN day_maps dm
       ON dm.user_id=u.user_id AND dm.map_date=$2::date
     WHERE (f.user_id=$1 OR f.friend_user_id=$1)
       AND f.status='accepted'
     ORDER BY LOWER(COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),u.username))`,
    [userID, mapDate],
  );

  return result.rows.map((row) => ({
    userID: String(row.user_id),
    username: String(row.username ?? ''),
    displayName: displayName(row),
    imageURL: row.profile_image_url ?? null,
    lastActive: iso(row.last_active),
    progressPercent: percentage(row.current_progress),
    goalTargetPercent: 100,
    mapDate: row.map_date ?? mapDate,
  }));
}

export async function listPostsFeed(client, { userID, limit = 50, offset = 0 }) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const result = await client.query(
    `SELECT
       p.post_id::text,p.post_type,p.subject,p.post_main_media_url,p.post_main_media_type,
       p.post_media_count,p.post_image_urls,p.post_video_urls,p.poster_id::text,p.created_at,p.tags,
       COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),u.username,'Member') AS poster_name,
       u.profile_image_url AS poster_image_url,
       (SELECT COUNT(*)::int FROM post_replies pr WHERE pr.post_id=p.post_id AND COALESCE(pr.post_status,'active')='active') AS reply_count,
       (SELECT COUNT(*)::int FROM post_saves ps WHERE ps.post_id=p.post_id) AS save_count,
       EXISTS(SELECT 1 FROM post_saves mine WHERE mine.post_id=p.post_id AND mine.user_id=$1) AS is_saved
     FROM posts p
     LEFT JOIN users u ON u.user_id=p.poster_id
     WHERE COALESCE(p.post_status,'active')='active'
     ORDER BY p.created_at DESC,p.post_id DESC
     LIMIT $2 OFFSET $3`,
    [userID, safeLimit, safeOffset],
  );

  return result.rows.map((row) => ({
    postID: String(row.post_id),
    postType: String(row.post_type ?? 'Post'),
    subject: String(row.subject ?? ''),
    mainMediaURL: row.post_main_media_url ?? null,
    mainMediaType: row.post_main_media_type ?? null,
    imageURLs: Array.isArray(row.post_image_urls) ? row.post_image_urls : [],
    videoURLs: Array.isArray(row.post_video_urls) ? row.post_video_urls : [],
    posterID: row.poster_id ? String(row.poster_id) : null,
    posterName: String(row.poster_name ?? 'Member'),
    posterImageURL: row.poster_image_url ?? null,
    createdAt: iso(row.created_at),
    tags: Array.isArray(row.tags) ? row.tags : [],
    replyCount: Number(row.reply_count ?? 0),
    saveCount: Number(row.save_count ?? 0),
    isSaved: Boolean(row.is_saved),
  }));
}

export async function setFeedPostSaved(client, { userID, postID, isSaved }) {
  assertUUID(postID, 'postID');
  const post = await client.query('SELECT 1 FROM posts WHERE post_id=$1 AND COALESCE(post_status,\'active\')=\'active\'', [postID]);
  if (!post.rowCount) throw new GameError('not_found', 'Post does not exist.');
  if (isSaved) {
    await client.query(
      `INSERT INTO post_saves(user_id,post_id) VALUES ($1,$2)
       ON CONFLICT(user_id,post_id) DO NOTHING`,
      [userID, postID],
    );
  } else {
    await client.query('DELETE FROM post_saves WHERE user_id=$1 AND post_id=$2', [userID, postID]);
  }
  const counts = await client.query(
    `SELECT COUNT(*)::int AS save_count,
            EXISTS(SELECT 1 FROM post_saves WHERE user_id=$1 AND post_id=$2) AS is_saved
       FROM post_saves WHERE post_id=$2`,
    [userID, postID],
  );
  return {
    postID,
    isSaved: Boolean(counts.rows[0]?.is_saved),
    saveCount: Number(counts.rows[0]?.save_count ?? 0),
  };
}

function postReplyDTO(row) {
  return {
    replyID: String(row.post_reply_id),
    postID: String(row.post_id),
    parentReplyID: row.parent_id ? String(row.parent_id) : null,
    body: String(row.reply_text || row.subject || ''),
    posterID: row.poster_id ? String(row.poster_id) : null,
    posterName: String(row.poster_name ?? 'Member'),
    posterImageURL: row.poster_image_url ?? null,
    createdAt: iso(row.created_at),
  };
}

export async function listPostReplies(client, { postID }) {
  assertUUID(postID, 'postID');
  const result = await client.query(
    `SELECT pr.post_reply_id::text,pr.post_id::text,pr.parent_id::text,
            pr.reply_text,pr.subject,pr.poster_id::text,pr.created_at,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),u.username,'Member') AS poster_name,
            u.profile_image_url AS poster_image_url
       FROM post_replies pr
       LEFT JOIN users u ON u.user_id=pr.poster_id
      WHERE pr.post_id=$1 AND COALESCE(pr.post_status,'active')='active'
      ORDER BY pr.created_at,pr.post_reply_id`,
    [postID],
  );
  return result.rows.map(postReplyDTO);
}

export async function createFeedPostReply(client, { userID, postID, body }) {
  assertUUID(postID, 'postID');
  const text = assertString(body, 'body').trim();
  if (!text) throw new GameError('invalid_payload', 'Reply cannot be empty.');
  if (text.length > 4000) throw new GameError('invalid_payload', 'Reply is too long.');
  const post = await client.query(
    `SELECT post_type FROM posts WHERE post_id=$1 AND COALESCE(post_status,'active')='active'`,
    [postID],
  );
  if (!post.rowCount) throw new GameError('not_found', 'Post does not exist.');
  const inserted = await client.query(
    `INSERT INTO post_replies(post_id,post_type,subject,poster_id,reply_text,post_status)
     VALUES ($1,$2,$3,$4,$3,'active')
     RETURNING post_reply_id::text,post_id::text,parent_id::text,reply_text,subject,poster_id::text,created_at`,
    [postID, post.rows[0].post_type, text, userID],
  );
  const user = await client.query(
    `SELECT username,first_name,last_name,profile_image_url FROM users WHERE user_id=$1`,
    [userID],
  );
  const row = inserted.rows[0];
  row.poster_name = user.rowCount ? displayName(user.rows[0]) : 'Member';
  row.poster_image_url = user.rows[0]?.profile_image_url ?? null;
  return postReplyDTO(row);
}
