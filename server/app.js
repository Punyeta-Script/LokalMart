const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production.');

const CATS = ['Vegetables', 'Fruits', 'Rice & Grains', 'Meat & Fish', 'Bakery', 'Crafts', 'Others'];
const UNITS = ['kg', 'gram', 'piece', 'pack', 'sack', 'bundle'];
const LOCS = ['Balbalayang (Pob.)', 'Banga', 'Caoayan', 'Danac', 'Licungan', 'Pangotan'];
const TOPICS = ['Order problem', 'Seller or listing', 'Payment or refund', 'My account', 'Other'];
const SCHEDULES = ['ASAP', 'Today afternoon', 'Tomorrow morning', 'Tomorrow afternoon'];
const NEXT = { Pending: 'Accepted', Accepted: 'Preparing', Preparing: 'Ready', Ready: 'Completed' };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
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
const notify = (uid, t, x = db) => x.q('INSERT INTO notes(uid,t,d,ts) VALUES($1,$2,$3,$4)', [uid, t, now(), Date.now()]);
const notifyAdmins = async (t, x = db) => { for (const a of await x.q("SELECT id FROM users WHERE role='admin'")) await notify(a.id, t, x); };
const audit = (t) => notifyAdmins('[Audit] ' + t);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '30d' });

app.use('/api', async (req, res, next) => { try { await db.init(); next(); } catch (e) { next(e); } });
app.use('/api', async (req, res, next) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(h.slice(7), SECRET);
      const u = await db.one('SELECT * FROM users WHERE id=$1', [p.id]);
      if (u && u.active) req.user = u;
    } catch (e) { /* invalid token = guest */ }
  }
  next();
});
const need = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in first' }));
const adminOnly = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });

