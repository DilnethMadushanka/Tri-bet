// Admin API. Every route here requires an admin session (see requireAdmin in server.js).
const express = require('express');
const { db, tx } = require('./db');
const game = require('./game');
const payments = require('./payments');
const settings = require('./settings');
const crash = require('./crash');
const instant = require('./instant');

const r = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    await settings.load();
    res.json({ ok: true, ...((await fn(req)) || {}) });
  } catch (e) {
    if (e instanceof game.GameError || e instanceof settings.SettingsError) {
      return res.status(400).json({ error: e.message });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};

const sum = async (sql, ...a) => (await db.get(sql, ...a)).s || 0;
const count = async (sql, ...a) => (await db.get(sql, ...a)).n;

r.get('/overview', handle(async () => {
  const now = Date.now();
  const day = 86400000;
  const since = now - 14 * day;
  const rounds = (await db.all("SELECT ended_at, total_bet, total_paid, players FROM rounds WHERE status = 'crashed' AND ended_at >= ?", since));
  const signups = (await db.all('SELECT created_at FROM users WHERE created_at >= ?', since));
  const plays = (await db.all("SELECT created_at, amount, payout FROM plays WHERE status != 'active' AND created_at >= ?", since));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * day); start.setHours(0, 0, 0, 0);
    const s = start.getTime(), e = s + day;
    const rs = rounds.filter((x) => x.ended_at >= s && x.ended_at < e);
    const ps = plays.filter((x) => x.created_at >= s && x.created_at < e);
    const bet = rs.reduce((a, x) => a + x.total_bet, 0) + ps.reduce((a, x) => a + x.amount, 0);
    const paid = rs.reduce((a, x) => a + x.total_paid, 0) + ps.reduce((a, x) => a + x.payout, 0);
    days.push({ day: s, signups: signups.filter((u) => u.created_at >= s && u.created_at < e).length, wagered: bet, profit: bet - paid });
  }
  const t = (await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(total_bet), 0) AS bet, COALESCE(SUM(total_paid), 0) AS paid FROM rounds WHERE status = 'crashed'"));
  const td = (await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(total_bet), 0) AS bet, COALESCE(SUM(total_paid), 0) AS paid FROM rounds WHERE status = 'crashed' AND ended_at >= ?", now - day));
  const pAll = (await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM plays WHERE status != 'active'"));
  const pDay = (await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM plays WHERE status != 'active' AND created_at >= ?", now - day));
  const byGame = [{ game: 'crash', name: 'Crash', bets: await count("SELECT COUNT(*) AS n FROM bets WHERE status IN ('won', 'lost')"), wagered: t.bet, paid: t.paid }]
    .concat((await db.all("SELECT game, COUNT(*) AS bets, SUM(amount) AS wagered, SUM(payout) AS paid FROM plays WHERE status != 'active' GROUP BY game"))
      .map((g) => ({ ...g, name: instant.GAMES[g.game] || g.game })));
  const W = t.bet + pAll.bet, P = t.paid + pAll.paid;
  return {
    users: await count('SELECT COUNT(*) AS n FROM users'),
    usersToday: await count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', now - day),
    activeToday: await count('SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?', now - day),
    playersToday: await count("SELECT COUNT(*) AS n FROM (SELECT user_id FROM bets WHERE created_at >= ? AND status != 'refunded' UNION SELECT user_id FROM plays WHERE created_at >= ?)", now - day, now - day),
    banned: await count('SELECT COUNT(*) AS n FROM users WHERE is_banned = 1'),
    totalBalances: await sum('SELECT SUM(balance) AS s FROM users'),
    rounds: t.n, wagered: W, paid: P, profit: W - P, byGame, betsCount: byGame.reduce((a, g) => a + g.bets, 0),
    roundsToday: td.n, betsToday: td.n + pDay.n, wageredToday: td.bet + pDay.bet, profitToday: td.bet + pDay.bet - td.paid - pDay.paid,
    rtp: W > 0 ? (P / W) * 100 : null,
    houseEdgePct: settings.get('houseEdgePct'),
    deposits: await sum("SELECT SUM(amount) AS s FROM ledger WHERE type = 'deposit'"),
    withdrawalsApproved: await sum("SELECT SUM(amount) AS s FROM withdrawals WHERE status = 'approved'"),
    withdrawalsPending: await count("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'"),
    withdrawalsPendingAmount: await sum("SELECT SUM(amount) AS s FROM withdrawals WHERE status = 'pending'"),
    referralPaid: await sum("SELECT SUM(amount) AS s FROM ledger WHERE type IN ('referral_bonus', 'referral_signup')"),
    bonusesPaid: await sum("SELECT SUM(amount) AS s FROM ledger WHERE type = 'signup_bonus'"),
    live: await crash.publicState(now),
    days,
  };
}));

r.get('/rounds', handle(async () => ({
  rounds: (await db.all(`SELECT id, hash, crash_point, status, started_at, ended_at, players, total_bet, total_paid FROM rounds
    WHERE status = 'crashed' ORDER BY id DESC LIMIT 200`)),
})));
r.get('/rounds/:id', handle(async (req) => {
  const round = (await db.get('SELECT * FROM rounds WHERE id = ?', Number(req.params.id)));
  if (!round) throw new game.GameError('Round not found');
  if (round.status === 'open' && round.crash_at > Date.now()) { round.seed = null; round.crash_point = null; } // secret until it ends, even for admins
  const bets = (await db.all('SELECT b.*, u.username FROM bets b JOIN users u ON u.id = b.user_id WHERE b.round_id = ? ORDER BY b.payout DESC, b.amount DESC', round.id));
  return { round, bets };
}));

r.get('/plays', handle(async (req) => {
  const g = String(req.query.game || '');
  return { plays: (await db.all(`SELECT p.id, p.game, p.amount, p.payout, p.multiplier, p.status, p.created_at, u.username, u.id AS user_id
    FROM plays p JOIN users u ON u.id = p.user_id WHERE (? = '' OR p.game = ?) ORDER BY p.id DESC LIMIT 300`, g, g)) };
}));

r.get('/bets', handle(async (req) => {
  const big = Number(req.query.min || 0);
  return { bets: (await db.all(`SELECT b.id, b.round_id, b.amount, b.auto_cashout, b.status, b.cashout_at, b.payout, b.created_at, u.username, u.id AS user_id
    FROM bets b JOIN users u ON u.id = b.user_id WHERE b.amount >= ? AND b.status != 'active' ORDER BY b.id DESC LIMIT 300`, big)) };
}));

r.get('/users', handle(async (req) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const users = (await db.all(`
    SELECT u.id, u.username, u.email, u.balance, u.created_at, u.last_seen, u.is_admin, u.is_banned, u.referral_code,
      inv.username AS invited_by,
      (SELECT COUNT(*) FROM bets WHERE user_id = u.id AND status IN ('won', 'lost')) + (SELECT COUNT(*) FROM plays WHERE user_id = u.id AND status != 'active') AS bets,
      (SELECT COALESCE(SUM(amount - payout), 0) FROM bets WHERE user_id = u.id AND status IN ('won', 'lost'))
        + (SELECT COALESCE(SUM(amount - payout), 0) FROM plays WHERE user_id = u.id AND status != 'active') AS house_profit,
      (SELECT COUNT(*) FROM users x WHERE x.referred_by = u.id) AS referrals
    FROM users u LEFT JOIN users inv ON inv.id = u.referred_by
    WHERE u.username LIKE ? OR IFNULL(u.email, '') LIKE ? OR u.referral_code LIKE ?
    ORDER BY u.id DESC LIMIT 300`, q, q, q));
  return { users };
}));

