# BetDouble (virtual coins)

Five games on one balance: Crash, Dice, Mines, Plinko and Coin Flip. All have the same house edge (default 3%) and are provably fair.

## Crash

A multiplayer game. Each round:

1. **Betting** (7 s): players place a bet, optionally with an auto cash-out (for example 2.00x). A bet placed while
   the previous round is still flying is locked in for the next round (it can be cancelled until that round starts).
2. **Flying**: the multiplier climbs from 1.00x. Players press **Cash out** to win bet × multiplier.
3. **Crash**: at a secret point fixed before the round, it crashes. Bets not cashed out are lost.

There is no game loop running on the server. Each round's times (betting ends, crash) are saved in the database
when the round opens, and every request works out where the game is from the clock: it settles a round that has
crashed, pays auto cash-outs that are due, and opens the next round. Pages ask for the state about twice a second
during a flight and less often otherwise. That is what lets it run on Vercel.

The house edge is set in Admin → Settings (default 3%). Players get back 97% of all bets on average.

## Instant games

- **Dice**: roll 0.00–99.99. Pick under/over and a target (1–95% win chance). Pays 97 ÷ chance.
- **Mines**: 5×5 grid with 1–24 mines. Each gem raises the multiplier. Cash out any time; a mine loses the bet.
- **Plinko**: 12 rows with low, medium or high risk. The slot tables are scaled to pay back 97%.
- **Coin Flip**: heads or tails, pays 1.94x.

Each player has a seed pair: a server seed (secret, its hash is shown), a client seed (theirs to change) and a nonce (counts bets).
Result numbers are `HMAC_SHA256(server seed, "clientSeed:nonce:cursor")`, read 4 bytes at a time as floats in [0, 1).
Changing the seed reveals the old server seed, and the Provably fair page re-checks any bet. See `src/instant.js`.

## Run

```
npm install
npm start            # http://localhost:3000
npm test             # 20 tests: fairness maths, payback of every game, the round timetable, cash-outs, limits, referrals
```

Locally the data is kept in `data.sqlite` (change with `DB_PATH`). In production set `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` to use a hosted Turso database. To put it online, see [DEPLOY.md](DEPLOY.md) (Vercel).

The first account that registers becomes the admin. Or run `ADMIN_USERNAME=name npm start`, or `npm run make-admin -- name`.

## Pages

- `/register`, `/login`: sign-up has an 18+ check and an optional invite code.
- `/`: the game (Play), Provably fair, Invite friends, Wallet (deposits, withdrawals, responsible play).
- `/admin`: live round, house profit, payout check, users, rounds and bets, withdrawals, settings, and a pause switch.

## Provably fair

Before each round the server picks a random seed and shows `sha256(seed)`. After the crash it reveals the seed.

```
h = HMAC_SHA256(key = seed, "betdouble")
x = int(first 13 hex chars of h) / 2^52
crash = max(1, floor((100 - edge) / (1 - x)) / 100)
```

The Provably fair page checks any round in the browser.

## Money

Coins are **virtual**. "Add coins" gives free demo coins, and withdrawals are only marked approved by an admin. Real money must go through a payment provider approved for licensed online gaming in Sri Lanka. Connect it in `src/payments.js`, and add KYC and age checks.

## Files

- `src/crash.js`: crash engine (rounds, bets, cash-outs, fairness).
- `src/instant.js`: Dice, Mines, Plinko, Coin Flip and player seeds.
- `src/game.js`: accounts, referrals, limits, ledger.
- `src/payments.js`: payment stub.
- `src/admin.js`: admin API.
- `src/settings.js`: admin-editable settings.
- `src/db.js`: database (Turso / libSQL, or a local file).
- `src/server.js`: routes. Exports the Express app for Vercel; `npm start` runs it locally.
- `public/`: front end (`app.js` for crash and account pages, `games.js` for the instant games).
