// Realtime "something changed" pings through Supabase Realtime Broadcast (no data is sent, clients then refetch /api/state).
const crypto = require('crypto');
const cfg = () => ({ url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key: process.env.SUPABASE_SERVICE_KEY || '', anon: process.env.SUPABASE_ANON_KEY || '' });
const enabled = () => { const c = cfg(); return !!(c.url && c.key && c.anon); };
/** Unguessable per-user channel name. */
const topic = (uid) => 'u-' + uid + '-' + crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-only-secret-change-me').update('rt:' + uid).digest('hex').slice(0, 16);
async function ping(uid) {
  if (!enabled()) return;
  const c = cfg();
  const r = await fetch(`${c.url}/realtime/v1/api/broadcast`, { method: 'POST', headers: { apikey: c.key, Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ topic: topic(uid), event: 'ping', payload: {}, private: false }] }) });
  if (!r.ok) throw new Error('Realtime broadcast failed ' + r.status);
}
const info = (uid) => ({ url: cfg().url, key: cfg().anon, topic: topic(uid) });
module.exports = { enabled, ping, info, topic };