r.get('/users/:id', handle(async (req) => {
  const id = Number(req.params.id);
  const user = (await db.get(`SELECT u.*, inv.username AS invited_by FROM users u LEFT JOIN users inv ON inv.id = u.referred_by WHERE u.id = ?`, id));
  if (!user) throw new game.GameError('User not found');
  delete user.password_hash;
  const bets = (await db.all('SELECT id, round_id, amount, auto_cashout, status, cashout_at, payout, created_at FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 100', id));
  const totals = (await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM bets WHERE user_id = ? AND status IN ('won', 'lost')", id));
  const pt = (await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS bet, COALESCE(SUM(payout), 0) AS paid FROM plays WHERE user_id = ? AND status != 'active'", id));
  totals.n += pt.n; totals.bet += pt.bet; totals.paid += pt.paid;
  const plays = (await db.all("SELECT id, game, amount, payout, multiplier, status, created_at FROM plays WHERE user_id = ? ORDER BY id DESC LIMIT 60", id));
  const ledger = (await db.all('SELECT id, type, amount, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100', id));
  const referrals = (await db.all('SELECT id, username, created_at FROM users WHERE referred_by = ? ORDER BY id DESC', id));
  return { user, bets, plays, totals, ledger, referrals };
}));

r.post('/users/:id/adjust', handle(async (req) => {
  const id = Number(req.params.id);
  const amount = Number(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!Number.isFinite(amount) || amount === 0) throw new game.GameError('Enter a non-zero amount');
  if (!note) throw new game.GameError('Add a reason');
  await tx(async () => {
    const u = await game.getUser(id);
    if (!u) throw new game.GameError('User not found');
    if (u.balance + amount < 0) throw new game.GameError('Balance would go below zero');
    (await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', amount, id));
    await game.addLedger(id, 'admin_adjust', amount, `Admin: ${note}`);
  });
}));

r.post('/users/:id/ban', handle(async (req) => {
  const id = Number(req.params.id);
  if (id === req.userId) throw new game.GameError("You can't ban yourself");
  const banned = req.body.banned ? 1 : 0;
  (await db.run('UPDATE users SET is_banned = ? WHERE id = ?', banned, id));
  if (banned) (await db.run('DELETE FROM sessions WHERE user_id = ?', id));
}));

r.post('/users/:id/admin', handle(async (req) => {
  const id = Number(req.params.id);
  if (id === req.userId && !req.body.admin) throw new game.GameError("You can't remove your own admin rights");
  (await db.run('UPDATE users SET is_admin = ? WHERE id = ?', req.body.admin ? 1 : 0, id));
}));

r.get('/withdrawals', handle(async (req) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = (await db.all(`SELECT w.*, u.username, u.balance FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.id DESC LIMIT 300`, status));
  return { withdrawals: rows };
}));

r.post('/withdrawals/:id', handle(async (req) => {
  await payments.decideWithdrawal(req.userId, Number(req.params.id), !!req.body.approve, req.body.note || '');
}));


r.get('/settings', handle(async () => ({ settings: settings.all() })));
r.post('/settings', handle(async (req) => ({ settings: await settings.update(req.body || {}) })));

let hasher = null;
r.setPasswordHasher = (fn) => { hasher = fn; };
r.post('/users/:id/password', handle(async (req) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) throw new game.GameError('Password must be at least 8 characters');
  const id = Number(req.params.id);
  const c = (await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hasher(pw), id)).changes;
  if (!c) throw new game.GameError('User not found');
  (await db.run('DELETE FROM sessions WHERE user_id = ?', id));
}));

module.exports = r;
