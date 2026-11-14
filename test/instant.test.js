const { db, game, settings, user, bal, ledgerSum, close, fund, cleanup } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const I = require('../src/instant');

test.before(() => settings.load(true));
test.after(cleanup);

test('floats are deterministic and in [0, 1)', () => {
  const a = I.floats('s', 'c', 1, 20), b = I.floats('s', 'c', 1, 20);
  assert.deepEqual(a, b);
  assert.ok(a.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(a, I.floats('s', 'c', 2, 20));
});

test('every game pays back about 97% (exact maths)', () => {
  // dice: chance c pays (97 / c) x, wins c% of the time
  for (const c of [1, 10, 49.5, 95]) assert.ok(Math.abs(I.diceMultiplier(c, 0.97) * c / 100 - 0.97) < 0.001);
  // plinko
  for (const risk of ['low', 'medium', 'high']) {
    const rtp = I.plinkoTable(risk, 0.97).reduce((a, m, i) => a + m * I.SLOT_P[i], 0);
    assert.ok(Math.abs(rtp - 0.97) < 0.003, `${risk} ${rtp}`);
  }
  // mines: chance of k safe picks x multiplier ~ 0.97
  for (const [m, k] of [[1, 1], [3, 5], [10, 3], [24, 1]]) {
    let p = 1; for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i);
    const ev = p * I.minesMultiplier(m, k, 0.97);
    assert.ok(ev <= 0.97 + 1e-9 && ev > 0.95, `mines ${m}/${k} ${ev}`);
  }
});

test('dice: result matches the seed, balance and ledger agree', async () => {
  const a = await user();
  const s = await I.seedOf(a);
  const r = await I.playDice(a, { amount: 10, target: 50, mode: 'under' });
  assert.equal(r.roll, I.diceRoll(I.floats(s.server_seed, s.client_seed, 0, 1)));
  assert.equal(r.status, r.roll < 50 ? 'won' : 'lost');
  close(await bal(a), 90 + r.payout);
  assert.equal((await I.seedOf(a)).nonce, 1);
  await assert.rejects(I.playDice(a, { amount: 10, target: 99, mode: 'under' }), /between 1% and 95%/);
  close(await bal(a), await ledgerSum(a));
});

test('coin flip and plinko', async () => {
  const a = await user(); await fund(a, 1000);
  let wins = 0;
  for (let i = 0; i < 40; i++) { const r = await I.playFlip(a, { amount: 1, side: 'heads' }); if (r.status === 'won') { wins++; close(r.payout, 1.94); } }
  assert.ok(wins > 5 && wins < 35);
  const r = await I.playPlinko(a, { amount: 10, risk: 'high' });
  assert.equal(r.path.length, 12);
  assert.equal(r.slot, r.path.reduce((x, y) => x + y, 0));
  close(r.payout, Math.round(10 * I.plinkoTable('high')[r.slot] * 100) / 100);
  close(await bal(a), await ledgerSum(a));
});

test('mines: reveal safe tiles, cash out; hitting a mine loses', async () => {
  const a = await user();
  const s = await I.seedOf(a);
  await I.minesStart(a, { amount: 10, mines: 3 });
  await assert.rejects(I.minesStart(a, { amount: 10, mines: 3 }), /already/);
  await assert.rejects(I.rotateSeed(a), /Finish/);
  const pos = I.minesPositions(I.floats(s.server_seed, s.client_seed, 0, 3), 3);
  const safe = [...Array(25).keys()].filter((t) => !pos.includes(t));
  await I.minesReveal(a, { tile: safe[0] });
  await I.minesReveal(a, { tile: safe[1] });
  const out = await I.minesCashout(a);
  close(out.multiplier, I.minesMultiplier(3, 2));
  close(await bal(a), 90 + out.payout);
  // second game: hit a mine
  const s2 = await I.seedOf(a);
  await I.minesStart(a, { amount: 5, mines: 5 });
  const pos2 = I.minesPositions(I.floats(s2.server_seed, s2.client_seed, 1, 5), 5);
  const r = await I.minesReveal(a, { tile: pos2[0] });
  assert.equal(r.boom, true);
  assert.equal(await I.activeMines(a), null);
  close(await bal(a), await ledgerSum(a));
});

test('rotating the seed reveals the old one', async () => {
  const a = await user();
  const old = await I.seedOf(a);
  await I.playFlip(a, { amount: 1, side: 'tails' });
  const r = await I.rotateSeed(a, 'my-seed');
  assert.equal(r.revealedServerSeed, old.server_seed);
  assert.equal(I.sha256(r.revealedServerSeed), old.server_hash);
  const now = await I.seedOf(a);
  assert.equal(now.client_seed, 'my-seed');
  assert.equal(now.nonce, 0);
  assert.notEqual(now.server_hash, old.server_hash);
});

test('24-hour limit counts instant games', async () => {
  const a = await user();
  await game.setPlay(a, { dailyBetLimit: 15 });
  await I.playFlip(a, { amount: 10, side: 'heads' });
  await assert.rejects(I.playDice(a, { amount: 10, target: 50, mode: 'over' }), /24-hour/);
});
