const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const mail = require('./mail');
const storage = require('./storage');
const push = require('./push');
const xendit = require('./xendit');
const realtime = require('./realtime');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production.');

const CATS = ['Vegetables', 'Fruits', 'Rice & Grains', 'Meat & Fish', 'Bakery', 'Crafts', 'Others'];
const UNITS = ['kg', 'gram', 'piece', 'pack', 'sack', 'bundle'];
const LOCS = ['Balbalayang (Pob.)', 'Banga', 'Caoayan', 'Danac', 'Licungan', 'Pangotan'];
const TOPICS = ['Order problem', 'Seller or listing', 'Payment or refund', 'My account', 'Other'];
const SCHEDULES = ['ASAP', 'Today afternoon', 'Tomorrow morning', 'Tomorrow afternoon'];
const ONLINE = 'Online (Xendit)';
const NEXT = { Pending: 'Accepted', Accepted: 'Preparing', Preparing: 'Ready', Ready: 'Completed' };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, // OpenStreetMap tiles require a referer
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org', ...(storage.origin() ? [storage.origin()] : [])],
      connectSrc: ["'self'", ...(realtime.enabled() ? ['wss://' + new URL(process.env.SUPABASE_URL).host] : [])],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.json({ limit: '1mb' }));

/* ---------- helpers ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const now = () => new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
const setting = async (k) => ((await db.one('SELECT v FROM settings WHERE k=$1', [k])) || {}).v || '';
const background = (p) => {
  p = Promise.resolve(p).catch((e) => console.error('background task failed:', e.message));
  if (process.env.VERCEL) { try { require('@vercel/functions').waitUntil(p); } catch (e) { /* not available */ } }
  return p;
};
const notify = (uid, t, x = db) => {
  const ping = () => {
    if (push.enabled() && !t.startsWith('[Audit]')) background(push.sendTo(uid, t));
    if (realtime.enabled()) background(realtime.ping(uid));
  };
  return x.q('INSERT INTO notes(uid,t,d,ts) VALUES($1,$2,$3,$4)', [uid, t, now(), Date.now()]).then((r) => { x.after ? x.after(ping) : ping(); return r; });
};
const notifyAdmins = async (t, x = db) => { for (const a of await x.q("SELECT id FROM users WHERE role='admin'")) await notify(a.id, t, x); };
const audit = (t) => notifyAdmins('[Audit] ' + t);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '30d' });
const COOKIE = 'lm_session';
const readCookie = (req, n) => { const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith(n + '=')); return c ? decodeURIComponent(c.slice(n.length + 1)) : ''; };
const cookie = (req, res, val, age) => res.append('Set-Cookie', `${COOKIE}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${req.secure ? '; Secure' : ''}`);
/** Log the user in: httpOnly cookie for the browser app; the token is returned in the body only if the client asks (bearer:true). */
const session = (req, res, u) => { cookie(req, res, sign(u), 30 * 86400); res.json(req.body && req.body.bearer === true ? { ok: true, token: sign(u) } : { ok: true }); };
const appUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

app.use('/api', async (req, res, next) => { try { await db.init(); next(); } catch (e) { next(e); } });
app.use('/api', async (req, res, next) => {
  const h = req.headers.authorization || '';
  const viaCookie = !h.startsWith('Bearer '), token = viaCookie ? readCookie(req, COOKIE) : h.slice(7);
  if (token) {
    try {
      const p = jwt.verify(token, SECRET);
      const u = await db.one('SELECT * FROM users WHERE id=$1', [p.id]);
      if (u && u.active) {
        // Cookie sessions: changing requests must carry a custom header (a cross-site form or image cannot add one).
        if (viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'lokalmart') return res.status(403).json({ error: 'Blocked request' });
        req.user = u;
      }
    } catch (e) { /* invalid token = guest */ }
  }
  next();
});
const need = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in first' }));
const adminOnly = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));
/** Login/register/reset throttle kept in Postgres, so it holds across every serverless instance. */
const limiter = async (req, res, next) => {
  try {
    const max = +process.env.AUTH_RATE_MAX || 30, win = 15 * 60 * 1000, t = Date.now();
    const r = await db.one(`INSERT INTO rate_hits(k,n,reset) VALUES($1,1,$2) ON CONFLICT(k) DO UPDATE SET
      n=CASE WHEN rate_hits.reset<$3 THEN 1 ELSE rate_hits.n+1 END, reset=CASE WHEN rate_hits.reset<$3 THEN $2 ELSE rate_hits.reset END RETURNING n,reset`, ['auth:' + req.ip, t + win, t]);
    if (Math.random() < 0.02) db.q('DELETE FROM rate_hits WHERE reset<$1', [t]).catch(() => {});
    if (r.n > max) return res.set('Retry-After', String(Math.ceil((r.reset - t) / 1000))).status(429).json({ error: 'Too many attempts. Try again later.' });
    next();
  } catch (e) { next(e); }
};

