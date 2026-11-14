const { db, game, settings, user, bal, ledgerSum, close, cleanup } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const payments = require('../src/payments');
const crash = require('../src/crash');
const { crashPointFromSeed, hashSeed, multAt, msToReach } = crash;

test.before(() => settings.load(true));
test.after(cleanup);

// Each test gets its own round far in the "future", with a crash point we choose.
let T = Date.now();
async function round(cp) {
  T += 10 * 86400000;
  const r0 = await crash.current(T);
  const crashAt = Math.ceil(r0.betting_ends_at + msToReach(cp));
  await db.run('UPDATE rounds SET crash_point = ?, crash_at = ? WHERE id = ?', cp, crashAt, r0.id);
  return db.get('SELECT * FROM rounds WHERE id = ?', r0.id);
}
const my = (id, now) => crash.myBet(id, now);

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
  assert.ok(Math.abs(over2 / N - 0.485) < 0.015, `P(>=2) ${over2 / N}`);
  assert.ok(Math.abs(over10 / N - 0.097) < 0.01, `P(>=10) ${over10 / N}`);
  assert.ok(Math.abs(instant / N - (1 - 0.97 / 1.01)) < 0.006, `instant ${instant / N}`);
  assert.equal(crashPointFromSeed('abc', 3), crashPointFromSeed('abc', 3));
  assert.equal(crashPointFromSeed(crypto.randomBytes(32).toString('hex'), 3, 5) <= 5, true);
});

test('multiplier curve', () => {
  assert.equal(multAt(0), 1);
  assert.equal(multAt(msToReach(2) + 1), 2);
  assert.ok(multAt(msToReach(2) - 50) < 2);
});

test('round timetable: betting, running, crashed, then the next round', async () => {
  const r = await round(3);
  assert.equal(r.hash, hashSeed(r.seed));
  let st = await crash.publicState(r.created_at + 10);
  assert.equal(st.round.status, 'betting');
  assert.equal(st.round.crashPoint, null);
  assert.equal(st.round.seed, null); // secret until the crash
  st = await crash.publicState(r.betting_ends_at + 100);
  assert.equal(st.round.status, 'running');
  st = await crash.publicState(r.crash_at + 1);
  assert.equal(st.round.status, 'crashed');
  assert.equal(st.round.crashPoint, 3);
  assert.equal(st.round.seed, r.seed);
  assert.equal(st.history[0].crashPoint, 3);
  st = await crash.publicState(r.crash_at + settings.get('pauseSeconds') * 1000 + 5);
  assert.equal(st.round.id, r.id + 1);
  assert.equal(st.round.status, 'betting');
});

test('manual cash-out wins, auto cash-out wins, the rest lose', async () => {
  const a = await user(), b = await user(), d = await user();
  const r = await round(3.5);
  const t0 = r.created_at;
  await crash.placeBet(a, 10, null, t0 + 100);
  await crash.placeBet(b, 20, 1.5, t0 + 200);
  await crash.placeBet(d, 30, null, t0 + 300);
  await assert.rejects(crash.placeBet(a, 5, null, t0 + 400), /already have a bet/);
  assert.equal(await bal(a), 90);
  const run = r.betting_ends_at;
  const late = await user();
  assert.equal((await crash.placeBet(late, 5, null, run + 1)).roundId, r.id + 1); // too late for this round: goes on the next
  await assert.rejects(crash.cancelBet(a, run + 1), /started/);

  const tOut = run + msToReach(2.2) + 5;
  await crash.current(tOut); // b's auto 1.5x is due
  assert.equal((await my(b)).status, 'won');
  assert.equal((await my(b)).cashoutAt, 1.5);
  close(await bal(b), 80 + 30);
  const res = await crash.cashout(a, tOut);
  assert.equal(res.multiplier, 2.2);
  close(await bal(a), 90 + 22);
  await assert.rejects(crash.cashout(a, tOut + 10), /Already/);

  await assert.rejects(crash.cashout(d, r.crash_at + 1), /Too late/);
  assert.equal((await my(d)).status, 'lost');
  close(await bal(d), 70);
  const row = await db.get('SELECT * FROM rounds WHERE id = ?', r.id);
  assert.equal(row.status, 'crashed');
  close(row.total_bet, 60);
  close(row.total_paid, 52);
  for (const id of [a, b, d]) close(await bal(id), await ledgerSum(id));
});

