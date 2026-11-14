const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db, ready, testMode } = require('./db');
const config = require('./config');
const settings = require('./settings');
const game = require('./game');
const payments = require('./payments');
const adminRoutes = require('./admin');
const crash = require('./crash');
const instant = require('./instant');

const app = express();
app.set('trust proxy', 1); // behind Vercel's proxy: real client IP and HTTPS detection
app.use(express.json());
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(cookieParser());
// On Vercel, public/ is served by the CDN and this line is skipped. Locally it serves the pages.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// Every API call: make sure the tables exist and the admin settings are fresh.
// Errors from async handlers go to the error handler at the bottom.
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.use('/api', a(async (req, res, next) => {
  await ready(); await settings.load(); next();
}));

// ---------- auth ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
async function startSession(res, userId, remember = true) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, userId, Date.now());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: res.req.secure, ...(remember ? { maxAge: 30 * 24 * 3600 * 1000 } : {}) });
}
const sessionRow = (sid) => sid ? db.get(
  'SELECT s.user_id, u.is_admin, u.is_banned, u.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', sid) : null;
const auth = a(async (req, res, next) => {
  const row = await sessionRow(req.cookies.sid);
  if (!row) return res.status(401).json({ error: 'Please log in' });
  if (row.is_banned) return res.status(403).json({ error: 'This account is blocked' });
  req.userId = row.user_id;
  req.isAdmin = !!row.is_admin;
  const now = Date.now();
  if (!row.last_seen || now - row.last_seen > 60_000) await db.run('UPDATE users SET last_seen = ? WHERE id = ?', now, row.user_id);
  next();
});
function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admins only' });
  next();
}

// Simple in-memory rate limit for login/register (per IP, per server instance).
const hits = new Map();
function limit(req, res, next) {
  const key = req.ip, now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < 60_000);
  h.push(now); hits.set(key, h);
  if (h.length > 20) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  next();
}

app.post('/api/register', limit, a(async (req, res) => {
  const { username, password, email, ref, remember, adult } = req.body || {};
  if (adult !== true) return res.status(400).json({ error: 'You must be 18 or older to join', field: 'adult' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'Username: 3-20 letters, numbers or _', field: 'username' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email address looks wrong', field: 'email' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters', field: 'password' });
  if (await db.get('SELECT 1 AS x FROM users WHERE username = ?', username)) return res.status(400).json({ error: 'That username is taken', field: 'username' });
  try {
    const id = await game.registerUser({ username, email: email ? String(email).trim().toLowerCase() : null, passwordHash: hashPassword(password), referralCode: ref });
    await startSession(res, id, remember !== false);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof game.GameError) return res.status(400).json({ error: e.message, field: 'ref' });
    throw e;
  }
}));

app.get('/api/check-username', a(async (req, res) => {
  const u = String(req.query.u || '');
  res.json({ valid: /^[a-zA-Z0-9_]{3,20}$/.test(u), taken: !!(await db.get('SELECT 1 AS x FROM users WHERE username = ?', u)) });
}));
app.get('/api/check-ref', a(async (req, res) => {
  const row = await db.get('SELECT username FROM users WHERE referral_code = ? AND is_banned = 0', String(req.query.code || '').trim().toUpperCase());
  res.json({ valid: !!row, inviter: row ? row.username : null });
}));

app.post('/api/login', limit, a(async (req, res) => {
  const { username, password, remember } = req.body || {};
  const user = await db.get('SELECT id, password_hash, is_banned FROM users WHERE username = ? OR email = ?', String(username || ''), String(username || '').toLowerCase());
  if (!user || !checkPassword(String(password || ''), user.password_hash)) return res.status(400).json({ error: 'Wrong username or password' });
  if (user.is_banned) return res.status(403).json({ error: 'This account is blocked' });
  await startSession(res, user.id, remember !== false);
  res.json({ ok: true });
}));

