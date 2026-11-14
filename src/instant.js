// Instant games: Dice, Coin Flip, Plinko and Mines.
//
// Provably fair with a seed pair per player:
//   - server seed: secret, picked by the server. Its sha256 hash is shown before you play.
//   - client seed: yours, you can change it any time.
//   - nonce: counts your bets (0, 1, 2 ...).
// Every result comes from HMAC_SHA256(server seed, "clientSeed:nonce:cursor"), turned into numbers
// between 0 and 1 (see floats()). When you rotate your seed, the old server seed is revealed so you
// can re-check every bet you made with it.
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const settings = require('./settings');
const game = require('./game');
const { GameError, round2 } = game;

const GAMES = { dice: 'Dice', flip: 'Coin Flip', plinko: 'Plinko', mines: 'Mines' };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- randomness ----------
function floats(serverSeed, clientSeed, nonce, count) {
  const out = [];
  for (let cursor = 0; out.length < count; cursor++) {
    const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${cursor}`).digest();
    for (let i = 0; i + 4 <= h.length && out.length < count; i += 4) {
      out.push(h[i] / 256 + h[i + 1] / 256 ** 2 + h[i + 2] / 256 ** 3 + h[i + 3] / 256 ** 4);
    }
  }
  return out;
}

// ---------- the games (pure functions, so the browser can repeat them) ----------
const edgeFactor = () => (100 - settings.get('houseEdgePct')) / 100;

// Dice: roll 0.00 to 99.99. "under" wins if roll < target; "over" wins if roll > target.
function diceChance(mode, target) { return mode === 'under' ? target : 99.99 - target; }
function diceMultiplier(chance, ef = edgeFactor()) { return Math.floor((ef * 100 / chance) * 10000) / 10000; }
function diceRoll(f) { return Math.floor(f[0] * 10000) / 100; }

// Coin flip: under 0.5 = heads.
const flipSide = (f) => (f[0] < 0.5 ? 'heads' : 'tails');

// Plinko: 12 rows. Each row the ball goes left or right; the slot is the number of rights (0-12).
const PLINKO_ROWS = 12;
const PLINKO_SHAPES = {
  low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
  medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
  high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
};
const binom = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return r; };
const SLOT_P = [...Array(PLINKO_ROWS + 1)].map((_, k) => binom(PLINKO_ROWS, k) / 2 ** PLINKO_ROWS);
// The shapes are scaled so that, on average, players get back (100 - edge)% of their bets.
function plinkoTable(risk, ef = edgeFactor()) {
  const shape = PLINKO_SHAPES[risk];
  const raw = shape.reduce((a, m, i) => a + m * SLOT_P[i], 0);
  const t = shape.map((m) => Math.round(m * (ef / raw) * 100) / 100);
  // Rounding moves the average a little; the two rare edge slots absorb the difference.
  const rtp = t.reduce((a, m, i) => a + m * SLOT_P[i], 0);
  const fix = Math.floor((t[0] + (ef - rtp) / (2 * SLOT_P[0])) * 100) / 100;
  t[0] = t[PLINKO_ROWS] = fix;
  return t;
}
function plinkoPath(f) { return f.slice(0, PLINKO_ROWS).map((x) => (x < 0.5 ? 0 : 1)); }

// Mines: 25 tiles. The mine positions are the first `mines` tiles of a shuffle.
const TILES = 25;
function minesPositions(f, mines) {
  const deck = [...Array(TILES).keys()];
  const out = [];
  for (let i = 0; i < mines; i++) {
    const j = Math.floor(f[i] * deck.length);
    out.push(deck.splice(j, 1)[0]);
  }
  return out;
}
function minesMultiplier(mines, picks, ef = edgeFactor()) {
  if (picks === 0) return 1;
  let m = ef;
  for (let i = 0; i < picks; i++) m *= (TILES - i) / (TILES - mines - i);
  return Math.floor(m * 100) / 100;
}

// ---------- seeds ----------
async function seedOf(userId, now = Date.now()) {
  let s = await db.get('SELECT * FROM seeds WHERE user_id = ?', userId);
  if (!s) {
    const server = crypto.randomBytes(32).toString('hex');
    await db.run('INSERT INTO seeds (user_id, server_seed, server_hash, client_seed, nonce, created_at) VALUES (?, ?, ?, ?, 0, ?)', userId, server, sha256(server), crypto.randomBytes(8).toString('hex'), now);
    s = await db.get('SELECT * FROM seeds WHERE user_id = ?', userId);
  }
  return s;
}
async function publicSeed(userId) {
  const s = await seedOf(userId);
  const revealed = await db.all('SELECT server_seed, server_hash, client_seed, last_nonce, revealed_at FROM revealed_seeds WHERE user_id = ? ORDER BY id DESC LIMIT 10', userId);
  return { serverHash: s.server_hash, clientSeed: s.client_seed, nonce: s.nonce, revealed };
}
// Reveals the current server seed and starts a new pair.
async function rotateSeed(userId, clientSeed, now = Date.now()) {
  return tx(async () => {
    if (await db.get("SELECT 1 AS x FROM plays WHERE user_id = ? AND status = 'active'", userId)) throw new GameError('Finish your Mines game first');
    const cs = String(clientSeed || '').trim() || crypto.randomBytes(8).toString('hex');
    if (!/^[\w-]{1,64}$/.test(cs)) throw new GameError('Client seed: up to 64 letters, numbers, _ or -');
    const old = await seedOf(userId, now);
    await db.run('INSERT INTO revealed_seeds (user_id, server_seed, server_hash, client_seed, last_nonce, revealed_at) VALUES (?, ?, ?, ?, ?, ?)', userId, old.server_seed, old.server_hash, old.client_seed, old.nonce - 1, now);
    const server = crypto.randomBytes(32).toString('hex');
    await db.run('UPDATE seeds SET server_seed = ?, server_hash = ?, client_seed = ?, nonce = 0, created_at = ? WHERE user_id = ?', server, sha256(server), cs, now, userId);
    return { revealedServerSeed: old.server_seed };
  });
}

// ---------- shared bet handling ----------
async function takeStake(userId, gameId, amount, now) {
  const s = settings.all();
  amount = round2(Number(amount));
  if (!Number.isFinite(amount) || amount < s.minBet || amount > s.maxBet) throw new GameError(`Bet must be between ${s.minBet} and ${s.maxBet}`);
  const u = await game.getUser(userId);
  if (!u || u.is_banned) throw new GameError('This account is blocked');
  await game.checkCanBet(u, amount, now);
  if (u.balance < amount - 1e-9) throw new GameError('Not enough balance');
  await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', amount, userId);
  await game.addLedger(userId, 'bet', -amount, `${GAMES[gameId]} bet`, now);
  const seed = await seedOf(userId, now);
  await db.run('UPDATE seeds SET nonce = nonce + 1 WHERE user_id = ?', userId);
  return { amount, seed, user: u };
}

async function finish(userId, gameId, amount, multiplier, detail, seed, now, playId = null) {
  const won = multiplier > 0;
  const payout = won ? Math.min(round2(amount * multiplier), settings.get('maxWin')) : 0;
  if (payout > 0) await game.credit(userId, payout, 'win', `${GAMES[gameId]} win at ${multiplier}x`, now);
  const status = won && multiplier >= 1 ? 'won' : 'lost';
  const json = JSON.stringify(detail);
  if (playId) {
    await db.run('UPDATE plays SET payout = ?, multiplier = ?, status = ?, detail = ?, ended_at = ? WHERE id = ?', payout, multiplier, status, json, now, playId);
  } else {
    playId = (await db.run(`INSERT INTO plays (user_id, game, amount, payout, multiplier, status, detail, server_hash, client_seed, nonce, created_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, userId, gameId, amount, payout, multiplier, status, json, seed.server_hash, seed.client_seed, seed.nonce, now, now)).lastId;
  }
  await game.payReferral({ amount, round_id: null }, await game.getUser(userId), now);
  return { playId, payout, multiplier, status, profit: round2(payout - amount), nonce: seed.nonce };
}

