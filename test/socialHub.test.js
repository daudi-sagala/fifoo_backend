import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversationMessage,
  ensureDirectConversation,
  listFriends,
  listPostsFeed,
} from '../src/services/socialHub.js';

const USER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';

test('friend list maps relational user/day-map state into progress cards', async () => {
  const client = {
    async query(sql) {
      assert.match(sql, /FROM user_friends/);
      return { rows: [{
        user_id: FRIEND,
        username: 'maya',
        first_name: 'Maya',
        last_name: 'Chen',
        profile_image_url: null,
        last_active: new Date('2026-08-29T17:00:00Z'),
        map_date: '2026-08-29',
        current_progress: 72,
      }] };
    },
  };
  const friends = await listFriends(client, { userID: USER, mapDate: '2026-08-29' });
  assert.equal(friends[0].displayName, 'Maya Chen');
  assert.equal(friends[0].progressPercent, 72);
  assert.equal(friends[0].goalTargetPercent, 100);
});

test('direct conversation reuses an existing two-person thread', async () => {
  let calls = 0;
  const client = {
    async query(sql) {
      calls += 1;
      if (sql.includes('SELECT user_id FROM users')) return { rowCount: 1, rows: [{ user_id: FRIEND }] };
      if (sql.includes('cardinality(conversation_member_ids)=2')) return { rowCount: 1, rows: [{ conversation_id: CONVERSATION }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const id = await ensureDirectConversation(client, { userID: USER, partnerUserID: FRIEND });
  assert.equal(id, CONVERSATION);
  assert.equal(calls, 2);
});

test('conversation message persists body and returns participant broadcast IDs', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('FROM conversations')) return {
        rowCount: 1,
        rows: [{ conversation_id: CONVERSATION, conversation_member_ids: [USER, FRIEND], status: 'active' }],
      };
      if (sql.includes('INSERT INTO messages')) return {
        rowCount: 1,
        rows: [{
          message_id: MESSAGE,
          conversation_id: CONVERSATION,
          body: 'Hello',
          subject: 'Hello',
          image_urls: [],
          video_urls: [],
          sender_id: USER,
          created_at: new Date('2026-08-29T18:00:00Z'),
        }],
      };
      if (sql.includes('UPDATE conversations')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM users WHERE user_id')) return {
        rowCount: 1,
        rows: [{ username: 'demo', first_name: 'Demo', last_name: 'User', profile_image_url: null }],
      };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await createConversationMessage(client, {
    userID: USER,
    conversationID: CONVERSATION,
    body: 'Hello',
  });
  assert.equal(result.message.body, 'Hello');
  assert.deepEqual(result.memberIDs, [USER, FRIEND]);
});

test('posts feed exposes common social counts and saved state', async () => {
  const client = {
    async query(sql) {
      assert.match(sql, /FROM posts p/);
      return { rows: [{
        post_id: POST,
        post_type: 'Tip',
        subject: 'A ten-minute walk still counts',
        post_main_media_url: null,
        post_main_media_type: null,
        post_image_urls: [],
        post_video_urls: [],
        poster_id: FRIEND,
        created_at: new Date('2026-08-29T18:00:00Z'),
        tags: ['walking'],
        poster_name: 'Maya Chen',
        poster_image_url: null,
        reply_count: 3,
        save_count: 2,
        is_saved: true,
      }] };
    },
  };
  const posts = await listPostsFeed(client, { userID: USER });
  assert.equal(posts[0].replyCount, 3);
  assert.equal(posts[0].saveCount, 2);
  assert.equal(posts[0].isSaved, true);
});
