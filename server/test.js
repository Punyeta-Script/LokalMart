// Run with: npm test
// Needs a LOCAL Postgres (the test wipes the public schema). Set TEST_DATABASE_URL, e.g.
//   postgres://postgres:postgres@localhost:5432/lokalmart_test
const url = process.env.TEST_DATABASE_URL;
if (!url || !/@(localhost|127\.0\.0\.1)/.test(url)) {
  console.error('Set TEST_DATABASE_URL to a LOCAL Postgres database (never your Supabase project): tests wipe the schema.');
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = 'test-secret';
const assert = require('assert');
const db = require('./db');
const app = require('./app');

(async () => {
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.init();
  const srv = app.listen(0);
  const base = `http://localhost:${srv.address().port}/api`;
  const call = async (m, p, b, t) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const login = async (email, pw) => (await call('POST', '/login', { email, pw })).j.token;
  const ok = (name) => console.log('  ok -', name);

  const buyer = await login('ana@demo.ph', 'buyer123'), rosa = await login('rosa@demo.ph', 'seller123'), admin = await login('admin@lokalmart.ph', 'admin123');
  assert(buyer && rosa && admin); ok('login for buyer, seller, admin');
  assert.strictEqual((await call('POST', '/login', { email: 'ana@demo.ph', pw: 'wrong' })).s, 401); ok('wrong password rejected');

  let st = (await call('GET', '/state')).j;
  assert(st.products.length === 6 && !st.me && !st.orders.length); ok('guest sees public catalog only');
  assert(!JSON.stringify(st).includes('"pw"')); ok('no password data in state');

  const reg = await call('POST', '/register', { name: 'Test Seller', email: 'ts@x.ph', pw: 'secret1', seller: { store: 'Test Store', area: 'Pangotan' } });
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
  for (const s of ['Ready', 'Completed']) assert.strictEqual((await call('PUT', `/orders/${ord.id}/status`, { status: s }, rosa)).s, 200);
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

  srv.close();
  await db.pool.end();
  console.log('\nAll API tests passed.');
  process.exit(0);
})().catch((e) => { console.error('\nTEST FAILED:', e.message); process.exit(1); });