// ---------- game actions ----------
async function playDice(userId, { amount, target, mode }, now = Date.now()) {
  mode = mode === 'over' ? 'over' : 'under';
  target = Math.round(Number(target) * 100) / 100;
  const chance = diceChance(mode, target);
  if (!Number.isFinite(target) || chance < 1 || chance > 95) throw new GameError('Win chance must be between 1% and 95%');
  return tx(async () => {
    const { amount: a, seed } = await takeStake(userId, 'dice', amount, now);
    const roll = diceRoll(floats(seed.server_seed, seed.client_seed, seed.nonce, 1));
    const win = mode === 'under' ? roll < target : roll > target;
    const mult = diceMultiplier(chance);
    return { roll, ...(await finish(userId, 'dice', a, win ? mult : 0, { mode, target, chance, roll, payoutMultiplier: mult }, seed, now)) };
  });
}

async function playFlip(userId, { amount, side }, now = Date.now()) {
  if (side !== 'heads' && side !== 'tails') throw new GameError('Pick heads or tails');
  return tx(async () => {
    const { amount: a, seed } = await takeStake(userId, 'flip', amount, now);
    const result = flipSide(floats(seed.server_seed, seed.client_seed, seed.nonce, 1));
    const mult = Math.floor(2 * edgeFactor() * 100) / 100;
    return { result, ...(await finish(userId, 'flip', a, result === side ? mult : 0, { side, result }, seed, now)) };
  });
}

async function playPlinko(userId, { amount, risk }, now = Date.now()) {
  if (!PLINKO_SHAPES[risk]) throw new GameError('Pick low, medium or high risk');
  return tx(async () => {
    const { amount: a, seed } = await takeStake(userId, 'plinko', amount, now);
    const path = plinkoPath(floats(seed.server_seed, seed.client_seed, seed.nonce, PLINKO_ROWS));
    const slot = path.reduce((x, y) => x + y, 0);
    const mult = plinkoTable(risk)[slot];
    // A slot under 1x pays back part of the bet: that counts as a loss.
    return { path, slot, ...(await finish(userId, 'plinko', a, mult, { risk, path, slot }, seed, now)) };
  });
}

