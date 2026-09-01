import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileNodeMediaMetadata } from '../src/lib/nodeCodec.js';

const postID = '11111111-2222-4333-8444-555555555555';

function postNode() {
  return {
    id: { rawValue: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    content: {
      post: {
        _0: {
          postID,
          title: 'Media post',
          image: { remote: { urlString: 'https://old.example/stale.jpg' } },
          snapshot: {
            postID,
            postImageURLs: [
              ' https://cdn.example/one.jpg ',
              'https://cdn.example/one.jpg',
              'none',
            ],
            postVideoURLs: ['https://cdn.example/two.mp4'],
            postGIFMedia: {},
            postMainMediaURL: 'https://old.example/stale.jpg',
            postMainMediaType: 'video',
            postMediaCount: 99,
            posterImageURL: 'https://cdn.example/avatar.jpg',
          },
        },
      },
    },
  };
}

test('post media fields are reconciled from authoritative image/video arrays', () => {
  const node = reconcileNodeMediaMetadata(postNode());
  const post = node.content.post._0;
  const snapshot = post.snapshot;

  assert.deepEqual(snapshot.postImageURLs, ['https://cdn.example/one.jpg']);
  assert.deepEqual(snapshot.postVideoURLs, ['https://cdn.example/two.mp4']);
  assert.equal(snapshot.postMediaCount, 2);
  assert.equal(snapshot.postMainMediaURL, 'https://cdn.example/one.jpg');
  assert.equal(snapshot.postMainMediaType, 'image');
  assert.equal(post.image.remote.urlString, 'https://cdn.example/one.jpg');
});

test('video-first posts keep a still-image marker instead of using the video URL as a texture', () => {
  const input = postNode();
  input.content.post._0.snapshot.postImageURLs = [];
  const node = reconcileNodeMediaMetadata(input);
  const post = node.content.post._0;

  assert.equal(post.snapshot.postMainMediaURL, 'https://cdn.example/two.mp4');
  assert.equal(post.snapshot.postMainMediaType, 'video');
  assert.equal(post.image.remote.urlString, 'https://cdn.example/avatar.jpg');
});

test('activity task media is deduplicated and first image becomes its marker', () => {
  const node = reconcileNodeMediaMetadata({
    id: { rawValue: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
    content: {
      activity: {
        _0: {
          activityType: 'task',
          task: {
            imageURLs: [' https://cdn.example/task.jpg ', 'https://cdn.example/task.jpg'],
            videoURLs: ['https://cdn.example/task.mp4', 'none'],
          },
        },
      },
    },
  });

  const activity = node.content.activity._0;
  assert.deepEqual(activity.task.imageURLs, ['https://cdn.example/task.jpg']);
  assert.deepEqual(activity.task.videoURLs, ['https://cdn.example/task.mp4']);
  assert.equal(activity.image.remote.urlString, 'https://cdn.example/task.jpg');
});

test('standalone image media synchronizes its marker with its remote content URL', () => {
  const node = reconcileNodeMediaMetadata({
    id: { rawValue: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa' },
    content: {
      media: {
        _0: {
          mediaID: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb',
          mediaType: 'image',
          urlString: ' https://cdn.example/media.jpg ',
        },
      },
    },
  });

  const media = node.content.media._0;
  assert.equal(media.urlString, 'https://cdn.example/media.jpg');
  assert.equal(media.image.remote.urlString, 'https://cdn.example/media.jpg');
});
