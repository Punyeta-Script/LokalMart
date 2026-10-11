// One-time: move existing base64 product photos from the database to Supabase Storage.
// Usage: set DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY, then: npm run migrate:images
const db = require('../server/db');
const storage = require('../server/storage');
(async () => {
  if (!storage.enabled()) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY first.');
  const rows = await db.q("SELECT id,img FROM products WHERE img LIKE 'data:%'");
  for (const r of rows) {
    const url = await storage.upload(r.img);
    await db.q('UPDATE products SET img=$1 WHERE id=$2', [url, r.id]);
    console.log('moved product', r.id);
  }
  console.log(`Done: ${rows.length} photo(s) moved.`);
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
