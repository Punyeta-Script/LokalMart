// Web Push (PWA notifications). Needs VAPID keys: npx web-push generate-vapid-keys
const webpush = require('web-push');
const db = require('./db');

const enabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const api = { enabled, sender: (...a) => webpush.sendNotification(...a), sendTo };

async function sendTo(uid, body) {
  if (!enabled()) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@lokalmart.ph', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const subs = await db.q('SELECT * FROM push_subs WHERE uid=$1', [uid]);
  await Promise.all(subs.map(async (s) => {
    try {
      await api.sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: 'LokalMart', body, url: '/' }), { TTL: 3600 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await db.q('DELETE FROM push_subs WHERE id=$1', [s.id]).catch(() => {});
    }
  }));
}
module.exports = api;