async function activeMines(userId) {
  const p = await db.get("SELECT * FROM plays WHERE user_id = ? AND game = 'mines' AND status = 'active'", userId);
  if (!p) return null;
  const d = JSON.parse(p.detail);
  return { playId: p.id, amount: p.amount, mines: d.mines, revealed: d.revealed, multiplier: minesMultiplier(d.mines, d.revealed.length),
    next: minesMultiplier(d.mines, d.revealed.length + 1), nonce: p.nonce };
}

async function minesStart(userId, { amount, mines }, now = Date.now()) {
  mines = Number(mines);
  if (!Number.isInteger(mines) || mines < 1 || mines > 24) throw new GameError('Mines must be between 1 and 24');
  return tx(async () => {
    if (await activeMines(userId)) throw new GameError('You already have a Mines game running');
    const { amount: a, seed } = await takeStake(userId, 'mines', amount, now);
    const positions = minesPositions(floats(seed.server_seed, seed.client_seed, seed.nonce, mines), mines);
    await db.run(`INSERT INTO plays (user_id, game, amount, status, detail, server_hash, client_seed, nonce, created_at)
      VALUES (?, 'mines', ?, 'active', ?, ?, ?, ?, ?)`, userId, a, JSON.stringify({ mines, positions, revealed: [] }), seed.server_hash, seed.client_seed, seed.nonce, now);
    return { mines: await activeMines(userId) };
  });
}

async function minesReveal(userId, { tile }, now = Date.now()) {
  tile = Number(tile);
  if (!Number.isInteger(tile) || tile < 0 || tile >= TILES) throw new GameError('Bad tile');
  return tx(async () => {
    const p = await db.get("SELECT * FROM plays WHERE user_id = ? AND game = 'mines' AND status = 'active'", userId);
    if (!p) throw new GameError('Start a Mines game first');
    const d = JSON.parse(p.detail);
    if (d.revealed.includes(tile)) throw new GameError('Already opened');
    const seed = { server_hash: p.server_hash, client_seed: p.client_seed, nonce: p.nonce };
    if (d.positions.includes(tile)) {
      d.revealed.push(tile); d.hit = tile;
      const out = await finish(userId, 'mines', p.amount, 0, d, seed, now, p.id);
      return { boom: true, tile, positions: d.positions, ...out };
    }
    d.revealed.push(tile);
    if (d.revealed.length === TILES - d.mines) { // every safe tile found: cash out automatically
      const out = await finish(userId, 'mines', p.amount, minesMultiplier(d.mines, d.revealed.length), d, seed, now, p.id);
      return { boom: false, tile, done: true, positions: d.positions, ...out };
    }
    await db.run('UPDATE plays SET detail = ? WHERE id = ?', JSON.stringify(d), p.id);
    return { boom: false, tile, mines: await activeMines(userId) };
  });
}

async function minesCashout(userId, now = Date.now()) {
  return tx(async () => {
    const p = await db.get("SELECT * FROM plays WHERE user_id = ? AND game = 'mines' AND status = 'active'", userId);
    if (!p) throw new GameError('No Mines game running');
    const d = JSON.parse(p.detail);
    if (!d.revealed.length) throw new GameError('Open at least one tile first');
    const seed = { server_hash: p.server_hash, client_seed: p.client_seed, nonce: p.nonce };
    const out = await finish(userId, 'mines', p.amount, minesMultiplier(d.mines, d.revealed.length), d, seed, now, p.id);
    return { positions: d.positions, ...out };
  });
}

// What a player sees about their recent games (mine positions only after the game ends).
async function recentPlays(userId, limit = 30) {
  return (await db.all("SELECT id, game, amount, payout, multiplier, status, detail, server_hash, client_seed, nonce, created_at FROM plays WHERE user_id = ? AND status != 'active' ORDER BY id DESC LIMIT ?", userId, limit)).map((p) => ({ ...p, detail: JSON.parse(p.detail) }));
}

function gameConfig() {
  const ef = edgeFactor();
  return {
    edgePct: settings.get('houseEdgePct'),
    flipMultiplier: Math.floor(2 * ef * 100) / 100,
    plinko: { rows: PLINKO_ROWS, low: plinkoTable('low', ef), medium: plinkoTable('medium', ef), high: plinkoTable('high', ef) },
  };
}

module.exports = {
  GAMES, floats, sha256, diceChance, diceMultiplier, diceRoll, flipSide, plinkoTable, plinkoPath, SLOT_P, PLINKO_ROWS,
  minesPositions, minesMultiplier, seedOf, publicSeed, rotateSeed,
  playDice, playFlip, playPlinko, minesStart, minesReveal, minesCashout, activeMines, recentPlays, gameConfig,
};
