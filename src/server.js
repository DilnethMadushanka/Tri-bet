const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db } = require('./db');
const config = require('./config');
const settings = require('./settings');
const game = require('./game');
const payments = require('./payments');
const adminRoutes = require('./admin');
const { crash } = require('./crash');
const instant = require('./instant');

const app = express();
app.set('trust proxy', 1); // behind Render/Railway's proxy: real client IP and HTTPS detection
app.use(express.json());
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

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
function startSession(res, userId, remember = true) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: res.req.secure, ...(remember ? { maxAge: 30 * 24 * 3600 * 1000 } : {}) });
}
function auth(req, res, next) {
  const row = req.cookies.sid && db.prepare(
    'SELECT s.user_id, u.is_admin, u.is_banned, u.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).get(req.cookies.sid);
  if (!row) return res.status(401).json({ error: 'Please log in' });
  if (row.is_banned) return res.status(403).json({ error: 'This account is blocked' });
  req.userId = row.user_id;
  req.isAdmin = !!row.is_admin;
  const now = Date.now();
  if (!row.last_seen || now - row.last_seen > 60_000) db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, row.user_id);
  next();
}
function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admins only' });
  next();
}

// Simple in-memory rate limit for login/register (per IP).
const hits = new Map();
function limit(req, res, next) {
  const key = req.ip, now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < 60_000);
  h.push(now); hits.set(key, h);
  if (h.length > 20) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  next();
}

app.post('/api/register', limit, (req, res) => {
  const { username, password, email, ref, remember, adult } = req.body || {};
  if (adult !== true) return res.status(400).json({ error: 'You must be 18 or older to join', field: 'adult' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'Username: 3-20 letters, numbers or _', field: 'username' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email address looks wrong', field: 'email' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters', field: 'password' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'That username is taken', field: 'username' });
  try {
    const id = game.registerUser({ username, email: email ? String(email).trim().toLowerCase() : null, passwordHash: hashPassword(password), referralCode: ref });
    startSession(res, id, remember !== false);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof game.GameError) return res.status(400).json({ error: e.message, field: 'ref' });
    throw e;
  }
});

app.get('/api/check-username', (req, res) => {
  const u = String(req.query.u || '');
  res.json({ valid: /^[a-zA-Z0-9_]{3,20}$/.test(u), taken: !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(u) });
});
app.get('/api/check-ref', (req, res) => {
  const row = db.prepare('SELECT username FROM users WHERE referral_code = ? AND is_banned = 0').get(String(req.query.code || '').trim().toUpperCase());
  res.json({ valid: !!row, inviter: row ? row.username : null });
});

app.post('/api/login', limit, (req, res) => {
  const { username, password, remember } = req.body || {};
  const user = db.prepare('SELECT id, password_hash, is_banned FROM users WHERE username = ? OR email = ?').get(username || '', String(username || '').toLowerCase());
  if (!user || !checkPassword(String(password || ''), user.password_hash)) return res.status(400).json({ error: 'Wrong username or password' });
  if (user.is_banned) return res.status(403).json({ error: 'This account is blocked' });
  startSession(res, user.id, remember !== false);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

// ---------- public ----------
app.get('/api/config', (req, res) => {
  const s = settings.all();
  res.json({
    brand: config.BRAND, coin: config.COIN, demoDeposits: s.demoDeposits, signupBonus: s.signupBonus, licenseText: s.licenseText,
    referralSignupBonus: s.referralSignupBonus, referralPct: s.referralPct, minWithdraw: s.minWithdraw,
    minBet: s.minBet, maxBet: s.maxBet, bettingSeconds: s.bettingSeconds, games: instant.gameConfig(), maxWin: s.maxWin, maxMultiplier: s.maxMultiplier, houseEdgePct: s.houseEdgePct,
  });
});
app.get('/api/public-stats', (req, res) => {
  const day = Date.now() - 86400000;
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    rounds: db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE status = 'crashed'").get().n,
    biggest: db.prepare("SELECT COALESCE(MAX(crash_point), 0) AS m FROM rounds WHERE status = 'crashed' AND ended_at >= ?").get(day).m,
    paid: db.prepare("SELECT COALESCE(SUM(payout), 0) AS s FROM bets WHERE status = 'won'").get().s,
  });
});