app.post('/api/logout', a(async (req, res) => {
  if (req.cookies.sid) await db.run('DELETE FROM sessions WHERE token = ?', req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
}));

// ---------- public ----------
app.get('/api/config', (req, res) => {
  const s = settings.all();
  res.json({
    brand: config.BRAND, coin: config.COIN, testMode, demoDeposits: s.demoDeposits, signupBonus: s.signupBonus, licenseText: s.licenseText,
    referralSignupBonus: s.referralSignupBonus, referralPct: s.referralPct, minWithdraw: s.minWithdraw,
    minBet: s.minBet, maxBet: s.maxBet, bettingSeconds: s.bettingSeconds, games: instant.gameConfig(), maxWin: s.maxWin, maxMultiplier: s.maxMultiplier, houseEdgePct: s.houseEdgePct,
  });
});
app.get('/api/public-stats', a(async (req, res) => {
  const day = Date.now() - 86400000;
  res.json({
    users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
    rounds: (await db.get("SELECT COUNT(*) AS n FROM rounds WHERE status = 'crashed'")).n,
    biggest: (await db.get("SELECT COALESCE(MAX(crash_point), 0) AS m FROM rounds WHERE status = 'crashed' AND ended_at >= ?", day)).m,
    paid: (await db.get("SELECT COALESCE(SUM(payout), 0) AS s FROM bets WHERE status = 'won'")).s,
  });
}));

// Live game state. The page polls this (there is no always-on server, so no stream).
// Each call also moves the game forward: settles a crashed round, opens the next, pays due auto cash-outs.
// With a login cookie it also returns "me": your bet in the current round.
app.get('/api/crash/state', a(async (req, res) => {
  const now = Date.now();
  const st = await crash.publicState(now);
  const row = await sessionRow(req.cookies.sid);
  if (row && !row.is_banned) {
    st.me = await crash.myBet(row.user_id, now);
    st.meNext = await crash.nextBet(row.user_id);
    st.balance = (await game.getUser(row.user_id)).balance;
  }
  res.set('Cache-Control', 'no-store');
  res.json(st);
}));

// Fairness check for any finished round.
app.get('/api/rounds', a(async (req, res) => {
  res.json({ rounds: await db.all("SELECT id, hash, seed, crash_point, edge_pct, ended_at, players, total_bet FROM rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 50") });
}));
app.get('/api/rounds/:id', a(async (req, res) => {
  await crash.current();
  const r = await db.get('SELECT id, hash, seed, crash_point, edge_pct, status, started_at, ended_at, players, total_bet, total_paid FROM rounds WHERE id = ?', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Round not found' });
  if (r.status !== 'crashed') { r.seed = null; r.crash_point = null; }
  const bets = r.status === 'crashed' ? await db.all(`SELECT u.username, b.amount, b.status, b.cashout_at, b.payout FROM bets b JOIN users u ON u.id = b.user_id
    WHERE b.round_id = ? AND b.status != 'refunded' ORDER BY b.payout DESC, b.amount DESC LIMIT 200`, r.id) : [];
  res.json({ round: r, bets });
}));

// ---------- player ----------
const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req);
    const now = Date.now();
    const state = await game.state(req.userId, now);
    state.withdrawals = await payments.userWithdrawals(req.userId);
    state.myBet = await crash.myBet(req.userId, now);
    state.nextBet = await crash.nextBet(req.userId);
    state.plays = await instant.recentPlays(req.userId);
    state.seed = await instant.publicSeed(req.userId);
    state.mines = await instant.activeMines(req.userId);
    res.json({ ok: true, ...(out || {}), state });
  } catch (e) {
    if (e instanceof game.GameError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};

app.get('/api/state', auth, wrap(() => {}));
app.post('/api/bet', auth, wrap((req) => crash.placeBet(req.userId, req.body.amount, req.body.autoCashout)));
app.post('/api/bet/cancel', auth, wrap((req) => crash.cancelBet(req.userId)));
app.post('/api/cashout', auth, wrap((req) => crash.cashout(req.userId)));
app.post('/api/games/dice', auth, wrap(async (req) => ({ result: await instant.playDice(req.userId, req.body || {}) })));
app.post('/api/games/flip', auth, wrap(async (req) => ({ result: await instant.playFlip(req.userId, req.body || {}) })));
app.post('/api/games/plinko', auth, wrap(async (req) => ({ result: await instant.playPlinko(req.userId, req.body || {}) })));
app.post('/api/games/mines/start', auth, wrap(async (req) => ({ result: await instant.minesStart(req.userId, req.body || {}) })));
app.post('/api/games/mines/reveal', auth, wrap(async (req) => ({ result: await instant.minesReveal(req.userId, req.body || {}) })));
app.post('/api/games/mines/cashout', auth, wrap(async (req) => ({ result: await instant.minesCashout(req.userId) })));
app.post('/api/seed/rotate', auth, wrap(async (req) => ({ result: await instant.rotateSeed(req.userId, (req.body || {}).clientSeed) })));
app.post('/api/play-settings', auth, wrap((req) => game.setPlay(req.userId, req.body || {})));
app.post('/api/deposit', auth, wrap((req) => payments.deposit(req.userId, Number(req.body.amount))));
app.post('/api/withdraw', auth, wrap((req) => payments.withdraw(req.userId, Number(req.body.amount))));

adminRoutes.setPasswordHasher(hashPassword);
app.use('/api/admin', auth, requireAdmin, adminRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
  app.listen(config.PORT, () => console.log(`${config.BRAND} running on http://localhost:${config.PORT}`));
}

module.exports = app;
