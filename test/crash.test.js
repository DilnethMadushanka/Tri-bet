process.env.DB_PATH = ':memory:';
process.env.CRASH_AUTOSTART = 'false';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { db } = require('../src/db');
const game = require('../src/game');
const settings = require('../src/settings');
const payments = require('../src/payments');
const { Crash, crashPointFromSeed, hashSeed, multAt, msToReach } = require('../src/crash');

let n = 0;
const user = (opts = {}) => game.registerUser({ username: `u${++n}`, passwordHash: 'x', ...opts });
const bal = (id) => game.getUser(id).balance;
const ledgerSum = (id) => db.prepare('SELECT SUM(amount) AS s FROM ledger WHERE user_id = ?').get(id).s;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// A round with a crash point we choose.
function round(c, cp, now) {
  const r = c.newRound(now);
  r.crashPoint = cp;
  return r;
}

test('crash points follow the house edge', () => {
  const N = 40000;
  let instant = 0, over2 = 0, over10 = 0;
  for (let i = 0; i < N; i++) {
    const cp = crashPointFromSeed(crypto.randomBytes(32).toString('hex'), 3);
    assert.ok(cp >= 1);
    if (cp === 1) instant++;
    if (cp >= 2) over2++;
    if (cp >= 10) over10++;
  }
  // P(cp >= m) = 0.97 / m
  assert.ok(Math.abs(over2 / N - 0.485) < 0.015, `P(>=2) ${over2 / N}`);
  assert.ok(Math.abs(over10 / N - 0.097) < 0.01, `P(>=10) ${over10 / N}`);
  assert.ok(Math.abs(instant / N - (1 - 0.97 / 1.01)) < 0.006, `instant ${instant / N}`);
  assert.equal(crashPointFromSeed('abc', 3), crashPointFromSeed('abc', 3)); // same seed, same result
  assert.equal(crashPointFromSeed(crypto.randomBytes(32).toString('hex'), 3, 5) <= 5, true);
});

test('multiplier curve', () => {
  assert.equal(multAt(0), 1);
  assert.equal(multAt(msToReach(2) + 1), 2);
  assert.ok(multAt(msToReach(2) - 50) < 2);
});

test('round: manual cash-out wins, auto cash-out wins, the rest lose', () => {
  const c = new Crash();
  const a = user(), b = user(), d = user();
  const t0 = 1_000_000;
  const r = round(c, 3.5, t0);
  assert.equal(r.hash, hashSeed(r.seed));
  c.placeBet(a, 10, null, t0 + 100);
  c.placeBet(b, 20, 1.5, t0 + 200);
  c.placeBet(d, 30, null, t0 + 300);
  assert.throws(() => c.placeBet(a, 5, null, t0 + 400), /already have a bet/);
  assert.equal(bal(a), 90);
  c.startRunning(t0 + 7000);
  assert.throws(() => c.placeBet(user(), 5, null, t0 + 7001), /closed/);
  assert.throws(() => c.cancelBet(a, t0 + 7001), /started/);

  const tOut = t0 + 7000 + msToReach(2.2) + 5;
  c.tick(tOut); // b's auto 1.5x is due
  assert.equal(c.myBet(b).status, 'won');
  assert.equal(c.myBet(b).cashoutAt, 1.5);
  close(bal(b), 80 + 30);
  const res = c.cashout(a, tOut);
  assert.equal(res.multiplier, 2.2);
  close(bal(a), 90 + 22);
  assert.throws(() => c.cashout(a, tOut + 10), /Already/);

  const tCrash = r.crashAt;
  assert.throws(() => c.cashout(d, tCrash + 1), /Too late/);
  assert.equal(r.status, 'crashed');
  assert.equal(c.myBet(d).status, 'lost');
  close(bal(d), 70);
  const row = db.prepare('SELECT * FROM rounds WHERE id = ?').get(r.id);
  assert.equal(row.status, 'crashed');
  close(row.total_bet, 60);
  close(row.total_paid, 52);
  assert.equal(c.publicState().history[0].crashPoint, 3.5);
  for (const id of [a, b, d]) close(bal(id), ledgerSum(id));
});

test('auto cash-out that the round never reaches loses; auto at exactly the crash point wins', () => {
  const c = new Crash();
  const a = user(), b = user();
  const r = round(c, 2, 0);
  c.placeBet(a, 10, 2, 1);
  c.placeBet(b, 10, 2.01, 1);
  c.startRunning(1000);
  c.tick(r.crashAt + 100); // skipped straight past: still paid at the exact target
  assert.equal(c.myBet(a).status, 'won');
  close(c.myBet(a).payout, 20);
  assert.equal(c.myBet(b).status, 'lost');
});

