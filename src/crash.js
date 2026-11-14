// The crash game.
//
// Every round:
//   1. BETTING: players place a bet (and optionally an auto cash-out).
//   2. RUNNING: a multiplier starts at 1.00x and grows. Players cash out any time to win bet x multiplier.
//   3. CRASHED: at a secret, pre-decided point the multiplier crashes. Bets not cashed out are lost.
//
// Provably fair: the crash point comes from a random secret seed. sha256(seed) (the "hash") is shown
// before anyone bets, and the seed is revealed after the crash, so players can check the result was
// fixed in advance. See crashPointFromSeed() for the exact formula.
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const settings = require('./settings');
const game = require('./game');
const { GameError, round2 } = game;

// Multiplier growth: m(t) = e^(GROWTH * ms). 2.00x after ~11.6 s, 10x after ~38 s.
const GROWTH = 0.00006;
const multAt = (elapsedMs) => Math.floor(100 * Math.exp(GROWTH * Math.max(0, elapsedMs)) + 1e-9) / 100;
const msToReach = (m) => Math.log(m) / GROWTH;

// Crash point from the seed. With a house edge of E%, the chance the round reaches multiplier m is
// (100 - E) / (100 m), so cashing out at any target returns (100 - E)% of bets on average.
// About 4% of rounds (with E = 3) end at 1.00x, so no cash-out target can win them.
function crashPointFromSeed(seed, edgePct, maxMultiplier = Infinity) {
  const h = crypto.createHmac('sha256', seed).update('betdouble').digest('hex');
  const x = parseInt(h.slice(0, 13), 16) / 2 ** 52; // uniform in [0, 1)
  const cp = Math.floor((100 - edgePct) / (1 - x)) / 100;
  return Math.min(Math.max(1, cp), maxMultiplier);
}
const hashSeed = (seed) => crypto.createHash('sha256').update(seed).digest('hex');

class Crash {
  constructor() {
    this.round = null;          // the current round (in memory)
    this.bets = new Map();      // userId -> bet, for the current round
    this.listeners = new Set(); // fn(event) for live updates (SSE)
    this.timer = null;
    this.running = false;
    this.history = db.prepare("SELECT id, crash_point FROM rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 30").all()
      .map((r) => ({ id: r.id, crashPoint: r.crash_point }));
  }

