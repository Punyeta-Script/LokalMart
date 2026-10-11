// Run with: npm test
// Needs a LOCAL Postgres (the test wipes the public schema). Set TEST_DATABASE_URL, e.g.
//   postgres://postgres:postgres@localhost:5432/lokalmart_test
const url = process.env.TEST_DATABASE_URL;
if (!url || !/@(localhost|127\.0\.0\.1)/.test(url)) {
  console.error('Set TEST_DATABASE_URL to a LOCAL Postgres database (never your Supabase project): tests wipe the schema.');
  process.exit(1);
}
const http = require('http');
const assert = require('assert');

/* Fake Supabase Storage + Resend, so the real upload/email code runs without the internet. */
const seen = { uploads: [], deletes: [], mails: [], invoices: [], pings: [] };
const inv = {}, flags = { failInvoice: false };
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/invoices') {
      if (flags.failInvoice) { res.statusCode = 500; return res.end('{"message":"boom"}'); }
      const b = JSON.parse(body.toString()), id = 'inv' + (seen.invoices.length + 1);
      assert.strictEqual(req.headers.authorization, 'Basic ' + Buffer.from('xnd_test:').toString('base64'));
      seen.invoices.push(b); inv[id] = { id, external_id: b.external_id, status: 'PENDING', amount: b.amount };
      return res.end(JSON.stringify({ id, external_id: b.external_id, invoice_url: 'https://checkout.xendit.test/web/' + id }));
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/invoices/')) { const i = inv[req.url.split('/').pop()]; if (!i) { res.statusCode = 404; return res.end('{}'); } return res.end(JSON.stringify(i)); }
    if (req.method === 'POST' && req.url === '/realtime/v1/api/broadcast') { seen.pings.push(JSON.parse(body.toString()).messages[0].topic); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/emails') { seen.mails.push(JSON.parse(body.toString())); return res.end('{"id":"1"}'); }
    if (req.method === 'POST' && req.url === '/storage/v1/bucket') return res.end('{"name":"product-images"}');
    if (req.method === 'POST' && req.url.startsWith('/storage/v1/object/')) { seen.uploads.push({ url: req.url, type: req.headers['content-type'], bytes: body.length, auth: req.headers.authorization }); return res.end('{"Key":"x"}'); }
    if (req.method === 'DELETE' && req.url.startsWith('/storage/v1/object/')) { seen.deletes.push(req.url); return res.end('{}'); }
    res.statusCode = 404; res.end('{}');
  });
});

