// Email through Resend (https://resend.com). Set RESEND_API_KEY (and MAIL_FROM once you verify a domain).
const enabled = () => !!process.env.RESEND_API_KEY;
async function send(to, subject, text) {
  if (!enabled()) return false;
  const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'LokalMart <onboarding@resend.dev>', to: [to], subject, text }),
  });
  if (!r.ok) throw new Error('Email provider returned ' + r.status);
  return true;
}
module.exports = { enabled, send };
