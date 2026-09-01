import { GameError } from '../lib/errors.js';
import { assertObject, optionalUUID } from '../lib/validation.js';

function cell(payload) {
  const c = assertObject(payload.cell, 'payload.cell');
  const column = Number(c.column);
  const row = Number(c.row);
  if (!Number.isInteger(column) || !Number.isInteger(row)) {
    throw new GameError('invalid_payload', 'Tile column and row must be integers.');
  }
  return { column, row };
}

export async function persistReveal(client, { dayMap, payload }) {
  const { column, row } = cell(payload);
  const isRevealed = payload.isRevealed !== false;
  const nodeID = optionalUUID(payload.nodeID);
  if (nodeID) {
    const owned = await client.query(`SELECT 1 FROM day_map_nodes WHERE day_map_id=$1 AND node_id=$2`, [dayMap.day_map_id, nodeID]);
    if (!owned.rowCount) throw new GameError('validation_failed', 'Reveal nodeID is not part of this Day Map.');
  }
  if (isRevealed) {
    await client.query(
      `INSERT INTO day_map_tile_reveals(day_map_id,column_index,row_index,node_id,is_revealed,revealed_at)
       VALUES ($1,$2,$3,$4,TRUE,NOW())
       ON CONFLICT(day_map_id,column_index,row_index)
       DO UPDATE SET node_id=EXCLUDED.node_id,is_revealed=TRUE,revealed_at=NOW()`,
      [dayMap.day_map_id, column, row, nodeID],
    );
  } else {
    await client.query(
      `DELETE FROM day_map_tile_reveals WHERE day_map_id=$1 AND column_index=$2 AND row_index=$3`,
      [dayMap.day_map_id, column, row],
    );
  }
  return { cell: { column, row }, isRevealed };
}

export async function persistSuggestionDecision(client, { dayMap, userID, payload }) {
  const { column, row } = cell(payload);
  const decision = String(payload.decision ?? '');
  if (!['accepted', 'rejected'].includes(decision)) {
    throw new GameError('invalid_payload', 'Suggestion decision must be accepted or rejected.');
  }
  await client.query(
    `INSERT INTO day_map_suggestion_decisions(day_map_id,user_id,column_index,row_index,decision,decided_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT(day_map_id,user_id,column_index,row_index)
     DO UPDATE SET decision=EXCLUDED.decision,decided_at=NOW()`,
    [dayMap.day_map_id, userID, column, row, decision],
  );
  return { cell: { column, row }, decision };
}
