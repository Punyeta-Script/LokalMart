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
api/index.js        Vercel serverless entry
server/app.js       REST API (Express)
server/db.js        Postgres connection, schema, seed
server/index.js     local dev server
server/test.js      integration tests
supabase/schema.sql schema to paste in the Supabase SQL editor (optional)
vercel.json         routes /api/* to the function
```

## Known limitations / next steps
- No email or SMS yet: an admin resets passwords (Admin, Users, Reset password).
- No online payment gateway: COD and cash on pickup only.
- Updates (chat, orders, notifications) arrive by polling every ~10 seconds, not websockets. Supabase Realtime could replace this later.
- Login rate limiting is in-memory per serverless instance, so it is a basic safeguard only.
- Google Maps is used through links (route, rider location); an embedded map needs your own Maps API key.
- Product photos are stored in the database (small, compressed). For many photos, move them to Supabase Storage.
- The session token is kept in `localStorage`; always use HTTPS (Vercel does) and keep dependencies updated.
- Terms and Privacy text in Settings is a template: have it reviewed before launch.