/* ---------- state (everything the signed-in user may see) ---------- */
async function buildState(u) {
  const adm = !!u && u.role === 'admin', uid = u ? u.id : 0;
  const none = Promise.resolve([]);
  const [orders, msgs, notes, tickets, products, rev, ratingRows, commission, town] = await Promise.all([
    !u ? none : adm ? db.q('SELECT * FROM orders ORDER BY id DESC LIMIT 300') : db.q('SELECT * FROM orders WHERE bid=$1 OR sid=$1 OR rid=$1 ORDER BY id DESC LIMIT 150', [uid]),
    !u ? none : db.q('SELECT f,t,x,ts FROM (SELECT * FROM msgs WHERE f=$1 OR t=$1 ORDER BY id DESC LIMIT 400) m ORDER BY id', [uid]),
    !u ? none : db.q('SELECT uid,t,d,ts FROM notes WHERE uid=$1 ORDER BY id DESC LIMIT 100', [uid]),
    !u ? none : adm ? db.q('SELECT * FROM tickets ORDER BY id DESC LIMIT 300') : db.q('SELECT * FROM tickets WHERE uid=$1 ORDER BY id DESC LIMIT 100', [uid]),
    db.q(`SELECT p.id,p.sid,p.name,p.cat,p.price,p.disc,p.stock,p.unit,p.descr AS "desc",p.st,p.sold,
            CASE WHEN p.img LIKE 'http%' THEN p.img ELSE '' END AS imgurl,
            CASE WHEN p.img LIKE 'data:%' THEN md5(p.img) ELSE '' END AS imgv
          FROM products p LEFT JOIN stores s ON s.uid=p.sid
          WHERE $1::boolean OR p.sid=$2 OR (p.st='published' AND s.status='approved') ORDER BY p.id`, [adm, uid]),
    db.q('SELECT sid,n,r,t FROM reviews ORDER BY id DESC LIMIT 200'),
    db.q('SELECT sid, array_agg(r) rs FROM reviews GROUP BY sid'),
    setting('commission'), setting('town'),
  ]);
  if (u && !adm) for (let i = orders.length - 1; i >= 0; i--) { const x = orders[i]; if (x.pay === ONLINE && !x.paid && x.sid === uid && x.bid !== uid && x.rid !== uid) orders.splice(i, 1); } // sellers see online orders once paid
  const rel = new Set([uid]);
  orders.forEach((o) => { rel.add(o.bid); rel.add(o.sid); if (o.rid) rel.add(o.rid); if (o.bid !== uid) delete o.pin; }); // only the buyer sees the delivery PIN
  msgs.forEach((m) => { rel.add(m.f); rel.add(m.t); });
  tickets.forEach((t) => rel.add(t.uid));
  const ratings = {};
  ratingRows.forEach((r) => { ratings[r.sid] = r.rs; });
  const urows = await db.q(
    `SELECT u.id,u.name,u.email,u.role,u.active,u.addrs,u.fav,u.fs,u.seen,u.rt,s.store,s.descr sdesc,s.area,s.open,s.status sstatus,s.plan
     FROM users u LEFT JOIN stores s ON s.uid=u.id WHERE $1::boolean OR u.id=ANY($2::int[]) OR s.status='approved' OR ($3::boolean AND u.role='rider' AND u.active=1)`, [adm, [...rel], !!u]);
  const users = urows.map((r) => {
    const self = !!u && u.id === r.id;
    const o = { id: r.id, name: r.name, role: adm || self || r.role === 'rider' ? r.role : 'user', active: !!r.active };
    if (r.store) o.seller = { store: r.store, desc: r.sdesc, area: r.area, open: !!r.open, status: r.sstatus, plan: r.plan, ratings: ratings[r.id] || [] };
    if (adm || self) o.email = r.email;
    if (self) Object.assign(o, { addrs: r.addrs, fav: r.fav, fs: r.fs, seen: r.seen, rt: r.rt });
    return o;
  });
  return {
    me: u ? { id: u.id } : null, users, reviews: rev, notes, msgs, tickets, orders,
    products: products.map(({ imgv, imgurl, ...p }) => ({ ...p, img: imgurl || (imgv ? `/api/img/${p.id}?v=${imgv.slice(0, 8)}` : '') })),
    commission: +commission || 0, town,
  };
}
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/state', wrap(async (req, res) => res.json(await buildState(req.user))));
app.get('/api/img/:id', wrap(async (req, res) => {
  const p = await db.one('SELECT img FROM products WHERE id=$1', [+req.params.id || 0]);
  if (p && p.img.startsWith('http')) return res.redirect(302, p.img);
  const m = p && /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(p.img);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'public, max-age=86400').send(Buffer.from(m[2], 'base64'));
}));

