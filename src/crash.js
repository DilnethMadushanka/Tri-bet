// The crash game, built to run without an always-on server (e.g. on Vercel).
//
// Every round runs on a timetable stored in the database:
//   created_at ........ betting opens
//   betting_ends_at ... bets close and the multiplier starts climbing from 1.00x
//   crash_at .......... the multiplier crashes (worked out from the secret crash point)
//   crash_at + pause .. the next round opens
// Nothing needs a timer. Whenever anyone loads the game, the server looks at the clock: it settles
// a round that has crashed, pays auto cash-outs that are due, and opens the next round when it's time.
// If nobody is playing, no rounds happen.
//
// Provably fair: the crash point comes from a random secret seed. sha256(seed) (the "hash") is shown
// before anyone bets, and the seed is revealed after the crash. See crashPointFromSeed().
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const settings = require('./settings');
const game = require('./game');
const { GameError, round2 } = game;

// Multiplier growth: m(t) = e^(GROWTH * ms). 2.00x after ~11.6 s, 10x after ~38 s.
const GROWTH = 0.00006;
const multAt = (elapsedMs) => Math.floor(100 * Math.exp(GROWTH * Math.max(0, elapsedMs)) + 1e-9) / 100;
const msToReach = (m) => Math.log(m) / GROWTH;

// With a house edge of E%, the chance the round reaches multiplier m is (100 - E) / (100 m),
// so cashing out at any target returns (100 - E)% of bets on average.
function crashPointFromSeed(seed, edgePct, maxMultiplier = Infinity) {
  const h = crypto.createHmac('sha256', seed).update('betdouble').digest('hex');
  const x = parseInt(h.slice(0, 13), 16) / 2 ** 52; // uniform in [0, 1)
  const cp = Math.floor((100 - edgePct) / (1 - x)) / 100;
  return Math.min(Math.max(1, cp), maxMultiplier);
}
const hashSeed = (seed) => crypto.createHash('sha256').update(seed).digest('hex');

const phase = (r, now) => (now < r.betting_ends_at ? 'betting' : now < r.crash_at ? 'running' : 'crashed');
const capFor = (amount) => Math.floor((settings.get('maxWin') / amount) * 100 + 1e-9) / 100; // multiplier where the max win is reached
// The multiplier a bet cashes out at automatically (auto cash-out or the max-win cap), if any.
const autoTarget = (b) => Math.min(b.auto_cashout || Infinity, capFor(b.amount));

// ---------- rounds ----------
const latest = () => db.get('SELECT * FROM rounds ORDER BY id DESC LIMIT 1');

