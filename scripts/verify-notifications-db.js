/** Read-only verification AFTER npm run migrate. Does not register devices or send pushes. */
import {pool} from '../src/db.js';
const required=['notification_preferences','notification_devices','scheduler_notifications','notification_delivery_attempts','notification_plan_jobs'];
try {
 const client=await pool.connect();
 try {
  for(const name of required) {
   const r=await client.query('SELECT to_regclass($1)::text AS name',[name]);
   if(!r.rows[0]?.name) throw new Error(`Missing table ${name}; run npm run migrate.`);
  }
  const t=await client.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
   ('notification_plan_committed','notification_activity_outcome','notification_node_removed')`);
  if(t.rowCount!==3)throw new Error('Notification transaction triggers are missing.');
  const summary=await client.query(`SELECT status,push_state,COUNT(*)::int AS count FROM scheduler_notifications GROUP BY status,push_state ORDER BY status,push_state`);
  console.log(JSON.stringify({schemaReady:true,triggerCount:t.rowCount,notifications:summary.rows},null,2));
 } finally {client.release();}
} catch(error){console.error(error.message);process.exitCode=1;}
finally{await pool.end();}