/* ---------- auth & account ---------- */
app.post('/api/register', limiter, wrap(async (req, res) => {
  const name = str(req.body.name, 60), email = str(req.body.email, 80).toLowerCase(), pw = req.body.pw, sl = req.body.seller;
  if (!name || !email) throw bad('Enter your name and email or mobile number');
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 100) throw bad('Password must be at least 6 characters');
  if (await db.one('SELECT 1 x FROM users WHERE email=$1', [email])) throw bad('That email or mobile number is already registered');
  if (sl && !LOCS.includes(sl.area)) throw bad('Choose a valid store location');
  const id = await db.tx(async (t) => {
    const uid = (await t.one('INSERT INTO users(name,email,pw,created) VALUES($1,$2,$3,$4) RETURNING id', [name, email, bcrypt.hashSync(pw, 10), Date.now()])).id;
    if (sl) {
      await t.q('INSERT INTO stores(uid,store,area) VALUES($1,$2,$3)', [uid, str(sl.store, 60) || name + "'s Store", sl.area]);
      await notifyAdmins('New seller application: ' + name, t);
    } else await notifyAdmins('New user: ' + name, t);
    return uid;
  });
  session(req, res, { id });
}));
app.post('/api/login', limiter, wrap(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE email=$1', [str(req.body.email, 80).toLowerCase()]);
  if (!u || typeof req.body.pw !== 'string' || !bcrypt.compareSync(req.body.pw, u.pw)) throw bad('Invalid email or password', 401);
  if (!u.active) throw bad('This account is deactivated', 403);
  session(req, res, u);
}));
app.post('/api/logout', (req, res) => { cookie(req, res, '', 0); res.json({ ok: true }); });
app.get('/api/config', (req, res) => res.json({ online: xendit.enabled(), realtime: realtime.enabled() }));
app.get('/api/rt', need, (req, res) => (realtime.enabled() ? res.json(realtime.info(req.user.id)) : res.status(404).json({ error: 'Realtime is not set up' })));
const hashCode = (email, code) => crypto.createHmac('sha256', SECRET).update(email + ':' + code).digest('hex');
app.post('/api/forgot', limiter, wrap(async (req, res) => {
  const email = str(req.body.email, 80).toLowerCase();
  const u = email && (await db.one('SELECT id,name,active FROM users WHERE email=$1', [email]));
  if (u && u.active && mail.enabled() && email.includes('@')) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.q('INSERT INTO resets(email,code,exp,tries) VALUES($1,$2,$3,0) ON CONFLICT(email) DO UPDATE SET code=EXCLUDED.code,exp=EXCLUDED.exp,tries=0',
      [email, hashCode(email, code), Date.now() + 15 * 60 * 1000]);
    try {
      await mail.send(email, 'LokalMart password reset code', `Hi ${u.name},\n\nYour LokalMart password reset code is ${code}. It expires in 15 minutes.\nIf you did not ask for this, you can ignore this email.`);
    } catch (e) { console.error('reset email failed:', e.message); }
  }
  res.json({ ok: true, email: mail.enabled() }); // same answer whether or not the account exists
}));
app.post('/api/reset', limiter, wrap(async (req, res) => {
  const email = str(req.body.email, 80).toLowerCase(), code = str(req.body.code, 10), pw = req.body.pw;
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 100) throw bad('Password must be at least 6 characters');
  const done = await db.tx(async (t) => {
    const r = await t.one('SELECT * FROM resets WHERE email=$1 FOR UPDATE', [email]);
    if (!r || r.exp < Date.now() || r.tries >= 5) return false;
    const a = Buffer.from(r.code), b = Buffer.from(hashCode(email, code));
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) { await t.q('UPDATE resets SET tries=tries+1 WHERE email=$1', [email]); return false; }
    await t.q('UPDATE users SET pw=$1 WHERE email=$2', [bcrypt.hashSync(pw, 10), email]);
    await t.q('DELETE FROM resets WHERE email=$1', [email]);
    return true;
  });
  if (!done) throw bad('Invalid or expired code');
  res.json({ ok: true });
}));
app.get('/api/push/key', (req, res) => res.json({ key: push.enabled() ? process.env.VAPID_PUBLIC_KEY : '' }));
app.post('/api/push/subscribe', need, wrap(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!push.enabled()) throw bad('Push notifications are not set up on this server', 503);
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 600 || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) throw bad('Invalid subscription');
  await db.q('INSERT INTO push_subs(uid,endpoint,p256dh,auth,ts) VALUES($1,$2,$3,$4,$5) ON CONFLICT(endpoint) DO UPDATE SET uid=EXCLUDED.uid,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,ts=EXCLUDED.ts',
    [req.user.id, endpoint, keys.p256dh, keys.auth, Date.now()]);
  await db.q('DELETE FROM push_subs WHERE uid=$1 AND id NOT IN (SELECT id FROM push_subs WHERE uid=$1 ORDER BY ts DESC LIMIT 10)', [req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', need, wrap(async (req, res) => {
  await db.q('DELETE FROM push_subs WHERE uid=$1 AND endpoint=$2', [req.user.id, str(req.body.endpoint, 600)]);
  res.json({ ok: true });
}));
app.put('/api/me', need, wrap(async (req, res) => {
  const u = req.user, b = req.body || {}, sets = [], vals = [];
  const add = (col, val, cast = '') => { vals.push(val); sets.push(`${col}=$${vals.length}${cast}`); };
  if (b.name !== undefined) { const n = str(b.name, 60); if (n) add('name', n); }
  if (b.pw) { if (typeof b.pw !== 'string' || b.pw.length < 6) throw bad('Password must be at least 6 characters'); add('pw', bcrypt.hashSync(b.pw, 10)); }
  if (Array.isArray(b.addrs)) add('addrs', JSON.stringify(b.addrs.map((a) => str(a, 200)).filter(Boolean).slice(0, 10)), '::jsonb');
  if (Array.isArray(b.fav)) add('fav', JSON.stringify([...new Set(b.fav.map(Number).filter(Number.isInteger))].slice(0, 500)), '::jsonb');
  if (Array.isArray(b.fs)) add('fs', JSON.stringify([...new Set(b.fs.map(Number).filter(Number.isInteger))].slice(0, 200)), '::jsonb');
  if (Number.isInteger(b.seen) && b.seen >= 0) add('seen', b.seen);
  if (b.rt && typeof b.rt === 'object') {
    const rt = { ...u.rt };
    for (const [k, v] of Object.entries(b.rt)) if (/^\d+-\d+$/.test(k) && Number.isFinite(+v)) rt[k] = +v;
    add('rt', JSON.stringify(rt), '::jsonb');
  }
  if (sets.length) { vals.push(u.id); await db.q(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length}`, vals); }
  res.json({ ok: true });
}));
app.post('/api/me/deactivate', need, wrap(async (req, res) => {
  if (req.user.role === 'admin') throw bad('Admin accounts cannot be deactivated');
  await db.q('UPDATE users SET active=0 WHERE id=$1', [req.user.id]);
  res.json({ ok: true });
}));

/* ---------- seller & products ---------- */
app.post('/api/seller', need, wrap(async (req, res) => {
  if (await db.one('SELECT 1 x FROM stores WHERE uid=$1', [req.user.id])) throw bad('You already applied as a seller');
  const store = str(req.body.store, 60);
  if (!store || !LOCS.includes(req.body.area)) throw bad('Enter a store name and choose a location');
  await db.q('INSERT INTO stores(uid,store,area) VALUES($1,$2,$3)', [req.user.id, store, req.body.area]);
  await notifyAdmins('Seller application: ' + store);
  res.json({ ok: true });
}));
app.put('/api/seller', need, wrap(async (req, res) => {
  const s = await db.one('SELECT * FROM stores WHERE uid=$1', [req.user.id]);
  if (!s) throw bad('You are not a seller', 403);
  const b = req.body, area = LOCS.includes(b.area) ? b.area : s.area;
  await db.q('UPDATE stores SET store=$1,descr=$2,area=$3,open=$4 WHERE uid=$5', [str(b.store, 60) || s.store, str(b.desc, 300), area, b.open ? 1 : 0, req.user.id]);
  res.json({ ok: true });
}));
async function storeImg(dataUrl) {
  if (!storage.enabled()) return dataUrl;
  try { return await storage.upload(dataUrl); } catch (e) { console.error(e.message); throw bad('Photo upload failed. Try again.', 502); }
}
function productInput(b) {
  const name = str(b.name, 80), price = +b.price, disc = +b.disc || 0, stock = Math.floor(+b.stock);
  if (!name || !CATS.includes(b.cat) || !UNITS.includes(b.unit)) throw bad('Check the product name, category and unit');
  if (!(price > 0) || price > 1e7 || disc < 0 || (disc && disc >= price)) throw bad('Check the price and discount price');
  if (!(stock >= 0) || stock > 1e6) throw bad('Check the stock quantity');
  if (!['published', 'draft'].includes(b.st)) throw bad('Invalid status');
  const out = { name, cat: b.cat, price, disc, stock, unit: b.unit, desc: str(b.desc !== undefined ? b.desc : b.descr, 500), st: b.st };
  if (typeof b.img === 'string' && b.img.startsWith('data:image/')) {
    if (b.img.length > 400000) throw bad('Photo is too large');
    if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(b.img)) throw bad('Unsupported photo format');
    out.img = b.img;
  }
  return out;
}
app.post('/api/products', need, wrap(async (req, res) => {
  if (!(await db.one("SELECT 1 x FROM stores WHERE uid=$1 AND status='approved'", [req.user.id]))) throw bad('Your seller account is not approved yet', 403);
  const p = productInput(req.body);
  const r = await db.one('INSERT INTO products(sid,name,cat,price,disc,stock,unit,descr,st,img) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [req.user.id, p.name, p.cat, p.price, p.disc, p.stock, p.unit, p.desc, p.st, p.img ? await storeImg(p.img) : '']);
  res.json({ id: r.id });
}));
app.put('/api/products/:id', need, wrap(async (req, res) => {
  const cur = await db.one('SELECT * FROM products WHERE id=$1', [+req.params.id || 0]);
  if (!cur || cur.sid !== req.user.id) throw bad('Product not found', 404);
  if (cur.st === 'hidden' && req.body.st === 'published') throw bad('An admin hid this listing', 403);
  const p = productInput({ ...cur, ...req.body, st: cur.st === 'hidden' ? 'draft' : req.body.st || cur.st, desc: req.body.desc !== undefined ? req.body.desc : cur.descr, img: req.body.img });
  const img = p.img ? await storeImg(p.img) : cur.img;
  await db.q('UPDATE products SET name=$1,cat=$2,price=$3,disc=$4,stock=$5,unit=$6,descr=$7,st=$8,img=$9 WHERE id=$10',
    [p.name, p.cat, p.price, p.disc, p.stock, p.unit, p.desc, cur.st === 'hidden' ? 'hidden' : p.st, img, cur.id]);
  if (img !== cur.img) background(storage.remove(cur.img));
  res.json({ ok: true });
}));
app.delete('/api/products/:id', need, wrap(async (req, res) => {
  const r = await db.q('DELETE FROM products WHERE id=$1 AND sid=$2 RETURNING id,img', [+req.params.id || 0, req.user.id]);
  if (!r.length) throw bad('Product not found', 404);
  background(storage.remove(r[0].img));
  res.json({ ok: true });
}));

/* ---------- orders ---------- */
const voucher = (code, sub, fee) => {
  const c = String(code || '').trim().toUpperCase();
  return c === 'LOKAL10' ? Math.round(sub * 0.1) : c === 'FREESHIP' ? fee : c === 'LOKAL50' && sub >= 500 ? 50 : 0;
};
app.post('/api/orders', need, wrap(async (req, res) => {
  const { items, method, addr, note, when, vc } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) throw bad('Your cart is empty');
  if (!['delivery', 'pickup'].includes(method)) throw bad('Choose delivery or pickup');
  const address = str(addr, 200);
  if (method === 'delivery' && !address) throw bad('Add a delivery address');
  const online = req.body.pay === 'online';
  if (online && !xendit.enabled()) throw bad('Online payment is not available yet');
  const rate = +(await setting('commission')) || 0, u = req.user;
  const made = await db.tx(async (t) => {
    const merged = {};
    items.forEach((it) => { const k = Math.floor(+it.pid), q = Math.floor(+it.q); if (k > 0 && q > 0) merged[k] = (merged[k] || 0) + q; });
    if (!Object.keys(merged).length) throw bad('Your cart is empty');
    const by = {};
    for (const [pid, q] of Object.entries(merged)) {
      const p = await t.one(`SELECT p.*,s.status ss,s.open so,u.active ua FROM products p JOIN stores s ON s.uid=p.sid JOIN users u ON u.id=p.sid
                             WHERE p.id=$1 FOR UPDATE OF p`, [+pid]);
      if (!p || p.st !== 'published' || p.ss !== 'approved' || !p.ua) throw bad('An item in your cart is no longer available');
      if (p.sid === u.id) throw bad('You cannot buy your own product');
      if (!p.so) throw bad('A store in your cart is currently closed');
      if (q > p.stock) throw bad(`Only ${p.stock} ${p.unit} of ${p.name} left`);
      (by[p.sid] = by[p.sid] || []).push({ pid: p.id, name: p.name, price: p.disc || p.price, q, unit: p.unit });
    }
    const rows = Object.entries(by).map(([sid, l]) => ({ sid: +sid, l, sub: l.reduce((a, i) => a + i.price * i.q, 0), fee: method === 'delivery' ? 40 : 0 }));
    const tS = rows.reduce((a, r) => a + r.sub, 0), tF = rows.reduce((a, r) => a + r.fee, 0);
    const tD = Math.min(voucher(vc, tS, tF), tS + tF);
    let left = tD;
    const out = [];
    let amount = 0;
    for (const [k, r] of rows.entries()) {
      const d = k === rows.length - 1 ? left : Math.round((tD * (r.sub + r.fee)) / (tS + tF || 1));
      left -= d;
      const sched = SCHEDULES.includes(when) && when !== 'ASAP' ? `[${when}] ` : '';
      const o = await t.one(`INSERT INTO orders(bid,sid,items,sub,fee,disc,total,comm,method,addr,note,pay,date,ts,pin)
                             VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [u.id, r.sid, JSON.stringify(r.l), r.sub, r.fee, d, r.sub + r.fee - d, Math.round(r.sub * rate) / 100, method,
          method === 'delivery' ? address : '', sched + str(note, 300), online ? ONLINE : method === 'pickup' ? 'Cash on Pickup' : 'COD', now(), Date.now(),
          method === 'delivery' ? String(crypto.randomInt(0, 10000)).padStart(4, '0') : '']);
      out.push(o.id);
      amount += r.sub + r.fee - d;
      for (const i of r.l) {
        const upd = await t.one('UPDATE products SET stock=stock-$1,sold=sold+$1 WHERE id=$2 AND stock>=$1 RETURNING stock', [i.q, i.pid]);
        if (!upd) throw bad(`${i.name} just sold out`);
        if (upd.stock < 5) await notify(r.sid, 'Low stock: ' + i.name, t);
      }
      if (!online) await notify(r.sid, `New order #${o.id} from ${u.name}`, t); // online orders reach the seller once paid
    }
    await notify(u.id, online ? 'Order placed. Pay within 30 minutes or it is cancelled.' : 'Order placed successfully', t);
    let ref = '';
    if (online) {
      ref = `lm-${out.join('-')}-${Date.now().toString(36)}`;
      await t.q('INSERT INTO payments(ref,uid,oids,amount,ts) VALUES($1,$2,$3::jsonb,$4,$5)', [ref, u.id, JSON.stringify(out), amount, Date.now()]);
    }
    return { ids: out, ref, amount };
  });
  const ids = made.ids;
  if (online) {
    try {
      const inv = await xendit.createInvoice({ ref: made.ref, amount: made.amount, description: 'LokalMart ' + ids.map((i) => '#' + i).join(', '),
        successUrl: appUrl(req) + '/?paid=' + made.ref, failureUrl: appUrl(req) + '/?unpaid=' + made.ref });
      await db.q('UPDATE payments SET xid=$1,url=$2 WHERE ref=$3', [inv.id, inv.url, made.ref]);
      return res.json({ ids, pay: { url: inv.url, ref: made.ref } });
    } catch (e) {
      console.error(e.message);
      await db.q("UPDATE payments SET status='FAILED' WHERE ref=$1", [made.ref]).catch(() => {});
      await db.tx((t) => cancelInTx(t, ids, 'the payment could not be started'));
      throw bad('Could not start the online payment. Try again or choose cash.', 502);
    }
  }
  res.json({ ids });
}));
/** Cancel unpaid pending orders and give their stock back. Runs inside a transaction. */
async function cancelInTx(t, ids, why) {
  for (const id of ids) {
    const o = await t.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!o || o.status !== 'Pending' || o.paid) continue;
    await t.q("UPDATE orders SET status='Cancelled' WHERE id=$1", [id]);
    for (const i of o.items) await t.q('UPDATE products SET stock=stock+$1,sold=GREATEST(0,sold-$1) WHERE id=$2', [i.q, i.pid]);
    await notify(o.bid, `Order #${id} was cancelled: ${why}`, t);
  }
}
async function settle(ref, paid) {
  await db.tx(async (t) => {
    const p = await t.one('SELECT * FROM payments WHERE ref=$1 FOR UPDATE', [ref]);
    if (!p || p.status !== 'PENDING') return; // already handled (Xendit may send a callback more than once)
    await t.q('UPDATE payments SET status=$1 WHERE id=$2', [paid ? 'PAID' : 'EXPIRED', p.id]);
    if (!paid) return cancelInTx(t, p.oids, 'payment expired');
    for (const id of p.oids) {
      const o = await t.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      if (!o) continue;
      if (o.status === 'Cancelled' || o.status === 'Rejected') { await notifyAdmins(`Refund needed: order #${id} (${o.total}) was paid online but is ${o.status}`, t); continue; }
      await t.q('UPDATE orders SET paid=1 WHERE id=$1', [id]);
      await notify(o.sid, `New order #${id} from a buyer (paid online)`, t);
      await notify(o.bid, `Payment received for order #${id}`, t);
    }
  });
}
app.post('/api/xendit/callback', wrap(async (req, res) => {
  if (!xendit.enabled() || !xendit.tokenOk(req.headers['x-callback-token'])) return res.status(401).json({ error: 'Invalid callback token' });
  const ref = str(req.body.external_id, 120), pay = ref && (await db.one('SELECT * FROM payments WHERE ref=$1', [ref]));
  if (!pay) return res.json({ ok: true });
  const inv = await xendit.getInvoice(pay.xid || str(req.body.id, 80)); // trust Xendit's own record, not the request body
  if (inv.external_id !== ref) return res.json({ ok: true });
  const st = String(inv.status).toUpperCase();
  if (st === 'PAID' || st === 'SETTLED') {
    if (Math.abs(+inv.amount - pay.amount) > 0.009) { console.error('Xendit amount mismatch for', ref); return res.json({ ok: true }); }
    await settle(ref, true);
  } else if (st === 'EXPIRED') await settle(ref, false);
  res.json({ ok: true });
}));
app.post('/api/orders/:id/pay', need, wrap(async (req, res) => {
  const p = await db.one("SELECT url FROM payments WHERE uid=$1 AND status='PENDING' AND url<>'' AND oids @> $2::jsonb ORDER BY id DESC LIMIT 1", [req.user.id, JSON.stringify([+req.params.id || 0])]);
  if (!p) throw bad('There is no payment waiting for this order', 404);
  res.json({ url: p.url });
}));
app.put('/api/orders/:id/rider', need, wrap(async (req, res) => {
  const rid = req.body.rid === null || req.body.rid === '' ? null : Math.floor(+req.body.rid) || 0;
  const o = await db.one('SELECT * FROM orders WHERE id=$1', [+req.params.id || 0]);
  if (!o || (o.sid !== req.user.id && req.user.role !== 'admin')) throw bad('Order not found', 404);
  if (o.method !== 'delivery' || !['Accepted', 'Preparing', 'Ready'].includes(o.status)) throw bad('A rider can only be assigned to accepted delivery orders', 403);
  if (rid && !(await db.one("SELECT 1 x FROM users WHERE id=$1 AND role='rider' AND active=1", [rid]))) throw bad('Rider not found', 404);
  await db.q('UPDATE orders SET rid=$1 WHERE id=$2', [rid, o.id]);
  if (rid) { await notify(rid, `New delivery: order #${o.id}`); await notify(o.bid, `Order #${o.id} has a rider assigned`); }
  res.json({ ok: true });
}));
app.put('/api/orders/:id/status', need, wrap(async (req, res) => {
  const s = req.body.status, u = req.user;
  await db.tx(async (t) => {
    const o = await t.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [+req.params.id || 0]);
    if (!o || (o.bid !== u.id && o.sid !== u.id && o.rid !== u.id)) throw bad('Order not found', 404);
    const ok = (o.bid === u.id && s === 'Cancelled' && o.status === 'Pending') ||
      (o.sid === u.id && ((o.status === 'Pending' && (s === 'Accepted' || s === 'Rejected')) || (o.status !== 'Pending' && NEXT[o.status] === s))) ||
      (o.rid === u.id && o.status === 'Ready' && s === 'Completed');
    if (!ok) throw bad('That status change is not allowed', 403);
    if (s === 'Accepted' && o.pay === ONLINE && !o.paid) throw bad("Waiting for the buyer's online payment", 403);
    if (s === 'Completed' && o.method === 'delivery' && o.pin && String((req.body || {}).pin || '') !== o.pin) throw bad("Enter the buyer's 4-digit delivery PIN", 403);
    await t.q('UPDATE orders SET status=$1,paid=$2 WHERE id=$3', [s, s === 'Completed' ? 1 : o.paid, o.id]);
    if (s === 'Rejected' || s === 'Cancelled') {
      for (const i of o.items) await t.q('UPDATE products SET stock=stock+$1,sold=GREATEST(0,sold-$1) WHERE id=$2', [i.q, i.pid]);
    }
    await notify(o.bid, `Order #${o.id} is now ${s}`, t);
    if (s === 'Cancelled') await notify(o.sid, `Order #${o.id} cancelled by buyer`, t);
    if (o.rid && o.rid !== u.id && ['Cancelled', 'Rejected'].includes(s)) await notify(o.rid, `Delivery #${o.id} was ${s.toLowerCase()}`, t);
    if (o.rid === u.id) await notify(o.sid, `Order #${o.id} delivered by the rider`, t);
    if (['Cancelled', 'Rejected'].includes(s) && o.paid && o.pay === ONLINE) await notifyAdmins(`Refund needed: order #${o.id} (${o.total}) was paid online but is ${s}`, t);
  });
  res.json({ ok: true });
}));
app.post('/api/orders/:id/rate', need, wrap(async (req, res) => {
  const r = Math.floor(+req.body.r);
  await db.tx(async (t) => {
    const o = await t.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [+req.params.id || 0]);
    if (!o || o.bid !== req.user.id) throw bad('Order not found', 404);
    if (o.status !== 'Completed' || o.rated) throw bad('You can rate a completed order once', 403);
    if (!(r >= 1 && r <= 5)) throw bad('Choose a rating from 1 to 5');
    await t.q('INSERT INTO reviews(sid,n,r,t,ts) VALUES($1,$2,$3,$4,$5)', [o.sid, req.user.name, r, str(req.body.t, 200), Date.now()]);
    await t.q('UPDATE orders SET rated=1 WHERE id=$1', [o.id]);
    await notify(o.sid, `New review on order #${o.id}`, t);
  });
  res.json({ ok: true });
}));
app.post('/api/orders/hide', need, wrap(async (req, res) => {
  const id = Math.floor(+req.body.id) || 0;
  await db.q("UPDATE orders SET hid=1 WHERE bid=$1 AND status IN ('Cancelled','Rejected') AND ($2::int=0 OR id=$2::int)", [req.user.id, id]);
  res.json({ ok: true });
}));
app.put('/api/orders/:id/loc', need, wrap(async (req, res) => {
  const o = await db.one('SELECT * FROM orders WHERE id=$1', [+req.params.id || 0]), lat = +req.body.lat, lng = +req.body.lng;
  if (!o || (o.sid !== req.user.id && o.rid !== req.user.id)) throw bad('Order not found', 404);
  if (o.method !== 'delivery' || !['Preparing', 'Ready'].includes(o.status)) throw bad('Live location is only for orders being delivered', 403);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw bad('Invalid location');
  await db.q('UPDATE orders SET loc=$1::jsonb WHERE id=$2', [JSON.stringify({ lat, lng, t: Date.now() }), o.id]);
  if (!o.loc) await notify(o.bid, `Order #${o.id}: the rider is sharing live location`);
  res.json({ ok: true });
}));