/* ---------- state (everything the signed-in user may see) ---------- */
async function buildState(u) {
  const adm = !!u && u.role === 'admin', uid = u ? u.id : 0;
  const none = Promise.resolve([]);
  const [orders, msgs, notes, tickets, products, rev, ratingRows, commission, town] = await Promise.all([
    !u ? none : adm ? db.q('SELECT * FROM orders ORDER BY id DESC') : db.q('SELECT * FROM orders WHERE bid=$1 OR sid=$1 ORDER BY id DESC', [uid]),
    !u ? none : db.q('SELECT f,t,x,ts FROM msgs WHERE f=$1 OR t=$1 ORDER BY id', [uid]),
    !u ? none : db.q('SELECT uid,t,d,ts FROM notes WHERE uid=$1 ORDER BY id DESC LIMIT 100', [uid]),
    !u ? none : adm ? db.q('SELECT * FROM tickets ORDER BY id DESC') : db.q('SELECT * FROM tickets WHERE uid=$1 ORDER BY id DESC', [uid]),
    db.q(`SELECT p.id,p.sid,p.name,p.cat,p.price,p.disc,p.stock,p.unit,p.descr AS "desc",p.st,p.sold,
            CASE WHEN p.img='' THEN '' ELSE md5(p.img) END AS imgv
          FROM products p LEFT JOIN stores s ON s.uid=p.sid
          WHERE $1::boolean OR p.sid=$2 OR (p.st='published' AND s.status='approved') ORDER BY p.id`, [adm, uid]),
    db.q('SELECT sid,n,r,t FROM reviews ORDER BY id DESC LIMIT 200'),
    db.q('SELECT sid, array_agg(r) rs FROM reviews GROUP BY sid'),
    setting('commission'), setting('town'),
  ]);
  const rel = new Set([uid]);
  orders.forEach((o) => { rel.add(o.bid); rel.add(o.sid); });
  msgs.forEach((m) => { rel.add(m.f); rel.add(m.t); });
  tickets.forEach((t) => rel.add(t.uid));
  const ratings = {};
  ratingRows.forEach((r) => { ratings[r.sid] = r.rs; });
  const urows = await db.q(
    `SELECT u.id,u.name,u.email,u.role,u.active,u.addrs,u.fav,u.fs,u.seen,u.rt,s.store,s.descr sdesc,s.area,s.open,s.status sstatus,s.plan
     FROM users u LEFT JOIN stores s ON s.uid=u.id WHERE $1::boolean OR u.id=ANY($2::int[]) OR s.status='approved'`, [adm, [...rel]]);
  const users = urows.map((r) => {
    const self = !!u && u.id === r.id;
    const o = { id: r.id, name: r.name, role: adm || self ? r.role : 'user', active: !!r.active };
    if (r.store) o.seller = { store: r.store, desc: r.sdesc, area: r.area, open: !!r.open, status: r.sstatus, plan: r.plan, ratings: ratings[r.id] || [] };
    if (adm || self) o.email = r.email;
    if (self) Object.assign(o, { addrs: r.addrs, fav: r.fav, fs: r.fs, seen: r.seen, rt: r.rt });
    return o;
  });
  return {
    me: u ? { id: u.id } : null, users, reviews: rev, notes, msgs, tickets, orders,
    products: products.map(({ imgv, ...p }) => ({ ...p, img: imgv ? `/api/img/${p.id}?v=${imgv.slice(0, 8)}` : '' })),
    commission: +commission || 0, town,
  };
}
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/state', wrap(async (req, res) => res.json(await buildState(req.user))));
app.get('/api/img/:id', wrap(async (req, res) => {
  const p = await db.one('SELECT img FROM products WHERE id=$1', [+req.params.id || 0]);
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
  res.json({ token: sign({ id }) });
}));
app.post('/api/login', limiter, wrap(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE email=$1', [str(req.body.email, 80).toLowerCase()]);
  if (!u || typeof req.body.pw !== 'string' || !bcrypt.compareSync(req.body.pw, u.pw)) throw bad('Invalid email or password', 401);
  if (!u.active) throw bad('This account is deactivated', 403);
  res.json({ token: sign(u) });
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
    [req.user.id, p.name, p.cat, p.price, p.disc, p.stock, p.unit, p.desc, p.st, p.img || '']);
  res.json({ id: r.id });
}));
app.put('/api/products/:id', need, wrap(async (req, res) => {
  const cur = await db.one('SELECT * FROM products WHERE id=$1', [+req.params.id || 0]);
  if (!cur || cur.sid !== req.user.id) throw bad('Product not found', 404);
  if (cur.st === 'hidden' && req.body.st === 'published') throw bad('An admin hid this listing', 403);
  const p = productInput({ ...cur, ...req.body, st: cur.st === 'hidden' ? 'draft' : req.body.st || cur.st, desc: req.body.desc !== undefined ? req.body.desc : cur.descr, img: req.body.img });
  await db.q('UPDATE products SET name=$1,cat=$2,price=$3,disc=$4,stock=$5,unit=$6,descr=$7,st=$8,img=$9 WHERE id=$10',
    [p.name, p.cat, p.price, p.disc, p.stock, p.unit, p.desc, cur.st === 'hidden' ? 'hidden' : p.st, p.img || cur.img, cur.id]);
  res.json({ ok: true });
}));
app.delete('/api/products/:id', need, wrap(async (req, res) => {
  const r = await db.q('DELETE FROM products WHERE id=$1 AND sid=$2 RETURNING id', [+req.params.id || 0, req.user.id]);
  if (!r.length) throw bad('Product not found', 404);
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
  const rate = +(await setting('commission')) || 0, u = req.user;
  const ids = await db.tx(async (t) => {
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
    for (const [k, r] of rows.entries()) {
      const d = k === rows.length - 1 ? left : Math.round((tD * (r.sub + r.fee)) / (tS + tF || 1));
      left -= d;
      const sched = SCHEDULES.includes(when) && when !== 'ASAP' ? `[${when}] ` : '';
      const o = await t.one(`INSERT INTO orders(bid,sid,items,sub,fee,disc,total,comm,method,addr,note,pay,date,ts)
                             VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [u.id, r.sid, JSON.stringify(r.l), r.sub, r.fee, d, r.sub + r.fee - d, Math.round(r.sub * rate) / 100, method,
          method === 'delivery' ? address : '', sched + str(note, 300), method === 'pickup' ? 'Cash on Pickup' : 'COD', now(), Date.now()]);
      out.push(o.id);
      for (const i of r.l) {
        const upd = await t.one('UPDATE products SET stock=stock-$1,sold=sold+$1 WHERE id=$2 AND stock>=$1 RETURNING stock', [i.q, i.pid]);
        if (!upd) throw bad(`${i.name} just sold out`);
        if (upd.stock < 5) await notify(r.sid, 'Low stock: ' + i.name, t);
      }
      await notify(r.sid, `New order #${o.id} from ${u.name}`, t);
    }
    await notify(u.id, 'Order placed successfully', t);
    return out;
  });
  res.json({ ids });
}));
app.put('/api/orders/:id/status', need, wrap(async (req, res) => {
  const s = req.body.status, u = req.user;
  await db.tx(async (t) => {
    const o = await t.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [+req.params.id || 0]);
    if (!o || (o.bid !== u.id && o.sid !== u.id)) throw bad('Order not found', 404);
    const ok = (o.bid === u.id && s === 'Cancelled' && o.status === 'Pending') ||
      (o.sid === u.id && ((o.status === 'Pending' && (s === 'Accepted' || s === 'Rejected')) || (o.status !== 'Pending' && NEXT[o.status] === s)));
    if (!ok) throw bad('That status change is not allowed', 403);
    await t.q('UPDATE orders SET status=$1,paid=$2 WHERE id=$3', [s, s === 'Completed' ? 1 : o.paid, o.id]);
    if (s === 'Rejected' || s === 'Cancelled') {
      for (const i of o.items) await t.q('UPDATE products SET stock=stock+$1,sold=GREATEST(0,sold-$1) WHERE id=$2', [i.q, i.pid]);
    }
    await notify(o.bid, `Order #${o.id} is now ${s}`, t);
    if (s === 'Cancelled') await notify(o.sid, `Order #${o.id} cancelled by buyer`, t);
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
  if (!o || o.sid !== req.user.id) throw bad('Order not found', 404);
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
  const r = await db.q('DELETE FROM products WHERE id=$1 RETURNING id', [+req.params.id || 0]);
  if (!r.length) throw bad('Product not found', 404);
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