test('bet during a flight is locked in for the next round', async () => {
  const a = await user();
  const r = await round(3);
  await crash.placeBet(a, 10, null, r.created_at + 1);           // this round
  const res = await crash.placeBet(a, 20, 1.5, r.betting_ends_at + 500); // next round
  assert.equal(res.roundId, r.id + 1);
  assert.equal(res.nextRound, true);
  await assert.rejects(crash.placeBet(a, 5, null, r.betting_ends_at + 600), /already have a bet on the next round/);
  assert.equal(await bal(a), 70);
  assert.equal((await crash.nextBet(a)).amount, 20);
  // cancel the next-round bet while this round still flies, then place it again
  await crash.cancelBet(a, r.betting_ends_at + 700);
  assert.equal(await bal(a), 90);
  assert.equal((await crash.myBet(a)).status, 'active'); // the flying bet is untouched
  await crash.placeBet(a, 20, 1.5, r.betting_ends_at + 800);
  // this round crashes; next round opens with the bet already in it
  await crash.current(r.crash_at + 1);
  assert.equal((await crash.myBet(a)).status, 'lost');
  const next = await crash.current(r.crash_at + settings.get('pauseSeconds') * 1000 + 1);
  assert.equal(next.id, r.id + 1);
  const mine = await crash.myBet(a);
  assert.equal(mine.roundId, next.id);
  assert.equal(mine.amount, 20);
  assert.equal(mine.status, 'active');
  const st = await crash.publicState(next.created_at + 1);
  assert.equal(st.playerCount, 1);
  // it plays like any other bet: auto cash-out at 1.5x
  await db.run('UPDATE rounds SET crash_point = 4, crash_at = ? WHERE id = ?', Math.ceil(next.betting_ends_at + msToReach(4)), next.id);
  await crash.current(next.betting_ends_at + msToReach(2));
  close((await crash.myBet(a)).payout, 30);
  close(await bal(a), await ledgerSum(a));
});

test('settling twice pays once', async () => {
  const a = await user();
  const r = await round(2);
  await crash.placeBet(a, 10, 1.5, r.created_at + 1);
  await Promise.all([crash.current(r.crash_at + 5), crash.current(r.crash_at + 6), crash.publicState(r.crash_at + 7)]);
  close(await bal(a), 105);
  close(await bal(a), await ledgerSum(a));
});

test('auto cash-out the round never reaches loses; auto at exactly the crash point wins', async () => {
  const a = await user(), b = await user();
  const r = await round(2);
  await crash.placeBet(a, 10, 2, r.created_at + 1);
  await crash.placeBet(b, 10, 2.01, r.created_at + 1);
  await crash.current(r.crash_at + 100); // nobody polled during the flight: still paid at the exact target
  assert.equal((await my(a)).status, 'won');
  close((await my(a)).payout, 20);
  assert.equal((await my(b)).status, 'lost');
});

test('instant crash at 1.00x', async () => {
  const a = await user();
  const r = await round(1);
  assert.equal(r.crash_at, r.betting_ends_at);
  await crash.placeBet(a, 10, 1.01, r.created_at + 1);
  const st = await crash.publicState(r.betting_ends_at);
  assert.equal(st.round.status, 'crashed');
  assert.equal((await my(a)).status, 'lost');
});

