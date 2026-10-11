// Xendit Invoice API (GCash, Maya, cards). https://developers.xendit.co
const crypto = require('crypto');
const base = () => process.env.XENDIT_API_URL || 'https://api.xendit.co';
const enabled = () => !!process.env.XENDIT_SECRET_KEY;
const auth = () => 'Basic ' + Buffer.from(process.env.XENDIT_SECRET_KEY + ':').toString('base64');

async function createInvoice({ ref, amount, description, successUrl, failureUrl, minutes = 30 }) {
  const body = { external_id: ref, amount, currency: 'PHP', description, invoice_duration: minutes * 60, success_redirect_url: successUrl, failure_redirect_url: failureUrl };
  const methods = (process.env.XENDIT_METHODS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (methods.length) body.payment_methods = methods; // e.g. GCASH,PAYMAYA,CREDIT_CARD (empty = everything enabled in your dashboard)
  const r = await fetch(base() + '/v2/invoices', { method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.invoice_url) throw new Error('Xendit invoice failed: ' + r.status + ' ' + (j.message || ''));
  return { id: j.id, url: j.invoice_url };
}
/** Ask Xendit for the real invoice, so a forged callback can never mark an order paid. */
async function getInvoice(id) {
  const r = await fetch(base() + '/v2/invoices/' + encodeURIComponent(id), { headers: { Authorization: auth() } });
  if (!r.ok) throw new Error('Xendit lookup failed: ' + r.status);
  return r.json();
}
function tokenOk(given) {
  const want = process.env.XENDIT_CALLBACK_TOKEN || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { enabled, createInvoice, getInvoice, tokenOk };