  // Refund bets from a round that was cut short (server restart).
  recover(now = Date.now()) {
    tx(() => {
      for (const r of db.prepare("SELECT id FROM rounds WHERE status IN ('betting', 'running')").all()) {
        for (const b of db.prepare("SELECT * FROM bets WHERE round_id = ? AND status = 'active'").all(r.id)) {
          db.prepare("UPDATE bets SET status = 'refunded' WHERE id = ?").run(b.id);
          game.credit(b.user_id, b.amount, 'bet_refund', `Round #${r.id} was interrupted: bet refunded`, now, { roundId: r.id });
        }
        db.prepare("UPDATE rounds SET status = 'void', ended_at = ? WHERE id = ?").run(now, r.id);
      }
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, extra = {}) {
    const ev = { type, ...extra, state: this.publicState() };
    for (const fn of this.listeners) { try { fn(ev); } catch {} }
  }

  // ---------- phases ----------
  newRound(now = Date.now()) {
    const s = settings.all();
    const seed = crypto.randomBytes(32).toString('hex');
    const cp = crashPointFromSeed(seed, s.houseEdgePct, s.maxMultiplier);
    const r = db.prepare('INSERT INTO rounds (hash, seed, crash_point, edge_pct, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashSeed(seed), seed, cp, s.houseEdgePct, 'betting', now);
    this.round = {
      id: Number(r.lastInsertRowid), hash: hashSeed(seed), seed, crashPoint: cp, edgePct: s.houseEdgePct,
      status: 'betting', createdAt: now, bettingEndsAt: now + s.bettingSeconds * 1000, startedAt: null, crashAt: null, endedAt: null,
    };
    this.bets = new Map();
    this.emit('betting');
    return this.round;
  }

  startRunning(now = Date.now()) {
    const r = this.round;
    if (!r || r.status !== 'betting') throw new Error('No round in betting phase');
    r.status = 'running';
    r.startedAt = now;
    r.crashAt = now + msToReach(r.crashPoint);
    db.prepare("UPDATE rounds SET status = 'running', started_at = ? WHERE id = ?").run(now, r.id);
    this.emit('running');
    this.tick(now); // a 1.00x crash ends at once
  }

  // Current multiplier (never above the crash point).
  multiplier(now = Date.now()) {
    const r = this.round;
    if (!r || !r.startedAt) return 1;
    if (r.status === 'crashed') return r.crashPoint;
    return Math.min(multAt(now - r.startedAt), r.crashPoint);
  }

  // Pays auto cash-outs and max-win cash-outs that are due, and crashes the round when its time comes.
  tick(now = Date.now()) {
    const r = this.round;
    if (!r || r.status !== 'running') return;
    const crashed = now >= r.crashAt;
    const m = crashed ? r.crashPoint : this.multiplier(now);
    const maxWin = settings.get('maxWin');
    for (const b of this.bets.values()) {
      if (b.status !== 'active') continue;
      const capAt = Math.floor((maxWin / b.amount) * 100 + 1e-9) / 100; // where the max win is reached
      const target = Math.min(b.autoCashout || Infinity, capAt);
      if (target <= m) this.settleWin(b, target, now, b.autoCashout && b.autoCashout <= capAt ? 'auto' : 'max');
    }
    if (crashed) this.crash(now);
  }

  crash(now = Date.now()) {
    const r = this.round;
    r.status = 'crashed';
    r.endedAt = now;
    tx(() => {
      for (const b of this.bets.values()) {
        if (b.status === 'active') {
          b.status = 'lost';
          db.prepare("UPDATE bets SET status = 'lost' WHERE id = ?").run(b.id);
        }
        if (b.status === 'won' || b.status === 'lost') game.payReferral({ amount: b.amount, round_id: r.id }, game.getUser(b.userId), now);
      }
      const played = [...this.bets.values()].filter((b) => b.status !== 'refunded');
      db.prepare("UPDATE rounds SET status = 'crashed', ended_at = ?, total_bet = ?, total_paid = ?, players = ? WHERE id = ?")
        .run(now, played.reduce((a, b) => a + b.amount, 0), played.reduce((a, b) => a + b.payout, 0), played.length, r.id);
    });
    this.history.unshift({ id: r.id, crashPoint: r.crashPoint });
    this.history.length = Math.min(this.history.length, 30);
    this.emit('crashed');
  }

  // ---------- player actions ----------
  placeBet(userId, amount, autoCashout, now = Date.now()) {
    const r = this.round;
    if (!r || r.status !== 'betting' || now >= r.bettingEndsAt) throw new GameError('Bets are closed. Wait for the next round');
    if (this.bets.has(userId)) throw new GameError('You already have a bet in this round');
    const s = settings.all();
    amount = round2(Number(amount));
    if (!Number.isFinite(amount) || amount < s.minBet || amount > s.maxBet) throw new GameError(`Bet must be between ${s.minBet} and ${s.maxBet}`);
    let auto = null;
    if (autoCashout !== undefined && autoCashout !== null && autoCashout !== '' && Number(autoCashout) !== 0) {
      auto = Math.round(Number(autoCashout) * 100) / 100;
      if (!Number.isFinite(auto) || auto < 1.01 || auto > s.maxMultiplier) throw new GameError(`Auto cash-out must be between 1.01x and ${s.maxMultiplier}x`);
    }
    const bet = tx(() => {
      const u = game.getUser(userId);
      if (!u || u.is_banned) throw new GameError('This account is blocked');
      game.checkCanBet(u, amount, now);
      if (u.balance < amount - 1e-9) throw new GameError('Not enough balance');
      db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, userId);
      game.addLedger(userId, 'bet', -amount, `Bet on round #${r.id}${auto ? ` (auto cash-out ${auto.toFixed(2)}x)` : ''}`, now, { roundId: r.id });
      const ins = db.prepare('INSERT INTO bets (round_id, user_id, amount, auto_cashout, created_at) VALUES (?, ?, ?, ?, ?)').run(r.id, userId, amount, auto, now);
      return { id: Number(ins.lastInsertRowid), userId, username: u.username, amount, autoCashout: auto, status: 'active', cashoutAt: null, payout: 0, createdAt: now };
    });
    this.bets.set(userId, bet);
    this.emit('bet');
    return { betId: bet.id };
  }

  cancelBet(userId, now = Date.now()) {
    const r = this.round;
    const b = this.bets.get(userId);
    if (!b || b.status !== 'active') throw new GameError('No bet to cancel');
    if (r.status !== 'betting') throw new GameError('The round has started. Cash out instead');
    tx(() => {
      db.prepare("UPDATE bets SET status = 'refunded' WHERE id = ?").run(b.id);
      game.credit(userId, b.amount, 'bet_refund', `Bet on round #${r.id} cancelled`, now, { roundId: r.id });
    });
    this.bets.delete(userId);
    this.emit('cancel');
  }

  cashout(userId, now = Date.now()) {
    const r = this.round;
    const b = this.bets.get(userId);
    if (!b) throw new GameError('You have no bet in this round');
    if (b.status === 'won') throw new GameError('Already cashed out');
    if (b.status !== 'active') throw new GameError('This bet is over');
    if (!r || r.status !== 'running') throw new GameError(r && r.status === 'betting' ? 'The round has not started yet' : 'Too late, it crashed');
    if (now >= r.crashAt) { this.tick(now); throw new GameError('Too late, it crashed'); }
    const m = this.multiplier(now);
    const capAt = Math.floor((settings.get('maxWin') / b.amount) * 100 + 1e-9) / 100;
    return this.settleWin(b, Math.min(m, capAt), now, 'manual');
  }

  settleWin(b, m, now, how) {
    const r = this.round;
    const payout = Math.min(round2(b.amount * m), settings.get('maxWin'));
    tx(() => {
      db.prepare("UPDATE bets SET status = 'won', cashout_at = ?, payout = ? WHERE id = ?").run(m, payout, b.id);
      game.credit(b.userId, payout, 'win', `Cashed out at ${m.toFixed(2)}x on round #${r.id}${how === 'auto' ? ' (auto)' : how === 'max' ? ' (max win)' : ''}`, now, { roundId: r.id });
    });
    Object.assign(b, { status: 'won', cashoutAt: m, payout });
    this.emit('cashout', { userId: b.userId, username: b.username, multiplier: m, payout });
    return { multiplier: m, payout };
  }

  // ---------- views ----------
  publicState(now = Date.now()) {
    const r = this.round;
    const players = [...this.bets.values()]
      .sort((a, b) => (b.payout - a.payout) || (b.amount - a.amount))
      .slice(0, 100)
      .map((b) => ({ username: b.username, amount: b.amount, status: b.status, cashoutAt: b.cashoutAt, payout: b.payout }));
    return {
      serverNow: now,
      growth: GROWTH,
      paused: !!settings.get('gamePaused'),
      round: r && {
        id: r.id, hash: r.hash, status: r.status, bettingEndsAt: r.bettingEndsAt, startedAt: r.startedAt,
        crashPoint: r.status === 'crashed' ? r.crashPoint : null,
        seed: r.status === 'crashed' ? r.seed : null,
        multiplier: r.status === 'running' ? this.multiplier(now) : r.status === 'crashed' ? r.crashPoint : 1,
      },
      players,
      playerCount: this.bets.size,
      totalBet: round2([...this.bets.values()].reduce((a, b) => a + b.amount, 0)),
      history: this.history.slice(0, 25),
    };
  }

  myBet(userId) {
    const b = this.bets.get(userId);
    return b ? { amount: b.amount, autoCashout: b.autoCashout, status: b.status, cashoutAt: b.cashoutAt, payout: b.payout } : null;
  }

  // ---------- the loop ----------
  start() {
    if (this.running) return;
    this.running = true;
    this.recover();
    this.loopBetting();
  }
  stop() { this.running = false; clearTimeout(this.timer); }

  later(ms, fn) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.running) return;
      try { fn(); } catch (e) { console.error('crash loop error', e); this.later(2000, () => this.loopBetting()); }
    }, ms);
  }
  loopBetting() {
    if (settings.get('gamePaused')) { this.emit('paused'); return this.later(2000, () => this.loopBetting()); }
    const r = this.newRound();
    this.later(r.bettingEndsAt - Date.now(), () => { this.startRunning(); this.loopRunning(); });
  }
  loopRunning() {
    if (this.round.status === 'crashed') return this.later(settings.get('pauseSeconds') * 1000, () => this.loopBetting());
    this.later(Math.max(10, Math.min(50, this.round.crashAt - Date.now())), () => { this.tick(); this.loopRunning(); });
  }
}

const crash = new Crash();

module.exports = { crash, Crash, crashPointFromSeed, hashSeed, multAt, msToReach, GROWTH };
