const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint (timestamps in ms) -> JS number

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Use your Supabase connection string.');
const local = /@(localhost|127\.0\.0\.1)/.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: false },
  max: process.env.VERCEL ? 1 : 10, // serverless: one connection per instance (the Supabase pooler does the rest)
  idleTimeoutMillis: 10000,
});

const rows = (r) => r.rows;
const q = (sql, params) => pool.query(sql, params).then(rows);
const one = (sql, params) => q(sql, params).then((r) => r[0]);

/**
 * Run fn inside a transaction. fn receives { q, one, after } bound to that transaction.
 * t.after(fn) queues a callback that runs only once the transaction has committed (used for push notifications).
 */
async function tx(fn) {
  const c = await pool.connect();
  const later = [];
  try {
    await c.query('BEGIN');
    const t = { q: (s, p) => c.query(s, p).then(rows), one: (s, p) => c.query(s, p).then((r) => r.rows[0]), after: (f) => later.push(f) };
    const out = await fn(t);
    await c.query('COMMIT');
    later.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (x) { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

const TABLES = ['users', 'stores', 'products', 'orders', 'msgs', 'notes', 'reviews', 'tickets', 'settings', 'resets', 'push_subs', 'payments', 'rate_hits'];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pw TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1,
  addrs JSONB NOT NULL DEFAULT '[]', fav JSONB NOT NULL DEFAULT '[]', fs JSONB NOT NULL DEFAULT '[]',
  seen INTEGER NOT NULL DEFAULT 0, rt JSONB NOT NULL DEFAULT '{}', created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS stores(
  uid INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, store TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL, open INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending', plan TEXT NOT NULL DEFAULT 'Free');
CREATE TABLE IF NOT EXISTS products(
  id SERIAL PRIMARY KEY, sid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  cat TEXT NOT NULL, price DOUBLE PRECISION NOT NULL, disc DOUBLE PRECISION NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '', st TEXT NOT NULL DEFAULT 'published', sold INTEGER NOT NULL DEFAULT 0,
  img TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS orders(
  id SERIAL PRIMARY KEY, bid INTEGER NOT NULL REFERENCES users(id), sid INTEGER NOT NULL REFERENCES users(id),
  items JSONB NOT NULL, sub DOUBLE PRECISION NOT NULL, fee DOUBLE PRECISION NOT NULL, disc DOUBLE PRECISION NOT NULL DEFAULT 0,
  total DOUBLE PRECISION NOT NULL, comm DOUBLE PRECISION NOT NULL, method TEXT NOT NULL, addr TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', pay TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Pending',
  date TEXT NOT NULL, ts BIGINT NOT NULL, rated INTEGER NOT NULL DEFAULT 0, hid INTEGER NOT NULL DEFAULT 0, loc JSONB);
CREATE TABLE IF NOT EXISTS msgs(id SERIAL PRIMARY KEY, f INTEGER NOT NULL, t INTEGER NOT NULL, x TEXT NOT NULL, ts BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id SERIAL PRIMARY KEY, uid INTEGER NOT NULL, t TEXT NOT NULL, d TEXT NOT NULL, ts BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(id SERIAL PRIMARY KEY, sid INTEGER NOT NULL, n TEXT NOT NULL, r INTEGER NOT NULL, t TEXT NOT NULL DEFAULT '', ts BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(
  id SERIAL PRIMARY KEY, uid INTEGER NOT NULL, topic TEXT NOT NULL, oid INTEGER NOT NULL DEFAULT 0, msg TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open', reply TEXT NOT NULL DEFAULT '', ts BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resets(email TEXT PRIMARY KEY, code TEXT NOT NULL, exp BIGINT NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS push_subs(
  id SERIAL PRIMARY KEY, uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, ts BIGINT NOT NULL);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rid INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pin TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS payments(
  id SERIAL PRIMARY KEY, ref TEXT NOT NULL UNIQUE, uid INTEGER NOT NULL, oids JSONB NOT NULL, amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', xid TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', ts BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_hits(k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_rid ON orders(rid);
CREATE INDEX IF NOT EXISTS idx_orders_bid ON orders(bid);
CREATE INDEX IF NOT EXISTS idx_orders_sid ON orders(sid);
CREATE INDEX IF NOT EXISTS idx_msgs_f ON msgs(f);
CREATE INDEX IF NOT EXISTS idx_msgs_t ON msgs(t);
CREATE INDEX IF NOT EXISTS idx_notes_uid ON notes(uid);
CREATE INDEX IF NOT EXISTS idx_products_sid ON products(sid);
CREATE INDEX IF NOT EXISTS idx_push_uid ON push_subs(uid);
-- Supabase exposes public tables through its REST API. This app talks to Postgres directly from the server,
-- so Row Level Security is turned on with no policies: nobody can read these tables with the public API keys.
${TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n')}
`;

async function seed() {
  await tx(async (t) => {
    await t.q('SELECT pg_advisory_xact_lock(7001)');
    if ((await t.one('SELECT COUNT(*)::int c FROM users')).c) return;
    const now = Date.now();
    const addUser = async (name, email, pw, role, addrs = []) =>
      (await t.one('INSERT INTO users(name,email,pw,role,addrs,created) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id',
        [name, email, bcrypt.hashSync(pw, 10), role, JSON.stringify(addrs), now])).id;
    await addUser('Admin', (process.env.ADMIN_EMAIL || 'admin@lokalmart.ph').toLowerCase(), process.env.ADMIN_PASSWORD || 'admin123', 'admin');
    await t.q("INSERT INTO settings(k,v) VALUES('commission','5'),('town','') ON CONFLICT DO NOTHING");
    if (process.env.SEED_DEMO === 'false') return;
    const rosa = await addUser('Aling Rosa', 'rosa@demo.ph', 'seller123', 'user');
    const totoy = await addUser('Mang Totoy', 'totoy@demo.ph', 'seller123', 'user');
    const pend = await addUser('Pending Seller', 'new@demo.ph', 'seller123', 'user');
    await addUser('Ana Reyes', 'ana@demo.ph', 'buyer123', 'user', ['Purok 1, Danac']);
    const store = (uid, n, d, a, st) => t.q('INSERT INTO stores(uid,store,descr,area,status) VALUES($1,$2,$3,$4,$5)', [uid, n, d, a, st]);
    await store(rosa, "Rosa's Farm Fresh", 'Fresh vegetables from our farm.', 'Banga', 'approved');
    await store(totoy, "Totoy's Rice & Fish", 'Local rice and daily catch.', 'Danac', 'approved');
    await store(pend, 'Bake Haus', 'Pandesal and kakanin.', 'Caoayan', 'pending');
    const P = (...a) => t.q('INSERT INTO products(sid,name,cat,price,disc,stock,unit,descr,sold) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', a);
    await P(rosa, 'Kangkong', 'Vegetables', 25, 0, 40, 'bundle', 'Freshly picked this morning.', 12);
    await P(rosa, 'Native Tomatoes', 'Vegetables', 60, 50, 25, 'kg', 'Sweet and firm.', 30);
    await P(rosa, 'Lakatan Banana', 'Fruits', 70, 0, 3, 'kg', 'Ripe lakatan.', 20);
    await P(totoy, 'Dinorado Rice', 'Rice & Grains', 1350, 1300, 15, 'sack', '25kg sack, local harvest.', 9);
    await P(totoy, 'Fresh Bangus', 'Meat & Fish', 180, 0, 12, 'kg', 'Daily catch.', 44);
    await P(totoy, 'Woven Basket', 'Crafts', 250, 0, 8, 'piece', 'Handwoven rattan.', 5);
    await t.q('INSERT INTO reviews(sid,n,r,t,ts) VALUES($1,$2,$3,$4,$5)', [rosa, 'Ana R.', 5, 'Super fresh kangkong, fast pickup!', now]);
    await t.q('INSERT INTO reviews(sid,n,r,t,ts) VALUES($1,$2,$3,$4,$5)', [totoy, 'Ben D.', 4, 'Good rice, fair price.', now]);
  });
}

let ready = null;
/** Creates tables (if missing) and seeds the first admin. Safe to call on every request. */
const init = () => ready || (ready = (async () => { await pool.query(SCHEMA); await seed(); })().catch((e) => { ready = null; throw e; }));

module.exports = { pool, q, one, tx, init, SCHEMA };
