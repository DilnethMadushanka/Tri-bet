# Put BetDouble online with Vercel

The site runs on Vercel. The data (accounts, balances, bets) lives in a **Turso** database, because Vercel
can't keep files between requests. Both have free plans.

## Test mode (no database yet)

If you deploy without the database settings, the site still runs in **test mode**: a small orange notice says so,
and the data is kept in a temporary file on Vercel's server. It is wiped whenever Vercel restarts the server (after
a quiet spell or a new deploy), so accounts, coins and bets can disappear and you may need to register again.
Use it only to try the site. Connect the database before real players join.

## 1. Create the database (Turso)

Easiest way, from inside Vercel:

1. Open your project on vercel.com → **Storage** → **Create Database** → pick **Turso** (under Marketplace).
2. Choose the free plan and a region close to your players (for Sri Lanka: Mumbai, `bom1`, if offered, or Singapore).
3. Connect it to the project. Vercel adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for you.

Or by hand at [turso.tech](https://turso.tech):

1. Sign up, create a database, and copy its URL (starts with `libsql://`).
2. Create a token for it.
3. In Vercel: **Settings → Environment Variables**, add:

| Name | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://your-db-name-yourname.turso.io` |
| `TURSO_AUTH_TOKEN` | the token |

The tables are created automatically the first time the site runs.

## 2. Optional settings

| Name | What it does |
| --- | --- |
| `ADMIN_USERNAME` | This username becomes admin when it registers. Otherwise the first account to register is the admin. |

## 3. Deploy

- Framework preset: **Express** (Vercel finds `src/server.js`). Leave build and output settings empty.
- After adding the variables, go to **Deployments**, open the latest one, and press **Redeploy**.
- Every push to `main` on GitHub deploys again automatically.

Then open the site, register (you become admin), and open `/admin`.

## Good to know

- **No always-on server.** The crash game moves forward whenever someone has the page open. If nobody is
  playing, no rounds run, and the next visitor starts a fresh round.
- **Requests.** An open Crash page asks the server for the game state about twice a second during a flight and
  every 1–2 seconds otherwise (it stops while the tab is hidden). The free Vercel plan includes a fixed number of
  function calls each month, so with many players at once you will need a paid plan. Check usage under
  **Usage** in Vercel.
- **Region.** In Vercel **Settings → Functions**, set the function region next to the database region so each
  request is fast.
- **Coins are virtual.** Real money needs a payment provider approved for licensed online gaming in Sri Lanka,
  connected in `src/payments.js`, plus KYC and age checks.

## Run on your own computer

```
npm install
npm start        # http://localhost:3000, data in data.sqlite
```

`render.yaml` and `Dockerfile` still work for hosts with an always-on server (Render, Railway, a VPS).
