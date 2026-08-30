import test from 'node:test';
import assert from 'node:assert/strict';

import { applySocialStateToNodes } from '../src/services/dayMaps.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';
const postID = '11111111-2222-4333-8444-555555555555';
const postNodeID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const linkNodeID = '99999999-8888-4777-8666-555555555555';

function postNode() {
  return {
    id: { rawValue: postNodeID },
    content: {
      post: {
        _0: {
          postID,
          title: 'Post',
          snapshot: {
            postID,
            postResponseCount: 4,
            postSavedCount: 0,
            savedPostStatus: '',
            comments: [],
          },
        },
      },
    },
  };
}

function hyperlinkNode() {
  return {
    id: { rawValue: linkNodeID },
    content: {
      hyperlink: {
        _0: {
          title: 'Link',
          urlString: 'https://example.com',
        },
      },
    },
  };
}

test('snapshot hydration restores persisted reply text and save state', () => {
  const replyID = '12345678-1234-4234-8234-123456789012';
  const nodes = applySocialStateToNodes([postNode()], {
    userID,
    replyRows: [{
      post_reply_id: replyID,
      parent_id: null,
      post_id: postID,
      poster_id: userID,
      reply_text: 'Persist me after relaunch',
      created_at: new Date('2026-08-29T14:00:00Z'),
    }],
    savedPostIDs: [postID],
  });

  const snapshot = nodes[0].content.post._0.snapshot;
  assert.equal(snapshot.savedPostStatus, 'Saved');
  assert.equal(snapshot.postSavedCount, 1);
  assert.equal(snapshot.comments.length, 1);
  assert.equal(snapshot.comments[0].commentID, replyID);
  assert.equal(snapshot.comments[0].body, 'Persist me after relaunch');
  assert.equal(snapshot.comments[0].userName, 'You');
});

test('snapshot hydration restores the current user hyperlink vote', () => {
  const nodes = applySocialStateToNodes([hyperlinkNode()], {
    userID,
    voteRows: [{ node_id: linkNodeID, vote: 'downvote' }],
  });

  assert.equal(nodes[0].content.hyperlink._0.userVote, 'downvote');
});

test('snapshot hydration reconciles visible reply count from persisted rows', () => {
  const nodes = applySocialStateToNodes([postNode()], {
    userID,
    replyRows: [
      {
        post_reply_id: '12345678-1234-4234-8234-123456789012',
        parent_id: null,
        post_id: postID,
        poster_id: userID,
        reply_text: 'One',
        created_at: new Date('2026-08-29T14:00:00Z'),
      },
      {
        post_reply_id: '22345678-1234-4234-8234-123456789012',
        parent_id: null,
        post_id: postID,
        poster_id: userID,
        reply_text: 'Two',
        created_at: new Date('2026-08-29T14:01:00Z'),
      },
      {
        post_reply_id: '32345678-1234-4234-8234-123456789012',
        parent_id: null,
        post_id: postID,
        poster_id: userID,
        reply_text: 'Three',
        created_at: new Date('2026-08-29T14:02:00Z'),
      },
      {
        post_reply_id: '42345678-1234-4234-8234-123456789012',
        parent_id: null,
        post_id: postID,
        poster_id: userID,
        reply_text: 'Four',
        created_at: new Date('2026-08-29T14:03:00Z'),
      },
      {
        post_reply_id: '52345678-1234-4234-8234-123456789012',
        parent_id: null,
        post_id: postID,
        poster_id: userID,
        reply_text: 'Five',
        created_at: new Date('2026-08-29T14:04:00Z'),
      },
    ],
  });

  const snapshot = nodes[0].content.post._0.snapshot;
  assert.equal(snapshot.comments.length, 5);
  assert.equal(snapshot.postResponseCount, 5);
});
