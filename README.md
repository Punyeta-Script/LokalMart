# LokalMart

Mobile-friendly **multi-vendor marketplace** for local sellers (barangays: Balbalayang (Pob.), Banga, Caoayan, Danac, Licungan, Pangotan).

| Layer | Tech |
|---|---|
| Code hosting | **GitHub** |
| Frontend + API hosting | **Vercel** (static `public/` + one serverless function `api/index.js`) |
| Database | **Supabase** (Postgres) |
| Backend | Node.js + Express (`server/app.js`) |
| Frontend | Plain HTML / CSS / JavaScript single-page app (`public/index.html`), no build step |
| Security | bcrypt password hashing, JWT sessions, server-side validation, Helmet headers, role-based access, parameterized SQL, Row Level Security on every table |

## Installable app (PWA) and notifications
LokalMart can be installed on a phone (Settings, App, Install; or the browser's "Add to Home screen") and works as an app shell offline. With the `VAPID_*` variables set, users can turn on push notifications in Settings (on iPhone, install to the Home screen first). Password reset uses a 6-digit emailed code (valid 15 minutes, 5 tries); without `RESEND_API_KEY` the app falls back to "contact the admin".

## Online payment (Xendit)
Buyers choose **GCash / Maya / Card** at checkout and are sent to a Xendit payment page. Stock is reserved for 30 minutes. The order only reaches the seller after Xendit confirms payment: the server re-checks every callback with Xendit (token, status and amount), so a forged callback cannot mark an order paid. Unpaid invoices expire and the order is cancelled automatically with stock returned. If a paid order is rejected or cancelled, admins get a **Refund needed** notification (refunds are done by hand in the Xendit dashboard).

## Riders and delivery proof
Admin, Users, **Make rider** turns an account into a rider. Sellers assign a rider on accepted delivery orders. The rider sees only assigned deliveries, shares live location (shown on an OpenStreetMap map to the buyer) and finishes the delivery by entering the buyer's 4-digit PIN (shown only to the buyer).

## Features
**Buyer:** browse, search and filter (category, price, barangay); multi-seller cart; checkout (delivery or pickup, COD / cash on pickup), schedule and vouchers; order tracking with Google Maps links and rider live location; ratings and reviews; favorites, followed stores, saved addresses; chat with sellers; clickable notifications; support tickets.
**Seller:** apply and get verified; store settings; products with photos, stock and drafts; order workflow; live location sharing; sales dashboard, commission, CSV report; chat with buyers.
**Admin:** dashboard, seller approval, product moderation, user suspend / password reset, support tickets, commission and map settings, audit log.

## Deploy: GitHub + Supabase + Vercel

### 1. Supabase (database)
1. supabase.com, **New project**. Save the **database password** you set. Pick the region closest to you.
2. When the project is ready, click **Connect** (top of the project page), choose **Transaction pooler** (port 6543) and copy the URI. It looks like
   `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-xxxx.pooler.supabase.com:6543/postgres`
   Replace `[YOUR-PASSWORD]` with your database password. This is your `DATABASE_URL`.
   (Use the pooler, not the "Direct connection": direct is IPv6 only and Vercel needs IPv4. Serverless functions should use transaction mode.)
3. Nothing else to do: the tables are created automatically on the first request. If you prefer, run `supabase/schema.sql` once in **SQL Editor**.

### 2. GitHub (code)
```bash
git init
git add .
git commit -m "LokalMart"
git branch -M main
git remote add origin https://github.com/<your-username>/lokalmart.git
git push -u origin main
```

### 3. Vercel (hosting)
1. vercel.com, **Add New, Project**, import the GitHub repo.
2. Framework Preset: **Other**. Leave Build Command and Output Directory empty.
3. **Environment Variables** (all environments):

| Name | Value |
|---|---|
| `DATABASE_URL` | the Supabase transaction pooler URI from step 1 |
| `JWT_SECRET` | long random text: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` | your admin login email |
| `ADMIN_PASSWORD` | a strong password |
| `SEED_DEMO` | `false` (or `true` for demo sellers, products and a buyer) |
| `RESEND_API_KEY`, `MAIL_FROM` | optional: email for password reset codes ([resend.com](https://resend.com)) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET` | optional: product photos in Supabase Storage (the public bucket is created automatically). Existing photos: `npm run migrate:images` |
| `XENDIT_SECRET_KEY`, `XENDIT_CALLBACK_TOKEN`, `XENDIT_METHODS`, `APP_URL` | optional: online payment (GCash, Maya, cards) with Xendit invoices. In the Xendit dashboard (Settings, Callbacks) set the *Invoices paid* and *Invoices expired* URLs to `https://<your-app>.vercel.app/api/xendit/callback` and copy the callback verification token |
| `SUPABASE_ANON_KEY` | optional: realtime updates (needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` too) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional: push notifications. Generate with `npm run vapid` |

4. **Deploy**. Open the URL. The first request creates the tables and the admin account (takes a few seconds). Check `https://<your-app>.vercel.app/api/health` returns `{"ok":true}`.
5. Log in as admin, then **Admin, Settings, Map search area** to set your town / province for Google Maps.

Every `git push` to `main` redeploys automatically.

## Run locally
```bash
npm install
```
Set the variables, then start (Windows PowerShell):
```powershell
$env:DATABASE_URL="postgresql://...your Supabase pooler URI..."
$env:JWT_SECRET="any-long-random-text"
npm start
```
macOS / Linux: `export DATABASE_URL=...` and `export JWT_SECRET=...`. Open http://localhost:3000.
Demo logins (only when `SEED_DEMO` is not `false`): admin@lokalmart.ph / admin123, rosa@demo.ph / seller123 (seller), ana@demo.ph / buyer123 (buyer). Change `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first run to use your own admin.

## Tests
`npm test` runs API integration tests. It **wipes the public schema**, so it only accepts a *local* Postgres:
```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/lokalmart_test npm test
```
GitHub Actions runs the same tests on every push (`.github/workflows/ci.yml`).

## Project structure
```
public/index.html   frontend (UI + API client)
public/sw.js        service worker (offline shell, push)
public/manifest.webmanifest, public/icons/   PWA files
api/index.js        Vercel serverless entry
server/app.js       REST API (Express)
server/db.js        Postgres connection, schema, seed
server/mail.js, storage.js, push.js, xendit.js, realtime.js   email, Supabase Storage, web push, Xendit, realtime pings
public/vendor/leaflet   self-hosted Leaflet (embedded map)
scripts/migrate-images.js   move old photos to Storage
server/index.js     local dev server
server/test.js      integration tests
supabase/schema.sql schema to paste in the Supabase SQL editor (optional)
vercel.json         routes /api/* to the function
```

## Known limitations / next steps
- Email only (no SMS yet): users who signed up with a mobile number still ask an admin to reset the password (Admin, Users, Reset password).
- Refunds for online payments are manual (Xendit dashboard).
- Realtime: with `SUPABASE_ANON_KEY` set, the app listens to a private Supabase Realtime channel and refetches instantly; otherwise (or if the socket drops) it polls every ~10 seconds. `/api/state` returns the latest 150 orders (300 for admin), 400 messages and 100 tickets; the full catalog is still sent in one response.
- Login, register and reset attempts are rate limited per IP in Postgres (30 per 15 minutes, `AUTH_RATE_MAX`).
- The tracking map is OpenStreetMap through Leaflet (no API key); route links still open Google Maps. Public OSM tile servers are for light use: switch to a tile provider if traffic grows.
- Sessions use an httpOnly, SameSite=Lax cookie plus a required `X-Requested-With` header on writes (CSRF). Tokens last 30 days and cannot be revoked individually yet.
- Terms and Privacy text in Settings is a template: have it reviewed before launch.
