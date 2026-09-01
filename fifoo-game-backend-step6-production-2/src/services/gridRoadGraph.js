const GRAPH_ID = 'fifoo.cartesian.grid.v1';
const GRAPH_VERSION = 4;
const PROGRESS_PER_PITCH = 12.5;
const HOURS_PER_PITCH = 1.5;
const SECONDS_PER_PITCH = HOURS_PER_PITCH * 3600;
const MIN_ROW = 0;
const MAX_ROW = 16;
const DEFAULT_MIN_COLUMN = -12;
const DEFAULT_MAX_COLUMN = 20;

function wrapped(rawValue) {
  return { rawValue };
}

function formatted(value) {
  return String(Math.trunc(value)).padStart(2, '0');
}

export function gridVertexID(column, row) {
  return `grid.r${formatted(row)}.c${formatted(column)}`;
}

export function gridHorizontalEdgeID(row, leftColumn) {
  return `street.h.r${formatted(row)}.c${formatted(leftColumn)}-${formatted(leftColumn + 1)}`;
}

export function gridVerticalEdgeID(column, topRow) {
  return `street.v.c${formatted(column)}.r${formatted(topRow)}-${formatted(topRow + 1)}`;
}

export function gridCoordinate(column, row) {
  return {
    time: { secondsFromMidnight: row * SECONDS_PER_PITCH },
    progress: { percent: column * PROGRESS_PER_PITCH },
  };
}

/**
 * Mirrors the deterministic Swift GridRoadGraph currently rendered by iOS.
 * Keeping this topology server-side lets daily route generation run before
 * an iPhone has connected for that day.
 */
export function makeGridRoadGraph({
  minColumn = DEFAULT_MIN_COLUMN,
  maxColumn = DEFAULT_MAX_COLUMN,
} = {}) {
  const lower = Math.trunc(Math.min(minColumn, maxColumn));
  const upper = Math.trunc(Math.max(minColumn, maxColumn));
  const vertices = [];
  const edges = [];

  for (let row = MIN_ROW; row <= MAX_ROW; row += 1) {
    for (let column = lower; column <= upper; column += 1) {
      vertices.push({
        id: wrapped(gridVertexID(column, row)),
        coordinate: gridCoordinate(column, row),
        kind: 'intersection',
      });
    }
  }

  for (let row = MIN_ROW; row <= MAX_ROW; row += 1) {
    for (let leftColumn = lower; leftColumn < upper; leftColumn += 1) {
      edges.push({
        id: wrapped(gridHorizontalEdgeID(row, leftColumn)),
        fromID: wrapped(gridVertexID(leftColumn, row)),
        toID: wrapped(gridVertexID(leftColumn + 1, row)),
        roadClass: 'local',
        travelDirection: 'bidirectional',
        shape: 'straight',
        attributes: {
          displayName: null,
          isTraversable: true,
          isGradeSeparated: false,
          routingCostMultiplier: 1,
          tags: ['grid', 'horizontal'],
        },
      });
    }
  }

  for (let column = lower; column <= upper; column += 1) {
    for (let topRow = MIN_ROW; topRow < MAX_ROW; topRow += 1) {
      edges.push({
        id: wrapped(gridVerticalEdgeID(column, topRow)),
        fromID: wrapped(gridVertexID(column, topRow)),
        toID: wrapped(gridVertexID(column, topRow + 1)),
        roadClass: 'local',
        travelDirection: 'bidirectional',
        shape: 'straight',
        attributes: {
          displayName: null,
          isTraversable: true,
          isGradeSeparated: false,
          routingCostMultiplier: 1,
          tags: ['grid', 'vertical'],
        },
      });
    }
  }

  return {
    id: wrapped(GRAPH_ID),
    version: GRAPH_VERSION,
    vertices,
    edges,
  };
}

/**
 * Creates an internal routing anchor without moving the GameMapNode itself.
 * The nearest vertical street is used because its edge fraction can represent
 * the node's exact time while preserving Fifoo's no-upward-time route rule.
 */
export function gridRouteAnchorForNode({ nodeID, secondsFromMidnight, progressPercent }) {
  const seconds = Math.max(0, Math.min(86_400, Number(secondsFromMidnight) || 0));
  const progress = Number.isFinite(Number(progressPercent)) ? Number(progressPercent) : 0;
  const column = Math.round(progress / PROGRESS_PER_PITCH);
  const rowPosition = seconds / SECONDS_PER_PITCH;
  let topRow = Math.floor(rowPosition);
  let fraction = rowPosition - topRow;

  if (topRow >= MAX_ROW) {
    topRow = MAX_ROW - 1;
    fraction = 1;
  }
  if (topRow < MIN_ROW) {
    topRow = MIN_ROW;
    fraction = 0;
  }

  return {
    nodeID: wrapped(String(nodeID)),
    coordinate: {
      time: { secondsFromMidnight: seconds },
      progress: { percent: progress },
    },
    roadLocation: {
      edge: {
        edgeID: wrapped(gridVerticalEdgeID(column, topRow)),
        fraction: Math.max(0, Math.min(1, fraction)),
      },
    },
  };
}

export const gridRoadConstants = Object.freeze({
  graphID: GRAPH_ID,
  graphVersion: GRAPH_VERSION,
  progressPerPitch: PROGRESS_PER_PITCH,
  hoursPerPitch: HOURS_PER_PITCH,
  secondsPerPitch: SECONDS_PER_PITCH,
  minimumRow: MIN_ROW,
  maximumRow: MAX_ROW,
  defaultMinimumColumn: DEFAULT_MIN_COLUMN,
  defaultMaximumColumn: DEFAULT_MAX_COLUMN,
});
