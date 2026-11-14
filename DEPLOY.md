# Putting BetDouble online

BetDouble needs a server that **stays on** (Crash rounds run all the time) and a **disk** (the database is one SQLite file).
That's why it runs on Render or Railway, not Vercel: Vercel stops the server between requests and wipes files.

First put the code on GitHub: unzip `betdouble.tar.gz`, create a new GitHub repository, and upload the `betdouble` folder.

## Option A: Render (about $7/month)

1. Sign in at render.com with GitHub.
2. Click **New → Blueprint** and pick your BetDouble repository. Render reads `render.yaml`.
3. When asked, type your admin username for `ADMIN_USERNAME` (e.g. `dilneth`), then **Apply**.
4. Wait for "Live". Open the `https://betdouble-xxxx.onrender.com` link and register with that username. You are the admin.

## Option B: Railway (about $5/month)

1. Sign in at railway.app with GitHub, click **New Project → Deploy from GitHub repo** and pick the repository. Railway uses the `Dockerfile`.
2. In the service, open **Settings → Volumes → Add volume**, mount path `/data`.
3. In **Variables**, add `ADMIN_USERNAME` = your username.
4. In **Settings → Networking**, click **Generate domain**. Open it and register with that username.

## Your own domain (e.g. betdouble.lk)

Both have **Settings → Custom domain**. Add the domain there, then add the DNS record they show you at your domain seller. HTTPS is automatic.

## Settings you can set (environment variables)

| Name | What it does |
|---|---|
| `ADMIN_USERNAME` | This username becomes admin when it registers. |
| `DB_PATH` | Where the database file lives. Must be on the disk/volume. |
| `DEMO_DEPOSITS` | `false` hides the free "Add coins" button. |

## Backups

All data is in the one file at `DB_PATH`. Download a copy from the disk regularly (Render: Shell tab; Railway: volume backups).

## Before real money

Coins are virtual. Before taking real money: connect a payment provider approved for licensed online gaming in Sri Lanka (`src/payments.js`), add ID and age checks (KYC), and set `DEMO_DEPOSITS=false`.
