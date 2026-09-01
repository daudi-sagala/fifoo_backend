import { pool } from '../db.js';
import { config } from '../config.js';
import { ensureDayMap, lockDayMap, bumpRevision } from './dayMaps.js';
import { GameError, failureAck, successAck } from '../lib/errors.js';
import { assertJSONByteSize, assertMatchingRevision, parseEnvelope } from '../lib/validation.js';

export async function runDayMutation({ socket, event, rawEnvelope, mutate }) {
  let envelope;
  try {
    envelope = parseEnvelope(rawEnvelope);
    assertJSONByteSize(envelope.payload, config.maxMutationPayloadBytes, 'mutation payload');
  } catch (error) {
    return { ack: failureAck(error), replayed: false, result: null };
  }

  const requestID = envelope.context.requestID;
  const userID = socket.data.authUserID;
  if (!userID) {
    return { ack: failureAck(new GameError('unauthorized', 'Authenticate the socket first.'), requestID), replayed: false, result: null };
  }

  let client;
  let serverRevisionForFailure = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const ensured = await ensureDayMap(client, {
      userID,
      mapDate: envelope.context.mapDate,
      timeZoneIdentifier: envelope.context.timeZoneIdentifier,
    });
    const dayMap = await lockDayMap(client, ensured.day_map_id);
    serverRevisionForFailure = Number(dayMap.revision);

    const claimed = await client.query(
      `INSERT INTO day_map_mutations
       (request_id,day_map_id,user_id,device_id,event_name,base_revision,payload,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'processing')
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
      [
        requestID,
        dayMap.day_map_id,
        userID,
        envelope.context.deviceID,
        event,
        envelope.context.clientRevision,
        JSON.stringify(envelope.payload ?? {}),
      ],
    );

    if (!claimed.rowCount) {
      const existing = await client.query(
        `SELECT user_id,day_map_id,status,response,error_message
           FROM day_map_mutations WHERE request_id=$1`,
        [requestID],
      );
      const row = existing.rows[0];
      if (!row) throw new GameError('conflict', 'Mutation idempotency record disappeared.');
      if (row.user_id !== userID || row.day_map_id !== dayMap.day_map_id) {
        throw new GameError('forbidden', 'requestID belongs to a different user or day.');
      }
      if (row.status === 'completed' && row.response) {
        await client.query('COMMIT');
        return { ack: row.response, replayed: true, result: null };
      }
      throw new GameError('conflict', 'The same mutation is already being processed.');
    }

    // Optimistic concurrency is checked only after idempotency replay. A
    // retried request that already committed must always return its original
    // successful ack even if the Day Map has advanced since then.
    assertMatchingRevision(envelope.context.clientRevision, dayMap.revision);

    const result = await mutate({
      client,
      dayMap,
      userID,
      context: envelope.context,
      payload: envelope.payload ?? {},
    });

    const revision = await bumpRevision(client, dayMap.day_map_id);
    const ack = successAck(requestID, revision);

    await client.query(
      `UPDATE day_map_mutations
       SET result_revision=$2,response=$3::jsonb,status='completed',completed_at=NOW()
       WHERE request_id=$1`,
      [requestID, revision, JSON.stringify(ack)],
    );

    await client.query('COMMIT');
    return { ack, replayed: false, result: { ...(result ?? {}), revision, dayMapID: dayMap.day_map_id, mapDate: dayMap.map_date } };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be unusable */ }
    }
    return { ack: failureAck(error, requestID, serverRevisionForFailure), replayed: false, result: null };
  } finally {
    client?.release();
  }
}