// Live game feed (Server-Sent Events). Public: anyone can watch.
app.get('/api/crash/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ type: 'hello', state: crash.publicState() });
  const off = crash.on(send);
  const ping = setInterval(() => send({ type: 'sync', state: crash.publicState() }), 5000);
  req.on('close', () => { off(); clearInterval(ping); });
});
app.get('/api/crash/state', (req, res) => res.json(crash.publicState()));

// Fairness check for any finished round.
app.get('/api/rounds', (req, res) => {
  res.json({ rounds: db.prepare("SELECT id, hash, seed, crash_point, edge_pct, ended_at, players, total_bet FROM rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 50").all() });
});
app.get('/api/rounds/:id', (req, res) => {
  const r = db.prepare('SELECT id, hash, seed, crash_point, edge_pct, status, started_at, ended_at, players, total_bet, total_paid FROM rounds WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Round not found' });
  if (r.status !== 'crashed') { r.seed = null; r.crash_point = null; }
  const bets = r.status === 'crashed' ? db.prepare(`SELECT u.username, b.amount, b.status, b.cashout_at, b.payout FROM bets b JOIN users u ON u.id = b.user_id
    WHERE b.round_id = ? AND b.status != 'refunded' ORDER BY b.payout DESC, b.amount DESC LIMIT 200`).all(r.id) : [];
  res.json({ round: r, bets });
});

// ---------- player ----------
const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req);
    const state = game.state(req.userId);
    state.withdrawals = payments.userWithdrawals(req.userId);
    state.myBet = crash.myBet(req.userId);
    state.plays = instant.recentPlays(req.userId);
    state.seed = instant.publicSeed(req.userId);
    state.mines = instant.activeMines(req.userId);
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
app.post('/api/games/dice', auth, wrap((req) => ({ result: instant.playDice(req.userId, req.body || {}) })));
app.post('/api/games/flip', auth, wrap((req) => ({ result: instant.playFlip(req.userId, req.body || {}) })));
app.post('/api/games/plinko', auth, wrap((req) => ({ result: instant.playPlinko(req.userId, req.body || {}) })));
app.post('/api/games/mines/start', auth, wrap((req) => ({ result: instant.minesStart(req.userId, req.body || {}) })));
app.post('/api/games/mines/reveal', auth, wrap((req) => ({ result: instant.minesReveal(req.userId, req.body || {}) })));
app.post('/api/games/mines/cashout', auth, wrap((req) => ({ result: instant.minesCashout(req.userId) })));
app.post('/api/seed/rotate', auth, wrap((req) => ({ result: instant.rotateSeed(req.userId, (req.body || {}).clientSeed) })));
app.post('/api/play-settings', auth, wrap((req) => game.setPlay(req.userId, req.body || {})));
app.post('/api/deposit', auth, wrap((req) => payments.deposit(req.userId, Number(req.body.amount))));
app.post('/api/withdraw', auth, wrap((req) => payments.withdraw(req.userId, Number(req.body.amount))));

adminRoutes.setPasswordHasher(hashPassword);
app.use('/api/admin', auth, requireAdmin, adminRoutes);

if (require.main === module) {
  if (config.CRASH_AUTOSTART) crash.start();
  const server = app.listen(config.PORT, () => console.log(`${config.BRAND} running on http://localhost:${config.PORT}`));
  // On redeploy the host sends SIGTERM: stop new rounds; bets of an unfinished round are refunded on the next start.
  process.on('SIGTERM', () => { crash.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}

module.exports = app;
