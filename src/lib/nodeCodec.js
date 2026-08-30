import { optionalUUID, rawUUID, parseClockSeconds } from './validation.js';

export function unwrapAssociated(value) {
  if (!value || typeof value !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(value, '_0')) return value._0;
  return value;
}

export function enumCaseObject(enumObject, caseName) {
  if (!enumObject || typeof enumObject !== 'object') return null;
  return unwrapAssociated(enumObject[caseName]);
}

export function gameNodeID(node) {
  return rawUUID(node?.id);
}

export function activityContent(node) {
  return enumCaseObject(node?.content, 'activity');
}

export function postContent(node) {
  return enumCaseObject(node?.content, 'post');
}

export function hyperlinkContent(node) {
  return enumCaseObject(node?.content, 'hyperlink');
}

export function mediaContent(node) {
  return enumCaseObject(node?.content, 'media');
}

export function userContent(node) {
  return enumCaseObject(node?.content, 'user');
}

export function playContent(node) {
  return enumCaseObject(node?.content, 'play');
}

export function nodeKind(node) {
  if (activityContent(node)) {
    const type = String(activityContent(node).activityType ?? 'task').trim().toLowerCase();
    if (type === 'meal') return 'activityMeal';
    if (type === 'workout') return 'activityWorkout';
    return 'activityTask';
  }
  if (playContent(node)) return 'play';
  if (postContent(node)) return 'post';
  if (mediaContent(node)) return 'media';
  if (hyperlinkContent(node)) return 'hyperlink';
  if (userContent(node)) return 'user';
  return 'media';
}

export function nodeSourceUUID(node) {
  const activity = activityContent(node);
  if (activity) return optionalUUID(activity.activityID);
  const post = postContent(node);
  if (post) return optionalUUID(post.postID);
  const media = mediaContent(node);
  if (media) return optionalUUID(media.mediaID);
  const user = userContent(node);
  if (user) return optionalUUID(user.userID);
  return null;
}

export function nodeTimeSeconds(node) {
  const raw = Number(node?.time?.secondsFromMidnight);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(86_399, Math.floor(raw)));
  const coordinate = enumCaseObject(node?.placement, 'coordinate');
  const fromPlacement = Number(coordinate?.time?.secondsFromMidnight);
  if (Number.isFinite(fromPlacement)) {
    return Math.max(0, Math.min(86_399, Math.floor(fromPlacement)));
  }
  return 0;
}

export function nodeProgressPercent(node, existing = 0) {
  const coordinate = enumCaseObject(node?.placement, 'coordinate');
  const progress = Number(coordinate?.progress?.percent);
  return Number.isFinite(progress) ? progress : Number(existing ?? 0);
}

export function imageURL(image) {
  const remote = enumCaseObject(image, 'remote');
  if (remote && typeof remote.urlString === 'string') return remote.urlString.trim() || null;
  return null;
}

export function activityMainImageURL(activity) {
  if (!activity) return null;
  const direct = imageURL(activity.image);
  if (direct) return direct;
  if (activity.meal?.imageURL) return String(activity.meal.imageURL);
  const workoutImages = activity.workout?.imageURLs;
  if (Array.isArray(workoutImages) && workoutImages.length) return String(workoutImages[0]);
  const taskImages = activity.task?.imageURLs;
  if (Array.isArray(taskImages) && taskImages.length) return String(taskImages[0]);
  return null;
}

export function activityEndTimeSeconds(activity) {
  return parseClockSeconds(activity?.endTime);
}

export function normalizedStatus(value, fallback = 'active') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export function numberFromText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}


export function cleanMediaURL(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.toLowerCase() === 'none') return null;
  return cleaned;
}

function uniqueMediaURLs(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanMediaURL).filter(Boolean))];
}

function cleanStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key).trim(), String(entryValue ?? '').trim()])
      .filter(([key, entryValue]) => key && entryValue),
  );
}

function gifURL(gifMedia) {
  for (const key of ['url', 'gifURL', 'gif_url', 'originalURL', 'original_url']) {
    const url = cleanMediaURL(gifMedia?.[key]);
    if (url) return url;
  }
  const id = String(gifMedia?.id ?? '').trim();
  return id && id.toLowerCase() !== 'none'
    ? `https://media.giphy.com/media/${id}/giphy.gif`
    : null;
}

