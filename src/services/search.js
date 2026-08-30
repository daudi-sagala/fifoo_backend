import { config } from '../config.js';

export async function searchDayMap(client, { dayMapID, query }) {
  const text = String(query ?? '').trim();
  if (!text) return [];
  const pattern = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
  const result = await client.query(
    `SELECT node_data FROM day_map_nodes
     WHERE day_map_id=$1 AND is_enabled=TRUE AND node_data::text ILIKE $2 ESCAPE '\\'
     ORDER BY time_seconds LIMIT $3`,
    [dayMapID, pattern, config.maxSearchResults],
  );
  return result.rows.map((row) => row.node_data);
}
