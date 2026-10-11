// Product photos in Supabase Storage (public bucket). Falls back to the database when not configured.
const crypto = require('crypto');
const cfg = () => ({ url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key: process.env.SUPABASE_SERVICE_KEY || '', bucket: process.env.SUPABASE_BUCKET || 'product-images' });
const enabled = () => { const c = cfg(); return !!(c.url && c.key); };
const origin = () => { try { return new URL(cfg().url).origin; } catch (e) { return ''; } };
const hdr = (c, extra = {}) => ({ Authorization: 'Bearer ' + c.key, apikey: c.key, ...extra });
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

let bucketReady = null;
function ensureBucket(c) {
  return bucketReady || (bucketReady = (async () => {
    const r = await fetch(`${c.url}/storage/v1/bucket`, { method: 'POST', headers: hdr(c, { 'Content-Type': 'application/json' }), body: JSON.stringify({ id: c.bucket, name: c.bucket, public: true }) });
    if (!r.ok && !/exist|duplicate/i.test(await r.text())) throw new Error('Storage bucket error ' + r.status);
  })().catch((e) => { bucketReady = null; throw e; }));
}

/** Upload a data: URL, return its public https URL. */
async function upload(dataUrl) {
  const c = cfg(), m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Unsupported photo');
  await ensureBucket(c);
  const name = `p/${crypto.randomUUID()}.${EXT[m[1]]}`;
  const r = await fetch(`${c.url}/storage/v1/object/${c.bucket}/${name}`, { method: 'POST', headers: hdr(c, { 'Content-Type': m[1], 'Cache-Control': 'max-age=31536000' }), body: Buffer.from(m[2], 'base64') });
  if (!r.ok) throw new Error('Storage upload failed ' + r.status);
  return `${c.url}/storage/v1/object/public/${c.bucket}/${name}`;
}

/** Best-effort delete of an object previously returned by upload(). */
async function remove(publicUrl) {
  const c = cfg(), pre = `${c.url}/storage/v1/object/public/${c.bucket}/`;
  if (!enabled() || typeof publicUrl !== 'string' || !publicUrl.startsWith(pre)) return;
  try { await fetch(`${c.url}/storage/v1/object/${c.bucket}/${publicUrl.slice(pre.length)}`, { method: 'DELETE', headers: hdr(c) }); } catch (e) { /* ignore */ }
}
module.exports = { enabled, origin, upload, remove };