/* ---------- chat, notifications, support ---------- */
app.post('/api/messages', need, wrap(async (req, res) => {
  const to = Math.floor(+req.body.to) || 0, x = str(req.body.x, 500);
  if (!x || to === req.user.id || !(await db.one('SELECT 1 y FROM users WHERE id=$1', [to]))) throw bad('Message could not be sent');
  await db.q('INSERT INTO msgs(f,t,x,ts) VALUES($1,$2,$3,$4)', [req.user.id, to, x, Date.now()]);
  if (realtime.enabled()) background(realtime.ping(to));
  res.json({ ok: true });
}));
app.delete('/api/notes', need, wrap(async (req, res) => {
  await db.q('DELETE FROM notes WHERE uid=$1', [req.user.id]);
  await db.q('UPDATE users SET seen=0 WHERE id=$1', [req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/tickets', need, wrap(async (req, res) => {
  const msg = str(req.body.msg, 500), topic = TOPICS.includes(req.body.topic) ? req.body.topic : 'Other';
  if (!msg) throw bad('Describe the problem');
  const t = await db.one('INSERT INTO tickets(uid,topic,oid,msg,ts) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.user.id, topic, Math.floor(+req.body.oid) || 0, msg, Date.now()]);
  await notifyAdmins(`Support ticket #${t.id}: ${topic}`);
  res.json({ id: t.id });
}));
app.put('/api/tickets/:id', need, adminOnly, wrap(async (req, res) => {
  const t = await db.one('SELECT * FROM tickets WHERE id=$1', [+req.params.id || 0]);
  if (!t) throw bad('Ticket not found', 404);
  await db.q("UPDATE tickets SET reply=$1,status='Resolved' WHERE id=$2", [str(req.body.reply, 500), t.id]);
  await notify(t.uid, `Support replied to ticket #${t.id}`);
  res.json({ ok: true });
}));

/* ---------- admin ---------- */
app.put('/api/admin/sellers/:id', need, adminOnly, wrap(async (req, res) => {
  const s = await db.one('SELECT * FROM stores WHERE uid=$1', [+req.params.id || 0]);
  if (!s || !['approved', 'rejected', 'pending'].includes(req.body.status)) throw bad('Seller not found', 404);
  await db.q('UPDATE stores SET status=$1 WHERE uid=$2', [req.body.status, s.uid]);
  await notify(s.uid, 'Seller verification: ' + req.body.status);
  await audit(`Seller ${s.store} ${req.body.status}`);
  res.json({ ok: true });
}));
app.put('/api/admin/products/:id', need, adminOnly, wrap(async (req, res) => {
  const p = await db.one('SELECT * FROM products WHERE id=$1', [+req.params.id || 0]);
  if (!p || !['published', 'hidden'].includes(req.body.st)) throw bad('Product not found', 404);
  await db.q('UPDATE products SET st=$1 WHERE id=$2', [req.body.st, p.id]);
  await notify(p.sid, `Product "${p.name}" ${req.body.st === 'hidden' ? 'hidden by admin' : 'approved'}`);
  await audit(`Product ${p.id} ${req.body.st}`);
  res.json({ ok: true });
}));
app.delete('/api/admin/products/:id', need, adminOnly, wrap(async (req, res) => {
  const r = await db.q('DELETE FROM products WHERE id=$1 RETURNING id,img', [+req.params.id || 0]);
  if (!r.length) throw bad('Product not found', 404);
  background(storage.remove(r[0].img));
  await audit('Removed product ' + req.params.id);
  res.json({ ok: true });
}));
app.put('/api/admin/users/:id', need, adminOnly, wrap(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id=$1', [+req.params.id || 0]);
  if (!u || u.role === 'admin') throw bad('User not found', 404);
  if (req.body.active !== undefined) {
    await db.q('UPDATE users SET active=$1 WHERE id=$2', [req.body.active ? 1 : 0, u.id]);
    await audit(`${req.body.active ? 'Activated' : 'Suspended'} ${u.name}`);
  }
  if (req.body.role !== undefined) {
    if (!['user', 'rider'].includes(req.body.role)) throw bad('Invalid role');
    await db.q('UPDATE users SET role=$1 WHERE id=$2', [req.body.role, u.id]);
    await audit(`${u.name} is now ${req.body.role === 'rider' ? 'a rider' : 'a regular user'}`);
  }
  if (req.body.pw) {
    if (typeof req.body.pw !== 'string' || req.body.pw.length < 6) throw bad('Temporary password must be at least 6 characters');
    await db.q('UPDATE users SET pw=$1 WHERE id=$2', [bcrypt.hashSync(req.body.pw, 10), u.id]);
    await audit('Reset password for ' + u.name);
  }
  res.json({ ok: true });
}));
app.put('/api/admin/settings', need, adminOnly, wrap(async (req, res) => {
  const put = (k, v) => db.q('INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v', [k, v]);
  if (req.body.commission !== undefined) {
    const c = +req.body.commission;
    if (!(c >= 0 && c <= 50)) throw bad('Commission must be between 0 and 50');
    await put('commission', String(c));
    await audit(`Commission set to ${c}%`);
  }
  if (req.body.town !== undefined) await put('town', str(req.body.town, 80));
  res.json({ ok: true });
}));

/* ---------- static frontend (local dev; Vercel serves /public itself) & errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  if (err.code === '23505') return res.status(400).json({ error: 'That already exists' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

module.exports = app;