(async () => {
  await new Promise((r) => fake.listen(0, r));
  const fakeBase = `http://localhost:${fake.address().port}`;
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = 'test-secret';
  process.env.SUPABASE_URL = fakeBase;
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  process.env.AUTH_RATE_MAX = '1000';
  process.env.XENDIT_SECRET_KEY = 'xnd_test';
  process.env.XENDIT_API_URL = fakeBase;
  process.env.XENDIT_CALLBACK_TOKEN = 'cbtoken';
  process.env.APP_URL = 'https://shop.test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_API_URL = fakeBase + '/emails';
  const wp = require('web-push').generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = wp.publicKey;
  process.env.VAPID_PRIVATE_KEY = wp.privateKey;
  const db = require('./db');
  const app = require('./app');
  const push = require('./push');

  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.init();
  const srv = app.listen(0);
  const root = `http://localhost:${srv.address().port}`, base = root + '/api';
  const call = async (m, p, b, t) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const login = async (email, pw) => (await call('POST', '/login', { email, pw, bearer: true })).j.token;
  const ok = (name) => console.log('  ok -', name);
  const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

  const buyer = await login('ana@demo.ph', 'buyer123'), rosa = await login('rosa@demo.ph', 'seller123'), admin = await login('admin@lokalmart.ph', 'admin123');
  assert(buyer && rosa && admin); ok('login for buyer, seller, admin');
  assert.strictEqual((await call('POST', '/login', { email: 'ana@demo.ph', pw: 'wrong' })).s, 401); ok('wrong password rejected');

  let st = (await call('GET', '/state')).j;
  assert(st.products.length === 6 && !st.me && !st.orders.length); ok('guest sees public catalog only');
  assert(!JSON.stringify(st).includes('"pw"')); ok('no password data in state');

  const reg = await call('POST', '/register', { name: 'Test Seller', email: 'ts@x.ph', pw: 'secret1', bearer: true, seller: { store: 'Test Store', area: 'Pangotan' } });
  assert(reg.j.token); ok('register as seller');
  assert.strictEqual((await call('POST', '/products', { name: 'X', cat: 'Fruits', price: 10, stock: 5, unit: 'kg', st: 'published' }, reg.j.token)).s, 403); ok('unapproved seller cannot list products');

  const kang = st.products.find((p) => p.name === 'Kangkong');
  const bad = await call('POST', '/orders', { items: [{ pid: kang.id, q: 999 }], method: 'pickup' }, buyer);
  assert.strictEqual(bad.s, 400); ok('over-stock order rejected');
  assert.strictEqual((await call('POST', '/orders', { items: [{ pid: kang.id, q: 1 }], method: 'pickup' }, rosa)).s, 400); ok('seller cannot buy own product');

  const rice = st.products.find((p) => p.name === 'Dinorado Rice');
  const o = await call('POST', '/orders', { items: [{ pid: kang.id, q: 2 }, { pid: rice.id, q: 1 }], method: 'delivery', addr: 'Purok 1, Danac', vc: 'LOKAL50' }, buyer);
  assert.strictEqual(o.j.ids.length, 2); ok('multi-seller checkout creates one order per seller');
  const bs = (await call('GET', '/state', null, buyer)).j;
  assert.strictEqual(bs.orders.reduce((a, x) => a + x.total, 0), 50 + 1300 + 80 - 50); ok('voucher + shipping totals computed on the server');
  assert.strictEqual(bs.products.find((p) => p.id === kang.id).stock, 38); ok('stock deducted');

  const rs = (await call('GET', '/state', null, rosa)).j, ord = rs.orders[0];
  assert(rs.orders.length === 1 && rs.notes.some((n) => n.t.startsWith('New order'))); ok('seller sees only own orders + notification');
  assert.strictEqual((await call('PUT', `/orders/${ord.id}/status`, { status: 'Completed' }, rosa)).s, 403); ok('cannot skip order steps');
  assert.strictEqual((await call('PUT', `/orders/${ord.id}/status`, { status: 'Accepted' }, buyer)).s, 403); ok('buyer cannot accept own order');
  for (const s of ['Accepted', 'Preparing']) assert.strictEqual((await call('PUT', `/orders/${ord.id}/status`, { status: s }, rosa)).s, 200);
  assert.strictEqual((await call('PUT', `/orders/${ord.id}/loc`, { lat: 16.6, lng: 120.3 }, rosa)).s, 200); ok('seller shares live location');
  const pin = bs.orders.find((x) => x.id === ord.id).pin;
  assert(/^\d{4}$/.test(pin) && !rs.orders[0].pin); ok('buyer gets a delivery PIN, the seller does not');
  assert.strictEqual((await call('PUT', `/orders/${ord.id}/status`, { status: 'Ready' }, rosa)).s, 200);
  assert.strictEqual((await call('PUT', `/orders/${ord.id}/status`, { status: 'Completed', pin: pin === '0000' ? '1111' : '0000' }, rosa)).s, 403); ok('delivery cannot be completed without the right PIN');
  assert.strictEqual((await call('PUT', `/orders/${ord.id}/status`, { status: 'Completed', pin }, rosa)).s, 200);
  assert.strictEqual((await call('POST', `/orders/${ord.id}/rate`, { r: 5, t: 'Great' }, buyer)).s, 200);
  assert.strictEqual((await call('POST', `/orders/${ord.id}/rate`, { r: 5 }, buyer)).s, 403); ok('order flow, rating once only');

  const o2 = (await call('GET', '/state', null, buyer)).j.orders.find((x) => x.status === 'Pending');
  await call('PUT', `/orders/${o2.id}/status`, { status: 'Cancelled' }, buyer);
  const after = (await call('GET', '/state', null, buyer)).j;
  assert.strictEqual(after.products.find((p) => p.id === rice.id).stock, 15); ok('cancel restores stock');
  await call('POST', '/orders/hide', { id: o2.id }, buyer);
  assert((await call('GET', '/state', null, buyer)).j.orders.find((x) => x.id === o2.id).hid === 1); ok('cancelled order hidden for buyer only');

  await call('POST', '/messages', { to: 2, x: 'Hello po' }, buyer);
  assert((await call('GET', '/state', null, rosa)).j.msgs.length === 1); ok('chat message delivered');
  assert.strictEqual((await call('GET', '/state', null, admin)).j.msgs.length, 0); ok('chat is private (admin cannot read)');

  const t = await call('POST', '/tickets', { topic: 'Order problem', msg: 'Wrong item' }, buyer);
  await call('PUT', `/tickets/${t.j.id}`, { reply: 'Fixed' }, admin);
  assert.strictEqual((await call('PUT', `/tickets/${t.j.id}`, { reply: 'x' }, buyer)).s, 403);
  assert((await call('GET', '/state', null, buyer)).j.tickets[0].status === 'Resolved'); ok('support ticket flow, admin-only reply');

  const sid = (await call('GET', '/state', null, admin)).j.users.find((u) => u.name === 'Test Seller').id;
  assert.strictEqual((await call('PUT', `/admin/sellers/${sid}`, { status: 'approved' }, buyer)).s, 403); ok('admin routes blocked for normal users');
  await call('PUT', `/admin/sellers/${sid}`, { status: 'approved' }, admin);
  const np = await call('POST', '/products', { name: 'Mango', cat: 'Fruits', price: 90, stock: 10, unit: 'kg', st: 'published' }, reg.j.token);
  assert(np.j.id); ok('admin approves seller, seller can list products');
  await call('PUT', '/admin/settings', { commission: 10 }, admin);
  assert.strictEqual((await call('GET', '/state')).j.commission, 10); ok('admin settings saved');

  /* ----- PWA files ----- */
  for (const f of ['/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png']) assert.strictEqual((await fetch(root + f)).status, 200, f);
  const mf = await (await fetch(root + '/manifest.webmanifest')).json();
  assert(mf.display === 'standalone' && mf.icons.length >= 2); ok('PWA manifest, service worker and icons are served');

  /* ----- product photos in Supabase Storage ----- */
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pre = `${fakeBase}/storage/v1/object/public/product-images/p/`;
  const ph = await call('POST', '/products', { name: 'Photo Mango', cat: 'Fruits', price: 90, stock: 10, unit: 'kg', st: 'published', img: PNG }, rosa);
  assert(ph.j.id && seen.uploads.length === 1 && seen.uploads[0].type === 'image/png' && seen.uploads[0].auth === 'Bearer service-key');
  let pp = (await call('GET', '/state')).j.products.find((p) => p.id === ph.j.id);
  assert(pp.img.startsWith(pre) && pp.img.endsWith('.png')); ok('new photo goes to Supabase Storage and state returns its URL');
  assert.strictEqual((await db.one('SELECT img FROM products WHERE id=$1', [ph.j.id])).img, pp.img); ok('database keeps only the URL, not the image bytes');
  assert.strictEqual((await call('POST', '/products', { name: 'Bad', cat: 'Fruits', price: 9, stock: 1, unit: 'kg', st: 'draft', img: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, rosa)).s, 400); ok('non-image formats still rejected');
  const oldImg = pp.img;
  assert.strictEqual((await call('PUT', `/products/${ph.j.id}`, { img: PNG }, rosa)).s, 200);
  assert(await until(() => seen.deletes.length === 1) && oldImg.endsWith(seen.deletes[0].split('/product-images/')[1])); ok('replacing a photo deletes the old file');
  assert.strictEqual((await call('DELETE', `/products/${ph.j.id}`, null, rosa)).s, 200);
  assert(await until(() => seen.deletes.length === 2)); ok('deleting a product deletes its photo');
  const keep = process.env.SUPABASE_URL; delete process.env.SUPABASE_URL;
  const fb = await call('POST', '/products', { name: 'Fallback', cat: 'Fruits', price: 9, stock: 1, unit: 'kg', st: 'published', img: PNG }, rosa);
  const fp = (await call('GET', '/state')).j.products.find((p) => p.id === fb.j.id);
  const im = await fetch(root + fp.img.split('?')[0]);
  assert(fp.img.startsWith('/api/img/') && im.status === 200 && im.headers.get('content-type') === 'image/png'); ok('without Storage configured, photos still work from the database');
  process.env.SUPABASE_URL = keep;

  /* ----- push notifications ----- */
  const pk = await call('GET', '/push/key');
  assert.strictEqual(pk.j.key, wp.publicKey); ok('push public key is exposed');
  const subBody = { endpoint: 'https://push.example/abc', keys: { p256dh: 'BKey', auth: 'authkey' } };
  assert.strictEqual((await call('POST', '/push/subscribe', subBody)).s, 401);
  assert.strictEqual((await call('POST', '/push/subscribe', { ...subBody, endpoint: 'http://insecure' }, buyer)).s, 400);
  assert.strictEqual((await call('POST', '/push/subscribe', subBody, buyer)).s, 200); ok('subscribe needs login and an https endpoint');
  const sent = [];
  push.sender = async (sub, payload) => { sent.push({ sub, payload: JSON.parse(payload) }); };
  const t2 = await call('POST', '/tickets', { topic: 'Other', msg: 'Push test' }, buyer);
  await call('PUT', `/tickets/${t2.j.id}`, { reply: 'Done' }, admin);
  assert(await until(() => sent.length >= 1));
  assert(sent[0].sub.endpoint === subBody.endpoint && /Support replied/.test(sent[0].payload.body)); ok('a notification triggers a push to the user\'s devices');
  const n0 = sent.length;
  await call('POST', '/tickets', { topic: 'Other', msg: 'x' }, buyer); // notifies admins only
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(sent.length, n0); ok('other users do not receive that push');
  push.sender = async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); };
  const t3 = await call('POST', '/tickets', { topic: 'Other', msg: 'again' }, buyer);
  await call('PUT', `/tickets/${t3.j.id}`, { reply: 'ok' }, admin);
  assert(await until(async () => !(await db.one('SELECT 1 x FROM push_subs WHERE endpoint=$1', [subBody.endpoint])))); ok('expired subscriptions are removed');

  /* ----- password reset by email ----- */
  const f0 = await call('POST', '/forgot', { email: 'nobody@x.ph' });
  assert(f0.s === 200 && f0.j.email === true && seen.mails.length === 0); ok('unknown email gets the same answer and no email');
  assert.strictEqual((await call('POST', '/forgot', { email: 'ana@demo.ph' })).s, 200);
  assert.strictEqual(seen.mails.length, 1);
  const code = /(\d{6})/.exec(seen.mails[0].text)[1];
  assert(seen.mails[0].to[0] === 'ana@demo.ph'); ok('reset code emailed');
  assert.strictEqual((await db.one("SELECT code FROM resets WHERE email='ana@demo.ph'")).code.includes(code), false); ok('code is stored hashed');
  assert.strictEqual((await call('POST', '/reset', { email: 'ana@demo.ph', code: '000000' === code ? '111111' : '000000', pw: 'newpass1' })).s, 400); ok('wrong code rejected');
  assert.strictEqual((await call('POST', '/reset', { email: 'ana@demo.ph', code, pw: 'abc' })).s, 400); ok('weak new password rejected');
  assert.strictEqual((await call('POST', '/reset', { email: 'ana@demo.ph', code, pw: 'newpass1' })).s, 200);
  assert(await login('ana@demo.ph', 'newpass1')); assert(!(await login('ana@demo.ph', 'buyer123'))); ok('code resets the password');
  assert.strictEqual((await call('POST', '/reset', { email: 'ana@demo.ph', code, pw: 'again123' })).s, 400); ok('code works only once');
  await call('POST', '/forgot', { email: 'ana@demo.ph' });
  const code2 = /(\d{6})/.exec(seen.mails[1].text)[1], wrong = code2 === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await call('POST', '/reset', { email: 'ana@demo.ph', code: wrong, pw: 'hacked12' });
  assert.strictEqual((await call('POST', '/reset', { email: 'ana@demo.ph', code: code2, pw: 'hacked12' })).s, 400); ok('code locks after 5 wrong tries');
  delete process.env.RESEND_API_KEY;
  assert.strictEqual((await call('POST', '/forgot', { email: 'ana@demo.ph' })).j.email, false); ok('without email configured, the app says to contact the admin');

  /* ----- httpOnly cookie sessions ----- */
  const lr = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rosa@demo.ph', pw: 'seller123' }) });
  const sc = lr.headers.get('set-cookie');
  assert(/lm_session=/.test(sc) && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && !(await lr.json()).token); ok('login sets an httpOnly cookie and keeps the token out of the page');
  const ck = sc.split(';')[0], sellerBody = JSON.stringify({ store: "Rosa's Farm Fresh", desc: 'Fresh', area: 'Banga', open: 1 });
  assert((await (await fetch(base + '/state', { headers: { Cookie: ck } })).json()).me.id); ok('cookie authenticates reads');
  assert.strictEqual((await fetch(base + '/seller', { method: 'PUT', headers: { Cookie: ck, 'Content-Type': 'application/json' }, body: sellerBody })).status, 403); ok('cookie writes without the CSRF header are blocked');
  assert.strictEqual((await fetch(base + '/seller', { method: 'PUT', headers: { Cookie: ck, 'Content-Type': 'application/json', 'X-Requested-With': 'lokalmart' }, body: sellerBody })).status, 200); ok('cookie writes with the header work');
  assert(/Max-Age=0/.test((await fetch(base + '/logout', { method: 'POST' })).headers.get('set-cookie'))); ok('logout clears the cookie');

  /* ----- rate limit stored in the database ----- */
  process.env.AUTH_RATE_MAX = '3';
  const hit = (ip) => fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email: 'x@x.ph', pw: 'x' }) }).then((r) => r.status);
  assert.deepStrictEqual([await hit('9.9.9.9'), await hit('9.9.9.9'), await hit('9.9.9.9'), await hit('9.9.9.9')], [401, 401, 401, 429]);
  assert.strictEqual(await hit('8.8.8.8'), 401); ok('too many login attempts are blocked per IP, kept in Postgres');
  assert((await db.one("SELECT n FROM rate_hits WHERE k='auth:9.9.9.9'")).n >= 4);
  process.env.AUTH_RATE_MAX = '1000';

  /* ----- Xendit online payment ----- */
  const cb = (b, token) => fetch(base + '/xendit/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-callback-token': token } : {}) }, body: JSON.stringify(b) }).then((r) => r.status);
  const stockOf = async (id) => (await call('GET', '/state')).j.products.find((p) => p.id === id).stock;
  assert.strictEqual((await call('GET', '/config')).j.online, true);
  const s0 = await stockOf(kang.id);
  const po = await call('POST', '/orders', { items: [{ pid: kang.id, q: 1 }], method: 'delivery', addr: 'Purok 1, Danac', pay: 'online' }, buyer);
  assert(po.j.pay.url.startsWith('https://checkout.xendit.test/web/') && po.j.pay.ref);
  const ib = seen.invoices[seen.invoices.length - 1];
  assert(ib.amount === 65 && ib.currency === 'PHP' && ib.external_id === po.j.pay.ref && ib.invoice_duration === 1800 && ib.success_redirect_url.startsWith('https://shop.test/')); ok('online checkout creates a Xendit invoice for the exact total');
  const oid = po.j.ids[0];
  assert.strictEqual(await stockOf(kang.id), s0 - 1);
  let rs2 = (await call('GET', '/state', null, rosa)).j;
  assert(!rs2.orders.some((x) => x.id === oid) && !rs2.notes.some((n) => n.t.includes('#' + oid))); ok('seller does not see an online order until it is paid');
  assert.strictEqual((await call('PUT', `/orders/${oid}/status`, { status: 'Accepted' }, rosa)).s, 403); ok('seller cannot accept an unpaid online order');
  assert.strictEqual(await cb({ external_id: po.j.pay.ref, id: 'inv1', status: 'PAID' }), 401);
  assert.strictEqual(await cb({ external_id: po.j.pay.ref, id: 'inv1', status: 'PAID' }, 'wrong'), 401); ok('callback without the right token is rejected');
  assert.strictEqual(await cb({ external_id: po.j.pay.ref, id: 'inv1', status: 'PAID' }, 'cbtoken'), 200);
  assert.strictEqual((await db.one('SELECT paid FROM orders WHERE id=$1', [oid])).paid, 0); ok('a forged "PAID" callback is ignored (Xendit says pending)');
  const xid = (await db.one('SELECT xid FROM payments WHERE ref=$1', [po.j.pay.ref])).xid;
  inv[xid].status = 'PAID'; inv[xid].amount = 1;
  await cb({ external_id: po.j.pay.ref, id: xid, status: 'PAID' }, 'cbtoken');
  assert.strictEqual((await db.one('SELECT paid FROM orders WHERE id=$1', [oid])).paid, 0); ok('amount mismatch is not accepted');
  assert.strictEqual((await call('POST', `/orders/${oid}/pay`, null, buyer)).j.url, po.j.pay.url); ok('buyer can reopen the payment link');
  inv[xid].amount = 65;
  await cb({ external_id: po.j.pay.ref, id: xid, status: 'PAID' }, 'cbtoken');
  await cb({ external_id: po.j.pay.ref, id: xid, status: 'PAID' }, 'cbtoken');
  assert.strictEqual((await db.one('SELECT paid FROM orders WHERE id=$1', [oid])).paid, 1);
  rs2 = (await call('GET', '/state', null, rosa)).j;
  assert(rs2.orders.some((x) => x.id === oid) && rs2.notes.filter((n) => n.t.includes(`#${oid}`)).length === 1); ok('paid callback marks the order paid, notifies the seller once (idempotent)');
  assert.strictEqual((await call('POST', `/orders/${oid}/pay`, null, buyer)).s, 404);
  assert.strictEqual((await call('PUT', `/orders/${oid}/status`, { status: 'Accepted' }, rosa)).s, 200); ok('seller can accept after payment');
  const po2 = await call('POST', '/orders', { items: [{ pid: kang.id, q: 2 }], method: 'pickup', pay: 'online' }, buyer);
  const s1 = await stockOf(kang.id), xid2 = (await db.one('SELECT xid FROM payments WHERE ref=$1', [po2.j.pay.ref])).xid;
  inv[xid2].status = 'EXPIRED';
  await cb({ external_id: po2.j.pay.ref, id: xid2, status: 'EXPIRED' }, 'cbtoken');
  assert.strictEqual((await db.one('SELECT status FROM orders WHERE id=$1', [po2.j.ids[0]])).status, 'Cancelled');
  assert.strictEqual(await stockOf(kang.id), s1 + 2); ok('expired payment cancels the order and restores stock');
  flags.failInvoice = true; const s2 = await stockOf(kang.id);
  assert.strictEqual((await call('POST', '/orders', { items: [{ pid: kang.id, q: 1 }], method: 'pickup', pay: 'online' }, buyer)).s, 502);
  flags.failInvoice = false;
  assert.strictEqual(await stockOf(kang.id), s2); ok('if Xendit is down the order is cancelled and stock restored');
  const po3 = await call('POST', '/orders', { items: [{ pid: kang.id, q: 1 }], method: 'pickup', pay: 'online' }, buyer), oid3 = po3.j.ids[0];
  const xid3 = (await db.one('SELECT xid FROM payments WHERE ref=$1', [po3.j.pay.ref])).xid;
  inv[xid3].status = 'PAID';
  await cb({ external_id: po3.j.pay.ref, id: xid3, status: 'PAID' }, 'cbtoken');
  assert.strictEqual((await call('PUT', `/orders/${oid3}/status`, { status: 'Rejected' }, rosa)).s, 200);
  assert((await call('GET', '/state', null, admin)).j.notes.some((n) => n.t.startsWith('Refund needed: order #' + oid3))); ok('rejecting a paid online order alerts the admin to refund');

  /* ----- rider role ----- */
  const rr = await call('POST', '/register', { name: 'Rider Rey', email: 'rey@x.ph', pw: 'rider123', bearer: true });
  const riderId = (await call('GET', '/state', null, admin)).j.users.find((u) => u.name === 'Rider Rey').id;
  assert.strictEqual((await call('PUT', `/admin/users/${riderId}`, { role: 'rider' }, buyer)).s, 403);
  assert.strictEqual((await call('PUT', `/admin/users/${riderId}`, { role: 'admin' }, admin)).s, 400);
  assert.strictEqual((await call('PUT', `/admin/users/${riderId}`, { role: 'rider' }, admin)).s, 200); ok('only admins can make a rider');
  const mg = await call('POST', '/orders', { items: [{ pid: np.j.id, q: 1 }], method: 'delivery', addr: 'Purok 2, Pangotan' }, buyer);
  const mid = mg.j.ids[0], seller2 = reg.j.token;
  assert.strictEqual((await call('PUT', `/orders/${mid}/rider`, { rid: riderId }, seller2)).s, 403); ok('no rider before the seller accepts');
  await call('PUT', `/orders/${mid}/status`, { status: 'Accepted' }, seller2);
  assert.strictEqual((await call('PUT', `/orders/${mid}/rider`, { rid: riderId }, buyer)).s, 404);
  assert.strictEqual((await call('PUT', `/orders/${mid}/rider`, { rid: 1 }, seller2)).s, 404); ok('only the seller can assign, and only a real rider');
  assert.strictEqual((await call('PUT', `/orders/${mid}/rider`, { rid: riderId }, seller2)).s, 200);
  const rider = rr.j.token, rst = (await call('GET', '/state', null, rider)).j;
  assert(rst.orders.length === 1 && rst.orders[0].id === mid && !rst.orders[0].pin && rst.users.some((u) => u.name === 'Ana Reyes')); ok('rider sees only the assigned order, without the PIN');
  assert((await call('GET', '/state', null, seller2)).j.users.some((u) => u.id === riderId && u.role === 'rider')); ok('sellers can see the list of riders');
  assert.strictEqual((await call('PUT', `/orders/${mid}/status`, { status: 'Completed' }, rider)).s, 403);
  await call('PUT', `/orders/${mid}/status`, { status: 'Preparing' }, seller2);
  assert.strictEqual((await call('PUT', `/orders/${mid}/loc`, { lat: 16.7, lng: 120.4 }, rider)).s, 200); ok('rider shares live location');
  await call('PUT', `/orders/${mid}/status`, { status: 'Ready' }, seller2);
  const mpin = (await call('GET', '/state', null, buyer)).j.orders.find((x) => x.id === mid).pin;
  assert.strictEqual((await call('PUT', `/orders/${mid}/status`, { status: 'Completed', pin: mpin === '1234' ? '4321' : '1234' }, rider)).s, 403);
  assert.strictEqual((await call('PUT', `/orders/${mid}/status`, { status: 'Completed', pin: mpin }, rider)).s, 200);
  assert.strictEqual((await db.one('SELECT status,paid FROM orders WHERE id=$1', [mid])).status, 'Completed'); ok('rider completes the delivery with the buyer PIN');

  /* ----- realtime pings ----- */
  const rt = await call('GET', '/rt', null, rosa);
  assert(/^u-2-[0-9a-f]{16}$/.test(rt.j.topic) && rt.j.key === 'anon-key'); assert.strictEqual((await call('GET', '/rt')).s, 401);
  seen.pings.length = 0;
  await call('POST', '/messages', { to: 2, x: 'ping me' }, buyer);
  assert(await until(() => seen.pings.includes(rt.j.topic))); ok('a chat message pings the recipient\'s private realtime channel');

  srv.close(); fake.close();
  await db.pool.end();
  console.log('\nAll API tests passed.');
  process.exit(0);
})().catch((e) => { console.error('\nTEST FAILED:', e.stack || e.message); process.exit(1); });