test('cancel refunds; limits on amount and balance', async () => {
  const a = await user();
  const r = await round(5);
  const t = r.created_at;
  await assert.rejects(crash.placeBet(a, 0.5, null, t + 1), /between/);
  await assert.rejects(crash.placeBet(a, 5000, null, t + 1), /between/);
  await assert.rejects(crash.placeBet(a, 500, null, t + 1), /Not enough/);
  await assert.rejects(crash.placeBet(a, 10, 1.0, t + 1), /Auto cash-out/);
  await crash.placeBet(a, 40, null, t + 1);
  await crash.cancelBet(a, t + 2);
  assert.equal(await bal(a), 100);
  await crash.placeBet(a, 40, null, t + 3); // can bet again after cancelling
  assert.equal(await bal(a), 60);
});

test('max win caps the payout', async () => {
  await settings.update({ maxWin: 100, maxBet: 50 });
  try {
    const a = await user();
    const r = await round(50);
    await crash.placeBet(a, 20, null, r.created_at + 1);
    await crash.current(r.betting_ends_at + msToReach(6)); // 20 x 5 = 100 reached at 5x
    assert.equal((await my(a)).status, 'won');
    close((await my(a)).payout, 100);
    assert.equal((await my(a)).cashoutAt, 5);
  } finally { await settings.update({ maxWin: 50000, maxBet: 1000 }); }
});

test('paused game opens no new rounds', async () => {
  const r = await round(2);
  await settings.update({ gamePaused: true });
  try {
    const st = await crash.publicState(r.crash_at + 60000);
    assert.equal(st.round.id, r.id);
    assert.equal(st.round.status, 'crashed');
  } finally { await settings.update({ gamePaused: false }); }
});

test('responsible play: break and 24-hour limit', async () => {
  const a = await user(), b = await user();
  let r = await round(5);
  await game.setPlay(a, { dailyBetLimit: 15 }, r.created_at);
  await crash.placeBet(a, 10, null, r.created_at + 1);
  await crash.cancelBet(a, r.created_at + 2); // refunded bets don't count
  await crash.placeBet(a, 15, null, r.created_at + 3);
  await crash.current(r.crash_at);
  const t = r.crash_at + settings.get('pauseSeconds') * 1000 + 1;
  r = await crash.current(t);
  await assert.rejects(crash.placeBet(a, 1, null, t + 1), /24-hour bet limit/);
  await game.setPlay(b, { breakDays: 1 }, t);
  await assert.rejects(crash.placeBet(b, 1, null, t + 1), /break/);
  await assert.rejects(payments.deposit(b, 10, t + 1), /break/);
});

test('referral: inviter earns % of played bets, not cancelled ones', async () => {
  const inv = await user();
  const code = (await game.getUser(inv)).referral_code;
  const f = await user({ referralCode: code });
  assert.equal(await bal(f), 150); // welcome + invite bonus
  const r = await round(3);
  await crash.placeBet(f, 100, null, r.created_at + 1);
  await crash.cancelBet(f, r.created_at + 2);
  await crash.placeBet(f, 100, null, r.created_at + 3);
  await crash.current(r.crash_at);
  close(await bal(inv), 100 + 0.5); // 0.5% of 100
  assert.equal((await game.referralStats(inv)).activeCount, 1);
  await assert.rejects(user({ referralCode: 'NOPE' }), /not valid/);
});

test('withdrawal: reject refunds, approve keeps coins off', async () => {
  const a = await user();
  await payments.withdraw(a, 30);
  assert.equal(await bal(a), 70);
  const w = await db.get('SELECT id FROM withdrawals WHERE user_id = ?', a);
  await payments.decideWithdrawal(1, w.id, false, 'no');
  assert.equal(await bal(a), 100);
  await payments.withdraw(a, 20);
  await payments.decideWithdrawal(1, (await db.get("SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending'", a)).id, true);
  assert.equal(await bal(a), 80);
  close(await bal(a), await ledgerSum(a));
});