function remoteImage(urlString) {
  return { remote: { urlString } };
}

/**
 * Canonicalize duplicated media fields inside a GameMapNode. `node_data` is
 * the authoritative lossless model; relational tables and marker-image fields
 * are projections of these cleaned arrays/URLs.
 */
export function reconcileNodeMediaMetadata(node) {
  const copy = cloneNode(node);

  const activity = activityContent(copy);
  if (activity) {
    if (activity.meal) {
      const mealImage = cleanMediaURL(activity.meal.imageURL);
      activity.meal.imageURL = mealImage;
      if (mealImage) activity.image = remoteImage(mealImage);
    }

    if (activity.workout) {
      const images = uniqueMediaURLs(activity.workout.imageURLs);
      activity.workout.imageURLs = images.length ? images : null;
      if (images[0]) activity.image = remoteImage(images[0]);
    }

    if (activity.task) {
      const images = uniqueMediaURLs(activity.task.imageURLs);
      const videos = uniqueMediaURLs(activity.task.videoURLs);
      activity.task.imageURLs = images.length ? images : null;
      activity.task.videoURLs = videos.length ? videos : null;
      if (images[0]) activity.image = remoteImage(images[0]);
    }
  }

  const post = postContent(copy);
  if (post?.snapshot) {
    const snapshot = post.snapshot;
    const images = uniqueMediaURLs(snapshot.postImageURLs);
    const videos = uniqueMediaURLs(snapshot.postVideoURLs);
    const gifMedia = cleanStringMap(snapshot.postGIFMedia);
    const hasGIF = Object.keys(gifMedia).length > 0;

    snapshot.postImageURLs = images;
    snapshot.postVideoURLs = videos;
    snapshot.postGIFMedia = gifMedia;
    snapshot.postMediaCount = images.length + videos.length + (hasGIF ? 1 : 0);

    if (images[0]) {
      snapshot.postMainMediaURL = images[0];
      snapshot.postMainMediaType = 'image';
      post.image = remoteImage(images[0]);
    } else if (videos[0]) {
      snapshot.postMainMediaURL = videos[0];
      snapshot.postMainMediaType = 'video';
      // A video URL is not a still-image marker. Keep an existing poster/avatar
      // marker when present rather than pointing the map texture loader at video.
      const poster = cleanMediaURL(snapshot.posterImageURL);
      if (poster) post.image = remoteImage(poster);
    } else if (hasGIF) {
      const resolvedGIFURL = gifURL(gifMedia);
      snapshot.postMainMediaURL = resolvedGIFURL ?? '';
      snapshot.postMainMediaType = 'gif';
      if (resolvedGIFURL) post.image = remoteImage(resolvedGIFURL);
    } else {
      snapshot.postMainMediaURL = '';
      snapshot.postMainMediaType = '';
      const poster = cleanMediaURL(snapshot.posterImageURL);
      if (poster) post.image = remoteImage(poster);
    }
  }

  const media = mediaContent(copy);
  if (media) {
    media.urlString = cleanMediaURL(media.urlString);
    if (media.urlString && ['image', 'gif'].includes(String(media.mediaType ?? '').toLowerCase())) {
      media.image = remoteImage(media.urlString);
    }
  }

  return copy;
}

export function cloneNode(node) {
  return structuredClone(node);
}


export function withActivityStatus(node, action) {
  if (!node || !action) return node;
  const copy = cloneNode(node);
  const activity = activityContent(copy);
  if (!activity) return copy;
  if (action === 'skip') activity.status = 'Skipped';
  if (action === 'complete') activity.status = 'Completed';
  return copy;
}

export function incrementPostResponseCount(node) {
  const copy = cloneNode(node);
  const post = postContent(copy);
  if (post?.snapshot) {
    const oldValue = Number(post.snapshot.postResponseCount ?? 0);
    post.snapshot.postResponseCount = Number.isFinite(oldValue) ? oldValue + 1 : 1;
  }
  return copy;
}