async function openRound(prev, now) {
  const s = settings.all();
  // Keep the timetable smooth while people are playing; start fresh after a quiet spell.
  const due = prev ? prev.crash_at + s.pauseSeconds * 1000 : now;
  const start = now - due < s.bettingSeconds * 1000 ? Math.max(due, now - 1000) : now;
  const seed = crypto.randomBytes(32).toString('hex');
  const cp = crashPointFromSeed(seed, s.houseEdgePct, s.maxMultiplier);
  const bettingEnds = start + s.bettingSeconds * 1000;
  await db.run(`INSERT OR IGNORE INTO rounds (id, hash, seed, crash_point, edge_pct, created_at, betting_ends_at, started_at, crash_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, (prev ? prev.id : 0) + 1, hashSeed(seed), seed, cp, s.houseEdgePct, start, bettingEnds, bettingEnds, Math.ceil(bettingEnds + msToReach(cp)));
  return latest(); // if another server opened it first, we get theirs
}

// Settles a crashed round once: pays auto cash-outs that were due, marks the rest lost, pays referrals.
async function settle(r, now) {
  await tx(async () => {
    const ok = await db.run("UPDATE rounds SET status = 'crashed', ended_at = ? WHERE id = ? AND status = 'open'", r.crash_at, r.id);
    if (!ok.changes) return; // already settled
    for (const b of await db.all("SELECT * FROM bets WHERE round_id = ? AND status = 'active'", r.id)) {
      const t = autoTarget(b);
      if (t <= r.crash_point) await payWin(b, t, r, now, t === b.auto_cashout ? 'auto' : 'max');
      else await db.run("UPDATE bets SET status = 'lost' WHERE id = ? AND status = 'active'", b.id);
    }
    const played = await db.all("SELECT b.amount, b.payout, b.user_id FROM bets b WHERE b.round_id = ? AND b.status IN ('won', 'lost')", r.id);
    for (const b of played) await game.payReferral({ amount: b.amount, round_id: r.id }, await game.getUser(b.user_id), now);
    await db.run('UPDATE rounds SET total_bet = ?, total_paid = ?, players = ? WHERE id = ?',
      played.reduce((a, b) => a + b.amount, 0), played.reduce((a, b) => a + b.payout, 0), played.length, r.id);
  });
}

// Pays a winning bet exactly once (safe if two servers try at the same moment).
async function payWin(b, m, r, now, how) {
  const payout = Math.min(round2(b.amount * m), settings.get('maxWin'));
  const ok = await db.run("UPDATE bets SET status = 'won', cashout_at = ?, payout = ? WHERE id = ? AND status = 'active'", m, payout, b.id);
  if (!ok.changes) return null;
  await game.credit(b.user_id, payout, 'win', `Cashed out at ${m.toFixed(2)}x on round #${r.id}${how === 'auto' ? ' (auto)' : how === 'max' ? ' (max win)' : ''}`, now, { roundId: r.id });
  return { multiplier: m, payout };
}

// During the flight: pay auto cash-outs whose target has been passed.
async function payDueAutos(r, now) {
  const m = Math.min(multAt(now - r.betting_ends_at), r.crash_point);
  const due = (await db.all("SELECT * FROM bets WHERE round_id = ? AND status = 'active'", r.id)).filter((b) => autoTarget(b) <= m);
  if (!due.length) return;
  await tx(async () => { for (const b of due) await payWin(b, autoTarget(b), r, now, autoTarget(b) === b.auto_cashout ? 'auto' : 'max'); });
}

// Brings the game up to date and returns the current round.
async function current(now = Date.now()) {
  let r = await latest();
  if (r && r.status === 'open' && now >= r.crash_at) { await settle(r, now); r = await latest(); }
  if (!r || now >= r.crash_at + settings.get('pauseSeconds') * 1000) {
    if (!settings.get('gamePaused')) r = await openRound(r, now);
  }
  if (r && phase(r, now) === 'running') await payDueAutos(r, now);
  return r;
}

// ---------- player actions ----------
// Bets go into the round that is taking bets. While a round is flying (or just crashed), a bet goes
// into the NEXT round instead: it is locked in now and plays as soon as that round starts.
async function placeBet(userId, amount, autoCashout, now = Date.now()) {
  const r = await current(now);
  if (!r) throw new GameError('The game is paused. Try again soon');
  const p = phase(r, now);
  if (p !== 'betting' && settings.get('gamePaused')) throw new GameError('The game is paused. Try again soon');
  const roundId = p === 'betting' ? r.id : r.id + 1;
  const s = settings.all();
  amount = round2(Number(amount));
  if (!Number.isFinite(amount) || amount < s.minBet || amount > s.maxBet) throw new GameError(`Bet must be between ${s.minBet} and ${s.maxBet}`);
  let auto = null;
  if (autoCashout !== undefined && autoCashout !== null && autoCashout !== '' && Number(autoCashout) !== 0) {
    auto = Math.round(Number(autoCashout) * 100) / 100;
    if (!Number.isFinite(auto) || auto < 1.01 || auto > s.maxMultiplier) throw new GameError(`Auto cash-out must be between 1.01x and ${s.maxMultiplier}x`);
  }
  return tx(async () => {
    const u = await game.getUser(userId);
    if (!u || u.is_banned) throw new GameError('This account is blocked');
    if (await db.get("SELECT 1 AS x FROM bets WHERE round_id = ? AND user_id = ? AND status != 'refunded'", roundId, userId)) {
      throw new GameError(roundId === r.id ? 'You already have a bet in this round' : 'You already have a bet on the next round');
    }
    await game.checkCanBet(u, amount, now);
    if (u.balance < amount - 1e-9) throw new GameError('Not enough balance');
    await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', amount, userId);
    await game.addLedger(userId, 'bet', -amount, `Bet on round #${roundId}${auto ? ` (auto cash-out ${auto.toFixed(2)}x)` : ''}`, now, { roundId });
    const ins = await db.run('INSERT INTO bets (round_id, user_id, amount, auto_cashout, created_at) VALUES (?, ?, ?, ?, ?)', roundId, userId, amount, auto, now);
    return { betId: ins.lastId, roundId, nextRound: roundId !== r.id };
  });
}

// Cancels a bet whose round hasn't started: the one in the betting round, or one locked in for the next round.
async function cancelBet(userId, now = Date.now()) {
  const r = await current(now);
  return tx(async () => {
    if (!r) throw new GameError('No bet to cancel');
    const p = phase(r, now);
    const roundId = p === 'betting' ? r.id : r.id + 1;
    const b = await db.get("SELECT * FROM bets WHERE round_id = ? AND user_id = ? AND status = 'active'", roundId, userId);
    if (!b) {
      const flying = await db.get("SELECT 1 AS x FROM bets WHERE round_id = ? AND user_id = ? AND status = 'active'", r.id, userId);
      throw new GameError(flying ? 'The round has started. Cash out instead' : 'No bet to cancel');
    }
    await db.run("UPDATE bets SET status = 'refunded' WHERE id = ?", b.id);
    await game.credit(userId, b.amount, 'bet_refund', `Bet on round #${roundId} cancelled`, now, { roundId });
  });
}

async function cashout(userId, now = Date.now()) {
  const r = await current(now);
  const b = r && await db.get("SELECT * FROM bets WHERE round_id = ? AND user_id = ? AND status != 'refunded'", r.id, userId);
  if (!b) throw new GameError('You have no bet in this round');
  if (b.status === 'won') throw new GameError('Already cashed out');
  if (b.status !== 'active') throw new GameError(b.status === 'lost' ? 'Too late, it crashed' : 'This bet is over');
  const p = phase(r, now);
  if (p === 'betting') throw new GameError('The round has not started yet');
  if (p === 'crashed') { await settle(r, now); throw new GameError('Too late, it crashed'); }
  const m = Math.min(multAt(now - r.betting_ends_at), r.crash_point, autoTarget(b));
  const res = await tx(() => payWin(b, m, r, now, 'manual'));
  if (!res) throw new GameError('Already cashed out');
  return res;
}

// ---------- views ----------
async function publicState(now = Date.now()) {
  const r = await current(now);
  const s = settings.all();
  const history = (await db.all('SELECT id, crash_point FROM rounds WHERE crash_at <= ? ORDER BY id DESC LIMIT 25', now))
    .map((h) => ({ id: h.id, crashPoint: h.crash_point }));
  if (!r) return { serverNow: now, growth: GROWTH, paused: !!s.gamePaused, round: null, players: [], playerCount: 0, totalBet: 0, history, bettingSeconds: s.bettingSeconds };
  const p = phase(r, now);
  const players = await db.all(`SELECT u.username, b.amount, b.status, b.cashout_at AS cashoutAt, b.payout FROM bets b JOIN users u ON u.id = b.user_id
    WHERE b.round_id = ? AND b.status != 'refunded' ORDER BY b.payout DESC, b.amount DESC LIMIT 100`, r.id);
  const tot = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM bets WHERE round_id = ? AND status != 'refunded'", r.id);
  return {
    serverNow: now,
    growth: GROWTH,
    paused: !!s.gamePaused,
    bettingSeconds: s.bettingSeconds,
    round: {
      id: r.id, hash: r.hash, status: p, bettingEndsAt: r.betting_ends_at, startedAt: r.betting_ends_at,
      nextAt: p === 'crashed' ? r.crash_at + s.pauseSeconds * 1000 : null,
      crashPoint: p === 'crashed' ? r.crash_point : null,
      seed: p === 'crashed' ? r.seed : null,
      multiplier: p === 'running' ? Math.min(multAt(now - r.betting_ends_at), r.crash_point) : p === 'crashed' ? r.crash_point : 1,
    },
    players: players.map((x) => (p === 'crashed' || x.status !== 'lost' ? x : { ...x, status: 'active' })),
    playerCount: tot.n,
    totalBet: round2(tot.s),
    history: p === 'crashed' ? history : history.filter((h) => h.id !== r.id),
  };
}

const betView = (b) => (b ? { roundId: b.round_id, amount: b.amount, autoCashout: b.auto_cashout, status: b.status, cashoutAt: b.cashout_at, payout: b.payout } : null);
const betIn = (roundId, userId) => db.get("SELECT amount, auto_cashout, status, cashout_at, payout, round_id FROM bets WHERE round_id = ? AND user_id = ? AND status != 'refunded'", roundId, userId);

// My bet in the latest round.
async function myBet(userId) {
  const r = await latest();
  return r ? betView(await betIn(r.id, userId)) : null;
}
// My bet locked in for the round after the latest one (placed while it was flying).
async function nextBet(userId) {
  const r = await latest();
  return r ? betView(await betIn(r.id + 1, userId)) : null;
}

module.exports = { current, placeBet, cancelBet, cashout, publicState, myBet, nextBet, settle, crashPointFromSeed, hashSeed, multAt, msToReach, GROWTH, phase };