test('instant crash at 1.00x', () => {
  const c = new Crash();
  const a = user();
  round(c, 1, 0);
  c.placeBet(a, 10, 1.01, 1);
  c.startRunning(1000);
  assert.equal(c.round.status, 'crashed');
  assert.equal(c.myBet(a).status, 'lost');
});

test('cancel refunds; limits on amount and balance', () => {
  const c = new Crash();
  const a = user();
  round(c, 5, 0);
  assert.throws(() => c.placeBet(a, 0.5, null, 1), /between/);
  assert.throws(() => c.placeBet(a, 5000, null, 1), /between/);
  assert.throws(() => c.placeBet(a, 500, null, 1), /Not enough/);
  assert.throws(() => c.placeBet(a, 10, 1.0, 1), /Auto cash-out/);
  c.placeBet(a, 40, null, 1);
  c.cancelBet(a, 2);
  assert.equal(bal(a), 100);
  c.placeBet(a, 40, null, 3); // can bet again after cancelling
  assert.equal(bal(a), 60);
});

test('max win caps the payout', () => {
  settings.update({ maxWin: 100, maxBet: 50 });
  try {
    const c = new Crash();
    const a = user();
    const r = round(c, 50, 0);
    c.placeBet(a, 20, null, 1);
    c.startRunning(1000);
    c.tick(1000 + msToReach(6)); // 20 x 5 = 100 reached at 5x
    assert.equal(c.myBet(a).status, 'won');
    close(c.myBet(a).payout, 100);
    assert.equal(c.myBet(a).cashoutAt, 5);
    void r;
  } finally { settings.update({ maxWin: 50000, maxBet: 1000 }); }
});

test('responsible play: break and 24-hour limit', () => {
  const c = new Crash();
  const a = user(), b = user();
  game.setPlay(a, { dailyBetLimit: 15 }, 0);
  round(c, 5, 10);
  c.placeBet(a, 10, null, 11);
  c.cancelBet(a, 12); // refunded bets don't count
  c.placeBet(a, 15, null, 13);
  c.startRunning(1000); c.tick(c.round.crashAt);
  round(c, 5, c.round.crashAt + 10);
  assert.throws(() => c.placeBet(a, 1, null, c.round.createdAt + 1), /24-hour bet limit/);
  game.setPlay(b, { breakDays: 1 }, c.round.createdAt);
  assert.throws(() => c.placeBet(b, 1, null, c.round.createdAt + 1), /break/);
  assert.throws(() => payments.deposit(b, 10, c.round.createdAt + 1), /break/);
});

test('referral: inviter earns % of played bets, not cancelled ones', () => {
  const c = new Crash();
  const inv = user();
  const code = game.getUser(inv).referral_code;
  const f = user({ referralCode: code });
  assert.equal(bal(f), 150); // welcome + invite bonus
  round(c, 3, 0);
  c.placeBet(f, 100, null, 1);
  c.cancelBet(f, 2);
  c.placeBet(f, 100, null, 3);
  c.startRunning(1000); c.tick(c.round.crashAt);
  close(bal(inv), 100 + 0.5); // 0.5% of 100
  assert.equal(game.referralStats(inv).activeCount, 1);
  assert.throws(() => user({ referralCode: 'NOPE' }), /not valid/);
});

test('restart refunds bets of an unfinished round', () => {
  const c = new Crash();
  const a = user();
  const r = round(c, 3, 0);
  c.placeBet(a, 25, null, 1);
  c.startRunning(1000);
  new Crash().recover(2000);
  assert.equal(bal(a), 100);
  assert.equal(db.prepare('SELECT status FROM rounds WHERE id = ?').get(r.id).status, 'void');
});

test('withdrawal: reject refunds, approve keeps coins off', () => {
  const a = user();
  payments.withdraw(a, 30);
  assert.equal(bal(a), 70);
  const w = db.prepare('SELECT id FROM withdrawals WHERE user_id = ?').get(a);
  payments.decideWithdrawal(1, w.id, false, 'no');
  assert.equal(bal(a), 100);
  payments.withdraw(a, 20);
  payments.decideWithdrawal(1, db.prepare("SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending'").get(a).id, true);
  assert.equal(bal(a), 80);
  close(bal(a), ledgerSum(a));
});
